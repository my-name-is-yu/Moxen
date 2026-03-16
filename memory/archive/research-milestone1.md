# Milestone 1 Research: LLM-powered Observation

Generated: 2026-03-15

---

## 1. Current ObservationEngine.observe() Flow (Step-by-Step)

**File**: `src/observation-engine.ts`, lines 290–318

```
observe(goalId, methods[]) →
  1. stateManager.loadGoal(goalId)
  2. For each dimension (index i):
     a. method = methods[i] ?? dim.observation_method
     b. createObservationEntry({
          layer: "self_report",          ← HARDCODED — no LLM call here
          rawResult: dim.current_value,  ← re-uses existing stored value
          extractedValue: dim.current_value,
          confidence: dim.confidence,   ← re-uses existing stored confidence
        })
     c. applyObservation(goalId, entry) → updates dim.current_value + persists
```

**Key gap**: `observe()` currently only re-records whatever is already in `dim.current_value` as a `self_report` entry. It never queries DataSources or the LLM. It is a "snapshot recorder", not a "fresh measurement" function.

---

## 2. observeFromDataSource() Flow

**File**: `src/observation-engine.ts`, lines 333–399

```
observeFromDataSource(goalId, dimensionName, sourceId) →
  1. Find IDataSourceAdapter by sourceId in this.dataSources[]
  2. Build DataSourceQuery { dimension_name, timeout_ms: 10000, expression? }
     - expression = source.config.dimension_mapping?.[dimensionName]
  3. result = await source.query(query)
  4. Convert result.value to number/string/boolean/null
  5. Create ObservationLogEntry with:
     - layer: "mechanical"
     - confidence: 0.90
     - method.type: "mechanical", source: "data_source"
  6. applyObservation(goalId, entry)
  7. Return entry
```

This is the correct pattern for the new LLM observation path to mirror.

---

## 3. LAYER_CONFIG / ConfidenceTier Structure

**File**: `src/observation-engine.ts`, lines 18–34

| Layer               | Ceiling | Confidence Range | ConfidenceTier      |
|---------------------|---------|------------------|---------------------|
| `mechanical`        | 1.0     | [0.85, 1.0]      | `"mechanical"`      |
| `independent_review`| 0.90    | [0.50, 0.84]     | `"independent_review"` |
| `self_report`       | 0.70    | [0.10, 0.49]     | `"self_report"`     |

LLM observation must use `layer: "independent_review"` (confidence clamped to 0.50–0.84).

---

## 4. ILLMClient Interface

**File**: `src/llm-client.ts`, lines 29–35

```typescript
export interface ILLMClient {
  sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse>;
  parseJSON<T>(content: string, schema: ZodSchema<T>): T;
}
```

- `LLMMessage`: `{ role: "user" | "assistant"; content: string }`
- `LLMRequestOptions`: `{ model?, max_tokens?, system?, temperature? }`
- `LLMResponse`: `{ content: string; usage: {...}; stop_reason: string }`
- `parseJSON` handles markdown code fences automatically (via `extractJSON`)

---

## 5. ObservationEngine Constructor

**File**: `src/observation-engine.ts`, lines 55–65

```typescript
constructor(
  stateManager: StateManager,
  dataSources: IDataSourceAdapter[] = []
)
```

**Currently does NOT receive `ILLMClient`** — this must be added for C-1.

---

## 6. GoalNegotiator.negotiate() Signature

**File**: `src/goal-negotiator.ts`, lines 360–376

```typescript
async negotiate(
  rawGoalDescription: string,
  options?: {
    deadline?: string;
    constraints?: string[];
    timeHorizonDays?: number;
  }
): Promise<{ goal: Goal; response: NegotiationResponse; log: NegotiationLog }>
```

- Does **not** take `adapterType` as a parameter. AdapterType info flows in via the constructor:
  `adapterCapabilities?: Array<{ adapterType: string; capabilities: string[] }>`
- Constructor is at lines 329–347 — 8 parameters total, `adapterCapabilities` is the 8th.
- `adapterCapabilities` is already wired from `adapterRegistry.getAdapterCapabilities()` in CLIRunner (line 200).
- GoalNegotiator already uses it in Steps 4b (capability check) — no change needed for negotiation.

---

## 7. buildDecompositionPrompt() — Where Dimensions Are Added to Goals

**File**: `src/goal-negotiator.ts`, lines 49–92

