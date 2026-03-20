# Guardrail Callback Blueprint

**Date**: 2026-03-20
**Feature**: 4-point guardrail hook system extending EthicsGate
**Source**: §2.5 of `memory/agentic-ai-unified-report.md` (Google ADK / OpenAI SDK pattern)

---

## 1. Current State Analysis

### EthicsGate Today

**File**: `src/traits/ethics-gate.ts` (~680 lines)

EthicsGate has two public methods:
- `check(subjectType, subjectId, description, context?)` — evaluates goals/subgoals/tasks; 2-layer (blocklist → LLM)
- `checkMeans(taskId, taskDescription, means)` — evaluates execution approach before task runs

**Where EthicsGate is called** (13 files):

| Call site | Method | Hook point it maps to |
|-----------|--------|----------------------|
| `src/goal/goal-negotiator.ts` L107 | `check("goal", ...)` | goal-level, not a task hook |
| `src/goal/goal-negotiator.ts` L252 | `check("goal", ...)` | goal-level |
| `src/goal/goal-decomposer.ts` L104 | `check("subgoal", ...)` | goal-level |
| `src/goal/goal-suggest.ts` L165 | `check("task", ...)` | goal-level |
| `src/execution/task-approval.ts` L34 | `checkMeans(...)` | **before_tool** (existing) |
| `src/traits/curiosity-engine.ts` L394 | via `goal-decomposer` | goal-level |
| `src/knowledge/knowledge-transfer.ts` L311, L671 | `check("task", ...)` | knowledge-level |

**Core execution flow** in `runTaskCycle` (task-lifecycle.ts L330–436):
1. selectTargetDimension
2. detectCandidatesRealtime (knowledge enrichment)
3. **generateTask** ← LLM call; no hook here currently
4. runPreExecutionChecks → `checkMeans` ← **before_tool** exists here
5. executeTask → adapter.execute ← no hook here
6. verifyTask ← LLM call; no hook here currently
7. handleVerdict

**Gap**: The 4 ADK hook points (before_model, after_model, before_tool, after_tool) have NO dedicated callback interface. `checkMeans` does before_tool validation but it is baked into EthicsGate, not a pluggable callback.

### LLM call flow

`ILLMClient.sendMessage(messages, options)` in `src/llm/llm-client.ts` — single method, no hooks.
Callers that are relevant to guardrails:
- `src/execution/task-generation.ts` — generates Task from LLM
- `src/execution/task-verifier.ts` — LLM-based L2/L3 verification
- `src/traits/ethics-gate.ts` — ethics evaluation (meta: hook inside the evaluator itself)

---

## 2. Design Decisions

### Approach: Decorator/Wrapper on ILLMClient + Callback injection into EthicsGate

Two independent mechanisms:
1. **GuardrailHookRegistry** — a callback registry injected wherever hooks run
2. **GuardedLLMClient** — wraps any `ILLMClient`; fires `before_model`/`after_model` hooks around every `sendMessage` call

This keeps EthicsGate unchanged as the policy enforcer. Hooks are **observers** (they can block/modify but do not replace the gate).

### Hook semantics

| Hook | Can block? | Can mutate? |
|------|-----------|-------------|
| `before_model` | Yes (throw → abort LLM call) | Yes (can modify messages/options) |
| `after_model` | Yes (throw → treat as error) | Yes (can modify response) |
| `before_tool` | Yes (return `{ block: true }`) | No |
| `after_tool` | Yes (return `{ block: true }`) | No |

Blocking in `before_model`/`after_model` throws a typed error `GuardrailBlockedError`.
Blocking in `before_tool`/`after_tool` returns a `TaskCycleResult` (same pattern as existing `runPreExecutionChecks`).

---

## 3. New Types — `src/types/guardrail.ts` (NEW FILE, ~80 lines)

