# M10 Research: ゴール自動生成 (Goal Auto-Suggestion) Implementation

Date: 2026-03-16

---

## 1. GoalNegotiator Constructor Signature and Dependencies

```ts
constructor(
  stateManager: StateManager,
  llmClient: ILLMClient,
  ethicsGate: EthicsGate,
  observationEngine: ObservationEngine,
  characterConfig?: CharacterConfig,         // optional; defaults to DEFAULT_CHARACTER_CONFIG
  satisficingJudge?: SatisficingJudge,       // optional; Phase 2 auto-mapping proposals
  goalTreeManager?: GoalTreeManager,          // optional
  adapterCapabilities?: Array<{ adapterType: string; capabilities: string[] }> // optional
)
```

**Imports required:**
- `StateManager` from `./state-manager.js`
- `ILLMClient` from `./llm-client.js`
- `EthicsGate` from `./ethics-gate.js`
- `ObservationEngine` from `./observation-engine.js`
- `CharacterConfig`, `DEFAULT_CHARACTER_CONFIG` from `./types/character.js`
- `SatisficingJudge` from `./satisficing-judge.js`
- `GoalTreeManager` from `./goal-tree-manager.js`

**How CLI instantiates it (in `buildDeps()`, `cli-runner.ts` line ~246):**
```ts
const goalNegotiator = new GoalNegotiator(
  stateManager,
  llmClient,
  ethicsGate,
  observationEngine,
  characterConfig,
  satisficingJudge,
  goalTreeManager,
  adapterRegistry.getAdapterCapabilities()
);
```

---

## 2. negotiate() Flow Summary (6 Steps)

**Signature:**
```ts
async negotiate(
  rawGoalDescription: string,
  options?: {
    deadline?: string;
    constraints?: string[];
    timeHorizonDays?: number;  // default: 90
  }
): Promise<{ goal: Goal; response: NegotiationResponse; log: NegotiationLog }>
```

### Step 0: Ethics Gate
- Calls `this.ethicsGate.check("goal", goalId, rawGoalDescription)`
- If verdict is `"reject"` → throws `EthicsRejectedError`
- If verdict is `"flag"` → collects `ethicsFlags` (risks array)

### Step 1: Goal Intake
- Parses `options` (deadline, constraints, timeHorizonDays)
- Initializes `NegotiationLog`

### Step 2: Dimension Decomposition (LLM)
- Calls `this.observationEngine.getAvailableDimensionInfo()` to get DataSource info
- Calls `buildDecompositionPrompt(description, constraints, availableDataSources)`
- LLM call with `temperature: 0`
- Parses response as `z.array(DimensionDecompositionSchema)`
- Post-processes: maps dimension names to DataSource dimensions if similar names found
- Runs `deduplicateDimensionKeys()` to ensure unique `name` fields
- Logs to `log.step2_decomposition`

### Step 3: Baseline Observation
- For each dimension, records `null` baseline (no observation setup at goal creation time)
- All baselines have `confidence: 0`, `method: "initial_baseline"`
- Logs to `log.step3_baseline`

### Step 4: Feasibility Evaluation (Hybrid)
- For each dimension: evaluates quantitatively (when both baseline and threshold are numbers) or qualitatively (LLM)
- Currently: all new goals use qualitative path (baselines are null)
- Calls `buildFeasibilityPrompt(dim.name, description, baseline, threshold, timeHorizonDays)`
- LLM returns `{ assessment: "realistic" | "ambitious" | "infeasible", confidence, reasoning, key_assumptions, main_risks }`
- Logs to `log.step4_evaluation`

### Step 4b: Capability Check (optional)
- Only runs if `this.adapterCapabilities` is provided and non-empty
- Calls `buildCapabilityCheckPrompt(goalDescription, dimensions, adapterCapabilities)`
- LLM returns `{ gaps: [{ dimension, required_capability, acquirable, reason }] }`
- For non-acquirable gaps: sets dimension feasibility to `"infeasible"`
- Non-critical: failure does not block negotiation (only logs warning)

