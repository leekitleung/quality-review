import { createHash } from 'node:crypto';

export const CODEX_RADAR_SUMMARY_URL = 'https://codexradar.com/current.json';
export const RADAR_ATTRIBUTION = '数据来自 Codex 雷达 codexradar.com';
export const DEFAULT_RADAR_MAX_AGE_HOURS = 48;

const LIGHTWEIGHT_EFFORTS = new Set(['low', 'medium']);
export const REVIEW_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_RANK = new Map([
  ['minimal', 0], ['low', 1], ['medium', 2], ['high', 3], ['xhigh', 4], ['max', 5],
]);

export function validateReviewModelIdentity({ backend, model, reasoningEffort = null }, {
  requireReasoningEffort = false,
} = {}) {
  if (!['claude', 'codex'].includes(backend)) return { valid: false, error: 'invalid review backend' };
  if (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) {
    return { valid: false, error: 'invalid review model' };
  }
  const claudeModel = /^(?:claude-|sonnet$|opus$|haiku$)/i.test(model);
  if (backend === 'codex' && claudeModel) return { valid: false, error: `model ${model} is not valid for codex backend` };
  if (backend === 'claude' && !claudeModel) return { valid: false, error: `model ${model} is not valid for claude backend` };
  if (reasoningEffort !== null && !REVIEW_REASONING_EFFORTS.has(reasoningEffort)) {
    return { valid: false, error: 'invalid review reasoning effort' };
  }
  if (backend === 'claude' && reasoningEffort !== null) {
    return { valid: false, error: 'Claude review identity cannot set Codex reasoning effort' };
  }
  if (backend === 'codex' && requireReasoningEffort && reasoningEffort === null) {
    return { valid: false, error: 'Codex Radar identity is missing reasoning effort' };
  }
  return { valid: true, error: null };
}

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
  const identity = validateReviewModelIdentity(
    { backend: 'codex', model, reasoningEffort },
    { requireReasoningEffort: true },
  );
  if (!identity.valid || !/^(?:gpt-|o\d|codex)/i.test(model) ||
      !Number.isFinite(score) || !Number.isInteger(validTasks) || validTasks < 10) return null;
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
  if (!modelIq || typeof modelIq !== 'object') {
    const error = new Error('Radar snapshot is missing model_iq');
    error.code = 'MISSING_MODEL_IQ';
    throw error;
  }
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
    const error = new Error(`unsupported Radar schema_version: ${snapshot?.schema_version ?? 'missing'}`);
    error.code = 'INVALID_SCHEMA_VERSION';
    throw error;
  }
  const updatedAt = snapshot?.model_iq?.updated_at;
  const updatedTime = Date.parse(updatedAt || '');
  if (!Number.isFinite(updatedTime)) {
    const error = new Error('Radar snapshot has no valid model_iq.updated_at');
    error.code = 'MISSING_UPDATED_AT';
    throw error;
  }
  const ageHours = (now.getTime() - updatedTime) / 3_600_000;
  if (ageHours < -1 || ageHours > maxAgeHours) {
    const error = new Error(`Radar snapshot is stale or future-dated (${ageHours.toFixed(1)} hours old)`);
    error.code = 'STALE_SNAPSHOT';
    error.ageHours = ageHours;
    error.maxAgeHours = maxAgeHours;
    throw error;
  }

  const candidates = extractRadarCandidates(snapshot);
  if (candidates.length === 0) {
    const error = new Error('Radar snapshot contains no usable Codex model candidates');
    error.code = 'NO_CANDIDATES';
    throw error;
  }
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
  if (typeof fetchImpl !== 'function') {
    const error = new Error('Radar fetch is unavailable');
    error.code = 'RADAR_FETCH_UNAVAILABLE';
    throw error;
  }
  let response;
  try {
    response = await fetchImpl(CODEX_RADAR_SUMMARY_URL, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`Radar request failed: ${causeMessage}`);
    error.code = 'RADAR_REQUEST_FAILED';
    error.cause = cause;
    throw error;
  }
  if (!response?.ok) {
    const error = new Error(`Radar request failed with HTTP ${response?.status ?? 'unknown'}`);
    error.code = 'RADAR_HTTP_ERROR';
    error.status = response?.status;
    throw error;
  }
  let body;
  try {
    body = await response.text();
  } catch (cause) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`Radar response body failed: ${causeMessage}`);
    error.code = 'RADAR_BODY_READ_FAILED';
    error.cause = cause;
    throw error;
  }
  let snapshot;
  try {
    snapshot = JSON.parse(body);
  } catch (cause) {
    const error = new Error('Radar response is not valid JSON');
    error.code = 'RADAR_INVALID_JSON';
    error.cause = cause;
    throw error;
  }
  const result = selectRadarReviewerModel(snapshot, { now, maxAgeHours, preferLightweight });
  result.selection.snapshot_sha256 = createHash('sha256').update(body).digest('hex');
  return result;
}
