# Issue #54: Sync fs API Audit

Research date: 2026-03-19
Branch: main

---

## 1. src/state-manager.ts

**Sync APIs used:**
- L60: `fs.mkdirSync(dir, { recursive: true })` — inside `ensureDirectories()`

**Function containing sync call:** `ensureDirectories(): void` — sync, called from `constructor`

**Caller chain:** Constructor → sync (no await possible). All other methods in StateManager are `async` and use `fsp` (already imported as `node:fs/promises`).

**fs/promises import:** Yes — `import * as fsp from "node:fs/promises"` at L2

**Risk:** LOW. The only sync call is `mkdirSync` in the constructor. Pattern is common for one-time init. To convert, the constructor would need to become an async factory (`StateManager.create()`), which would cascade to all instantiation sites. However, the dirs being created are always the same fixed set and this runs once at startup — not in the hot loop. The simplest fix is to defer ensureDirectories to an async `init()` method and call it lazily, or keep it sync (mkdirSync on startup is widely accepted).

---

## 2. src/execution/task-prompt-builder.ts

**Sync APIs used:**
- L102: `_fs.existsSync(pkgPath)` — inside `buildTaskGenerationPrompt()`
- L103: `_fs.readFileSync(pkgPath, "utf-8")` — same location

**Function containing sync call:** `buildTaskGenerationPrompt(...): Promise<string>` — already async

**Caller chain:** async-compatible. Called from `task-lifecycle.ts` (async). The sync reads are inside a try/catch that silently ignores errors (best-effort repo context).

**fs/promises import:** No — only `import * as _fs from "node:fs"`. No fsp import.

**Risk:** LOW. Both calls are inside an async function and inside a best-effort try/catch. Converting to `fsp.access` + `fsp.readFile` is a 3-line change with no signature impact.

---

## 3. src/drive/drive-system.ts

**Sync APIs used:**
- L47: `fs.mkdirSync(dir, { recursive: true })` — `ensureDirectories(): void` (constructor)
- L55: `fs.writeFileSync(tmpPath, ...)` — `atomicWrite(): void` (sync)
- L56: `fs.renameSync(tmpPath, filePath)` — `atomicWrite(): void` (sync)
- L108: `fs.existsSync(eventsDir)` — `readEventQueue(): MotivaEvent[]` (sync)
- L114: `fs.readdirSync(eventsDir)` — `readEventQueue(): MotivaEvent[]` (sync)
- L125: `fs.statSync(filePath)` — `readEventQueue(): MotivaEvent[]` (sync)
- L132: `fs.readFileSync(filePath, "utf-8")` — `readEventQueue(): MotivaEvent[]` (sync)
- L158: `fs.mkdirSync(archiveDir, { recursive: true })` — `archiveEvent(): void` (sync)
- L160: `fs.renameSync(srcPath, dstPath)` — `archiveEvent(): void` (sync)
- L168: `fs.existsSync(eventsDir)` — `processEvents(): MotivaEvent[]` (sync)
- L174: `fs.readdirSync(eventsDir)` — `processEvents(): MotivaEvent[]` (sync)
- L184: `fs.statSync(filePath)` — `processEvents(): MotivaEvent[]` (sync)
- L191: `fs.readFileSync(filePath, "utf-8")` — `processEvents(): MotivaEvent[]` (sync)
- L220: `fs.readFileSync(filePath, "utf-8")` — `getSchedule(): GoalSchedule | null` (sync)
- L237: `fs.mkdirSync(scheduleDir, { recursive: true })` — `updateSchedule(): void` (sync)
- L306: `fs.mkdirSync(eventsDir, { recursive: true })` — `writeEvent(): void` (sync)
- L310: `fs.writeFileSync(tmpPath, ...)` — `writeEvent(): void` (sync)
- L311: `fs.renameSync(tmpPath, filePath)` — `writeEvent(): void` (sync)
- L322: `fs.mkdirSync(eventsDir, { recursive: true })` — `startWatcher(): void` (sync, fs.watch callback)
- L331: `fs.readFileSync(filePath, "utf-8")` — `startWatcher()` watcher callback (sync, inside `fs.watch` callback — CANNOT be async)

**Functions with sync calls:**
- `ensureDirectories(): void` — sync (constructor)
- `atomicWrite(): void` — sync, private
- `readEventQueue(): MotivaEvent[]` — sync (public)
- `archiveEvent(): void` — sync (public)
- `processEvents(): MotivaEvent[]` — sync (public)
- `getSchedule(): GoalSchedule | null` — sync (public)
- `updateSchedule(): void` — sync (public)
- `writeEvent(): void` — sync (public)
- `startWatcher(): void` — contains fs.watch callback (structurally must be sync)