The function already:
- Takes `availableDataSources: Array<{ name: string; dimensions: string[] }>` (optional)
- When DataSources are present, instructs LLM to use exact DataSource dimension names
- Returns dimensions with `observation_method_hint` (string, not typed method)

In `decompositionToDimension()` (lines 263–285), the hint string becomes:
```typescript
observation_method: {
  type: "llm_review",
  source: d.observation_method_hint,
  schedule: null,
  endpoint: null,
  confidence_tier: "self_report",   ← all new dimensions start as self_report
}
```

No change needed in GoalNegotiator for Milestone 1. The dimension's `observation_method.type` is just a hint — the actual observation layer is determined by which path `observe()` takes at runtime.

---

## 8. DataSource Dimension Key Format vs Goal Dimension Format

**IDataSourceAdapter** provides dimensions via `getSupportedDimensions(): string[]`
- Returns snake_case strings: e.g. `["open_issue_count", "completion_ratio"]`

**Goal Dimension** uses:
- `dim.name` (snake_case) — must match exactly for `observeFromDataSource()` to work
- `source.config.dimension_mapping?.[dimensionName]` — optional JSONPath expression for extraction

**Matching logic** (GoalNegotiator Step 2 post-processing, lines 413–424):
- If LLM generates a dimension name not in DataSource dimension list, `findBestDimensionMatch()` tries token-overlap matching (30% threshold)
- This is already in place.

**Key fact**: `observeFromDataSource()` finds a DataSource by `sourceId`, not by dimension name. The dimension name is used to build the query and look up `dimension_mapping`. This means to call `observeFromDataSource()`, the caller needs to know which `sourceId` serves a given dimension — there is currently no index from dimension→sourceId.

---

## 9. How observe() Is Called in the CoreLoop

**File**: `src/cli-runner.ts` — observe() is called inside `CoreLoop` (not directly from CLIRunner). CoreLoop calls `observationEngine.observe(goalId, methods)`. The exact call site is in `src/core-loop.ts` (not read here, but confirmed via grepping).

**GoalNegotiator** is built in CLIRunner `buildDeps()` at lines 192–201 and is passed:
- `observationEngine` (which has `dataSources[]` from `~/.motiva/datasources/*.json`)
- `adapterRegistry.getAdapterCapabilities()` as `adapterCapabilities`

---

## 10. Specific Code Insertion Points for C-1, C-2, C-3

### C-1: Add LLM observation to ObservationEngine

**Change 1 — Add llmClient to ObservationEngine constructor**

File: `src/observation-engine.ts`, line 55–65

```typescript
// BEFORE
constructor(stateManager: StateManager, dataSources: IDataSourceAdapter[] = [])

// AFTER
constructor(
  stateManager: StateManager,
  dataSources: IDataSourceAdapter[] = [],
  llmClient?: ILLMClient   // optional so existing code doesn't break
)
```

Need to add import: `import type { ILLMClient } from "./llm-client.js";`

**Change 2 — Add `observeWithLLM()` method**

Insert after `observeFromDataSource()` (around line 399). New method:

```typescript
async observeWithLLM(
  goalId: string,
  dimensionName: string,
  fileContent: string,    // content to evaluate
  goalDescription: string,
  dimensionLabel: string,
  threshold: string
): Promise<ObservationLogEntry>
```

Prompt structure (from roadmap C-1 spec):
```
以下のファイル内容を読み、「{dimensionLabel}」を0.0〜1.0で評価してください。
ゴール: {goalDescription}
閾値（目標値）: {threshold}
ファイル: {fileContent}
回答: {"score": 0.0〜1.0, "reason": "..."}
```

Response Zod schema: `z.object({ score: z.number().min(0).max(1), reason: z.string() })`

Entry should be created with:
- `layer: "independent_review"`
- `confidence: Math.max(0.50, Math.min(0.84, score))` (score drives confidence)
- `method.type: "llm_review"`, `confidence_tier: "independent_review"`

**Change 3 — Modify `observe()` to call DataSource then LLM fallback**

File: `src/observation-engine.ts`, lines 290–318. The `observe()` loop currently always creates `self_report`. New logic per dimension:

```
For each dim:
  1. Try to find a DataSource that serves this dimension
     → call observeFromDataSource() if found
  2. Else if llmClient available:
     → call observeWithLLM() to get independent_review score
  3. Else:
     → fall back to existing self_report path (current behavior)
```

