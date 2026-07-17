import { createHash } from 'node:crypto';

export const CODEX_RADAR_SUMMARY_URL = 'https://codexradar.com/current.json';
export const RADAR_ATTRIBUTION = '数据来自 Codex 雷达 codexradar.com';
export const DEFAULT_RADAR_MAX_AGE_HOURS = 48;

const LIGHTWEIGHT_EFFORTS = new Set(['low', 'medium']);
const EFFORT_RANK = new Map([
  ['minimal', 0], ['low', 1], ['medium', 2], ['high', 3], ['xhigh', 4], ['max', 5],
]);

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function candidateFromEntry(key, entry) {
  const latest = entry?.latest || entry;
  const model = latest?.model || entry?.model;
  const reasoningEffort = latest?.reasoning_effort || entry?.reasoning_effort;
  const score = Number(latest?.score);
  const validTasks = Number(latest?.valid_tasks ?? (Number(latest?.tasks) - Number(latest?.invalid || 0)));
  if (typeof model !== 'string' || !/^(?:gpt-|o\d|codex)/i.test(model) ||
      typeof reasoningEffort !== 'string' || !Number.isFinite(score) || validTasks < 10) return null;
  const recentScores = (entry?.recent_days || []).slice(-3).map(item => Number(item?.score));
  return {
    key,
    label: entry?.label || key,
    model,
    reasoningEffort,
    score,
    rollingMedian3: median(recentScores),
    validTasks,
    costUsd: Number.isFinite(Number(latest?.cost_usd)) ? Number(latest.cost_usd) : null,
    wallSeconds: Number.isFinite(Number(latest?.wall_seconds)) ? Number(latest.wall_seconds) : null,
  };
}

export function extractRadarCandidates(snapshot) {
  const modelIq = snapshot?.model_iq;
  if (!modelIq || typeof modelIq !== 'object') throw new Error('Radar snapshot is missing model_iq');
  const entries = Object.entries(modelIq.comparisons || {});
  if (modelIq.latest) entries.push(['latest', modelIq.latest]);
  const unique = new Map();
  for (const [key, entry] of entries) {
    const candidate = candidateFromEntry(key, entry);
    if (!candidate) continue;
    const identity = `${candidate.model}\0${candidate.reasoningEffort}`;
    const previous = unique.get(identity);
    if (!previous || candidate.score > previous.score) unique.set(identity, candidate);
  }
  return [...unique.values()];
}

function compareCandidates(a, b) {
  return b.score - a.score ||
    (b.rollingMedian3 ?? -Infinity) - (a.rollingMedian3 ?? -Infinity) ||
    (EFFORT_RANK.get(a.reasoningEffort) ?? 99) - (EFFORT_RANK.get(b.reasoningEffort) ?? 99) ||
    (a.costUsd ?? Infinity) - (b.costUsd ?? Infinity) ||
    (a.wallSeconds ?? Infinity) - (b.wallSeconds ?? Infinity) ||
    a.model.localeCompare(b.model) || a.reasoningEffort.localeCompare(b.reasoningEffort);
}

export function selectRadarReviewerModel(snapshot, {
  now = new Date(), maxAgeHours = DEFAULT_RADAR_MAX_AGE_HOURS, minimumIqExclusive = 100,
  preferLightweight = true,
} = {}) {
  if (!/^2\./.test(String(snapshot?.schema_version || ''))) {
    throw new Error(`unsupported Radar schema_version: ${snapshot?.schema_version ?? 'missing'}`);
  }
  const updatedAt = snapshot?.model_iq?.updated_at;
  const updatedTime = Date.parse(updatedAt || '');
  if (!Number.isFinite(updatedTime)) throw new Error('Radar snapshot has no valid model_iq.updated_at');
  const ageHours = (now.getTime() - updatedTime) / 3_600_000;
  if (ageHours < -1 || ageHours > maxAgeHours) {
    throw new Error(`Radar snapshot is stale or future-dated (${ageHours.toFixed(1)} hours old)`);
  }

  const candidates = extractRadarCandidates(snapshot);
  if (candidates.length === 0) throw new Error('Radar snapshot contains no usable Codex model candidates');
  const qualified = candidates.filter(candidate => candidate.score > minimumIqExclusive);
  const qualifiedLightweight = qualified.filter(candidate => LIGHTWEIGHT_EFFORTS.has(candidate.reasoningEffort));
  let pool;
  let mode;
  if (preferLightweight && qualifiedLightweight.length > 0) {
    pool = qualifiedLightweight;
    mode = 'radar-lightweight-qualified';
  } else if (qualified.length > 0) {
    pool = qualified;
    mode = preferLightweight ? 'radar-qualified-highest' : 'radar-high-assurance-highest';
  } else {
    pool = candidates;
    mode = 'radar-highest-score-fallback';
  }
  const selected = [...pool].sort(compareCandidates)[0];
  return {
    model: selected.model,
    reasoningEffort: selected.reasoningEffort,
    selection: {
      mode,
      selected_by: 'orchestrator',
      review_tier: preferLightweight ? 'lightweight-preferred' : 'high-assurance',
      target_iq_exclusive: minimumIqExclusive,
      target_met: selected.score > minimumIqExclusive,
      observed_iq: selected.score,
      rolling_median_3: selected.rollingMedian3,
      valid_tasks: selected.validTasks,
      radar_updated_at: updatedAt,
      source: CODEX_RADAR_SUMMARY_URL,
      attribution: RADAR_ATTRIBUTION,
    },
  };
}

export async function fetchRadarReviewerModel({
  fetchImpl = globalThis.fetch, now = new Date(), timeoutMs = 5000,
  maxAgeHours = DEFAULT_RADAR_MAX_AGE_HOURS, preferLightweight = true,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Radar fetch is unavailable');
  let response;
  try {
    response = await fetchImpl(CODEX_RADAR_SUMMARY_URL, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`Radar request failed: ${error.message}`);
  }
  if (!response?.ok) throw new Error(`Radar request failed with HTTP ${response?.status ?? 'unknown'}`);
  const body = await response.text();
  let snapshot;
  try {
    snapshot = JSON.parse(body);
  } catch {
    throw new Error('Radar response is not valid JSON');
  }
  const result = selectRadarReviewerModel(snapshot, { now, maxAgeHours, preferLightweight });
  result.selection.snapshot_sha256 = createHash('sha256').update(body).digest('hex');
  return result;
}
