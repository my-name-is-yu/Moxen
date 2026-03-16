# Capability-Aware Goal Negotiation — Gap Fill Research

**Date**: 2026-03-15
**Purpose**: Fill gaps identified in `capability-negotiation-research.md` to complete the implementation picture.

---

## 1. Full Capability/CapabilityGap Schema (`src/types/capability.ts`)

**Confirmed** — Full schemas:

```ts
CapabilitySchema = {
  id: string
  name: string
  description: string
  type: "tool" | "permission" | "service" | "data_source"  // NOTE: data_source is a valid type
  status: "available" | "missing" | "requested" | "acquiring" | "verification_failed"
  provider?: string
  acquired_at?: string
  acquisition_context?: AcquisitionContextSchema
}

CapabilityGapSchema = {
  missing_capability: { name: string, type: "tool"|"permission"|"service"|"data_source" }
  reason: string
  alternatives: string[]
  impact_description: string
  related_task_id?: string  // optional — used to link gap to a task
}

CapabilityRegistrySchema = {
  capabilities: Capability[]
  last_checked: string  // ISO timestamp
}
```

**Key nuance**: `CapabilityGapSchema.missing_capability.type` allows `"data_source"` (matching `CapabilityTypeEnum`), but the `DeficiencyResponseSchema` LLM response schema in `capability-detector.ts` line 37 only accepts `"tool" | "permission" | "service"` — `"data_source"` is absent. This is a latent inconsistency in the existing code (not introduced by the new feature).

---

## 2. GoalNegotiator Instantiation in `src/cli-runner.ts`

**Confirmed** — Line 189–198 in `cli-runner.ts`:

```ts
const goalNegotiator = new GoalNegotiator(
  stateManager,
  llmClient,
  ethicsGate,
  observationEngine,
  characterConfig,
  satisficingJudge,
  goalTreeManager,
  adapterRegistry.getAdapterCapabilities()   // ← 8th argument already passed!
);
```

**Critical finding**: `cli-runner.ts` is ALREADY passing `adapterRegistry.getAdapterCapabilities()` as the 8th argument to `GoalNegotiator`. This means `AdapterRegistry.getAdapterCapabilities()` was already added (line 87–93 in `adapter-layer.ts`). The call site is wired. The gap is solely in `GoalNegotiator`'s constructor and `negotiate()` implementation — it must accept and use this 8th argument.

---

## 3. Adapter Capability Declarations

**Confirmed** — All three adapters already declare `capabilities`:

| Adapter | `adapterType` | `capabilities` |
|---------|---------------|----------------|
| `ClaudeCodeCLIAdapter` | `"claude_code_cli"` | `["execute_code", "read_files", "write_files", "run_commands"]` |
| `ClaudeAPIAdapter` | `"claude_api"` | `["text_generation", "analysis", "planning"]` |
| `OpenAICodexCLIAdapter` | `"openai_codex_cli"` | `["execute_code", "read_files", "write_files", "run_commands"]` |

`GitHubIssueAdapter` — not checked here (previous research confirmed it lacks capabilities). Needs `["create_github_issue"]` added.

**All three mainstream adapters are already done.** Only `GitHubIssueAdapter` is missing.

---

## 4. `IAdapter` Interface and `AdapterRegistry` — Full State

**Confirmed** — `src/adapter-layer.ts` is already partially implemented for this feature:

```ts
export interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
  readonly capabilities?: readonly string[];   // ← already in interface
  listExistingTasks?(): Promise<string[]>;
}

// AdapterRegistry already has:
getAdapterCapabilities(): Array<{ adapterType: string; capabilities: string[] }>
// Returns capabilities array, defaulting to ["general_purpose"] if none declared
```

**Nothing needs to change in `IAdapter` or `AdapterRegistry`.** These are already complete.

---

## 5. `CapabilityDetector` — Full Method Signatures

**Confirmed** — All method signatures:

```ts
class CapabilityDetector {
  constructor(stateManager: StateManager, llmClient: ILLMClient, reportingEngine: ReportingEngine)

  // Existing methods:
  detectDeficiency(task: Task): Promise<CapabilityGap | null>        // task-level, post-generation
  loadRegistry(): Promise<CapabilityRegistry>
  saveRegistry(registry: CapabilityRegistry): Promise<void>
  registerCapability(cap: Capability, context?: AcquisitionContext): Promise<void>
  confirmDeficiency(taskId: string, consecutiveFailures: number): boolean
  planAcquisition(gap: CapabilityGap): CapabilityAcquisitionTask
  verifyAcquiredCapability(cap, acqTask, agentResult): Promise<CapabilityVerificationResult>
  removeCapability(capabilityId: string): Promise<void>
  findCapabilityByName(name: string): Promise<Capability | null>
  getAcquisitionHistory(goalId: string): Promise<AcquisitionContext[]>
  setCapabilityStatus(name, type, status): Promise<void>
  escalateToUser(gap: CapabilityGap, goalId: string): Promise<void>

  // MISSING (needs to be added for goal-level check):
  // detectGoalCapabilityGap(goalDescription: string, adapterCapabilities: Array<{adapterType, capabilities}>) -> Promise<CapabilityGap | null>
}
```

`detectDeficiency` takes a `Task` (post-generation). No goal-level method exists. The new method needs to be added.

**`detectDeficiency` prompt pattern** (lines 78–99): LLM prompt injects available registry capabilities, then asks about a task's `work_description`, `rationale`, and `approach`. New goal-level method should inject both registry capabilities AND adapter capabilities into a similar prompt, taking a goal description string instead of a Task.

---

## 6. Design Doc §3.1 チェック2 — Exact Spec

**Confirmed** — `docs/design/goal-negotiation.md` lines 115–132:

