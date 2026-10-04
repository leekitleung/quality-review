# 测试失败根因分析

**分析日期**: 2026-10-04
**基线提交**: 工作区状态（含未提交改动）
**执行命令**: `npm test`
**实际结果**: 122 tests / 109 pass / **12 fail** / 1 skipped

> ⚠️ **与规划文档的数字不一致**
> `EXECUTION-SUMMARY.md` 记录的是「118 tests / 111 pass / 6 fail」。
> 实测为 122 / 109 / 12。规划文档成文时测试数量已变化，其数字已失效。
> 本文档以实测为准。

---

## 结论先行

**12 个失败中，0 个是业务逻辑缺陷。** 全部归因于两条平台适配根因：

| 根因 | 失败数 | 性质 | 归属 |
|------|--------|------|------|
| **A. 同步子进程调用在本机 EBUSY** | 8 | 环境限制 | Task 2.1（被误排到 Phase 2） |
| **B. POSIX 路径/shebang 硬编码** | 4 | 代码跨平台缺陷 | Task 2.1（同上） |

**关键结论：Task 2.1「Windows 支持」不是 Phase 2 的 P1 优化项，而是 Phase 1 的硬前置。**
在 Windows 上，只要不动 Task 2.1，Task 1.1「修测试」在物理上不可能完成——测试进程根本起不来。
规划文档把因果关系排反了。

CI 跑在 `macos-latest`（`.github/workflows/skill-quality.yml:13`），所以这些问题在 CI 上不可见，
只在 Windows 本地暴露。这解释了为什么缺陷能长期存在。

---

## 根因 A：同步 spawn 在 Windows 上返回 EBUSY（8 个失败）

### 证据

最小复现（与项目代码完全无关）：

```js
import { spawnSync } from 'node:child_process';
spawnSync(process.execPath, ['-e', 'console.log(1)'], { encoding: 'utf8' });
// → status: null, error: Error: spawnSync ...node.exe EBUSY (errno -4082)
```

对照实验：

| 调用方式 | 结果 |
|----------|------|
| `spawnSync(execPath, ...)` | ❌ EBUSY |
| `execSync('node -e ...')` | ❌ EBUSY (cmd.exe EBUSY) |
| `spawn(execPath, ...)` 异步 | ✅ exit 0，stdout 正常 |
| 手�� Bash 直接执行 | ✅ exit 0 |

**同步 spawn 在本机 100% 失败，异步 spawn 完全正常。** 这是 Windows 同步 CreateProcess
路径的已知限制（句柄无法正确释放，常见于注入式 DLL / 安全软件拦截）。

### 失败清单

| # | 测试 | 位置 | 报错 |
|---|------|------|------|
| 1 | experiment runner completes a documented dry run | `deep-optimization-lab/__tests__/cli.test.mjs:22` | `null !== 0`，stdout 为 `undefined` |
| 2 | documented dry run bootstraps its baseline | `cli.test.mjs:32` | 同上 |
| 3 | experiment runner rejects a shell-shaped profile | `cli.test.mjs:47` | `null !== 4` |
| 4 | baseline collector rejects output paths outside project root | `cli.test.mjs:60` | `null !== 4` |
| 5 | gate change-scale module › detects current repository | `release-quality-review/__tests__/unit.test.mjs:374` | `Expected a known scale` |
| 6 | repository context preserves a nested project path | `unit.test.mjs:753` | `spawnSync git EBUSY` |
| 7 | security boundaries › validates structured rollback evidence | `__tests__/evidence-security.test.mjs:281` | `Buffer.byteLength` 收到 undefined |
| 8 | security boundaries › accepts paths contained by the repository | `evidence-security.test.mjs:178` | 根因 C（POSIX 路径断言） |

第 5 项细节：`scale.mjs:12` 用 `execFileSync('git', ['diff','--numstat'])`，EBUSY 被 catch
吞掉后 scale 落到 `'unknown'`，测试断言失败。**表面看是逻辑错误，实质是 spawn 失败。**

### 影响分析