```typescript
import { z } from "zod";
import type { LLMMessage, LLMRequestOptions, LLMResponse } from "../llm/llm-client.js";
import type { Task } from "./task.js";
import type { AgentResult } from "../execution/adapter-layer.js";

// ─── GuardrailHookPoint ───

export type GuardrailHookPoint = "before_model" | "after_model" | "before_tool" | "after_tool";

// ─── GuardrailContext ───
// Passed to every hook callback so hooks can make informed decisions

export interface GuardrailContext {
  goal_id?: string;
  task_id?: string;
  adapter_type?: string;
  hook_point: GuardrailHookPoint;
}

// ─── Hook callback signatures ───

export type BeforeModelHook = (
  messages: LLMMessage[],
  options: LLMRequestOptions | undefined,
  ctx: GuardrailContext
) => Promise<{ messages: LLMMessage[]; options?: LLMRequestOptions } | void>;

export type AfterModelHook = (
  response: LLMResponse,
  ctx: GuardrailContext
) => Promise<LLMResponse | void>;

export type BeforeToolHook = (
  task: Task,
  ctx: GuardrailContext
) => Promise<{ block: true; reason: string } | void>;

export type AfterToolHook = (
  task: Task,
  result: AgentResult,
  ctx: GuardrailContext
) => Promise<{ block: true; reason: string } | void>;

// ─── GuardrailHook (discriminated union) ───

export type GuardrailHook =
  | { point: "before_model"; fn: BeforeModelHook }
  | { point: "after_model"; fn: AfterModelHook }
  | { point: "before_tool"; fn: BeforeToolHook }
  | { point: "after_tool"; fn: AfterToolHook };

// ─── GuardrailBlockedError ───

export class GuardrailBlockedError extends Error {
  constructor(
    public readonly hookPoint: GuardrailHookPoint,
    public readonly reason: string
  ) {
    super(`Guardrail blocked at ${hookPoint}: ${reason}`);
    this.name = "GuardrailBlockedError";
  }
}

// ─── Zod schema for serialization (logs) ───

export const GuardrailEventSchema = z.object({
  event_id: z.string(),
  timestamp: z.string(),
  hook_point: z.enum(["before_model", "after_model", "before_tool", "after_tool"]),
  goal_id: z.string().optional(),
  task_id: z.string().optional(),
  adapter_type: z.string().optional(),
  blocked: z.boolean(),
  reason: z.string().optional(),
});
export type GuardrailEvent = z.infer<typeof GuardrailEventSchema>;
```

---

## 4. New File — `src/traits/guardrail-registry.ts` (NEW FILE, ~100 lines)

Stores registered hooks; fires them in registration order.

```typescript
import { randomUUID } from "node:crypto";
import type {
  GuardrailHook, GuardrailContext, BeforeModelHook, AfterModelHook,
  BeforeToolHook, AfterToolHook, GuardrailEvent,
} from "../types/guardrail.js";
import { GuardrailBlockedError } from "../types/guardrail.js";
import type { LLMMessage, LLMRequestOptions, LLMResponse } from "../llm/llm-client.js";
import type { Task } from "../types/task.js";
import type { AgentResult } from "../execution/adapter-layer.js";
import type { StateManager } from "../state-manager.js";

const GUARDRAIL_LOG_PATH = "ethics/guardrail-events.json";

export class GuardrailRegistry {
  private readonly hooks: GuardrailHook[] = [];
  private readonly stateManager?: StateManager;

  constructor(stateManager?: StateManager) {
    this.stateManager = stateManager;
  }

  register(hook: GuardrailHook): void {
    this.hooks.push(hook);
  }

  // ─── before_model ───
  async runBeforeModel(
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    ctx: Omit<GuardrailContext, "hook_point">
  ): Promise<{ messages: LLMMessage[]; options?: LLMRequestOptions }> {
    const fullCtx: GuardrailContext = { ...ctx, hook_point: "before_model" };
    let current = { messages, options };
    for (const hook of this.hooks) {
      if (hook.point !== "before_model") continue;
      const result = await hook.fn(current.messages, current.options, fullCtx);
      if (result) current = { messages: result.messages, options: result.options ?? current.options };
    }
    return current;
  }

  // ─── after_model ───
  async runAfterModel(
    response: LLMResponse,
    ctx: Omit<GuardrailContext, "hook_point">
  ): Promise<LLMResponse> {
    const fullCtx: GuardrailContext = { ...ctx, hook_point: "after_model" };
    let current = response;
    for (const hook of this.hooks) {
      if (hook.point !== "after_model") continue;
      const result = await hook.fn(current, fullCtx);
      if (result) current = result;
    }
    return current;
  }

  // ─── before_tool ───
  // Returns null if all passed; returns reason string if blocked.
  async runBeforeTool(
    task: Task,
    ctx: Omit<GuardrailContext, "hook_point">
  ): Promise<string | null> {
    const fullCtx: GuardrailContext = { ...ctx, hook_point: "before_tool" };
    for (const hook of this.hooks) {
      if (hook.point !== "before_tool") continue;
      const result = await hook.fn(task, fullCtx);
      if (result?.block) {
        await this.logEvent({ hook_point: "before_tool", blocked: true, reason: result.reason, ...ctx });
        return result.reason;
      }
    }
    return null;
  }

  // ─── after_tool ───
  async runAfterTool(
    task: Task,
    agentResult: AgentResult,
    ctx: Omit<GuardrailContext, "hook_point">
  ): Promise<string | null> {
    const fullCtx: GuardrailContext = { ...ctx, hook_point: "after_tool" };
    for (const hook of this.hooks) {
      if (hook.point !== "after_tool") continue;
      const result = await hook.fn(task, agentResult, fullCtx);
      if (result?.block) {
        await this.logEvent({ hook_point: "after_tool", blocked: true, reason: result.reason, ...ctx });
        return result.reason;
      }
    }
    return null;
  }

  private async logEvent(partial: Omit<GuardrailEvent, "event_id" | "timestamp">): Promise<void> {
    if (!this.stateManager) return;
    try {
      const entry: GuardrailEvent = {
        event_id: randomUUID(),
        timestamp: new Date().toISOString(),
        ...partial,
      };
      const raw = await this.stateManager.readRaw(GUARDRAIL_LOG_PATH);
      const logs: GuardrailEvent[] = Array.isArray(raw) ? raw as GuardrailEvent[] : [];
      logs.push(entry);
      await this.stateManager.writeRaw(GUARDRAIL_LOG_PATH, logs);
    } catch { /* non-fatal */ }
  }
}
```