### Step 5: Response Generation
- Calls `this.determineResponseType(feasibilityResults, baselineObservations, timeHorizonDays)`
  - Returns `{ responseType: "accept" | "counter_propose" | "flag_as_ambitious", counterProposal?, initialConfidence }`
  - Logic: based on feasibility ratios and caution_level from characterConfig
- Calls `buildResponsePrompt(description, responseType, feasibilityResults, counterProposal)`
- LLM generates a user-facing message (1-3 sentences, no JSON)

### Step 6 (implicit): Goal Persistence
- Builds `Goal` object from `GoalSchema.parse({ ... })`
- Calls `this.stateManager.saveGoal(goal)` and `this.saveNegotiationLog(goalId, log)`
- Returns `{ goal, response, log }`

---

## 3. Goal Type Structure

**File:** `src/types/goal.ts`

### GoalSchema fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | UUID |
| `parent_id` | `string \| null` | null for root goals |
| `node_type` | `"goal" \| "subgoal" \| "milestone" \| "leaf"` | default: `"goal"` |
| `title` | `string` | |
| `description` | `string` | default: `""` |
| `status` | `"active" \| "completed" \| "cancelled" \| "waiting" \| "archived"` | default: `"active"` |
| `dimensions` | `Dimension[]` | see below |
| `gap_aggregation` | `"max" \| "weighted_avg" \| "sum"` | default: `"max"` (bottleneck) |
| `dimension_mapping` | `DimensionMapping \| null` | subgoal→parent propagation |
| `constraints` | `string[]` | default: `[]` |
| `children_ids` | `string[]` | default: `[]` |
| `target_date` | `string \| null` | |
| `origin` | `"negotiation" \| "decomposition" \| "manual" \| "curiosity" \| null` | |
| `pace_snapshot` | `PaceSnapshot \| null` | |
| `deadline` | `string \| null` | ISO date |
| `confidence_flag` | `"high" \| "medium" \| "low" \| null` | |
| `user_override` | `boolean` | default: `false` |
| `feasibility_note` | `string \| null` | |
| `uncertainty_weight` | `number` | default: `1.0` |
| `decomposition_depth` | `number` | default: `0` |
| `specificity_score` | `number (0-1) \| null` | |
| `loop_status` | `"idle" \| "running" \| "paused"` | default: `"idle"` |
| `created_at` | `string` | ISO timestamp |
| `updated_at` | `string` | ISO timestamp |

### DimensionSchema fields

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | snake_case identifier |
| `label` | `string` | human-readable |
| `current_value` | `number \| string \| boolean \| null` | |
| `threshold` | `Threshold` | see below |
| `confidence` | `number (0-1)` | |
| `observation_method` | `ObservationMethod` | how to measure |
| `last_updated` | `string \| null` | |
| `history` | `HistoryEntry[]` | |
| `weight` | `number` | default: `1.0` |
| `uncertainty_weight` | `number \| null` | per-dimension override |
| `state_integrity` | `"ok" \| "uncertain"` | default: `"ok"` |
| `dimension_mapping` | `{ parent_dimension: string; aggregation: SatisficingAggregation } \| null` | |

### ThresholdSchema (discriminated union)

| Type | Fields | Meaning |
|------|--------|---------|
| `"min"` | `{ type: "min", value: number }` | must be >= value |
| `"max"` | `{ type: "max", value: number }` | must be <= value |
| `"range"` | `{ type: "range", low: number, high: number }` | must be in [low, high] |
| `"present"` | `{ type: "present" }` | must exist (boolean presence check) |
| `"match"` | `{ type: "match", value: string \| number \| boolean }` | must equal value |

---

## 4. CLI Command Dispatch Pattern

The CLI dispatch is in `run(argv: string[])` method. The pattern is:

```ts
// Top-level dispatch on argv[0]
const subcommand = argv[0];

if (subcommand === "goal") {
  const goalSubcommand = argv[1];

  if (goalSubcommand === "add") {
    // parse args from argv.slice(3)
    // using parseArgs() from "node:util"
    return await this.cmdGoalAdd(description, { deadline, constraints, yes });
  }

  if (goalSubcommand === "list") { ... }
  if (goalSubcommand === "archive") { ... }
  // etc.
}

if (subcommand === "run") { ... }
if (subcommand === "status") { ... }
// etc.
```