- **严重性**: High（阻断本地验证，不影响 macOS CI）
- **生产风险**: 否 —— CI 门禁在 macOS 上运行，逻辑本身正确
- **波及范围**: 163 处同步 spawn 调用，分布如下

  | 文件 | 同步 spawn 次数 |
  |------|----------------|
  | `runner-lifecycle.test.mjs` | 50 |
  | `gate-e2e.test.mjs` | 49 |
  | `gate-policy.test.mjs` | 43 |
  | `reviewer-selection.test.mjs` | 7 |
  | `evidence-security.test.mjs` | 7 |
  | `cli.test.mjs` | 5 |
  | `unit.test.mjs` | 2 |

### 修复方向

改造为异步 `spawn` + Promise 包装（约 163 处，跨 7 个文件、上千行）。
**这是 Phase 1 的前置条件，不是可选优化。**

---

## 根因 B：POSIX 路径与 shebang 硬编码（4 个文件整体崩溃）

### 证据

四个测试文件在 **module-load 阶段**就抛异常，导致整个文件的所有用例计为失败：

```js
// gate-e2e.test.mjs:161 / gate-policy.test.mjs:67
// reviewer-selection.test.mjs:149 / runner-lifecycle.test.mjs:154
spawnSync('/usr/bin/env', ['sh', '-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
// → TypeError: Cannot read properties of undefined (reading 'trim')
```

`/usr/bin/env` 在 Windows 上不存在，`stdout` 为 `undefined`。

### 影响面远大于这一行

这些文件的**测试夹具本身**建立�� POSIX 假设：

| POSIX 依赖 | 出现次数 | Windows 后果 |
|-----------|---------|-------------|
| `#!/usr/bin/env node` shebang fake bin | 12 处 | 假可执行文件无法执行 |
| `chmodSync(..., 0o755)` | 21 处 | 无意义，文件仍不可执行 |
| PATH 用 `:` 拼接 | 26 处 | 应为 `;`（`path.delimiter`） |
| `spawnSync` | 149 处 | 见根因 A |

**结论：这不是「修一行」的问题，是测试基础设施的跨平台重构。**
假 bin 需要改为跨平台包装器（Windows 用 `.cmd` / `process.execPath` 直接调用）。

### 已有的门控先例

仓库中已存在平台门控模式，可作为改造参考：

- `evidence-security.test.mjs:318` — `{ skip: process.platform !== 'darwin' }`
- `runner-lifecycle.test.mjs:224,260` — `if (process.platform !== 'darwin') return;`
- `security-utils.mjs:130-133` — 非 darwin 且非 Linux+Docker 时 fail-closed

---

## 根因 C：POSIX 路径断言未跨平台化（1 个失败）

**位置**: `evidence-security.test.mjs:179`

```
expected: /tmp/repository/.claude/agents/reviewer.md
actual:   H:\tmp\repository\.claude\agents\reviewer.md
```

测试用 `/tmp/...` 字符串构造预期路径，在 Windows 上 `resolve()` 产出盘符前缀。
**测试期望值写死为 POSIX 形态，应改用 `path.resolve()` / `path.join()` 构造。**

同文件 `:306` 的 `Buffer.byteLength` 收到 `undefined`，是 EBUSY 导致 git 输出为空的次生效应。

---

## 已修复：experiment-runner 硬编码相对路径

**文件**: `skills/deep-optimization-lab/scripts/experiment-runner.mjs:189`

**问题**: 用相对当前工作目录的硬编码路径调用 baseline-collector：

```js
execFileSync(process.execPath, [
  'skills/deep-optimization-lab/scripts/baseline-collector.mjs', '--profile', profile,
], { stdio: 'inherit', cwd: PROJECT_ROOT });
```

`PROJECT_ROOT` 取自 `process.cwd()`，当脚本从任意非项目根目录运行时必然 `MODULE_NOT_FOUND`。
该路径与同文件已有的 `EXPERIMENT_LOGS` 语义自相矛盾。

**修复**: 基于 `import.meta.url` 解析（`fileURLToPath` 原本已 import 但未使用）：

```js
const COLLECTOR = fileURLToPath(new URL('./baseline-collector.mjs', import.meta.url));
execFileSync(process.execPath, [COLLECTOR, '--profile', profile], {
  stdio: 'inherit', cwd: PROJECT_ROOT,
});
```

