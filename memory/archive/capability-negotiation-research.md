# Capability-Aware Goal Negotiation — Research Findings

**Date**: 2026-03-15
**Purpose**: Understand what changes are needed to make GoalNegotiator detect adapter capability limitations during negotiation and rescope goals accordingly.

---

## 1. GoalNegotiator (`src/goal-negotiator.ts`)

### negotiate() flow

6-step flow:
1. Step 0: Ethics gate check
2. Step 1: Goal intake (parse options)
3. Step 2: Dimension decomposition via LLM (`buildDecompositionPrompt`)
4. Step 3: Baseline observation (all null for new goals — no real observation yet)
5. Step 4: Feasibility evaluation (qualitative LLM only, since baselines are null)
6. Step 5: Response generation (accept / counter_propose / flag_as_ambitious)

### Inputs

```ts
negotiate(
  rawGoalDescription: string,
  options?: {
    deadline?: string;
    constraints?: string[];
    timeHorizonDays?: number;
  }
)
```

**No adapter/capability info is passed in.** The constructor also takes no `CapabilityDetector` or `AdapterRegistry`.

### Current constructor dependencies

```ts
constructor(
  stateManager: StateManager,
  llmClient: ILLMClient,
  ethicsGate: EthicsGate,
  observationEngine: ObservationEngine,
  characterConfig?: CharacterConfig,
  satisficingJudge?: SatisficingJudge,
  goalTreeManager?: GoalTreeManager
)
```

No capability or adapter information at all.

### What data sources ARE considered

`observationEngine.getAvailableDimensionInfo()` is called in Step 2 to inject available data source dimension names into the decomposition prompt. This is the closest analog to capability-awareness — it restricts dimension naming to what can be observed. **Confirmed.**

### LLM prompt structure

`buildDecompositionPrompt(description, constraints, availableDataSources?)` injects data source dimension names. `buildFeasibilityPrompt` asks purely about timeline feasibility (current baseline vs target vs time horizon). **Neither prompt mentions adapter capabilities.**

### Conclusion

GoalNegotiator currently knows nothing about what adapters can do. It has a precedent for injecting contextual constraints (data sources), but no adapter capability injection path exists yet.

---

## 2. CapabilityDetector (`src/capability-detector.ts`)

### What it tracks

Capabilities in `~/.motiva/capability_registry.json`. Each entry:
```ts
Capability {
  id: string
  name: string
  description: string
  type: "tool" | "permission" | "service"
  status: CapabilityStatus  // "available" | "unavailable" | "acquiring" | ...
  acquisition_context?: AcquisitionContext
  acquired_at?: string
}
```

### How capabilities are discovered/registered

- `registerCapability(cap, context?)` — manual or post-acquisition registration
- `setCapabilityStatus(name, type, status)` — upsert by name
- Registry is a flat JSON file, not adapter-specific

### Key interface for querying

- `loadRegistry(): Promise<CapabilityRegistry>` — returns all capabilities
- `findCapabilityByName(name): Promise<Capability | null>`
- `detectDeficiency(task: Task): Promise<CapabilityGap | null>` — **LLM-based, takes a Task object** (post-generation)

### Critical gap

`detectDeficiency()` operates on a **Task** (after task generation). It cannot be called during negotiation without a task. There is no method like `getAvailableCapabilitiesForAdapter(adapterType)`.

---

## 3. Adapter Capability Info

### `src/adapter-layer.ts`

`IAdapter` interface:
```ts
interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
}
```

**No capability metadata whatsoever.** Adapters expose only `execute()` and `adapterType`. There is no `getSupportedOperations()`, `getCapabilities()`, or similar. **Confirmed.**

### `src/adapters/github-issue.ts`

`GitHubIssueAdapter` only implements:
- `execute(task)` — calls `gh issue create`
- `parsePrompt(prompt)` — parses issue JSON from prompt
- Internal helpers: `spawnCreate`, `spawnDetect`, `spawnGitRemote`, `buildGhArgs`

**Cannot close issues, comment on issues, list issues, or do anything other than create.** No declaration of this limitation exists anywhere in the code. **Confirmed.**

### `AdapterRegistry`

Only stores a `Map<string, IAdapter>`. No capability querying.

---

## 4. Design Docs

### `docs/design/goal-negotiation.md` — Step 4 "能力チェック" (Capability Check)