**Caller chain:**
- `shouldActivate(goalId)` is async — calls `readEventQueue()` (sync) and `isScheduleDue()` → `getSchedule()` (sync). Callers: DaemonRunner async loop.
- `processEvents()` called from: need to check — likely CoreLoop or DaemonRunner
- `writeEvent()` called from: EventServer (sync HTTP handler context)
- `getSchedule()` also called directly from DaemonRunner L301 (sync call in async context — safe)

**fs/promises import:** No — only `import * as fs from "node:fs"`. No fsp.

**Risk:** HIGH for `readEventQueue`, `processEvents`, `archiveEvent`, `getSchedule`, `updateSchedule`, `writeEvent`. Signature changes cascade to all callers. The `startWatcher()` fs.watch callback is structurally synchronous (Node.js fs.watch callbacks cannot be awaited natively) — converting reads inside it requires a non-blocking workaround (spawn an async handler, don't await). The constructor `ensureDirectories` has same mkdirSync issue as StateManager.

This file has the highest total sync surface area in the codebase.

---

## 4. src/utils/json-io.ts

**Sync APIs used:**
- L14: `fs.readFileSync(filePath, "utf-8")` — `readJsonFileSync<T>(): T` (sync, by design)
- L22: `fs.writeFileSync(filePath, ...)` — `writeJsonFileSync(): void` (sync, by design)

**Functions:** Both are explicitly named `...Sync` — they exist as the sync variants alongside the async `readJsonFile` / `writeJsonFile` which already use `fsp`.

**Caller chain:** Grep shows no callers of `readJsonFileSync` or `writeJsonFileSync` in `src/` — they are dead code in production (only the async versions are imported by cli commands). Tests do not use them either.

**fs/promises import:** Yes — `import * as fsp from "node:fs/promises"` at L7

**Risk:** LOW (effectively dead code). Can be deleted or kept as a utility. No caller changes needed.

---

## 5. src/runtime/logger.ts

**Sync APIs used:**
- L42: `fs.mkdirSync(this.dir, { recursive: true })` — constructor
- L86: `fs.appendFileSync(this.currentFile, line, "utf-8")` — `writeToFile(): void` (sync, private)
- L99: `fs.renameSync(this.currentFile, ...)` — `rotateCurrent(): void` (sync, private)
- L114: `fs.existsSync(this.currentFile)` — `rotateIfNeeded(): void` (sync, private)
- L123: `fs.existsSync(this.currentFile)` — `rotateIfNeeded(): void` (sync, private)
- L124: `fs.statSync(this.currentFile)` — `rotateIfNeeded(): void` (sync, private)
- L131: `fs.existsSync(older)` — `rotateIfNeeded(): void` (sync, private)
- L132: `fs.unlinkSync(older)` — `rotateIfNeeded(): void` (sync, private)
- L134: `fs.existsSync(newer)` — `rotateIfNeeded(): void` (sync, private)
- L135: `fs.renameSync(newer, older)` — `rotateIfNeeded(): void` (sync, private)
- L140: `fs.renameSync(this.currentFile, ...)` — `rotateIfNeeded(): void` (sync, private)

**Functions containing sync calls:** All private sync methods. The public API (`debug/info/warn/error`) is sync and calls `writeToFile()` synchronously.

**Caller chain:** Logger is injected into almost every module. Its public interface is intentionally synchronous — this is the standard pattern for loggers (sync write-through). Converting to async would require all callers to `await logger.info(...)` which is a breaking change across the entire codebase.

**fs/promises import:** No — only `import * as fs from "node:fs"`.

**Risk:** HIGH to convert public interface. The `appendFileSync` in a tight loop can cause I/O blocking, but async logging typically uses a write-stream or a queue rather than converting the public API to async. Recommend using `fs.createWriteStream` (append mode) instead of `appendFileSync` — this avoids both blocking and API changes. The `rotateIfNeeded` and `rotateCurrent` private methods can be refactored to use the stream approach without touching the public API.

---

## 6. src/runtime/event-server.ts

**Sync APIs used:**
- L78: `fs.mkdirSync(this.eventsDir, { recursive: true })` — `startFileWatcher(): void` (sync)
- L103: `fs.existsSync(filePath)` — `processEventFile(): void` (sync, private)
- L104: `fs.statSync(filePath)` — `processEventFile(): void` (sync, private)
- L107: `fs.readFileSync(filePath, "utf-8")` — `processEventFile(): void` (sync, private)
- L116: `fs.mkdirSync(processedDir, { recursive: true })` — `processEventFile(): void` (sync, private)
- L118: `fs.renameSync(filePath, dstPath)` — `processEventFile(): void` (sync, private)

**Functions:** `startFileWatcher(): void` and `processEventFile(): void`. Both sync. `processEventFile` is called from inside a `fs.watch` callback (structurally sync). The `start()` method is already async using `fsp`.

**Caller chain:** `startFileWatcher()` called by DaemonRunner or CLI. The `fs.watch` callback cannot be made async natively — `processEventFile` would need to call an async function without await (fire-and-forget with error handling).

**fs/promises import:** Yes — `import * as fsp from "node:fs/promises"` at L2

**Risk:** MEDIUM. `startFileWatcher` and `processEventFile` are not in the request/response hot path. The `fs.watch` callback constraint means conversion requires a pattern change (fire async handler, catch errors). `mkdirSync` in `startFileWatcher` is init-time and low risk.

---

## 7. src/knowledge/memory-persistence.ts

**Sync APIs used:**
- L15: `fs.mkdirSync(dir, { recursive: true })` — `atomicWrite(): void` (sync)
- L17: `fs.writeFileSync(tmpPath, ...)` — `atomicWrite(): void` (sync)
- L18: `fs.renameSync(tmpPath, filePath)` — `atomicWrite(): void` (sync)
- L28: `fs.existsSync(filePath)` — `readJsonFile<T>(): T | null` (sync)
- L30: `fs.readFileSync(filePath, "utf-8")` — `readJsonFile<T>(): T | null` (sync)
- L148: `fs.existsSync(dirPath)` — `getDirectorySize(): number` (sync)
- L150: `fs.readdirSync(dirPath, ...)` — `getDirectorySize(): number` (sync)
- L157: `fs.statSync(entryPath)` — `getDirectorySize(): number` (sync)

**Functions:** `atomicWrite()`, `readJsonFile()`, `getDirectorySize()` — all public, all sync

**Caller chain:**
- `atomicWrite` and `readJsonFile` are called by `memory-stats.ts` (`updateStatistics` → sync), `memory-selection.ts` (sync functions), `memory-query.ts` (sync functions)
- `memory-lifecycle.ts` uses `readJsonFile` at L578 in `getStatistics()` which is a sync method — but also has async versions (`atomicWriteAsync`, `readJsonFileAsync`) already defined in the same file
- `getDirectorySize` is used by garbage collection logic

**fs/promises import:** Yes — `import * as fsp from "node:fs/promises"` at L3. Async equivalents `atomicWriteAsync` and `readJsonFileAsync` and `getDirectorySizeAsync` are ALREADY implemented in this file (L74-L140).

**Risk:** MEDIUM. The sync versions exist alongside already-implemented async versions. The conversion is mostly making callers switch from the sync to the async versions. `memory-stats.ts` and `memory-selection.ts` functions are currently sync — making them async requires cascading async up through `memory-lifecycle.ts`. `getStatistics()` in memory-lifecycle would need to become async.

---

## 8. src/knowledge/knowledge-graph.ts

**Sync APIs used:**
- L217: `fs.existsSync(this.graphPath)` — `_loadSync(): void` (sync, private)
- L219: `fs.readFileSync(this.graphPath, "utf-8")` — `_loadSync(): void` (sync, private)

**Functions:** `_loadSync(): void` — explicitly named sync, called only from constructor (L29). All other persistence uses async `save()` with `fsp`.

**fs/promises import:** Yes — `import * as fsp from "node:fs/promises"` at L2

**Risk:** LOW. Same pattern as `VectorIndex` below. Constructor calls `_loadSync()` for initial population. To convert, make it an async factory method `KnowledgeGraph.load(path)` that returns a fully initialized instance. Callers would need to await instantiation.

---

## 9. src/knowledge/vector-index.ts

**Sync APIs used:**
- L114: `fs.existsSync(this.indexPath)` — `_loadSync(): void` (sync, private)
- L116: `fs.readFileSync(this.indexPath, "utf-8")` — `_loadSync(): void` (sync, private)

**Functions:** `_loadSync(): void` — explicitly named sync, called only from constructor (L16). All writes use async `_save()` with `fsp`.

**fs/promises import:** Yes — `import * as fsp from "node:fs/promises"` at L2

**Risk:** LOW. Same constructor-init pattern as KnowledgeGraph. Convert to async factory method.

---

## 10. Additional Files Not in the 9-File List

Grep of `src/` confirms the 9 files listed are the **complete set** of files with sync fs APIs. `memory-stats.ts`, `memory-selection.ts`, and `memory-query.ts` do NOT call fs directly — they use the sync wrapper functions from `memory-persistence.ts`.

No other src files contain sync fs calls.

---

## 11. Daemon / Core-Loop Hot Path Analysis

The hot path for the Motiva orchestration loop is:

```
DaemonRunner.runLoop() [async]
  → determineActiveGoals() [async]
      → DriveSystem.shouldActivate() [async]  ← calls readEventQueue() SYNC
      → DriveSystem.getSchedule() SYNC
  → CoreLoop.run() [async]
      → ObservationEngine, TaskLifecycle, etc. [async]
```

**Most critical files to convert (highest I/O frequency per loop tick):**

1. **`src/drive/drive-system.ts`** — `readEventQueue()` and `getSchedule()` are called on EVERY loop iteration per goal. These are the highest-priority conversions. Each loop tick calls sync dir-scan + file reads, blocking the event loop.

2. **`src/runtime/logger.ts`** — `appendFileSync` is called on every log line in every module. In a daemon process with frequent loop ticks, this accumulates. Use `fs.createWriteStream` instead.

3. **`src/runtime/event-server.ts`** — `processEventFile()` is in the fs.watch callback, not the hot loop. Medium priority.

4. **`src/knowledge/memory-persistence.ts`** — called during observation and garbage collection, not every tick. Medium priority.

5. **`src/knowledge/knowledge-graph.ts`** and **`src/knowledge/vector-index.ts`** — constructor-only sync. Low impact once running.

6. **`src/state-manager.ts`** — `ensureDirectories` is constructor-only. Very low impact.

7. **`src/execution/task-prompt-builder.ts`** — called once per task generation. Low impact.

8. **`src/utils/json-io.ts`** — no callers in src. Effectively dead. Remove or ignore.

---

## 12. Test Files Using Sync fs APIs

Tests use sync fs APIs extensively for test setup (reading fixture files, checking outputs) — this is expected test infrastructure and does NOT need to change unless the modules under test change their signatures.

Key test files using sync fs:
- `tests/logger.test.ts` — uses `fs.existsSync`, `fs.readFileSync`, `fs.readdirSync` for assertions
- `tests/plugin-loader.test.ts` — uses `fs.existsSync`, `fs.readFileSync` for assertion
- `tests/strategy-template-registry.test.ts` — uses `fs.existsSync`, `fs.readFileSync`
- `tests/file-existence-datasource.test.ts` — uses `fs.writeFileSync` to create fixtures
- `tests/trust-manager.test.ts` — uses `fs.existsSync`, `fs.readFileSync`, `fs.readdirSync`
- `tests/observation-engine-context.test.ts` — uses `fs.writeFileSync` for fixtures

If `DriveSystem` methods become async, their test callers (`await drive.readEventQueue()`, etc.) will need updating. The test files themselves do not need to remove their own sync fs assertions.

---

## Summary Table

| File | Sync APIs | Containing Functions | Already Async Fn? | fsp Import? | Risk |
|---|---|---|---|---|---|
| state-manager.ts | mkdirSync | ensureDirectories | No (constructor) | Yes | LOW |
| task-prompt-builder.ts | existsSync, readFileSync | buildTaskGenerationPrompt | Yes | No | LOW |
| drive-system.ts | 18 calls, all types | 8 functions all sync | No | No | HIGH |
| json-io.ts | readFileSync, writeFileSync | readJsonFileSync, writeJsonFileSync | No (dead code) | Yes | LOW (dead) |
| logger.ts | 11 calls | writeToFile, rotateIfNeeded, rotateCurrent | No | No | HIGH |
| event-server.ts | 6 calls | startFileWatcher, processEventFile | No (fs.watch cb) | Yes | MEDIUM |
| memory-persistence.ts | 8 calls | atomicWrite, readJsonFile, getDirectorySize | No (async already exists) | Yes | MEDIUM |
| knowledge-graph.ts | existsSync, readFileSync | _loadSync (constructor only) | No | Yes | LOW |
| vector-index.ts | existsSync, readFileSync | _loadSync (constructor only) | No | Yes | LOW |

---

## Recommended Conversion Order

1. **task-prompt-builder.ts** (trivial, 2 lines, already in async fn)
2. **knowledge-graph.ts + vector-index.ts** (async factory pattern, low cascade)
3. **state-manager.ts** (constructor mkdirSync only, lazy-init pattern)
4. **memory-persistence.ts** (callers switch to async variants that already exist)
5. **drive-system.ts** (highest priority for loop performance, highest cascade risk — do last, carefully)
6. **event-server.ts** (fs.watch constraint, fire-and-forget pattern)
7. **logger.ts** (use fs.createWriteStream instead of appendFileSync — no API changes needed)
8. **json-io.ts** (remove dead sync exports or leave as-is)
