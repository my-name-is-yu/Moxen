# A2A Adapter Implementation Blueprint

**Created**: 2026-03-20
**Priority**: #1 in unified report integration table (agentic-ai-unified-report.md)
**Scope**: Implement IAdapter for A2A Protocol v0.3, enabling Motiva to orchestrate any A2A-compliant agent

---

## 1. Files to Create / Modify

### New Files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/adapters/a2a-adapter.ts` | A2AAdapter class implementing IAdapter | ~250 |
| `src/adapters/a2a-client.ts` | HTTP/SSE client for A2A JSON-RPC calls | ~200 |
| `src/types/a2a.ts` | Zod schemas for all A2A message types | ~180 |
| `tests/a2a-adapter.test.ts` | Unit tests for A2AAdapter | ~300 |
| `tests/a2a-client.test.ts` | Unit tests for A2AClient (mock HTTP) | ~200 |

### Modified Files

| File | Change |
|------|--------|
| `src/llm/provider-factory.ts` | Import and register A2AAdapter in `buildAdapterRegistry()` |
| `src/llm/provider-config.ts` | Add `a2a` section to ProviderConfig type and resolution |
| `src/index.ts` | Re-export `A2AAdapter` and `A2AAdapterConfig` |

---

## 2. Type Definitions (`src/types/a2a.ts`)

All types use Zod for runtime validation, following the project pattern (Zod schema + `z.infer<>`).

```typescript
import { z } from "zod";

// ─── Part variants ───

export const A2ATextPartSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
});

export const A2AFilePartSchema = z.object({
  kind: z.literal("file"),
  file: z.object({
    name: z.string().optional(),
    mimeType: z.string().optional(),
    bytes: z.string().optional(),  // base64
    uri: z.string().optional(),
  }),
});

export const A2ADataPartSchema = z.object({
  kind: z.literal("data"),
  data: z.record(z.unknown()),
});

export const A2APartSchema = z.discriminatedUnion("kind", [
  A2ATextPartSchema,
  A2AFilePartSchema,
  A2ADataPartSchema,
]);

export type A2APart = z.infer<typeof A2APartSchema>;

// ─── Message ───

export const A2AMessageSchema = z.object({
  role: z.enum(["user", "agent"]),
  parts: z.array(A2APartSchema),
  messageId: z.string().optional(),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
});

export type A2AMessage = z.infer<typeof A2AMessageSchema>;

// ─── Task Status ───

export const A2ATaskStateSchema = z.enum([
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

export type A2ATaskState = z.infer<typeof A2ATaskStateSchema>;

export const A2ATaskStatusSchema = z.object({
  state: A2ATaskStateSchema,
  message: z.string().optional(),
  timestamp: z.string().optional(),
});

export type A2ATaskStatus = z.infer<typeof A2ATaskStatusSchema>;

// ─── Artifact ───

export const A2AArtifactSchema = z.object({
  artifactId: z.string().optional(),
  parts: z.array(A2APartSchema),
  name: z.string().optional(),
  description: z.string().optional(),
});

export type A2AArtifact = z.infer<typeof A2AArtifactSchema>;

// ─── Task ───

export const A2ATaskSchema = z.object({
  id: z.string(),
  contextId: z.string().optional(),
  status: A2ATaskStatusSchema,
  artifacts: z.array(A2AArtifactSchema).optional(),
  history: z.array(A2AMessageSchema).optional(),
  kind: z.literal("task").optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type A2ATask = z.infer<typeof A2ATaskSchema>;

// ─── Agent Card ───

export const A2ASkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
});

export type A2ASkill = z.infer<typeof A2ASkillSchema>;

export const A2AAgentCardSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  url: z.string(),
  version: z.string().optional(),
  capabilities: z.object({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
  }).optional(),
  skills: z.array(A2ASkillSchema).optional(),
  securitySchemes: z.array(z.record(z.unknown())).optional(),
  defaultInputModes: z.array(z.string()).optional(),
  defaultOutputModes: z.array(z.string()).optional(),
});

export type A2AAgentCard = z.infer<typeof A2AAgentCardSchema>;

// ─── JSON-RPC envelope ───

export const A2AJsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
});

export type A2AJsonRpcResponse = z.infer<typeof A2AJsonRpcResponseSchema>;

// ─── SSE streaming events ───

export const A2AStatusUpdateEventSchema = z.object({
  taskId: z.string(),
  contextId: z.string().optional(),
  status: A2ATaskStatusSchema,
  final: z.boolean().optional(),
  kind: z.literal("status-update"),
});

export const A2AArtifactUpdateEventSchema = z.object({
  taskId: z.string(),
  contextId: z.string().optional(),
  artifact: A2AArtifactSchema,
  append: z.boolean().optional(),
  lastChunk: z.boolean().optional(),
  kind: z.literal("artifact-update"),
});

export type A2AStatusUpdateEvent = z.infer<typeof A2AStatusUpdateEventSchema>;
export type A2AArtifactUpdateEvent = z.infer<typeof A2AArtifactUpdateEventSchema>;

// ─── Terminal states (for polling/streaming exit condition) ───

export const A2A_TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);
```