```
必要な能力 = ゴール達成に必要なアクション・データソースの一覧
利用可能な能力 = Capability Registryの現在の状態

能力ギャップ = 必要な能力 - 利用可能な能力
```

Impact table:
| 状態 | 評価への影響 |
|------|------------|
| 能力ギャップ = なし | 評価に影響しない |
| 能力ギャップあり、追加可能 | 「能力追加が前提条件」として記録 |
| 能力ギャップあり、追加不可 | 実現可能性を下方修正 |

The spec says both the Capability Registry AND adapter capabilities feed into "利用可能な能力". The AdapterRegistry's `getAdapterCapabilities()` output is exactly the "adapter capabilities" side of this.

**"追加可能" determination**: The design doc does not define precisely how acquirability is determined. The existing `planAcquisition()` in `CapabilityDetector` handles `tool`/`permission`/`service`/`data_source` types — this is the closest proxy. For the negotiation context, a pragmatic approach: if the gap's `alternatives` array is non-empty OR if the type is `tool`/`service` (creatable), treat as acquirable. If `permission`-type with no alternatives, treat as not acquirable.

---

## 7. Exact Types/Interfaces Needing Modification

### `src/goal-negotiator.ts`
- **Constructor**: Add 8th parameter `adapterCapabilities?: Array<{ adapterType: string; capabilities: string[] }>`. **cli-runner.ts is already passing this argument** (line 197) — so `GoalNegotiator` constructor currently has 7 params but receives 8 from the call site. TypeScript would be erroring or silently ignoring it.
- **`negotiate()` Step 4**: Add capability check before/during feasibility evaluation. Query `CapabilityDetector.detectGoalCapabilityGap()` (new method) or inline LLM logic.
- **`buildFeasibilityPrompt()`**: Add adapter capabilities section to the prompt.

### `src/capability-detector.ts`
- **New method**: `detectGoalCapabilityGap(goalDescription: string, adapterCapabilities: Array<{adapterType: string, capabilities: string[]}>, registryCapabilities: Capability[]): Promise<CapabilityGap | null>`
- Pattern: reuse `detectDeficiency` LLM prompt structure, substituting goal description for task fields, merging registry + adapter capabilities as available capabilities.

### `src/adapters/github-issue.ts`
- Add `readonly capabilities = ["create_github_issue"] as const` to `GitHubIssueAdapter`.

### No changes needed in:
- `src/adapter-layer.ts` — `IAdapter.capabilities?` and `AdapterRegistry.getAdapterCapabilities()` are done
- `src/types/capability.ts` — schema is complete; `CapabilityGap.related_task_id` is optional so goal-level gaps work fine
- `src/cli-runner.ts` — already passes `adapterRegistry.getAdapterCapabilities()` to `GoalNegotiator`

---

## 8. Constructor Signatures That Need Updating

```ts
// BEFORE (current, 7 params):
constructor(
  stateManager: StateManager,
  llmClient: ILLMClient,
  ethicsGate: EthicsGate,
  observationEngine: ObservationEngine,
  characterConfig?: CharacterConfig,
  satisficingJudge?: SatisficingJudge,
  goalTreeManager?: GoalTreeManager
)

// AFTER (8 params, backward-compatible):
constructor(
  stateManager: StateManager,
  llmClient: ILLMClient,
  ethicsGate: EthicsGate,
  observationEngine: ObservationEngine,
  characterConfig?: CharacterConfig,
  satisficingJudge?: SatisficingJudge,
  goalTreeManager?: GoalTreeManager,
  adapterCapabilities?: Array<{ adapterType: string; capabilities: string[] }>
)
```

Adding `adapterCapabilities?` as optional 8th param is backward-compatible — callers that pass fewer args still work. `cli-runner.ts` already passes it.

---

## 9. Test File Locations

| Module | Test File |
|--------|-----------|
| `GoalNegotiator` | `/Users/yuyoshimuta/Documents/dev/Motiva/tests/goal-negotiator.test.ts` |
| `CapabilityDetector` | `/Users/yuyoshimuta/Documents/dev/Motiva/tests/capability-detector.test.ts` |
| `CoreLoop` | `/Users/yuyoshimuta/Documents/dev/Motiva/tests/core-loop.test.ts` |
| `CLIRunner` | `/Users/yuyoshimuta/Documents/dev/Motiva/tests/cli-runner.test.ts` + `tests/cli-runner-integration.test.ts` |
| `TaskLifecycle` | `/Users/yuyoshimuta/Documents/dev/Motiva/tests/task-lifecycle.test.ts` |

No test file exists for `AdapterLayer` directly (adapter capabilities already declared in source, no new logic). `GitHubIssueAdapter` test file not confirmed — worth checking.

---

## 10. Backward Compatibility Assessment

- **`IAdapter.capabilities`**: Already optional in interface (`readonly capabilities?: readonly string[]`). All adapters that don't declare it get `["general_purpose"]` default from `getAdapterCapabilities()`. **No breaking change.**
- **`GoalNegotiator` constructor**: Adding optional 8th param. All existing test instantiations pass ≤7 args and remain valid. **No breaking change.**
- **`CapabilityDetector` new method**: Pure addition. **No breaking change.**
- **`GitHubIssueAdapter` `capabilities` addition**: `IAdapter.capabilities` is `readonly` — implementation just adds a property. **No breaking change.**

---

## 11. Remaining Unknowns

- Whether `GoalNegotiator` currently stores the `adapterCapabilities` arg (the constructor may already accept it but not store/use it — need to read `goal-negotiator.ts` constructor body to confirm the exact current state).
- Whether `tests/goal-negotiator.test.ts` already has stubs/mocks for capability-related scenarios (would affect how much new test code is needed).
- Whether `GitHubIssueAdapter` has its own test file that would need updating.