---

## 5. New File — `src/llm/guarded-llm-client.ts` (NEW FILE, ~60 lines)

Wraps any `ILLMClient`. Fires `before_model`/`after_model` hooks. Used as a drop-in replacement for the inner client wherever GuardrailRegistry is configured.

```typescript
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "./llm-client.js";
import type { ZodSchema } from "zod";
import { extractJSON } from "./llm-client.js";
import type { GuardrailRegistry } from "../traits/guardrail-registry.js";

export class GuardedLLMClient implements ILLMClient {
  constructor(
    private readonly inner: ILLMClient,
    private readonly registry: GuardrailRegistry,
    private readonly ctx: { goal_id?: string; task_id?: string; adapter_type?: string } = {}
  ) {}

  async sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    // before_model: hooks may mutate messages/options or throw GuardrailBlockedError
    const { messages: mutatedMessages, options: mutatedOptions } =
      await this.registry.runBeforeModel(messages, options, this.ctx);

    const response = await this.inner.sendMessage(mutatedMessages, mutatedOptions);

    // after_model: hooks may mutate response or throw GuardrailBlockedError
    const finalResponse = await this.registry.runAfterModel(response, this.ctx);

    return finalResponse;
  }

  parseJSON<T>(content: string, schema: ZodSchema<T>): T {
    return this.inner.parseJSON(content, schema);
  }

  /** Return a new GuardedLLMClient bound to a specific task context */
  withContext(ctx: { goal_id?: string; task_id?: string; adapter_type?: string }): GuardedLLMClient {
    return new GuardedLLMClient(this.inner, this.registry, { ...this.ctx, ...ctx });
  }
}
```

---

## 6. Modified Files

### 6.1 `src/execution/task-approval.ts` — add before_tool hook

**Current**: `runPreExecutionChecks` calls `runEthicsCheck` then `runCapabilityCheck` then `runIrreversibleApprovalCheck`.

**Change**: Add `runGuardrailBeforeToolCheck` step after existing ethics check. Insert ~25 lines.

**Location**: After line 192 (after `if (deps.ethicsGate)` block ends), before `if (deps.capabilityDetector)`.

New import to add at top:
```typescript
import type { GuardrailRegistry } from "../traits/guardrail-registry.js";
import { VerificationResultSchema } from "../types/task.js";
```

Add to `PreExecutionCheckDeps` interface (line 10):
```typescript
guardrailRegistry?: GuardrailRegistry;
```

New helper function to add after `runEthicsCheck` (~line 82):
```typescript
export async function runGuardrailBeforeToolCheck(
  guardrailRegistry: GuardrailRegistry,
  task: Task,
  ctx: { goal_id?: string; adapter_type?: string }
): Promise<TaskCycleResult | null> {
  const blockedReason = await guardrailRegistry.runBeforeTool(task, {
    goal_id: ctx.goal_id,
    task_id: task.id,
    adapter_type: ctx.adapter_type,
  });

  if (blockedReason === null) return null;

  const blockedResult = VerificationResultSchema.parse({
    task_id: task.id,
    verdict: "fail",
    confidence: 1.0,
    evidence: [
      {
        layer: "mechanical",
        description: `Guardrail before_tool blocked: ${blockedReason}`,
        confidence: 1.0,
      },
    ],
    dimension_updates: [],
    timestamp: new Date().toISOString(),
  });
  return { task, verificationResult: blockedResult, action: "discard" };
}
```