---

## 3. A2A HTTP/SSE Client (`src/adapters/a2a-client.ts`)

Handles all network communication. Uses Node.js built-in `fetch` (Node 18+) to avoid external HTTP dependencies.

```typescript
import type {
  A2AAgentCard,
  A2ATask,
  A2ATaskState,
  A2AMessage,
  A2AJsonRpcResponse,
} from "../types/a2a.js";
import {
  A2AAgentCardSchema,
  A2ATaskSchema,
  A2AJsonRpcResponseSchema,
  A2A_TERMINAL_STATES,
} from "../types/a2a.js";

// ─── Config ───

export interface A2AClientConfig {
  /** Base URL of the A2A agent (e.g. "https://agent.example.com") */
  baseUrl: string;
  /** Auth token (Bearer). Optional — depends on agent's securitySchemes. */
  authToken?: string;
  /** Polling interval when SSE is not supported. Default: 2000ms */
  pollIntervalMs?: number;
  /** Maximum total wait time for task completion. Default: 300_000ms (5 min) */
  maxWaitMs?: number;
}

// ─── Client ───

export class A2AClient {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(config: A2AClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.authToken = config.authToken;
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.maxWaitMs = config.maxWaitMs ?? 300_000;
  }

  // ─── Agent Card Discovery ───

  async fetchAgentCard(): Promise<A2AAgentCard> {
    const url = `${this.baseUrl}/.well-known/agent.json`;
    const res = await this.httpGet(url);
    return A2AAgentCardSchema.parse(res);
  }

  // ─── message/send (blocking) ───

  async sendMessage(message: A2AMessage): Promise<A2ATask> {
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: { message },
    };
    const res = await this.jsonRpc(body);
    return A2ATaskSchema.parse(res);
  }

  // ─── tasks/get ───

  async getTask(taskId: string): Promise<A2ATask> {
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tasks/get",
      params: { id: taskId },
    };
    const res = await this.jsonRpc(body);
    return A2ATaskSchema.parse(res);
  }

  // ─── tasks/cancel ───

  async cancelTask(taskId: string): Promise<void> {
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tasks/cancel",
      params: { id: taskId },
    };
    await this.jsonRpc(body);
  }

  // ─── Polling loop ───

  async waitForCompletion(
    taskId: string,
    signal?: AbortSignal
  ): Promise<A2ATask> {
    const deadline = Date.now() + this.maxWaitMs;

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error("A2A task wait aborted");
      }

      const task = await this.getTask(taskId);
      if (A2A_TERMINAL_STATES.has(task.status.state)) {
        return task;
      }

      await sleep(this.pollIntervalMs);
    }

    // Attempt cancel on timeout
    try { await this.cancelTask(taskId); } catch { /* best-effort */ }
    throw new Error(`A2A task ${taskId} did not complete within ${this.maxWaitMs}ms`);
  }

  // ─── SSE streaming (message/stream) ───

  async sendMessageStream(
    message: A2AMessage,
    onStatus?: (state: A2ATaskState, msg?: string) => void,
    signal?: AbortSignal
  ): Promise<A2ATask> {
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/stream",
      params: { message },
    };

    const res = await fetch(`${this.baseUrl}`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      throw new Error(`A2A stream request failed: ${res.status} ${res.statusText}`);
    }

    if (!res.body) {
      throw new Error("A2A stream response has no body");
    }

    // Parse SSE events from the response stream
    let latestTask: A2ATask | null = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const kind = parsed.kind as string | undefined;

            if (kind === "task" || (!kind && parsed.id && parsed.status)) {
              latestTask = A2ATaskSchema.parse(parsed);
            } else if (kind === "status-update" && parsed.status) {
              const status = parsed.status as { state?: string; message?: string };
              if (status.state) {
                onStatus?.(status.state as A2ATaskState, status.message);
              }
            }
            // artifact-update events are accumulated in the task object
          } catch {
            // Skip malformed SSE data lines
          }
        }
      }
    }

    if (!latestTask) {
      throw new Error("A2A stream ended without returning a task");
    }
    return latestTask;
  }

  // ─── Private ───

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  private async httpGet(url: string): Promise<unknown> {
    const res = await fetch(url, { headers: this.buildHeaders() });
    if (!res.ok) {
      throw new Error(`A2A GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  private async jsonRpc(body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`A2A JSON-RPC failed: ${res.status} ${res.statusText}`);
    }

    const json = A2AJsonRpcResponseSchema.parse(await res.json());
    if (json.error) {
      throw new Error(
        `A2A JSON-RPC error ${json.error.code}: ${json.error.message}`
      );
    }
    return json.result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