**This is the most important finding.** The design doc explicitly describes a capability check as part of feasibility evaluation (§3.1 チェック2):

```
必要な能力 = ゴール達成に必要なアクション・データソースの一覧
利用可能な能力 = Capability Registryの現在の状態

能力ギャップ = 必要な能力 - 利用可能な能力
```

With impact table:
| State | Effect on evaluation |
|-------|---------------------|
| No capability gap | No effect |
| Gap present, acquirable | Record as "prerequisite condition" |
| Gap present, not acquirable | Downgrade feasibility |

**This behavior is designed but not implemented in the current GoalNegotiator.** **Confirmed gap.**

### `docs/design/data-source.md`

No mention of capability-aware negotiation. Purely about observation data sources.

---

## 5. CoreLoop Flow — Where Capability Info Is Used

In `src/core-loop.ts`:

- `capabilityDetector?: CapabilityDetector` is in `CoreLoopDeps` (optional)
- At line 882–885, there is a **comment** saying capability detection is handled inside `TaskLifecycle.runTaskCycle` to avoid orphaned tasks
- No pre-negotiation capability check exists in the loop
- `GoalNegotiator` is **not instantiated or called in CoreLoop at all** — it is called only at CLI entry (`cli-runner.ts`) when a new goal is set up

### Flow for capability check today

```
CoreLoop → TaskLifecycle.runTaskCycle() → [CapabilityDetector.detectDeficiency(task)]
```

Capability check happens **after** task is generated, not before negotiation. **Confirmed.**

---

## 6. What Needs to Change for Capability-Aware Negotiation

### Gap summary

1. **GoalNegotiator constructor** — needs `CapabilityDetector` (optional, for backward compat)
2. **GoalNegotiator.negotiate()** — needs a new capability check step between Step 3 and Step 4 (or as part of Step 4)
3. **CapabilityDetector** — needs a new method that takes a goal description (not a Task), queries the registry, and returns what capabilities are missing for that goal. OR the registry needs adapter-level capability declarations.
4. **IAdapter** — needs a `getSupportedOperations?(): string[]` or `capabilities?` property so the system can know what an adapter can/cannot do
5. **GitHubIssueAdapter** — needs to declare its limitations (can create issues, cannot close/comment/list)
6. **negotiate() prompt** — `buildDecompositionPrompt` and/or `buildFeasibilityPrompt` need to receive adapter capability context

### Design doc alignment

The design doc says capability gaps should be detected in Step 4 and:
- If the gap is **acquirable**: record it as a prerequisite condition on the goal (`feasibility_note`)
- If the gap is **not acquirable**: downgrade feasibility to `infeasible`, which triggers `counter_propose`

This is the target behavior for "rescope the goal to what's actually achievable."

### Minimal implementation path

**Option A (minimal)**: Add `capabilities?: string[]` to `IAdapter`. GitHubIssueAdapter declares `capabilities = ["create_issue"]`. GoalNegotiator receives available adapters and their capabilities, passes them into the feasibility prompt. LLM detects that "close issues" is not in capabilities and proposes rescoping.

**Option B (fuller)**: Add `detectGoalCapabilityGap(goalDescription: string, adapterCapabilities: string[]): Promise<CapabilityGap | null>` to CapabilityDetector. GoalNegotiator calls it in Step 4. This keeps the same pattern as `detectDeficiency(task)` but at goal level.

Option B is more aligned with the existing CapabilityDetector design pattern and the design doc's intent.

---

## Key Files

- `/Users/yuyoshimuta/Documents/dev/Motiva/src/goal-negotiator.ts` — main target
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/capability-detector.ts` — needs new goal-level method
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/adapter-layer.ts` — needs capability metadata on IAdapter
- `/Users/yuyoshimuta/Documents/dev/Motiva/src/adapters/github-issue.ts` — needs to declare its operations
- `/Users/yuyoshimuta/Documents/dev/Motiva/docs/design/goal-negotiation.md` — §3.1 チェック2 is the spec

## Gaps in This Research

- Did not read `src/cli-runner.ts` to confirm where GoalNegotiator is instantiated — but the CoreLoop analysis confirms negotiation happens pre-loop
- Did not check `src/types/capability.ts` for full Capability schema details
- Did not check if any other adapters (claude-code-cli, claude-api, openai-codex) declare capabilities
