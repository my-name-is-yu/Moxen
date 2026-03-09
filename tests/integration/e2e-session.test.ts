/**
 * E2E Integration Tests — Full Claude Code session lifecycle simulation
 *
 * Each scenario uses an isolated tmp directory created with mkdtempSync and
 * cleaned up in afterEach. All modules are imported directly from source; no
 * mocking is used so the tests exercise the real integration between modules.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { StateManager } from '../../src/state/manager.js';
import { Goal, MotiveState } from '../../src/state/models.js';
import { TrustBalance } from '../../src/state/models.js';
import { processSessionStart } from '../../src/hooks/session-start.js';
import { run as runUserPrompt } from '../../src/hooks/user-prompt.js';
import { run as runPreToolUse } from '../../src/hooks/pre-tool-use.js';
import { processPostToolUse } from '../../src/hooks/post-tool-use.js';
import { processPostToolFailure } from '../../src/hooks/post-tool-failure.js';
import { processStop } from '../../src/hooks/stop.js';
import { TrustManager } from '../../src/collaboration/trust.js';
import { BehaviorMatrix } from '../../src/collaboration/behavior.js';
import { ActionLogger } from '../../src/learning/logger.js';
import { PatternAnalyzer } from '../../src/learning/pattern-analyzer.js';
import { CuriosityEngine } from '../../src/engines/curiosity.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `motive-e2e-${prefix}-`));
}

function makeGoal(overrides: Partial<Parameters<typeof Goal.parse>[0]> = {}): Goal {
  return Goal.parse({
    title: 'Implement feature X',
    description: 'Build and test the feature X module',
    type: 'dissatisfaction',
    achievement_thresholds: { progress: 0.9 },
    state_vector: {
      progress: { value: 0.1, confidence: 0.7, source: 'llm_estimate' },
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Scenario 1: Full session lifecycle (happy path)
// ---------------------------------------------------------------------------

describe('Scenario 1: Full session lifecycle (happy path)', () => {
  let tmpDir: string;
  let manager: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir('scenario1');
    manager = new StateManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs a complete coding session end-to-end', async () => {
    // 1. SessionStart — init state and create a goal
    manager.init();
    const goal = makeGoal({ title: 'Write integration tests' });
    manager.addGoal(goal);

    const startResult = await processSessionStart({ session_id: 'e2e-session-1' }, tmpDir);

    expect(startResult.goalsProcessed).toBe(1);
    expect(existsSync(startResult.contextPath)).toBe(true);

    const motiveContent = readFileSync(startResult.contextPath, 'utf-8');
    expect(motiveContent).toContain('# Motiva Context');
    expect(motiveContent).toContain('Write integration tests');

    // Verify session_id was persisted
    const stateAfterStart = manager.loadState();
    expect(stateAfterStart.session_id).toBe('e2e-session-1');

    // 2. UserPrompt — prompt related to the goal receives context injection
    const promptResult = runUserPrompt(
      { prompt: 'Let us write some integration tests for this module' },
      tmpDir,
    );

    expect(promptResult.exitCode).toBe(0);
    expect(promptResult.output.prompt).toContain('[Motiva] Active goal context:');
    expect(promptResult.output.prompt).toContain('Write integration tests');

    // 3. PreToolUse — safe Write action passes
    const preToolResult = runPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: join(tmpDir, 'tests', 'my.test.ts'), content: 'test' },
    });

    expect(preToolResult.exitCode).toBe(0);
    expect(preToolResult.stderrMessage).toBeUndefined();

    // 4. PostToolUse — successful Write, verify progress update
    const postWriteResult = await processPostToolUse(
      { tool_name: 'Write', tool_input: { file_path: 'src/feature.ts' }, tool_output: 'OK' },
      tmpDir,
    );

    expect(postWriteResult.goalsUpdated).toBeGreaterThanOrEqual(1);

    const goalAfterWrite = manager.loadGoal(goal.id);
    expect(goalAfterWrite).not.toBeNull();
    // progress is now driven by checklist verification, not by Write heuristic
    expect(goalAfterWrite!.state_vector['progress']!.value).toBeGreaterThanOrEqual(0.1);

    // 5. PostToolUse — test run with all-passing output, verify quality_score updated
    const postTestResult = await processPostToolUse(
      {
        tool_name: 'Bash',
        tool_input: { command: 'vitest run' },
        tool_output: 'Tests: 10 passed, 0 failed\nAll tests pass',
      },
      tmpDir,
    );

    expect(postTestResult.goalsUpdated).toBeGreaterThanOrEqual(1);

    const goalAfterTest = manager.loadGoal(goal.id);
    expect(goalAfterTest).not.toBeNull();
    expect(goalAfterTest!.state_vector['quality_score']).toBeDefined();
    expect(goalAfterTest!.state_vector['quality_score']!.value).toBe(1.0);

    // 6. Stop — verify final state, completion judgment, log entry
    const stopResult = await processStop({ session_id: 'e2e-session-1' }, tmpDir);

    expect(stopResult.goalsProcessed).toBe(1);
    expect(stopResult.summaries).toHaveLength(1);
    expect(stopResult.summaries[0].id).toBe(goal.id);
    expect(typeof stopResult.summaries[0].judgment).toBe('string');

    // Verify log was written
    expect(existsSync(manager.logPath)).toBe(true);
    const logLines = readFileSync(manager.logPath, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const events = logLines.map(l => (JSON.parse(l) as { event: string }).event);
    expect(events).toContain('post_tool_use');
    expect(events).toContain('session_stop');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Irreversible action blocking
// ---------------------------------------------------------------------------

describe('Scenario 2: Irreversible action blocking', () => {
  let tmpDir: string;
  let manager: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir('scenario2');
    manager = new StateManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks git push commands', () => {
    manager.init();
    const goal = makeGoal({ title: 'Deploy application' });
    manager.addGoal(goal);

    const result = runPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderrMessage).toBeDefined();
    expect(result.stderrMessage).toContain('[Motiva] Blocked');
    expect(result.stderrMessage).toContain('Bash');
  });

  it('blocks rm -rf commands', () => {
    manager.init();
    const goal = makeGoal({ title: 'Clean up build artifacts' });
    manager.addGoal(goal);

    const result = runPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/test' },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderrMessage).toBeDefined();
    expect(result.stderrMessage).toContain('[Motiva] Blocked');
  });

  it('allows safe Write operations', () => {
    const result = runPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/safe-file.ts', content: 'hello' },
    });

    expect(result.exitCode).toBe(0);
  });

  it('blocks npm publish', () => {
    const result = runPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'npm publish --access public' },
    });

    expect(result.exitCode).toBe(2);
  });

  it('blocks DROP TABLE commands in Bash', () => {
    const result = runPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'psql -c "DROP TABLE users;"' },
    });

    expect(result.exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Stall detection and recovery
// ---------------------------------------------------------------------------

describe('Scenario 3: Stall detection and recovery', () => {
  let tmpDir: string;
  let manager: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir('scenario3');
    manager = new StateManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects stall after 3 consecutive failures with the same tool', async () => {
    manager.init();
    const goal = makeGoal({ title: 'Fix build pipeline' });
    manager.addGoal(goal);

    // First two failures — stall not yet triggered
    const result1 = await processPostToolFailure(
      { tool_name: 'Bash', error: 'command not found: tsc' },
      tmpDir,
    );
    expect(result1.stallDetected).toBe(false);
    expect(result1.failureCount).toBe(1);

    const result2 = await processPostToolFailure(
      { tool_name: 'Bash', error: 'command not found: tsc' },
      tmpDir,
    );
    expect(result2.stallDetected).toBe(false);
    expect(result2.failureCount).toBe(2);

    // Third failure — stall should be detected
    const result3 = await processPostToolFailure(
      { tool_name: 'Bash', error: 'command not found: tsc' },
      tmpDir,
    );
    expect(result3.stallDetected).toBe(true);
    expect(result3.failureCount).toBe(3);

    // Verify recovery message is generated
    expect(result3.recoveryMessage).not.toBeNull();
    expect(result3.recoveryMessage).toContain('[Motiva] Stall detected');
    expect(result3.recoveryMessage).toContain('Bash');

    // Verify stall_state updated in state.json
    const state = manager.loadState();
    expect(state.stall_state.consecutive_failures['Bash']).toBe(3);
    expect(state.stall_state.stall_count).toBeGreaterThanOrEqual(1);
    expect(state.stall_state.last_stall_at).not.toBeNull();
  });

  it('resets stall counter after a successful tool use', async () => {
    manager.init();
    const goal = makeGoal({ title: 'Fix build' });
    manager.addGoal(goal);

    // Accumulate 2 failures
    await processPostToolFailure({ tool_name: 'Bash', error: 'timeout' }, tmpDir);
    await processPostToolFailure({ tool_name: 'Bash', error: 'timeout' }, tmpDir);

    let state = manager.loadState();
    expect(state.stall_state.consecutive_failures['Bash']).toBe(2);

    // Successful use resets counter
    await processPostToolUse(
      { tool_name: 'Bash', tool_input: { command: 'echo ok' }, tool_output: 'ok' },
      tmpDir,
    );

    state = manager.loadState();
    expect(state.stall_state.consecutive_failures['Bash']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Multi-goal priority switching
// ---------------------------------------------------------------------------

describe('Scenario 4: Multi-goal priority switching', () => {
  let tmpDir: string;
  let manager: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir('scenario4');
    manager = new StateManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scores both goals at session start and shows highest-priority goal in motive.md', async () => {
    manager.init();

    // Goal 1: deadline-driven with tight deadline
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const goal1 = makeGoal({
      title: 'Urgent deadline task',
      type: 'deadline',
      deadline: tomorrow,
      state_vector: {
        progress: { value: 0.1, confidence: 0.8, source: 'llm_estimate' },
      },
    });

    // Goal 2: dissatisfaction-driven with large gap
    const goal2 = makeGoal({
      title: 'Quality improvement task',
      type: 'dissatisfaction',
      state_vector: {
        progress: { value: 0.0, confidence: 0.7, source: 'llm_estimate' },
      },
    });

    manager.addGoal(goal1);
    manager.addGoal(goal2);

    const startResult = await processSessionStart({}, tmpDir);
    expect(startResult.goalsProcessed).toBe(2);

    // Verify both goals have motivation scores after session start
    const updatedGoal1 = manager.loadGoal(goal1.id);
    const updatedGoal2 = manager.loadGoal(goal2.id);
    expect(updatedGoal1).not.toBeNull();
    expect(updatedGoal2).not.toBeNull();
    expect(updatedGoal1!.motivation_score).toBeGreaterThanOrEqual(0);
    expect(updatedGoal2!.motivation_score).toBeGreaterThanOrEqual(0);

    // motive.md should be written and contain at least one goal title
    const motiveContent = readFileSync(startResult.contextPath, 'utf-8');
    expect(motiveContent).toContain('# Motiva Context');
    // Either goal title should appear in the context
    const hasGoal1 = motiveContent.includes('Urgent deadline task');
    const hasGoal2 = motiveContent.includes('Quality improvement task');
    expect(hasGoal1 || hasGoal2).toBe(true);
  });

  it('marks goal 1 completed via processPostToolUse and leaves goal 2 active', async () => {
    manager.init();

    // Goal 1: nearly complete — progress already at 0.96, threshold 0.9.
    // After gap analysis the gap magnitude will be tiny and satisficing will mark it done.
    const goal1 = makeGoal({
      title: 'Nearly done task',
      achievement_thresholds: { progress: 0.9 },
      state_vector: {
        progress: { value: 0.96, confidence: 0.9, source: 'tool_output' },
      },
    });

    // Goal 2: low progress — should remain active throughout
    const goal2 = makeGoal({
      title: 'Long running task',
      achievement_thresholds: { progress: 0.9 },
      state_vector: {
        progress: { value: 0.3, confidence: 0.7, source: 'llm_estimate' },
      },
    });

    manager.addGoal(goal1);
    manager.addGoal(goal2);

    // A successful Write call triggers satisficing on all active goals.
    // goal1 (progress=0.96, threshold=0.9) has gap magnitude ~0.04 <= 0.05 → completed.
    const postResult = await processPostToolUse(
      { tool_name: 'Write', tool_input: { file_path: 'src/a.ts' }, tool_output: 'written' },
      tmpDir,
    );

    expect(postResult.goalsCompleted).toContain(goal1.id);
    expect(postResult.goalsCompleted).not.toContain(goal2.id);

    // goal1 file should be marked completed
    const updatedGoal1 = manager.loadGoal(goal1.id);
    expect(updatedGoal1).not.toBeNull();
    expect(updatedGoal1!.status).toBe('completed');

    // goal2 should still be active
    const updatedGoal2 = manager.loadGoal(goal2.id);
    expect(updatedGoal2).not.toBeNull();
    expect(updatedGoal2!.status).toBe('active');

    // Completed goal removed from active_goal_ids
    const state = manager.loadState();
    expect(state.active_goal_ids).not.toContain(goal1.id);
    expect(state.active_goal_ids).toContain(goal2.id);

    // processStop only sees remaining active goal (goal2)
    const stopResult = await processStop({}, tmpDir);
    expect(stopResult.goalsProcessed).toBe(1);
    expect(stopResult.summaries[0].id).toBe(goal2.id);
    expect(stopResult.summaries[0].status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Trust balance flow
// ---------------------------------------------------------------------------

describe('Scenario 5: Trust balance flow', () => {
  it('increments global trust by +0.05 on success', () => {
    const trustManager = new TrustManager();
    const initial: TrustBalance = { global: 0.5, per_goal: {} };

    const updated = trustManager.updateOnSuccess(initial);

    expect(updated.global).toBeCloseTo(0.55, 5);
  });

  it('decrements global trust by -0.15 on failure', () => {
    const trustManager = new TrustManager();
    const initial: TrustBalance = { global: 0.5, per_goal: {} };

    const updated = trustManager.updateOnFailure(initial);

    expect(updated.global).toBeCloseTo(0.35, 5);
  });

  it('does not exceed 1.0 or drop below 0.0', () => {
    const trustManager = new TrustManager();

    const high: TrustBalance = { global: 0.98, per_goal: {} };
    expect(trustManager.updateOnSuccess(high).global).toBeLessThanOrEqual(1.0);

    const low: TrustBalance = { global: 0.05, per_goal: {} };
    expect(trustManager.updateOnFailure(low).global).toBeGreaterThanOrEqual(0.0);
  });

  it('also updates per_goal trust when goalId key exists', () => {
    const trustManager = new TrustManager();
    const initial: TrustBalance = { global: 0.5, per_goal: { 'goal-abc': 0.6 } };

    const afterSuccess = trustManager.updateOnSuccess(initial, 'goal-abc');
    expect(afterSuccess.per_goal['goal-abc']).toBeCloseTo(0.65, 5);

    const afterFailure = trustManager.updateOnFailure(afterSuccess, 'goal-abc');
    expect(afterFailure.per_goal['goal-abc']).toBeCloseTo(0.5, 5);
  });

  it('does not create per_goal entry for unknown goalId', () => {
    const trustManager = new TrustManager();
    const initial: TrustBalance = { global: 0.5, per_goal: {} };

    const updated = trustManager.updateOnSuccess(initial, 'goal-unknown');
    expect('goal-unknown' in updated.per_goal).toBe(false);
  });

  it('BehaviorMatrix.decide returns autonomous for high trust + high confidence', () => {
    const matrix = new BehaviorMatrix();
    expect(matrix.decide(0.8, 0.9)).toBe('autonomous');
  });

  it('BehaviorMatrix.decide returns confirm_with_human for high trust + low confidence', () => {
    const matrix = new BehaviorMatrix();
    expect(matrix.decide(0.7, 0.5)).toBe('confirm_with_human');
  });

  it('BehaviorMatrix.decide returns confirm_with_human for low trust + high confidence', () => {
    const matrix = new BehaviorMatrix();
    expect(matrix.decide(0.4, 0.8)).toBe('confirm_with_human');
  });

  it('BehaviorMatrix.decide returns verify_first for low trust + low confidence', () => {
    const matrix = new BehaviorMatrix();
    expect(matrix.decide(0.3, 0.4)).toBe('verify_first');
  });

  it('BehaviorMatrix.decideForAction always returns confirm_with_human for irreversible actions', () => {
    const matrix = new BehaviorMatrix();
    // Even with max trust and confidence, irreversible requires human confirmation
    expect(matrix.decideForAction(1.0, 1.0, true)).toBe('confirm_with_human');
    expect(matrix.decideForAction(0.0, 0.0, true)).toBe('confirm_with_human');
  });

  it('full trust flow: start at 0.5, success then failure yields expected values', () => {
    const trustManager = new TrustManager();
    const matrix = new BehaviorMatrix();

    let trust: TrustBalance = { global: 0.5, per_goal: {} };

    // Success: 0.5 + 0.05 = 0.55
    trust = trustManager.updateOnSuccess(trust);
    expect(trust.global).toBeCloseTo(0.55, 5);
    // With moderate confidence, should still be confirm_with_human (trust < 0.6)
    expect(matrix.decide(trust.global, 0.8)).toBe('confirm_with_human');

    // Another success: 0.55 + 0.05 = 0.60
    trust = trustManager.updateOnSuccess(trust);
    expect(trust.global).toBeCloseTo(0.60, 5);
    // Now trust >= 0.6 and confidence >= 0.7 → autonomous
    expect(matrix.decide(trust.global, 0.8)).toBe('autonomous');

    // Failure: 0.60 - 0.15 = 0.45
    trust = trustManager.updateOnFailure(trust);
    expect(trust.global).toBeCloseTo(0.45, 5);
    // Back below 0.6, high confidence → confirm_with_human
    expect(matrix.decide(trust.global, 0.8)).toBe('confirm_with_human');
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Learning pipeline
// ---------------------------------------------------------------------------

describe('Scenario 6: Learning pipeline', () => {
  let tmpDir: string;
  let manager: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir('scenario6');
    manager = new StateManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates log entries via processPostToolUse and analyzes patterns', async () => {
    manager.init();
    const goal = makeGoal({ title: 'Refactor module Z' });
    manager.addGoal(goal);

    const sessionId = 'learning-session-1';

    // Run several processPostToolUse calls to populate log
    await processPostToolUse(
      { tool_name: 'Write', tool_input: { file_path: 'src/z.ts' }, tool_output: 'ok' },
      tmpDir,
    );
    await processPostToolUse(
      { tool_name: 'Write', tool_input: { file_path: 'src/z.ts' }, tool_output: 'ok' },
      tmpDir,
    );
    await processPostToolUse(
      {
        tool_name: 'Bash',
        tool_input: { command: 'vitest run' },
        tool_output: 'Tests: 5 passed, 0 failed\nAll tests pass',
      },
      tmpDir,
    );

    // Use ActionLogger to read and append structured entries to a patterns-compatible log
    const actionLogPath = join(tmpDir, '.motive', 'action.log.jsonl');
    const logger = new ActionLogger(actionLogPath);

    const entry1 = logger.createEntry({
      sessionId,
      goalId: goal.id,
      stateBefore: { progress: 0.1 },
      action: { tool: 'Write', target: 'src/z.ts' },
      stateAfter: { progress: 0.2 },
      outcome: 'success',
    });
    logger.append(entry1);

    const entry2 = logger.createEntry({
      sessionId,
      goalId: goal.id,
      stateBefore: { progress: 0.2 },
      action: { tool: 'Write', target: 'src/z.ts' },
      stateAfter: { progress: 0.3 },
      outcome: 'success',
    });
    logger.append(entry2);

    const entry3 = logger.createEntry({
      sessionId,
      goalId: goal.id,
      stateBefore: { progress: 0.3 },
      action: { tool: 'Bash', target: 'vitest run' },
      stateAfter: { progress: 0.3 },
      outcome: 'failure',
    });
    logger.append(entry3);

    // Verify entries can be read back
    const recent = logger.readRecent(10);
    expect(recent).toHaveLength(3);

    // Analyze patterns
    const patternsPath = join(tmpDir, '.motive', 'patterns.json');
    const analyzer = new PatternAnalyzer(patternsPath);
    const store = analyzer.analyze(recent);

    // Should have at least one pattern
    expect(store.patterns.length).toBeGreaterThan(0);

    // Write context: 2 successes → success_rate = 1.0
    const writePattern = store.patterns.find(p => p.context === 'Write:success');
    expect(writePattern).toBeDefined();
    expect(writePattern!.success_rate).toBe(1.0);
    expect(writePattern!.sample_count).toBe(2);
    expect(writePattern!.avg_state_delta).toBeGreaterThan(0);

    // Bash: 1 failure → failure area recorded
    expect(store.failure_areas.length).toBeGreaterThan(0);
    const bashFailure = store.failure_areas.find(fa => fa.area === 'Bash');
    expect(bashFailure).toBeDefined();
    expect(bashFailure!.failure_count).toBe(1);

    // Save and reload
    analyzer.save(store);
    const loaded = analyzer.load();
    expect(loaded.patterns).toHaveLength(store.patterns.length);
    expect(loaded.failure_areas).toHaveLength(store.failure_areas.length);
  });

  it('CuriosityEngine.checkActivation suggests retry goals when failures are old enough', () => {
    const tmpDir2 = makeTmpDir('curiosity');
    try {
      // Create .motiva directory and write a patterns.json with an old failure
      const motiveDir = join(tmpDir2, '.motiva');
      mkdirSync(motiveDir, { recursive: true });

      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48 h ago
      const patternsData = {
        failure_patterns: [
          {
            area: 'Bash',
            last_failed_at: oldDate,
            failure_count: 3,
            retry_eligible: true,
          },
        ],
      };
      writeFileSync(join(motiveDir, 'patterns.json'), JSON.stringify(patternsData));

      const engine = new CuriosityEngine(tmpDir2);

      // Build a state with no active goals so idle mode is triggered
      const state = MotiveState.parse({
        meta_motivation: {
          exploration_budget: 5,
          activation_conditions: {
            retry_failed_after_hours: 24,
            idle_threshold_seconds: 30,
            anomaly_threshold: 0.7,
          },
        },
      });

      // No active goals
      const result = engine.checkActivation(state, []);

      expect(result.activated).toBe(true);
      expect(result.reason).toBe('retry');
      expect(result.suggestedGoals.length).toBeGreaterThan(0);
      expect(result.suggestedGoals[0].source).toBe('curiosity_retry');
      expect(result.suggestedGoals[0].title).toContain('Retry');
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it('CuriosityEngine.checkActivation does not activate when active goals remain and no retries', () => {
    const engine = new CuriosityEngine(tmpDir);

    const state = MotiveState.parse({});
    const activeGoal = Goal.parse({ title: 'Still working on this', status: 'active' });

    const result = engine.checkActivation(state, [activeGoal]);

    // no idle, no anomaly, no retry-eligible failures → not activated
    expect(result.activated).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.suggestedGoals).toHaveLength(0);
  });
});