**To add a new `goal suggest` subcommand:**
1. Add a new `if (goalSubcommand === "suggest")` block inside the `if (subcommand === "goal")` block
2. Parse args with `parseArgs({ args: argv.slice(2), options: { ... } })`
3. Delegate to a new private method `this.cmdGoalSuggest(...)`
4. Implement `private async cmdGoalSuggest(...)` that builds deps via `this.buildDeps(apiKey)` and calls `goalNegotiator.suggestGoals(...)`
5. Update the error message in the `if (!goalSubcommand)` branch to include `"goal suggest"`
6. Update the help text in `printHelp()` (around line 1860)

**Dependency injection pattern:**
- All LLM-dependent commands call `this.buildDeps(apiKey)` which returns `{ coreLoop, goalNegotiator, reportingEngine, stateManager, driveSystem }`
- `goalNegotiator` is always fully wired (with `adapterRegistry.getAdapterCapabilities()`)

---

## 5. CapabilityDetector.detectGoalCapabilityGap() Signature and Behavior

**File:** `src/capability-detector.ts`

```ts
async detectGoalCapabilityGap(
  goalDescription: string,
  adapterCapabilities: string[]
): Promise<{ gap: CapabilityGap; acquirable: boolean } | null>
```

**Behavior:**
1. Loads the capability registry from `~/.motiva/capability_registry.json`
2. Combines registry capabilities (status=`"available"`) + adapter-declared capabilities into one list
3. Sends LLM prompt asking whether the goal can be achieved with available capabilities
4. LLM returns `{ has_gap: false }` or `{ has_gap: true, missing_capability: { name, type }, reason, alternatives, impact_description, acquirable }`
5. Returns `null` if no gap or if parsing fails (errors are swallowed)
6. Returns `{ gap: CapabilityGap, acquirable: boolean }` if a gap is detected

**CapabilityGap type:**
```ts
{
  missing_capability: { name: string; type: "tool" | "permission" | "service" | "data_source" };
  reason: string;
  alternatives: string[];
  impact_description: string;
  related_task_id?: string;  // omitted for goal-level checks
}
```

**Note:** This is distinct from the capability check inside `negotiate()` (Step 4b), which operates per-dimension. `detectGoalCapabilityGap()` operates at the whole-goal level.

---

## 6. LLM Prompt Templates Used in negotiate()

### Decomposition Prompt (`buildDecompositionPrompt`)

Key instructions to LLM:
- Decompose goal into measurable dimensions
- Each dimension: `{ name, label, threshold_type, threshold_value, observation_method_hint }`
- If DataSources available, must use their exact dimension names when they match
- Quality rules enforced: no "present"-only goals; add quality-scoring dimensions with "min" type (0.0-1.0)
- Returns: JSON array only

### Feasibility Prompt (`buildFeasibilityPrompt`)

Inputs: `dimension`, `description`, `baselineValue`, `thresholdValue`, `timeHorizonDays`

Returns:
```json
{
  "assessment": "realistic" | "ambitious" | "infeasible",
  "confidence": "high" | "medium" | "low",
  "reasoning": "...",
  "key_assumptions": [...],
  "main_risks": [...]
}
```

### Response Message Prompt (`buildResponsePrompt`)

Inputs: `description`, `responseType`, `feasibilityResults`, `counterProposal?`

Returns: plain text user-facing message (1-3 sentences, NO JSON).

### Capability Check Prompt (`buildCapabilityCheckPrompt`)

Inputs: `goalDescription`, `dimensions`, `adapterCapabilities`

Returns:
```json
{
  "gaps": [
    {
      "dimension": "...",
      "required_capability": "...",
      "acquirable": false,
      "reason": "..."
    }
  ]
}
```

---

## 7. Key Considerations for Adding suggestGoals() Method

### What suggestGoals() should do
Given a context (e.g., project description, current state, existing goals), suggest a list of candidate goal descriptions that the user could then pass to `negotiate()`.