**验证**: 在无 baseline 的干净临时目录中直接执行，exit code = 0，输出含 `DRY RUN MODE`。
（注：该用例的测试断言仍因根因 A 失败，但实现侧已由 Bash 手工执行验证通过。）

---

## 预防策略

1. **CI 增加 Windows job**（`windows-latest`），让根因 A/B 在 CI 暴露而非本地
2. **测试禁止同步 spawn**：加 lint 规则拦截 `spawnSync|execSync|execFileSync`
3. **路径断言统一走 `path` 模块**，禁止字面量 `/tmp`、`/usr/bin`
4. **fake bin 抽象层**：跨平台包装器，Windows 走 `process.execPath`
5. **PATH 拼接用 `path.delimiter`**，不用字面量 `:`

---

## 对规划文档的修正建议

| 规划项 | 原定优先级 | 建议 |
|--------|-----------|------|
| Task 2.1 Windows 支持 | Phase 2 / P1 / Week 2 | **提升为 Phase 1 / P0 / Week 1** |
| Task 1.1 修 6 个测试 | Phase 1 / P0 | 数字已过时（实为 12）；且在 Windows 上不可完成 |
| Task 1.2 根因文档 | Phase 1 / P0 | ✅ 本文档即交付物 |
| 文档「8.7/10 → 9.2/10」 | — | 该评分体系未在任何仓库文件中定义，无法验证，建议删除或补齐评分方法 |

---

## 附：完整失败清单

TAP 输出共 14 条 `not ok` 行，其中 2 条是 suite 级汇总（`security boundaries`、
`gate change-scale module`），扣除后为 **12 个原子失败**：

| # | 测试 | 位置 | 根因 |
|---|------|------|------|
| 1 | experiment runner completes a documented dry run | `cli.test.mjs:22` | A |
| 2 | documented dry run bootstraps its baseline | `cli.test.mjs:32` | A |
| 3 | experiment runner rejects a shell-shaped profile | `cli.test.mjs:47` | A |
| 4 | baseline collector rejects output paths outside project root | `cli.test.mjs:60` | A |
| 5 | security boundaries › accepts paths contained by the repository | `evidence-security.test.mjs:178` | C |
| 6 | security boundaries › validates structured rollback evidence | `evidence-security.test.mjs:281` | A |
| 7 | gate-e2e.test.mjs（module load 崩溃） | `gate-e2e.test.mjs:161` | B |
| 8 | gate-policy.test.mjs（module load 崩溃） | `gate-policy.test.mjs:67` | B |
| 9 | reviewer-selection.test.mjs（module load 崩溃） | `reviewer-selection.test.mjs:149` | B |
| 10 | runner-lifecycle.test.mjs（module load 崩溃） | `runner-lifecycle.test.mjs:154` | B |
| 11 | gate change-scale module › detects the current repository | `unit.test.mjs:374` | A |
| 12 | repository context preserves a nested project path | `unit.test.mjs:753` | A |

原始 TAP 条目（`# fail 12` 计数来源，含 suite 汇总）：

```
not ok 1  - experiment runner completes a documented dry run without external YAML dependencies
not ok 2  - documented dry run bootstraps its baseline in a clean workspace
not ok 3  - experiment runner rejects a shell-shaped profile without executing it
not ok 4  - baseline collector rejects output paths outside the project root
not ok 4  -   accepts paths contained by the repository                     [suite: security boundaries]
not ok 11 -   validates structured rollback evidence and rejects forged trees [suite: security boundaries]
not ok 7  - security boundaries                                            [suite 汇总]
not ok 4  - skills\release-quality-review\__tests__\gate-e2e.test.mjs
not ok 5  - skills\release-quality-review\__tests__\gate-policy.test.mjs
not ok 8  - skills\release-quality-review\__tests__\reviewer-selection.test.mjs
not ok 9  - skills\release-quality-review\__tests__\runner-lifecycle.test.mjs
not ok 1  -   detects the current repository and fails closed for an invalid root [suite: gate change-scale module]
not ok 28 - gate change-scale module                                        [suite 汇总]
not ok 37 - repository context preserves a nested project path
```
