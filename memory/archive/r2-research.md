# R2 Research: contextProvider — Current State

## 1. contextProvider Signature

**Confirmed** — exact TypeScript type (inline, no named type/interface):

```typescript
() => Promise<string>
```

Location in `ObservationEngine` class (`src/observation-engine.ts`):
- L67: `private readonly contextProvider?: () => Promise<string>;`
- L73: constructor parameter `contextProvider?: () => Promise<string>`
- L78: `this.contextProvider = contextProvider;`

**No named type exists in `src/types/`.** The type is inline-only in both the engine and the CLI. There is no `IContextProvider` interface or Zod schema.

---

## 2. How observe() Calls contextProvider

`observe()` uses a lazy-fetch pattern (`src/observation-engine.ts` L325–L348):

```typescript
// L327–L348
let workspaceContext: string | undefined;
let workspaceContextFetched = false;

const fetchWorkspaceContext = async (): Promise<string | undefined> => {
  if (workspaceContextFetched) return workspaceContext;
  workspaceContextFetched = true;
  if (this.contextProvider) {
    try {
      workspaceContext = await this.contextProvider();
    } catch (err) {
      console.warn(`[ObservationEngine] contextProvider failed: ...`);
    }
  } else {
    console.warn(`[ObservationEngine] No contextProvider configured. LLM observation will proceed without workspace context (scores may be unreliable).`);
  }
  return workspaceContext;
};
```

`fetchWorkspaceContext()` is called at L370 (`const ctx = await fetchWorkspaceContext();`) and the result `ctx` is passed as the last argument to `observeWithLLM()`.

---

## 3. observeWithLLM() Prompt Template

**Confirmed** — `src/observation-engine.ts` L546–L557:

```typescript
const contextSection = workspaceContext
  ? `\n=== Current Workspace State ===\n${workspaceContext}\n=== End Workspace State ===\n`
  : "";

const prompt =
  `以下のゴールの次元を0.0〜1.0で評価してください。\n\n` +
  `ゴール: ${goalDescription}\n` +
  `評価次元: ${dimensionLabel}\n` +
  `目標値: ${thresholdDescription}\n` +
  contextSection +
  `\n現在の状態を考慮して、この次元の達成度を0.0（未達成）〜1.0（完全達成）で評価してください。\n\n` +
  `回答はJSON形式で: {"score": 0.0〜1.0, "reason": "評価理由"}`;
```

Key facts:
- Prompt is in Japanese
- workspaceContext is injected verbatim between `目標値` and `現在の状態を考慮して`
- Expected JSON response: `{ "score": number, "reason": string }`
- Confidence is hardcoded to `0.70` (L585)
- Layer is always `"independent_review"` (L575)

---

## 4. Current CLI Injection (`src/cli-runner.ts` L132–L149)

**Confirmed** — defined inline inside `buildDeps()`, lines 132–147:

```typescript
const contextProvider = async (): Promise<string> => {
  const cwd = process.cwd();
  const candidates = ['README.md', 'package.json', 'CLAUDE.md', 'tsconfig.json', 'docs/status.md'];
  const parts: string[] = [`# Workspace: ${cwd}`];
  try {
    const entries = fs.readdirSync(cwd);
    parts.push(`## Directory listing\n${entries.join(', ')}`);
  } catch { /* skip */ }
  for (const rel of candidates) {
    try {
      const content = fs.readFileSync(path.join(cwd, rel), 'utf-8');
      parts.push(`## ${rel}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``);
    } catch { /* skip missing */ }
  }
  return parts.join('\n\n');
};

const observationEngine = new ObservationEngine(stateManager, dataSources, llmClient, contextProvider);
```

What it collects:
- `cwd` path
- Directory listing (flat)
- Up to 2000 chars each from: `README.md`, `package.json`, `CLAUDE.md`, `tsconfig.json`, `docs/status.md`

---

## 5. Existing vs. What Needs to Be Created

### Exists
| Item | Location | Notes |
|------|----------|-------|
| `contextProvider` inline type | `src/observation-engine.ts` L67, 73 | `() => Promise<string>` |
| Lazy fetch in `observe()` | L325–L370 | Single-call per observe pass |
| `observeWithLLM()` | L530–L592 | Accepts optional `workspaceContext` |
| CLI default implementation | `src/cli-runner.ts` L132–L147 | File-read based, 5 candidates, 2000-char cap |
| Injection into ObservationEngine | `src/cli-runner.ts` L149 | 4th constructor argument |

### Does NOT Exist
- `src/context-providers/` directory — **does not exist**
- Named `IContextProvider` interface or type alias — **does not exist**
- Any Zod schema for context provider config — **does not exist**
- Any test for the contextProvider function — not confirmed (no grep match)
- Pluggable/configurable context provider selection — everything is hardcoded inline in `buildDeps()`

---

## 6. Key Line Numbers for Modification Points

| File | Lines | Purpose |
|------|-------|---------|
| `src/observation-engine.ts` | 67, 73, 78 | contextProvider field declaration + constructor param |
| `src/observation-engine.ts` | 325–348 | `fetchWorkspaceContext` lazy closure inside `observe()` |
| `src/observation-engine.ts` | 368–380 | Call site: `ctx` fetched and passed to `observeWithLLM` |
| `src/observation-engine.ts` | 530–592 | `observeWithLLM()` full implementation + prompt template |
| `src/observation-engine.ts` | 546–557 | Prompt construction (contextSection insertion point) |
| `src/cli-runner.ts` | 132–147 | Default contextProvider implementation |
| `src/cli-runner.ts` | 149 | ObservationEngine constructor call (injection point) |

---

## 7. Gaps / Uncertainties

- Whether any existing tests exercise `contextProvider` behavior — no grep match found for `contextProvider` in tests/ (not explicitly checked)
- Whether R2 scope requires changing the `observeWithLLM` prompt structure or only the provider implementation
- No design doc for R2 found yet (`docs/design/` not checked for context-provider specific doc)
