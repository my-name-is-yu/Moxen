# Milestone 3 Dogfooding — Bug Analysis

**Date**: 2026-03-15
**Analyst**: researcher agent
**Status**: 7 unfixed bugs from M3 dogfooding findings

---

## #4 LLM観測の甘い評価 (CRITICAL)

**File**: `src/observation-engine.ts`, lines 492–540

**Root cause**: `observeWithLLM()` constructs its prompt using only:
- `goalDescription` (the goal's description string)
- `dimensionLabel` (human-readable label)
- `thresholdDescription` (JSON-stringified threshold object)

The prompt (lines 503–509) is:
```
以下のゴールの次元を0.0〜1.0で評価してください。
ゴール: ${goalDescription}
評価次元: ${dimensionLabel}
目標値: ${thresholdDescription}
現在の状態を考慮して...
```

**What's missing**: The LLM has NO access to:
1. Actual workspace file contents (e.g., the README it's supposed to evaluate)
2. The git working tree state or any filesystem artifacts
3. The current `dim.current_value` (previous observation result)

The LLM is asked to evaluate "current state" with zero context about what the current state actually is. For a "README quality" goal, it would hallucinate a score rather than read the README. The only real inputs are the goal description and target threshold — both of which were provided at goal creation time, not at observation time.

**Caller site** (`observe()`, lines 334–341): passes `goal.description`, `dim.label ?? dim.name`, and `JSON.stringify(dim.threshold)` — no file paths, no workspace context.

**Suggested fix**:
- Add an optional `context?: string` parameter to `observeWithLLM()` and thread it through from `observe()`.
- The caller (`observe()`) should try to gather relevant context before invoking `observeWithLLM()`: e.g. for file-based goals, read and truncate the most relevant files; for code quality goals, run a quick shell command.
- Alternatively, add a `contextProvider?: (goalId: string, dimensionName: string) => Promise<string>` DI parameter to `ObservationEngine`.
- At minimum, pass `dim.current_value` and the dimension history summary so the LLM can at least be anchored to prior observations.

**Confidence**: Confirmed

---

## #3 DataSource次元名がゴール交渉を支配

**File**: `src/goal-negotiator.ts`, lines 49–91 (`buildDecompositionPrompt`) and lines 399–424 (in `negotiate()`)

**Root cause**: Two compounding mechanisms force DataSource dimension names to dominate:

**Mechanism 1 — Prompt-level coercion** (lines 61–66):
```
CRITICAL CONSTRAINT: When available data source dimensions are listed below, you MUST use those exact dimension names...
Map your dimensions 1:1 to data source dimensions whenever possible.
Only create new dimension names for concepts that have NO matching data source dimension.
```
The word "MUST" and "CRITICAL CONSTRAINT" in the prompt is extremely aggressive. For a goal like "improve npm publish quality", if DataSources expose `open_issue_count`/`closed_issue_count`/`completion_ratio`, the LLM is instructed to use those as the only dimensions even if the actual goal needs `README_completeness`, `package_description_quality`, etc.

**Mechanism 2 — Post-processing remapping** (lines 413–424):
After the LLM generates dimensions, the code runs `findBestDimensionMatch()` which uses 30% token overlap to forcibly rename LLM-generated dimensions to the closest DataSource dimension name. So even if the LLM generates `code_coverage`, it may be remapped to `completion_ratio` if there's a 30%+ token overlap.

`findBestDimensionMatch()` (lines 1207–1223): the 30% threshold is very low. For example, `readme_quality` and `completion_ratio` would not match, but `issue_count` and `open_issue_count` would both pull toward `open_issue_count` (50% overlap). Any quality dimension could be remapped to a DataSource dimension if one token overlaps.

**Combined effect**: The goal's quality-oriented dimensions (what the user actually cares about) get replaced by whatever the DataSource can measure — even if those DataSource dimensions are proxies, not the real quality criteria.

**Suggested fix**:
- Soften the prompt language: "prefer matching DataSource dimensions where appropriate" instead of "MUST" and "CRITICAL CONSTRAINT".
- Add a quality-dimensions section: "Always include at least N dimensions that directly capture the goal's quality intent, even if they don't map to any DataSource."
- Raise `findBestDimensionMatch` threshold from `0.3` to `0.6`+ or make it opt-in via a flag.
- Consider a two-pass approach: first decompose quality dimensions freely, then overlay DataSource coverage as additional mechanical observation method hints rather than replacing dimension names.

**Confidence**: Confirmed

---

## #5 file_existenceタイプがCLI非対応

**File**: `src/cli-runner.ts`, lines 812–814

**Root cause**: The `cmdDatasourceAdd()` method at line 812 validates allowed types:
```typescript
if (type !== "file" && type !== "http_api" && type !== "github_issue") {
  console.error(`Error: unsupported type "${type}". Supported: file, http_api, github_issue`);
  return 1;
}
```

`file_existence` is NOT in the allowed list. Users cannot register a `file_existence` data source via `motiva datasource add file_existence ...` — the CLI immediately returns error code 1.

However, the **runtime loading** code at line 125 does handle `file_existence`:
```typescript
} else if (config.type === 'file_existence') {
  dataSources.push(new FileExistenceDataSourceAdapter(config));
}
```

So a `file_existence` datasource that was manually written to `~/.motiva/datasources/` would load correctly, but there is no CLI path to create one.

Additionally, `name` derivation at line 833 doesn't handle `file_existence`:
```typescript
const name = values.name ?? (type === "file" ? `file:${...}` : `http_api:${...}`);
```
And help text at lines 1538–1539 only mentions `file | http_api`.

**Suggested fix**:
- Add `"file_existence"` to the allowed types check at line 812.
- Add a `connection.path` branch in the connection-building block (lines 836–851) for `file_existence` (same as `file` — needs `--path`).
- Update the `name` fallback at line 833 to handle the new type.
- Update help text at lines 1538 and 1587.

**Confidence**: Confirmed

---

## #6 archiveGoal後にloadGapHistory/loadGoalが空を返す

**Files**: `src/state-manager.ts`, lines 89–93 (`loadGoal`), lines 253–263 (`loadGapHistory`), lines 218–228 (`loadObservationLog`)

**Root cause**: After `archiveGoal()` (lines 116–161), all goal data is moved:
- `goals/<goalId>/` → `archive/<goalId>/goal/`
- `tasks/<goalId>/` → `archive/<goalId>/tasks/`
- etc.

The loading functions all look in the original paths only:

`loadGoal()` (line 90): looks in `path.join(this.baseDir, "goals", goalId, "goal.json")` — returns `null` after archiving.

`loadGapHistory()` (line 254): looks in `path.join(this.baseDir, "goals", goalId, "gap-history.json")` — returns `[]` after archiving.

`loadObservationLog()` (line 219): looks in `path.join(this.baseDir, "goals", goalId, "observations.json")` — returns `null` after archiving.

None of these have archive fallback logic. After calling `archiveGoal()`, any code that subsequently calls `loadGoal(goalId)` gets `null`, which causes errors in anything that depends on the goal state (e.g. `motiva goal show <id>` after archiving).

**Note**: `listArchivedGoals()` returns the goal IDs, but there's no `loadArchivedGoal()` method that reads from `archive/<goalId>/goal/goal.json`.

**Suggested fix**:
- Add a `loadArchivedGoal(goalId: string): Goal | null` method that reads from `archive/<goalId>/goal/goal.json`.
- Optionally, add fallback logic to `loadGoal()`: if not found in `goals/`, check `archive/<goalId>/goal/goal.json`.
- Add analogous archive-fallback or dedicated methods for `loadGapHistory` and `loadObservationLog`.
- `motiva goal show <id>` and `motiva goal list --archived` should use the archived path.

**Confidence**: Confirmed

---

## #7 observe()のobserveCountトランケーション仕様

**File**: `src/observation-engine.ts`, line 319

**Root cause**: The `observe()` method computes `observeCount` as:
```typescript
const observeCount = methods.length > 0
  ? Math.min(goal.dimensions.length, methods.length)
  : goal.dimensions.length;
```

**Behavior**:
- When `methods = []` (empty array): `methods.length > 0` is `false`, so `observeCount = goal.dimensions.length` — all dimensions observed. Correct.
- When `methods` contains fewer entries than `goal.dimensions`: only the first `methods.length` dimensions are observed. Dimensions beyond the methods array are **silently skipped**.

This is a confusing API. The design intent of `methods` (per the JSDoc comment) is to provide observation method descriptors "one per dimension, in the same order as goal.dimensions. Extra entries are ignored; missing entries fall back to the dimension's own observation_method." But the implementation doesn't fall back for missing entries — it skips those dimensions entirely.

The fallback `methods[idx] ?? dim.observation_method` at line 323 is never reached for dimensions beyond `observeCount`.

**Practical impact**: If a caller passes `methods` for only the first 2 dimensions of a 5-dimension goal, the last 3 dimensions are never observed. This is a latent data staleness bug whenever callers don't pass the full methods array.

**Suggested fix**:
- Change `observeCount` to always be `goal.dimensions.length`, so all dimensions are always observed.
- The fallback at line 323 (`methods[idx] ?? dim.observation_method`) already handles the case where `methods[idx]` is `undefined`.
- Or make the behavior explicit: if `methods.length > 0` and `methods.length < goal.dimensions.length`, log a warning about the truncation.

**Confidence**: Confirmed

---

## #8 環境変数管理の煩雑さ

**File**: `src/provider-factory.ts`, lines 31–83

**Root cause / Situation**: The factory reads from `loadProviderConfig()` which merges `~/.motiva/provider.json` with environment variables. The required env vars depend on the chosen provider:

| Provider | Required env vars | Optional |
|----------|-------------------|----------|
| `anthropic` (default before 2026-03-15) | `ANTHROPIC_API_KEY` | — |
| `openai` (current default) | `OPENAI_API_KEY` | `OPENAI_MODEL`, `OPENAI_BASE_URL` |
| `ollama` | — | `OLLAMA_BASE_URL`, `OLLAMA_MODEL` |
| `codex` | (codex CLI in PATH) | `OPENAI_MODEL` |

**Problems**:
1. The default provider is OpenAI (`buildLLMClient` falls back to `OpenAILLMClient` in the `default:` branch at line 63), but there is no clear error thrown if `OPENAI_API_KEY` is missing — `OpenAILLMClient` constructor silently accepts `undefined` as `apiKey` and only fails at first LLM call.
2. No `--env` or `motiva config set` command to set provider preferences without editing `provider.json` directly.
3. `MOTIVA_LLM_PROVIDER` env var overrides `provider.json`, but this coupling is in `loadProviderConfig()` (not visible in `provider-factory.ts`). Documentation is only in the JSDoc comment.
4. The help text at CLI line 1538 doesn't explain how to configure the LLM provider.

**This is UX friction, not a code bug.** There is no crash or data corruption — just poor discoverability.

**Suggested fix**:
- Add early validation in `buildLLMClient()`: if provider is `openai` and `OPENAI_API_KEY` is not set (and not in `provider.json`), throw a descriptive error immediately with instructions.
- Add a `motiva config set llm_provider <value>` CLI command that writes to `provider.json`.
- Add a `motiva config show` command that prints current provider configuration.
- Update help text to mention provider configuration.

**Confidence**: Confirmed (as UX/DX issue, not a runtime crash)

---

## #9 ゴール交渉のインタラクティブフィードバック不足

**File**: `src/goal-negotiator.ts`, lines 360–614 (`negotiate()`)

**Root cause**: `negotiate()` is a single, non-interactive async function. It:
1. Calls LLM for dimension decomposition (Step 2)
2. Calls LLM for feasibility evaluation per dimension (Step 4)
3. Calls LLM for capability check (Step 4b, silent if it fails)
4. Calls LLM for response generation (Step 5)
5. Returns `{ goal, response, log }`

**What's missing**: There is no mechanism for the user to:
- Review and modify the LLM-generated dimensions before they become the goal's dimensions
- Provide feedback on the feasibility assessment ("actually I know the current state is X")
- Confirm or reject the negotiated dimensions interactively

The CLI caller in `cmdGoalAdd()` displays `response.message` to the user, but by that point the goal has already been **persisted** (`this.stateManager.saveGoal(goal)` at line 610). The user sees the final message but cannot amend the decomposition.

There is no callback, event emitter, or streaming mechanism in `negotiate()`. The `NegotiationLog` records what happened but there's no interactive step.

The `step5_response.user_acknowledged` field (always set to `false` in the log at line 570) was presumably designed for this, but no code ever sets it to `true`.

**Suggested fix**:
- Add an optional `onDimensionsGenerated?: (dims: DimensionDecomposition[]) => Promise<DimensionDecomposition[]>` callback parameter to `negotiate()`. This lets callers (CLI, TUI) present the dimensions to the user for review/edit before feasibility evaluation runs.
- In `cmdGoalAdd()`, implement the callback to print the decomposed dimensions and ask "Do you want to modify any? [y/N]".
- After user confirmation, set `step5_response.user_acknowledged = true` in the log.
- Save the goal only after user acknowledgment (not before).

**Confidence**: Confirmed

---

## Summary Table

| # | Issue | File | Lines | Severity | Type |
|---|-------|------|-------|----------|------|
| #4 | LLM observation has no workspace context | `src/observation-engine.ts` | 492–510 | CRITICAL | Logic gap |
| #3 | DataSource names dominate goal decomposition | `src/goal-negotiator.ts` | 61–66, 413–424, 1207–1223 | HIGH | Prompt + algorithm |
| #5 | `file_existence` type not wired in CLI | `src/cli-runner.ts` | 812–814 | MEDIUM | Missing case |
| #6 | No archive fallback in load methods | `src/state-manager.ts` | 89–93, 218–228, 253–263 | MEDIUM | Missing fallback |
| #7 | `observeCount` truncates dimensions silently | `src/observation-engine.ts` | 319–323 | LOW | Logic ambiguity |
| #8 | Env var management is opaque | `src/provider-factory.ts` | 31–83 | LOW | UX/DX |
| #9 | `negotiate()` has no interactive feedback | `src/goal-negotiator.ts` | 360–614 | LOW | UX/DX |