In `runPreExecutionChecks`, add after the ethics gate block:
```typescript
  // 3b. Guardrail before_tool hooks
  if (deps.guardrailRegistry) {
    const guardrailResult = await runGuardrailBeforeToolCheck(
      deps.guardrailRegistry,
      task,
      { goal_id: task.goal_id, adapter_type: undefined }
    );
    if (guardrailResult !== null) return guardrailResult;
  }
```

### 6.2 `src/execution/task-executor.ts` — add after_tool hook

**Current**: `executeTask` returns `AgentResult` with no post-execution hook.

**Change**: Accept optional `guardrailRegistry` in `TaskExecutorDeps` and fire `after_tool` hook after adapter completes successfully. Insert ~25 lines.

Add to `TaskExecutorDeps` interface (line 12):
```typescript
  guardrailRegistry?: GuardrailRegistry;
```

Add import at top:
```typescript
import type { GuardrailRegistry } from "../traits/guardrail-registry.js";
```

After the existing scope check block (after line ~182), add:
```typescript
  // after_tool guardrail hook
  if (deps.guardrailRegistry && result.success) {
    const blockedReason = await deps.guardrailRegistry.runAfterTool(task, result, {
      goal_id: task.goal_id,
      task_id: task.id,
      adapter_type: adapter.adapterType,
    });
    if (blockedReason !== null) {
      result.success = false;
      result.output = (result.output || "") + `\n[Guardrail after_tool blocked]: ${blockedReason}`;
      result.stopped_reason = "error";
    }
  }
```

### 6.3 `src/execution/task-lifecycle.ts` — wire guardrailRegistry

**Current**: `options` bag (line 93) has no `guardrailRegistry`.

**Changes**:

1. Add import at top:
```typescript
import type { GuardrailRegistry } from "../traits/guardrail-registry.js";
```

2. Add to private fields (after line 83):
```typescript
  private readonly guardrailRegistry?: GuardrailRegistry;
```

3. Add to options interface (after line 107):
```typescript
      guardrailRegistry?: GuardrailRegistry;
```

4. Add assignment in constructor (after line 124):
```typescript
    this.guardrailRegistry = options?.guardrailRegistry;
```

5. In `runTaskCycle` (line 373), add `guardrailRegistry` to `runPreExecutionChecks` deps:
```typescript
    const preCheckResult = await runPreExecutionChecks(
      {
        ethicsGate: this.ethicsGate,
        capabilityDetector: this.capabilityDetector,
        approvalFn: this.approvalFn,
        checkIrreversibleApproval: (t) => this.checkIrreversibleApproval(t),
        guardrailRegistry: this.guardrailRegistry,  // NEW
      },
      task
    );
```

6. In `executeTask` delegation (line 269), pass `guardrailRegistry`:
```typescript
    return _executeTask(
      {
        stateManager: this.stateManager,
        sessionManager: this.sessionManager,
        logger: this.logger,
        execFileSyncFn: this.execFileSyncFn,
        guardrailRegistry: this.guardrailRegistry,  // NEW
      },
      task,
      adapter,
      workspaceContext
    );
```

### 6.4 `src/execution/task-pipeline-cycle.ts` — wire guardrailRegistry

Add `guardrailRegistry?: GuardrailRegistry` to `PipelineCycleDeps` interface (line 20). Pass through to `runPreExecutionChecks` call at line 106. Same pattern as task-lifecycle.ts above.

### 6.5 `src/cli/setup.ts` — optional wiring

No mandatory change. Add optional support for passing `guardrailRegistry` when constructing `TaskLifecycle`. Example:

After line 107 (`const ethicsGate = new EthicsGate(...)`):
```typescript
  // Optional: const guardrailRegistry = new GuardrailRegistry(stateManager);
  // Register hooks: guardrailRegistry.register({ point: "before_tool", fn: myHook });
```

Pass to `TaskLifecycle` options at line ~193 if configured.

### 6.6 `src/types/ethics.ts` — no change required

Existing `EthicsVerdict`/`EthicsLog` types remain unchanged. Guardrail types live in the new `src/types/guardrail.ts`.

---

## 7. before_model / after_model Hook Wiring via GuardedLLMClient

The `GuardedLLMClient` handles before_model and after_model automatically whenever it is used instead of the raw `ILLMClient`. The caller must:

1. Create `GuardrailRegistry` with `stateManager`
2. Register hooks
3. Wrap the inner LLM client: `new GuardedLLMClient(innerClient, registry)`
4. Pass the wrapped client wherever `ILLMClient` is accepted

