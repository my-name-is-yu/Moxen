import { StateManager } from '../state/manager.js';
import { GapAnalysisEngine } from '../engines/gap-analysis.js';
import { SatisficingEngine } from '../engines/satisficing.js';
import { StallDetectionEngine } from '../engines/stall-detection.js';
import { VerificationRunner, calculateProgress } from '../engines/verification.js';
import type { Goal, StateVectorElement } from '../state/models.js';
import type { Checklist } from '../state/models.js';
import { Checklist as ChecklistSchema } from '../state/models.js';
import { debug } from '../debug.js';

export interface PostToolUseInput {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
}

export interface PostToolUseResult {
  goalsUpdated: number;
  goalsCompleted: string[];
  stallResetsApplied: string[];
}

// Error-like patterns in tool output
const ERROR_PATTERNS = [
  /error/i,
  /exception/i,
  /failed/i,
  /failure/i,
  /fatal/i,
  /panic/i,
  /traceback/i,
];

function hasErrorOutput(output: string): boolean {
  return ERROR_PATTERNS.some(p => p.test(output));
}

// Heuristics: return a partial state vector update based on tool type and output.
// NOTE: Write/Edit no longer produce a progress bump here — progress is now
// driven exclusively by checklist verification via VerificationRunner.
function deriveStateUpdates(
  input: PostToolUseInput,
): Record<string, Partial<StateVectorElement>> {
  const updates: Record<string, Partial<StateVectorElement>> = {};
  const output = input.tool_output ?? '';
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const now = new Date().toISOString();

  const hasError = hasErrorOutput(output);

  // Bash + test command → update quality_score
  if (toolName === 'Bash') {
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
    if (/\btest\b|jest|vitest|pytest|mocha|rspec|go test/i.test(command)) {
      // Detect test pass/fail from common test runner output patterns.
      //
      // Positive signals (test suite passed):
      //   "15 passed, 0 failed" / "Tests: 15 passed" / "PASSED" / "All tests pass"
      // Negative signals (test suite failed — at least 1 failure):
      //   "2 failed" / "FAILED" / "AssertionError" / "Error:" (but NOT "0 failed")
      //
      // Strategy: first look for an explicit non-zero failure count, then look
      // for failure keywords not preceded by "0 "; if neither matches, check for
      // any pass indicator.
      // Non-zero failure: "2 failed", "failed: 3", exact "FAILED", "AssertionError"
      // Note: we deliberately avoid /i flag on "FAILED" to not match "0 failed".
      const nonZeroFail =
        /[1-9]\d*\s+failed/i.test(output) ||
        /failed:\s*[1-9]/i.test(output) ||
        /\bFAILED\b/.test(output) ||
        /AssertionError/i.test(output);
      const anyPassIndicator = /\bpassed\b|PASSED|all tests pass|\bok\b/i.test(output);
      const passed = !nonZeroFail && anyPassIndicator;
      updates['quality_score'] = {
        value: passed ? 1.0 : 0.0,
        confidence: 0.9,
        observed_at: now,
        source: 'tool_output',
        observation_method: 'test_runner_output',
      };
    }
  }

  // Any tool with error output → note in state
  if (hasError) {
    updates['last_error'] = {
      value: -1,
      confidence: 0.8,
      observed_at: now,
      source: 'tool_output',
      observation_method: 'error_pattern_match',
    };
  }

  return updates;
}

// Merge derived updates into the goal's state_vector.
// Progress is now set absolutely (not additively); all other dimensions use
// the normal merge (existing fields preserved, patch fields overwrite).
function applyStateUpdates(
  goal: Goal,
  updates: Record<string, Partial<StateVectorElement>>,
): void {
  for (const [dim, patch] of Object.entries(updates)) {
    const existing = goal.state_vector[dim];

    if (existing) {
      goal.state_vector[dim] = { ...existing, ...patch };
    } else {
      // New dimension — fill required fields with defaults
      goal.state_vector[dim] = {
        value: patch.value ?? 0,
        confidence: patch.confidence ?? 0.5,
        observed_at: patch.observed_at ?? new Date().toISOString(),
        source: patch.source ?? 'tool_output',
        observation_method: patch.observation_method ?? '',
      };
    }
  }
}

/**
 * Apply an absolute progress value to a goal's state vector.
 * This replaces any existing progress value rather than adding to it.
 */
function applyAbsoluteProgress(goal: Goal, progress: number, now: string): void {
  const existing = goal.state_vector['progress'];
  goal.state_vector['progress'] = {
    // preserve any extra fields from an existing entry, then override with new values
    ...(existing ?? {}),
    value: Math.min(1.0, Math.max(0.0, progress)),
    confidence: 0.85,
    observed_at: now,
    source: 'tool_output',
    observation_method: 'checklist_verification',
  };
}

/**
 * Resolve the project root from a file path written by the agent.
 *
 * The .motiva directory sits at the project root; if the written file is
 * inside `.motiva/goals/` we can walk up two levels.  For any other file we
 * fall back to the provided `fallbackRoot`.
 */