---

## 4. A2AAdapter Class (`src/adapters/a2a-adapter.ts`)

### Design Principles

- Implements `IAdapter` (same as ClaudeAPIAdapter, ClaudeCodeCLIAdapter, etc.)
- Wraps `A2AClient` for network I/O
- Maps Motiva's `AgentTask.prompt` to A2A `Message` with text part
- Maps A2A `Task` terminal state to Motiva's `AgentResult`
- Supports both polling and SSE streaming (prefers streaming when agent advertises it)
- Handles `input-required` by treating it as a failure (Motiva doesn't support mid-task human input through adapters)

```typescript
import type { IAdapter, AgentTask, AgentResult } from "../execution/adapter-layer.js";
import { A2AClient } from "./a2a-client.js";
import type { A2AClientConfig } from "./a2a-client.js";
import type { A2AAgentCard, A2ATask, A2AMessage } from "../types/a2a.js";
import { A2A_TERMINAL_STATES } from "../types/a2a.js";

// ─── Config ───

export interface A2AAdapterConfig extends A2AClientConfig {
  /**
   * Adapter type string registered in AdapterRegistry.
   * Default: "a2a". Override to register multiple A2A agents
   * (e.g., "a2a_research_agent", "a2a_code_agent").
   */
  adapterType?: string;
  /**
   * Override capabilities instead of deriving from Agent Card skills.
   * If not set, capabilities are fetched from the Agent Card on first use.
   */
  capabilities?: string[];
  /**
   * Prefer SSE streaming over polling. Default: true.
   * Falls back to polling if the agent does not advertise streaming support.
   */
  preferStreaming?: boolean;
  /**
   * Context ID for multi-turn conversations. If set, all tasks sent through
   * this adapter share the same A2A conversation context.
   */
  contextId?: string;
}

// ─── Adapter ───

export class A2AAdapter implements IAdapter {
  readonly adapterType: string;

  private readonly client: A2AClient;
  private readonly preferStreaming: boolean;
  private readonly contextId?: string;
  private resolvedCapabilities: string[] | null;
  private agentCard: A2AAgentCard | null = null;

  constructor(config: A2AAdapterConfig) {
    this.adapterType = config.adapterType ?? "a2a";
    this.client = new A2AClient(config);
    this.preferStreaming = config.preferStreaming ?? true;
    this.contextId = config.contextId;
    this.resolvedCapabilities = config.capabilities ?? null;
  }

  get capabilities(): readonly string[] {
    return this.resolvedCapabilities ?? ["general_purpose"];
  }

  /**
   * Fetch Agent Card and derive capabilities from skills.
   * Called lazily on first execute() if capabilities were not provided in config.
   * Safe to call multiple times (cached).
   */
  async discoverCapabilities(): Promise<void> {
    if (this.agentCard) return;
    try {
      this.agentCard = await this.client.fetchAgentCard();
      if (!this.resolvedCapabilities && this.agentCard.skills?.length) {
        this.resolvedCapabilities = this.agentCard.skills.flatMap(
          (s) => s.tags ?? [s.id]
        );
      }
    } catch {
      // Agent Card not available — continue with default capabilities
    }
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();

    // Lazy capability discovery
    if (!this.agentCard) {
      await this.discoverCapabilities();
    }

    // Build A2A message from Motiva's prompt
    const message: A2AMessage = {
      role: "user",
      parts: [{ kind: "text", text: task.prompt }],
      messageId: crypto.randomUUID(),
      ...(this.contextId ? { contextId: this.contextId } : {}),
    };

    // Timeout via AbortController
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), task.timeout_ms);

    try {
      let a2aTask: A2ATask;

      const supportsStreaming =
        this.preferStreaming &&
        this.agentCard?.capabilities?.streaming === true;

      if (supportsStreaming) {
        // ── SSE streaming path ──
        a2aTask = await this.client.sendMessageStream(
          message,
          undefined, // onStatus callback — not needed for basic adapter
          controller.signal
        );
      } else {
        // ── Polling path ──
        const initial = await this.client.sendMessage(message);

        if (A2A_TERMINAL_STATES.has(initial.status.state)) {
          a2aTask = initial;
        } else {
          a2aTask = await this.client.waitForCompletion(
            initial.id,
            controller.signal
          );
        }
      }

      clearTimeout(timeoutHandle);
      return this.mapTaskToResult(a2aTask, startedAt);
    } catch (err) {
      clearTimeout(timeoutHandle);
      const elapsed = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);

      // Distinguish timeout from other errors
      if (controller.signal.aborted || message.includes("did not complete within")) {
        return {
          success: false,
          output: "",
          error: `Timed out after ${task.timeout_ms}ms`,
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "timeout",
        };
      }

      return {
        success: false,
        output: "",
        error: message,
        exit_code: null,
        elapsed_ms: elapsed,
        stopped_reason: "error",
      };
    }
  }

  // ─── Private: map A2A Task to Motiva AgentResult ───

  private mapTaskToResult(task: A2ATask, startedAt: number): AgentResult {
    const elapsed = Date.now() - startedAt;

    // Extract text output from artifacts
    const output = this.extractTextOutput(task);

    switch (task.status.state) {
      case "completed":
        return {
          success: true,
          output,
          error: null,
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "completed",
        };

      case "failed":
        return {
          success: false,
          output,
          error: task.status.message ?? "A2A task failed",
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "error",
        };

      case "canceled":
        return {
          success: false,
          output,
          error: "A2A task was canceled",
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "timeout",  // closest mapping
        };

      case "rejected":
        return {
          success: false,
          output,
          error: task.status.message ?? "A2A task was rejected by the remote agent",
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "error",
        };

      case "input-required":
      case "auth-required":
        return {
          success: false,
          output,
          error: `A2A task requires ${task.status.state}: ${task.status.message ?? "no details"}. ` +
            "Motiva does not support interactive input through adapters.",
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "error",
        };

      default:
        // Should not reach here after waitForCompletion, but handle gracefully
        return {
          success: false,
          output,
          error: `A2A task in unexpected state: ${task.status.state}`,
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "error",
        };
    }
  }

  /**
   * Extract text content from A2A artifacts and history.
   * Concatenates all text parts from artifacts (preferred) or last agent message.
   */
  private extractTextOutput(task: A2ATask): string {
    // Prefer artifacts
    if (task.artifacts?.length) {
      const texts: string[] = [];
      for (const artifact of task.artifacts) {
        for (const part of artifact.parts) {
          if (part.kind === "text") {
            texts.push(part.text);
          }
        }
      }
      if (texts.length > 0) return texts.join("\n");
    }

    // Fallback: last agent message in history
    if (task.history?.length) {
      const agentMessages = task.history.filter((m) => m.role === "agent");
      const last = agentMessages[agentMessages.length - 1];
      if (last) {
        const texts: string[] = [];
        for (const part of last.parts) {
          if (part.kind === "text") {
            texts.push(part.text);
          }
        }
        if (texts.length > 0) return texts.join("\n");
      }
    }

    return "";
  }
}
```

---

## 5. Configuration

### Provider Config Extension (`src/llm/provider-config.ts`)

Add A2A section to `ProviderConfig`:

```typescript
// Add to ProviderConfig interface:
a2a?: {
  /** Map of adapter name -> A2A agent endpoint config */
  agents?: Record<string, {
    base_url: string;
    auth_token?: string;
    capabilities?: string[];
    prefer_streaming?: boolean;
    poll_interval_ms?: number;
    max_wait_ms?: number;
  }>;
};
```

### User Configuration in `~/.motiva/provider.json`

```json
{
  "llm_provider": "openai",
  "default_adapter": "openai_codex_cli",
  "a2a": {
    "agents": {
      "a2a_research": {
        "base_url": "https://research-agent.example.com",
        "auth_token": "sk-...",
        "capabilities": ["web_search", "analysis"]
      },
      "a2a_code_gen": {
        "base_url": "http://localhost:8080",
        "prefer_streaming": true
      }
    }
  }
}
```

### Environment Variable Override

```
MOTIVA_A2A_BASE_URL=https://agent.example.com
MOTIVA_A2A_AUTH_TOKEN=sk-...
```

### Registration in `buildAdapterRegistry()` (`src/llm/provider-factory.ts`)

```typescript
import { A2AAdapter } from "../adapters/a2a-adapter.js";

export async function buildAdapterRegistry(
  llmClient: ILLMClient,
  providerConfig?: ProviderConfig
): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  registry.register(new ClaudeCodeCLIAdapter());
  registry.register(new ClaudeAPIAdapter(llmClient));
  registry.register(new OpenAICodexCLIAdapter());
  registry.register(new GitHubIssueAdapter());

  // Register A2A agents from config
  const config = providerConfig ?? await loadProviderConfig();
  if (config.a2a?.agents) {
    for (const [name, agentConfig] of Object.entries(config.a2a.agents)) {
      registry.register(new A2AAdapter({
        adapterType: name.startsWith("a2a") ? name : `a2a_${name}`,
        baseUrl: agentConfig.base_url,
        authToken: agentConfig.auth_token,
        capabilities: agentConfig.capabilities,
        preferStreaming: agentConfig.prefer_streaming,
        pollIntervalMs: agentConfig.poll_interval_ms,
        maxWaitMs: agentConfig.max_wait_ms,
      }));
    }
  }

  // Single-agent env var shortcut
  const envBaseUrl = process.env["MOTIVA_A2A_BASE_URL"];
  if (envBaseUrl && !config.a2a?.agents) {
    registry.register(new A2AAdapter({
      baseUrl: envBaseUrl,
      authToken: process.env["MOTIVA_A2A_AUTH_TOKEN"],
    }));
  }

  return registry;
}
```

**Note**: This changes `buildAdapterRegistry` from sync to async. The call sites (CLIRunner, TUI entry) already use async initialization, so this is a safe change.

---

## 6. Test Strategy

### Unit Tests (`tests/a2a-adapter.test.ts`)

Mock `A2AClient` methods (dependency injection) to avoid real HTTP. Test pattern matches `tests/adapter-layer.test.ts`.

| Test | What it verifies |
|------|-----------------|
| `adapterType defaults to "a2a"` | Constructor default |
| `adapterType accepts custom name` | Config override |
| `capabilities derived from Agent Card skills` | discoverCapabilities() |
| `capabilities fallback to ["general_purpose"]` | When Agent Card fetch fails |
| `execute returns success for completed task` | Happy path mapping |
| `execute returns error for failed task` | State mapping |
| `execute returns error for rejected task` | State mapping |
| `execute returns error for input-required task` | Edge case |
| `execute returns timeout on AbortController` | Timeout handling |
| `execute returns timeout when polling exceeds timeout_ms` | Polling timeout |
| `execute uses streaming when agent advertises it` | Streaming path selection |
| `execute falls back to polling when streaming not supported` | Fallback |
| `extractTextOutput prefers artifacts over history` | Output extraction |
| `extractTextOutput falls back to last agent message` | Fallback |
| `can be registered in AdapterRegistry` | Integration with registry |
| `multiple A2A adapters can coexist in registry` | Multi-agent |

### HTTP Client Tests (`tests/a2a-client.test.ts`)

Use `vi.fn()` to mock `global.fetch` (Node 18+ built-in).

| Test | What it verifies |
|------|-----------------|
| `fetchAgentCard parses well-known endpoint` | Agent Card discovery |
| `fetchAgentCard throws on 404` | Error handling |
| `sendMessage sends correct JSON-RPC body` | Request format |
| `sendMessage parses task response` | Response parsing |
| `sendMessage throws on JSON-RPC error` | Error propagation |
| `getTask sends correct params` | Request format |
| `cancelTask sends correct params` | Request format |
| `waitForCompletion polls until terminal state` | Polling loop |
| `waitForCompletion respects maxWaitMs` | Timeout |
| `waitForCompletion cancels task on timeout` | Cleanup |
| `sendMessageStream parses SSE events` | Streaming |
| `Authorization header included when authToken set` | Auth |
| `No Authorization header when authToken not set` | Auth absence |

### Mock Pattern

```typescript
// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Helper: create JSON-RPC success response
function jsonRpcOk(result: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: "1", result }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// Helper: create A2A task in a given state
function a2aTask(state: string, output?: string): Record<string, unknown> {
  return {
    id: "task-1",
    contextId: "ctx-1",
    status: { state, timestamp: new Date().toISOString() },
    artifacts: output
      ? [{ parts: [{ kind: "text", text: output }] }]
      : [],
  };
}
```

---

## 7. Edge Cases & Error Handling

### Timeout

- `AbortController` signal passed to `fetch()` and `waitForCompletion()`
- On timeout: attempt `tasks/cancel` (best-effort, catch errors)
- Map to `AgentResult.stopped_reason = "timeout"`

### Retry

- **No automatic retry in the adapter**. The circuit breaker in `AdapterRegistry` handles retry decisions at a higher level.
- Transient HTTP errors (429, 503) should bubble up as `stopped_reason: "error"` so the circuit breaker can record the failure and potentially retry with a different adapter.

### Authentication

- Bearer token from config or env var
- If agent returns `auth-required` state: map to error with descriptive message
- Agent Card's `securitySchemes` field is read but not acted on in MVP (future: OAuth2 flow support)

### Error Mapping

| A2A State | AgentResult.stopped_reason | AgentResult.success |
|-----------|---------------------------|---------------------|
| `completed` | `"completed"` | `true` |
| `failed` | `"error"` | `false` |
| `canceled` | `"timeout"` | `false` |
| `rejected` | `"error"` | `false` |
| `input-required` | `"error"` | `false` |
| `auth-required` | `"error"` | `false` |
| Timeout (AbortController) | `"timeout"` | `false` |
| HTTP error | `"error"` | `false` |
| Network error | `"error"` | `false` |

### Agent Card Unavailable

- `discoverCapabilities()` catches all errors silently
- Adapter still works without Agent Card (uses default capabilities)
- Streaming falls back to polling if Agent Card is unavailable

### Large Outputs

- Text output extracted from artifacts is concatenated with newlines
- No size limit in MVP; future enhancement: truncate to match `AgentResult.output` expectations

### Multi-turn Conversations

- `contextId` in config enables multi-turn: all messages share the same A2A context
- Without `contextId`, each `execute()` call is independent

---

## 8. Implementation Order

1. **`src/types/a2a.ts`** — Zod schemas (no dependencies)
2. **`src/adapters/a2a-client.ts`** — HTTP/SSE client (depends on types)
3. **`tests/a2a-client.test.ts`** — Client tests (mock fetch)
4. **`src/adapters/a2a-adapter.ts`** — Adapter class (depends on client + adapter-layer)
5. **`tests/a2a-adapter.test.ts`** — Adapter tests
6. **`src/llm/provider-config.ts`** — Add A2A config section
7. **`src/llm/provider-factory.ts`** — Register A2A adapters
8. **`src/index.ts`** — Re-export

Estimated total: ~1,130 lines of production code, ~500 lines of tests.

---

## 9. Future Enhancements (Out of Scope for MVP)

- **OAuth2 flow**: Auto-negotiate OAuth2 credentials from Agent Card securitySchemes
- **Push notifications**: Register webhook endpoint for real-time updates instead of polling
- **File parts**: Support passing file artifacts (code patches, images) via A2A file parts
- **Multi-turn interactive**: Allow Motiva to respond to `input-required` with follow-up messages
- **Agent Card caching**: Cache discovered Agent Cards with TTL to reduce network calls
- **gRPC binding**: A2A v0.3 added gRPC support; add as an alternative transport
- **Motiva as A2A server**: Expose Motiva itself as an A2A-compliant agent (inbound adapter)