**In `src/cli/setup.ts`** (line ~107), replace:
```typescript
const ethicsGate = new EthicsGate(stateManager, llmClient);
```
with:
```typescript
const guardrailRegistry = new GuardrailRegistry(stateManager);
// register built-in ethics hook as before_tool (already handled by EthicsGate — optional double-check):
// guardrailRegistry.register({ point: "before_tool", fn: myCustomHook });
const guardedLLMClient = new GuardedLLMClient(llmClient, guardrailRegistry);
const ethicsGate = new EthicsGate(stateManager, guardedLLMClient);
```

This means ALL LLM calls (goal negotiation, task generation, LLM verification) pass through the hooks.

**Context binding for task-specific hooks**: In `task-executor.ts`, when constructing a per-task guarded client, use `guardedLLMClient.withContext({ goal_id, task_id, adapter_type })` to attach context so hook callbacks know which task they are running for.

---

## 8. File Summary

| File | Action | Est. Lines |
|------|--------|-----------|
| `src/types/guardrail.ts` | NEW | ~80 |
| `src/traits/guardrail-registry.ts` | NEW | ~100 |
| `src/llm/guarded-llm-client.ts` | NEW | ~60 |
| `src/execution/task-approval.ts` | MODIFY | +40 |
| `src/execution/task-executor.ts` | MODIFY | +30 |
| `src/execution/task-lifecycle.ts` | MODIFY | +15 |
| `src/execution/task-pipeline-cycle.ts` | MODIFY | +10 |
| `src/cli/setup.ts` | MODIFY (optional) | +10 |

Total new code: ~345 lines. No existing file exceeds 500 lines after changes (task-approval.ts will be ~250 lines).

---

## 9. Test Strategy

### New test files

**`tests/guardrail-registry.test.ts`** (~120 lines)
- before_model: hook mutates messages → verify mutated messages passed to inner client
- before_model: hook throws `GuardrailBlockedError` → verify error propagates
- after_model: hook mutates response content → verify caller gets mutated content
- before_tool: hook blocks → verify returns reason string
- after_tool: hook blocks → verify reason returned
- Multiple hooks: verify all fire in registration order
- No hooks registered: verify pass-through with no side effects

**`tests/guarded-llm-client.test.ts`** (~80 lines)
- before_model hook fires with correct messages/options
- after_model hook receives actual LLM response
- `withContext()` binds context to subsequent calls
- Hook mutation propagates (messages → inner, response → caller)
- GuardrailBlockedError propagates out of `sendMessage`

**`tests/task-approval-guardrail.test.ts`** (~60 lines)
- `runGuardrailBeforeToolCheck`: hook blocks → returns `TaskCycleResult` with action=discard
- `runGuardrailBeforeToolCheck`: hook passes → returns null
- `runPreExecutionChecks` with `guardrailRegistry` set → before_tool hook fires

**`tests/task-executor-after-tool.test.ts`** (~60 lines) — extend existing task-executor tests
- after_tool hook fires after successful execution
- after_tool blocks → result.success flipped to false
- after_tool does NOT fire on failed execution

### Existing tests that must still pass

No existing tests should break since all changes are additive (optional fields, new optional deps). Confirm with `npx vitest run`.

---

## 10. Implementation Order

1. Create `src/types/guardrail.ts` (no deps on other new files)
2. Create `src/traits/guardrail-registry.ts` (depends on guardrail.ts)
3. Create `src/llm/guarded-llm-client.ts` (depends on guardrail-registry.ts)
4. Modify `src/execution/task-approval.ts` (add `runGuardrailBeforeToolCheck`, wire into `runPreExecutionChecks`)
5. Modify `src/execution/task-executor.ts` (add after_tool hook)
6. Modify `src/execution/task-lifecycle.ts` (wire guardrailRegistry into deps)
7. Modify `src/execution/task-pipeline-cycle.ts` (same wiring)
8. Write tests
9. Update `src/index.ts` exports (add `GuardrailRegistry`, `GuardedLLMClient`, `GuardrailBlockedError`, `GuardrailHook` types)

---

## 11. Key Constraints

- **No breaking changes**: All new parameters are optional. Existing call sites continue to work unchanged.
- **EthicsGate untouched**: EthicsGate remains the policy enforcer. Guardrail hooks are additional observers.
- **before_tool does not replace `checkMeans`**: Both run. EthicsGate.checkMeans fires first (inside `runEthicsCheck`), then guardrail before_tool hooks fire.
- **File size**: No modified file will exceed 500 lines after changes.
- **No circular imports**: `guardrail.ts` (types) → no deps. `guardrail-registry.ts` → imports from types only. `guarded-llm-client.ts` → imports from registry. `task-approval.ts` → imports registry. Clean DAG.