### Method signature proposal
```ts
async suggestGoals(
  context: string,
  options?: {
    maxSuggestions?: number;   // default: 5
    existingGoals?: string[];  // titles of already-registered goals (to avoid duplicates)
    domain?: string;           // optional domain hint (e.g., "software quality", "performance")
  }
): Promise<Array<{ title: string; description: string; rationale: string }>>
```

### Dependencies needed
- `this.llmClient` — for LLM call (same as negotiate)
- `this.ethicsGate` — optionally pre-screen suggestions (soft filter, not throw)
- `this.stateManager` — to load existing goals for deduplication

### LLM prompt design considerations
1. System prompt: "You are a goal advisor. Given a project context, suggest concrete, measurable goals."
2. User message: include context, existing goals list, domain hint
3. Return format: JSON array of `{ title, description, rationale }` objects
4. Each `description` should be phrased to work well as input to `negotiate()` (self-contained, specific)

### Ethics filtering
- Either: call `ethicsGate.check()` for each suggestion and filter out rejects before returning
- Or: add a `flags` field to the suggestion output and return flagged ones with a warning
- Recommendation: filter rejects silently, include `flagged: boolean` for "flag" verdicts

### CLI command design
```
motiva goal suggest "<context>"
  --max <n>          Max suggestions (default: 5)
  --domain <text>    Domain hint
```
Output: numbered list of suggestions, each with title + rationale + command hint:
```
1. Increase test coverage to 90%
   Rationale: Current codebase has low test coverage, increasing it reduces regression risk.
   → motiva goal add "Increase test coverage to 90%"
```

### Integration with negotiate()
`suggestGoals()` is NOT a replacement for `negotiate()`. It is a discovery layer:
```
suggestGoals() → user picks a suggestion → negotiate() → goal registered
```
The CLI flow should make this pipeline obvious.

### ILLMClient interface methods used (same as negotiate)
- `llmClient.sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>`
- `llmClient.parseJSON(content: string, schema: ZodSchema): T`

### Existing pattern to follow
The `decompose()` method in `GoalNegotiator` is the closest analog — it:
1. Builds a prompt
2. Calls `this.llmClient.sendMessage(...)` with `temperature: 0`
3. Parses with `this.llmClient.parseJSON(response.content, schema)`
4. Runs ethics check per item
5. Returns filtered results

`suggestGoals()` should follow the same pattern.

### Zod schema for LLM response
```ts
const GoalSuggestionSchema = z.object({
  title: z.string(),
  description: z.string(),
  rationale: z.string(),
});
const GoalSuggestionListSchema = z.array(GoalSuggestionSchema);
```

### Important: origin field
If suggestions are later passed to `negotiate()`, the resulting goal will have `origin: "negotiation"`.
Consider adding `origin: "suggestion"` (or reusing `"curiosity"`) to distinguish auto-suggested goals.
However, adding a new origin value requires updating `GoalSchema.origin` enum — check if that is in scope for M10.

### Where to add in goal-negotiator.ts
Add `suggestGoals()` as a public method after `decompose()` in the `GoalNegotiator` class. No new class needed.

### Test pattern (based on goal-negotiator.test.ts)
- Use `createMockLLMClient()` helper from `tests/helpers/mock-llm.js`
- Mock responses: queue up the suggestions JSON response and optionally ethics verdicts
- Test: normal path (n suggestions), ethics filter path (one rejected), empty context path
- EthicsRejectedError is NOT thrown from suggestGoals — rejections are filtered, not thrown

---

## Summary

- `GoalNegotiator` is the right class to add `suggestGoals()` to
- All dependencies are already available in the constructor
- The 6-step `negotiate()` flow is the reference; `suggestGoals()` is simpler (1 LLM call + optional ethics filter)
- CLI addition: new `goalSubcommand === "suggest"` branch inside `if (subcommand === "goal")` + new `cmdGoalSuggest()` private method
- Key Zod schemas: `GoalSuggestionListSchema` (new) + existing `DimensionDecompositionSchema` pattern
- No new dependencies needed; `CapabilityDetector.detectGoalCapabilityGap()` can optionally be called to annotate suggestions with feasibility warnings