function resolveProjectRoot(filePath: string | undefined, fallbackRoot: string): string {
  if (!filePath) return fallbackRoot;
  // e.g. /some/project/.motive/goals/goal-abc-checklist.json
  //   → /some/project
  const motive = filePath.lastIndexOf('/.motiva/');
  if (motive !== -1) return filePath.slice(0, motive);
  return fallbackRoot;
}

/**
 * Detect whether a Write tool call targets a checklist file inside the
 * `.motiva/goals/` directory.
 */
function isChecklistWrite(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== 'Write') return false;
  const filePath = typeof toolInput['file_path'] === 'string' ? toolInput['file_path'] : '';
  return /[/\\]\.motiva[/\\]goals[/\\][^/\\]+-checklist\.json$/.test(filePath);
}

export async function processPostToolUse(
  input: PostToolUseInput,
  projectRoot?: string,
): Promise<PostToolUseResult> {
  const root = projectRoot ?? process.cwd();
  debug('post-tool-use', 'entry', { tool_name: input.tool_name, has_output: Boolean(input.tool_output) });

  const manager = new StateManager(root);
  const state = manager.loadState();

  const gapEngine = new GapAnalysisEngine();
  const satisficingEngine = new SatisficingEngine();
  const stallEngine = new StallDetectionEngine();

  // Seed stall engine from persisted stall state
  for (const [tool, count] of Object.entries(state.stall_state.consecutive_failures)) {
    for (let i = 0; i < count; i++) {
      stallEngine.onFailure(tool);
    }
  }

  const stateUpdates = deriveStateUpdates(input);
  const hasError = hasErrorOutput(input.tool_output ?? '');
  debug('post-tool-use', 'tool result', { tool_name: input.tool_name, has_error: hasError, state_updates: Object.keys(stateUpdates) });

  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const now = new Date().toISOString();

  const goals = manager.loadActiveGoals();
  const goalsCompleted: string[] = [];
  const stallResetsApplied: string[] = [];

  // ------------------------------------------------------------------
  // Case A: Agent writes a checklist file
  // ------------------------------------------------------------------
  if (isChecklistWrite(toolName, toolInput)) {
    const filePath = typeof toolInput['file_path'] === 'string' ? toolInput['file_path'] : '';
    const detectedRoot = resolveProjectRoot(filePath, root);
    const verifier = new VerificationRunner(detectedRoot, 200);

    try {
      // Parse the content the agent wrote
      const rawContent = typeof toolInput['content'] === 'string' ? toolInput['content'] : '';
      const parsedChecklist = ChecklistSchema.parse(JSON.parse(rawContent)) as Checklist;

      // Mark the matching goal as having a checklist
      const matchingGoal = goals.find(g => g.id === parsedChecklist.goal_id);
      if (matchingGoal) {
        matchingGoal.checklist_created = true;
        manager.saveGoal(matchingGoal);
      }

      // Verify all items and compute progress
      const verifiedItems = verifier.verifyAll(parsedChecklist.items);
      const progress = calculateProgress(verifiedItems);

      // Persist updated checklist
      const updatedChecklist: Checklist = {
        ...parsedChecklist,
        items: verifiedItems,
        updated_at: now,
      };
      manager.saveChecklist(updatedChecklist);

      debug('post-tool-use', 'checklist write processed', {
        goal_id: parsedChecklist.goal_id,
        items: verifiedItems.length,
        progress,
      });

      // Apply progress to the matching goal
      if (matchingGoal) {
        applyAbsoluteProgress(matchingGoal, progress, now);
        applyStateUpdates(matchingGoal, stateUpdates);
        matchingGoal.gaps = gapEngine.computeGaps(matchingGoal);
        const judgment = satisficingEngine.judgeCompletion(matchingGoal.gaps);
        if (judgment.status === 'completed') {
          matchingGoal.status = 'completed';
          goalsCompleted.push(matchingGoal.id);
          state.active_goal_ids = state.active_goal_ids.filter(id => id !== matchingGoal.id);
          debug('post-tool-use', 'goal completed after checklist write', { goal_id: matchingGoal.id });
        }
        manager.saveGoal(matchingGoal);
      }

      // Update remaining goals (no progress change — apply other state updates only)
      for (const goal of goals) {
        if (matchingGoal && goal.id === matchingGoal.id) continue;
        applyStateUpdates(goal, stateUpdates);
        goal.gaps = gapEngine.computeGaps(goal);
        const judgment = satisficingEngine.judgeCompletion(goal.gaps);
        if (judgment.status === 'completed') {
          goal.status = 'completed';
          goalsCompleted.push(goal.id);
          state.active_goal_ids = state.active_goal_ids.filter(id => id !== goal.id);
        }
        manager.saveGoal(goal);
      }
    } catch (err) {
      debug('post-tool-use', 'checklist write failed — falling through to normal path', { err: String(err) });
      // Fall through: treat as a normal file write below
      for (const goal of goals) {
        applyStateUpdates(goal, stateUpdates);
        goal.gaps = gapEngine.computeGaps(goal);
        const judgment = satisficingEngine.judgeCompletion(goal.gaps);
        if (judgment.status === 'completed') {
          goal.status = 'completed';
          goalsCompleted.push(goal.id);
          state.active_goal_ids = state.active_goal_ids.filter(id => id !== goal.id);
        }
        manager.saveGoal(goal);
      }
    }
  }

  // ------------------------------------------------------------------
  // Case B / C: Write/Edit on a regular file, or any other tool
  // ------------------------------------------------------------------
  else if ((toolName === 'Write' || toolName === 'Edit') && goals.some(g => g.checklist_created)) {
    // Case B: at least one goal has a checklist — re-verify and update progress
    const detectedRoot = resolveProjectRoot(
      typeof toolInput['file_path'] === 'string' ? toolInput['file_path'] : undefined,
      root,
    );
    const verifier = new VerificationRunner(detectedRoot, 200);

    for (const goal of goals) {
      applyStateUpdates(goal, stateUpdates);

      if (goal.checklist_created) {
        try {
          const checklist = manager.loadChecklist(goal.id);
          if (checklist) {
            // Skip bash verification on Write/Edit hot path (reserved for `motiva verify`)
            const nonBashItems = checklist.items.filter(i => i.verification.type !== 'bash');
            const bashItems = checklist.items.filter(i => i.verification.type === 'bash');
            const verifiedNonBash = verifier.verifyAll(nonBashItems);
            const verifiedItems = [...verifiedNonBash, ...bashItems];
            const progress = calculateProgress(verifiedItems);

            const updatedChecklist: Checklist = {
              ...checklist,
              items: verifiedItems,
              updated_at: now,
            };
            manager.saveChecklist(updatedChecklist);

            applyAbsoluteProgress(goal, progress, now);
            debug('post-tool-use', 'checklist re-verified', { goal_id: goal.id, progress });
          }
        } catch (err) {
          debug('post-tool-use', 'checklist re-verification failed', { goal_id: goal.id, err: String(err) });
          // Progress not updated — leave as-is
        }
      }
      // Case C (no checklist for this goal): no progress update at all

      goal.gaps = gapEngine.computeGaps(goal);
      const judgment = satisficingEngine.judgeCompletion(goal.gaps);
      if (judgment.status === 'completed') {
        goal.status = 'completed';
        goalsCompleted.push(goal.id);
        state.active_goal_ids = state.active_goal_ids.filter(id => id !== goal.id);
        debug('post-tool-use', 'goal completed', { goal_id: goal.id, judgment: judgment.reason });
      }

      manager.saveGoal(goal);
    }
  } else {
    // Any other tool (Bash, Read, etc.) or Write/Edit with no checklists at all
    for (const goal of goals) {
      applyStateUpdates(goal, stateUpdates);
      goal.gaps = gapEngine.computeGaps(goal);
      const judgment = satisficingEngine.judgeCompletion(goal.gaps);
      if (judgment.status === 'completed') {
        goal.status = 'completed';
        goalsCompleted.push(goal.id);
        state.active_goal_ids = state.active_goal_ids.filter(id => id !== goal.id);
        debug('post-tool-use', 'goal completed', { goal_id: goal.id, judgment: judgment.reason });
      }
      manager.saveGoal(goal);
    }
  }

  // On success (no error), reset stall counters for this tool
  if (!hasError) {
    stallEngine.onSuccess(input.tool_name);
    state.stall_state.consecutive_failures[input.tool_name] = 0;
    stallResetsApplied.push(input.tool_name);
    debug('post-tool-use', 'stall reset applied', { tool_name: input.tool_name });
  }

  // Persist updated stall state
  // (failure side is managed in post-tool-failure; here we only clear on success)
  manager.saveState(state);

  // Log action
  manager.appendLog({
    event: 'post_tool_use',
    tool_name: input.tool_name,
    has_error: hasError,
    goals_updated: goals.map(g => g.id),
    goals_completed: goalsCompleted,
    stall_resets: stallResetsApplied,
    timestamp: new Date().toISOString(),
  });

  debug('post-tool-use', 'exit', { goals_updated: goals.length, goals_completed: goalsCompleted.length, stall_resets: stallResetsApplied });

  return {
    goalsUpdated: goals.length,
    goalsCompleted,
    stallResetsApplied,
  };
}

async function main(): Promise<void> {
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let input: PostToolUseInput = { tool_name: 'Unknown' };
  if (rawInput.trim()) {
    try {
      input = JSON.parse(rawInput) as PostToolUseInput;
    } catch {
      // Unparseable stdin — use defaults
    }
  }

  await processPostToolUse(input);
  process.exit(0);
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith('post-tool-use.ts') ||
    process.argv[1].endsWith('post-tool-use.js'))
) {
  main().catch(() => process.exit(1));
}