The DataSource lookup needs a helper to find which sourceId serves a dimension:
```typescript
private findDataSourceForDimension(dimensionName: string): string | null {
  for (const ds of this.dataSources) {
    const dims = ds.getSupportedDimensions?.() ?? [];
    if (dims.includes(dimensionName)) return ds.sourceId;
    if (ds.config.dimension_mapping && dimensionName in ds.config.dimension_mapping) {
      return ds.sourceId;
    }
  }
  return null;
}
```

**Change 4 — Update CLIRunner `buildDeps()` to pass llmClient to ObservationEngine**

File: `src/cli-runner.ts`, line 132:
```typescript
// BEFORE
const observationEngine = new ObservationEngine(stateManager, dataSources);
// AFTER
const observationEngine = new ObservationEngine(stateManager, dataSources, llmClient);
```

---

### C-2: Observation Prompt Improvement + Merge Logic

These are refinements within `observe()` and `observeWithLLM()`:

- Per-dimension prompt: already addressed by using `dim.label`, `dim.threshold`, `goal.description`
- Merge logic: already handled by C-1's priority order (DataSource first → LLM fallback → self_report)
- Dimension name mismatch warning: add a `console.warn` when `findDataSourceForDimension()` returns null and llmClient is also undefined

---

### C-3: Test Changes

New test file: `src/__tests__/observation-engine-llm.test.ts`

Test cases needed:
1. `observe()` with MockLLMClient — verify `independent_review` layer used when no DataSource
2. `observe()` with DataSource present — verify DataSource takes priority over LLM
3. `observeWithLLM()` — verify score is clamped to [0.50, 0.84]
4. Integration: ObservationEngine → GapCalculator with LLM-observed values

---

## 11. ObservationResult / ObservationMethod Type Locations

- `ObservationMethod` type: `src/types/core.ts`, lines 71–78
  - `.type`: `"mechanical" | "llm_review" | "api_query" | "file_check" | "manual"`
  - `.confidence_tier`: `"mechanical" | "independent_review" | "self_report"`
- `ObservationLayer` type: `src/types/core.ts`, line 96 — `"mechanical" | "independent_review" | "self_report"`
- `ObservationLogEntry` type: defined via `ObservationLogEntrySchema` in `src/types/state.ts`
- There is NO separate `src/types/observation.ts` — types live in `src/types/core.ts` and `src/types/state.ts`

---

## 12. Files That Need Changes for Milestone 1

| File | Change | Size |
|------|--------|------|
| `src/observation-engine.ts` | Add llmClient param, `findDataSourceForDimension()`, `observeWithLLM()`, modify `observe()` | Medium (~60 lines) |
| `src/cli-runner.ts` | Pass llmClient to ObservationEngine constructor | 1 line |
| `src/__tests__/observation-engine-llm.test.ts` | New test file | Medium (~80 lines) |

GoalNegotiator does NOT need changes for Milestone 1.

---

## 13. Dependency Diagram for LLM Observation

```
CLIRunner.buildDeps()
  ├── buildLLMClient()                    → ILLMClient
  ├── DataSources from ~/.motiva/datasources/
  └── ObservationEngine(stateManager, dataSources, llmClient)  ← needs llmClient added
         ├── observe(goalId, methods)
         │     ├── findDataSourceForDimension(dim.name)
         │     │     ├── DataSource found → observeFromDataSource()  [mechanical, 0.90]
         │     │     └── Not found + llmClient present → observeWithLLM()  [independent_review, 0.50-0.84]
         │     └── Neither → self_report (current behavior)  [self_report, dim.confidence]
         └── observeWithLLM(goalId, dimName, content, ...)
               └── llmClient.sendMessage([prompt]) → parseJSON → score+reason
                     └── createObservationEntry({ layer: "independent_review", ... })
```

---

## 14. Confidence Summary

- `observe()` is currently a "re-record stored value" function, not a fresh measurement — **Confirmed**
- `observeFromDataSource()` is the correct pattern to mirror for LLM observation — **Confirmed**
- `ObservationEngine` does not currently receive `ILLMClient` — **Confirmed** (constructor at line 59)
- LLM observation tier must be `independent_review` (confidence 0.50–0.84) — **Confirmed** (roadmap + layer config)
- GoalNegotiator does NOT need changes for Milestone 1 — **Confirmed** (adapterType already handled via constructor DI)
- `src/types/observation.ts` does NOT exist — types are in `src/types/core.ts` — **Confirmed**
- DataSource→dimension resolution needs a new helper (no existing index) — **Confirmed**
- CLIRunner already passes `llmClient` to most components; adding to ObservationEngine is 1-line — **Confirmed**
