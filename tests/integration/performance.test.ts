/**
 * Performance benchmark tests for Motiva hooks.
 *
 * Targets (pure JS function call — no process spawn overhead):
 *   SessionStart  < 200ms avg and p95
 *   All others    < 300ms avg and p95
 *
 * Strategy:
 *   1 warm-up iteration (module/JIT warm-up), then N measured iterations.
 *   Reports avg and p95; asserts against target thresholds.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { StateManager } from '../../src/state/manager.js';
import { Goal } from '../../src/state/models.js';
import { processSessionStart } from '../../src/hooks/session-start.js';
import { processStop } from '../../src/hooks/stop.js';
import { run as runUserPrompt } from '../../src/hooks/user-prompt.js';
import { run as runPreToolUse } from '../../src/hooks/pre-tool-use.js';
import { processPostToolUse } from '../../src/hooks/post-tool-use.js';
import { processPostToolFailure } from '../../src/hooks/post-tool-failure.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ITERATIONS = 10;
const SESSION_START_TARGET_MS = 200;
const DEFAULT_TARGET_MS = 300;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(samples: number[]): { avg: number; p95: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
  return {
    avg,
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function createRealisticGoal(
  overrides: Partial<Parameters<typeof Goal.parse>[0]> = {},
): Goal {
  return Goal.parse({
    title: 'Implement feature X',
    description: 'Build and test the feature X module with full coverage',
    type: 'deadline',
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 1 week out
    achievement_thresholds: {
      progress: 0.9,
      quality_score: 0.8,
      test_coverage: 0.85,
    },
    state_vector: {
      progress: {
        value: 0.45,
        confidence: 0.75,
        source: 'tool_output',
        observation_method: 'file_write_heuristic',
      },
      quality_score: {
        value: 0.6,
        confidence: 0.9,
        source: 'tool_output',
        observation_method: 'test_runner_output',
      },
      test_coverage: {
        value: 0.5,
        confidence: 0.8,
        source: 'tool_output',
        observation_method: 'coverage_report',
      },
      complexity: {
        value: 0.3,
        confidence: 0.5,
        source: 'llm_estimate',
        observation_method: 'manual',
      },
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let manager: StateManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'motive-perf-test-'));
  manager = new StateManager(tmpDir);
  manager.init();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedGoals(count = 3): Goal[] {
  const goals: Goal[] = [];
  for (let i = 0; i < count; i++) {
    const g = createRealisticGoal({ title: `Performance goal ${i + 1}` });
    manager.addGoal(g);
    goals.push(g);
  }
  return goals;
}

// ---------------------------------------------------------------------------
// 1. SessionStart performance  (target: < 200ms)
// ---------------------------------------------------------------------------

describe('SessionStart performance', () => {
  it('avg and p95 are under 200ms with 3 active goals', async () => {
    seedGoals(3);

    // Warm-up
    await processSessionStart({}, tmpDir);

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      await processSessionStart({}, tmpDir);
      samples.push(performance.now() - t0);
    }

    const { avg, p95, min, max } = stats(samples);
    console.log(
      `[SessionStart] avg=${avg.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms`,
    );

    expect(avg).toBeLessThan(SESSION_START_TARGET_MS);
    expect(p95).toBeLessThan(SESSION_START_TARGET_MS);
  });
});

// ---------------------------------------------------------------------------
// 2. UserPromptSubmit performance  (target: < 300ms)
// ---------------------------------------------------------------------------

describe('UserPromptSubmit performance', () => {
  it('avg and p95 are under 300ms', () => {
    const goals = seedGoals(3);
    const samplePrompt = `Please help me implement ${goals[0].title} and write tests for it`;

    // Warm-up
    runUserPrompt({ prompt: samplePrompt }, tmpDir);

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      runUserPrompt({ prompt: samplePrompt }, tmpDir);
      samples.push(performance.now() - t0);
    }

    const { avg, p95, min, max } = stats(samples);
    console.log(
      `[UserPromptSubmit] avg=${avg.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms`,
    );

    expect(avg).toBeLessThan(DEFAULT_TARGET_MS);
    expect(p95).toBeLessThan(DEFAULT_TARGET_MS);
  });
});

// ---------------------------------------------------------------------------
// 3. PreToolUse performance  (target: < 300ms)
// ---------------------------------------------------------------------------

describe('PreToolUse performance', () => {
  it('avg and p95 are under 300ms for safe tool calls', () => {
    seedGoals(2);

    const safeInput = {
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/safe-output.ts',
        content: 'export const x = 1;\n',
      },
    };

    // Warm-up
    runPreToolUse(safeInput);

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      runPreToolUse(safeInput);
      samples.push(performance.now() - t0);
    }

    const { avg, p95, min, max } = stats(samples);
    console.log(
      `[PreToolUse/safe] avg=${avg.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms`,
    );

    expect(avg).toBeLessThan(DEFAULT_TARGET_MS);
    expect(p95).toBeLessThan(DEFAULT_TARGET_MS);
  });

  it('avg and p95 are under 300ms for irreversible tool calls (blocked path)', () => {
    const irreversibleInput = {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    };

    // Warm-up
    runPreToolUse(irreversibleInput);

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      runPreToolUse(irreversibleInput);
      samples.push(performance.now() - t0);
    }

    const { avg, p95, min, max } = stats(samples);
    console.log(
      `[PreToolUse/irreversible] avg=${avg.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms`,
    );

    expect(avg).toBeLessThan(DEFAULT_TARGET_MS);
    expect(p95).toBeLessThan(DEFAULT_TARGET_MS);
  });
});

// ---------------------------------------------------------------------------
// 4. PostToolUse performance  (target: < 300ms)
// ---------------------------------------------------------------------------

describe('PostToolUse performance', () => {
  it('avg and p95 are under 300ms with 3 active goals and Write tool simulation', async () => {
    seedGoals(3);

    const input = {
      tool_name: 'Write',
      tool_input: { file_path: 'src/feature-x.ts', content: 'export const featureX = true;\n' },
      tool_output: 'File written successfully',
    };

    // Warm-up
    await processPostToolUse(input, tmpDir);

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      await processPostToolUse(input, tmpDir);
      samples.push(performance.now() - t0);
    }

    const { avg, p95, min, max } = stats(samples);
    console.log(
      `[PostToolUse] avg=${avg.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms`,
    );

    expect(avg).toBeLessThan(DEFAULT_TARGET_MS);
    expect(p95).toBeLessThan(DEFAULT_TARGET_MS);
  });
});

// ---------------------------------------------------------------------------
// 5. PostToolFailure performance  (target: < 300ms)
// ---------------------------------------------------------------------------

describe('PostToolFailure performance', () => {
  it('avg and p95 are under 300ms', async () => {
    seedGoals(2);

    // Pre-seed the stall counter so the engine has history to process
    const state = manager.loadState();
    state.stall_state.consecutive_failures['Bash'] = 2;
    manager.saveState(state);

    const input = {
      tool_name: 'Bash',
      error: 'Command exited with code 1: npm run build',
    };

    // Warm-up
    await processPostToolFailure(input, tmpDir);

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      await processPostToolFailure(input, tmpDir);
      samples.push(performance.now() - t0);
    }

    const { avg, p95, min, max } = stats(samples);
    console.log(
      `[PostToolFailure] avg=${avg.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms`,
    );

    expect(avg).toBeLessThan(DEFAULT_TARGET_MS);
    expect(p95).toBeLessThan(DEFAULT_TARGET_MS);
  });
});

// ---------------------------------------------------------------------------
// 6. Stop performance  (target: < 300ms)
// ---------------------------------------------------------------------------

describe('Stop performance', () => {
  it('avg and p95 are under 300ms with 3 active goals, one near completion', async () => {
    // Two normal goals
    seedGoals(2);
    // One goal near completion (progress ~0.95, above threshold of 0.9)
    const nearDone = createRealisticGoal({
      title: 'Near-complete goal',
      state_vector: {
        progress: {
          value: 0.95,
          confidence: 0.9,
          source: 'tool_output',
          observation_method: 'file_write_heuristic',
        },
        quality_score: {
          value: 0.9,
          confidence: 0.95,
          source: 'tool_output',
          observation_method: 'test_runner_output',
        },
        test_coverage: {
          value: 0.9,
          confidence: 0.85,
          source: 'tool_output',
          observation_method: 'coverage_report',
        },
      },
    });
    manager.addGoal(nearDone);

    const input = { session_id: 'perf-test-session', stop_reason: 'task_complete' };

    // Warm-up
    await processStop(input, tmpDir);

    // Re-seed after warm-up since goals may have been marked completed
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), 'motive-perf-stop-'));
    manager = new StateManager(tmpDir);
    manager.init();
    seedGoals(2);
    manager.addGoal(
      createRealisticGoal({
        title: 'Near-complete goal (bench)',
        state_vector: {
          progress: {
            value: 0.95,
            confidence: 0.9,
            source: 'tool_output',
            observation_method: 'file_write_heuristic',
          },
          quality_score: {
            value: 0.9,
            confidence: 0.95,
            source: 'tool_output',
            observation_method: 'test_runner_output',
          },
          test_coverage: {
            value: 0.9,
            confidence: 0.85,
            source: 'tool_output',
            observation_method: 'coverage_report',
          },
        },
      }),
    );

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      await processStop(input, tmpDir);
      samples.push(performance.now() - t0);
    }

    const { avg, p95, min, max } = stats(samples);
    console.log(
      `[Stop] avg=${avg.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms`,
    );

    expect(avg).toBeLessThan(DEFAULT_TARGET_MS);
    expect(p95).toBeLessThan(DEFAULT_TARGET_MS);
  });
});

// ---------------------------------------------------------------------------
// 7. Full lifecycle overhead  (informational — no hard assert)
// ---------------------------------------------------------------------------

describe('Full lifecycle overhead (informational)', () => {
  it('logs total time for SessionStart → UserPrompt → PreToolUse → PostToolUse → Stop', async () => {
    seedGoals(3);

    const sessionInput = { session_id: 'lifecycle-perf-test' };
    const promptInput = { prompt: 'Implement the feature X module with full test coverage' };
    const preToolInput = {
      tool_name: 'Write',
      tool_input: { file_path: 'src/feature.ts', content: 'export const x = 1;\n' },
    };
    const postToolInput = {
      tool_name: 'Write',
      tool_input: { file_path: 'src/feature.ts', content: 'export const x = 1;\n' },
      tool_output: 'File written successfully',
    };
    const stopInput = { session_id: 'lifecycle-perf-test', stop_reason: 'task_complete' };

    // Warm-up
    await processSessionStart(sessionInput, tmpDir);
    runUserPrompt(promptInput, tmpDir);
    runPreToolUse(preToolInput);
    await processPostToolUse(postToolInput, tmpDir);
    await processStop(stopInput, tmpDir);

    // Fresh state for measured run
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), 'motive-perf-lifecycle-'));
    manager = new StateManager(tmpDir);
    manager.init();
    seedGoals(3);

    const t0 = performance.now();
    await processSessionStart(sessionInput, tmpDir);
    runUserPrompt(promptInput, tmpDir);
    runPreToolUse(preToolInput);
    await processPostToolUse(postToolInput, tmpDir);
    await processStop(stopInput, tmpDir);
    const total = performance.now() - t0;

    console.log(`[Full lifecycle] total=${total.toFixed(1)}ms`);

    // Informational only — just verify the run completed without error
    expect(total).toBeGreaterThan(0);
  });
});
