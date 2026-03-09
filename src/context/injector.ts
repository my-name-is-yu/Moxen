import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { StateManager } from '../state/manager.js';
import { GapAnalysisEngine } from '../engines/gap-analysis.js';
import { TaskGenerationEngine } from '../engines/task-generation.js';
import type { MotiveState, Goal, Checklist } from '../state/models.js';
import { debug } from '../debug.js';

export class ContextInjector {
  private static readonly MAX_CHARS = 2000; // ~500 tokens
  private manager: StateManager;
  private gapEngine: GapAnalysisEngine;
  private taskEngine: TaskGenerationEngine;
  readonly outputPath: string;

  constructor(manager: StateManager) {
    this.manager = manager;
    this.gapEngine = new GapAnalysisEngine();
    this.taskEngine = new TaskGenerationEngine();
    this.outputPath = join(manager.projectRoot, '.claude', 'rules', 'motiva.md');
  }

  /**
   * Generate motiva.md content (≤500 tokens).
   * Can be called with explicit state/goals, or without args to load from disk.
   */
  generate(state?: MotiveState, goals?: Goal[]): string {
    const resolvedState = state ?? this.manager.loadState();
    const resolvedGoals = goals ?? this.manager.loadActiveGoals();

    if (resolvedGoals.length === 0) {
      return '# Motiva Context\n\nNo active goals. Awaiting user direction.\n';
    }

    // Check for unrefined goals — emit mandatory clarification block if any exist
    const unrefinedGoals = resolvedGoals.filter(g => g.status === 'active' && !g.refined);
    if (unrefinedGoals.length > 0) {
      const goalList = unrefinedGoals
        .map(g => `- **${g.title}**: ${g.description || '(no description)'}`)
        .join('\n');
      const clarificationBlock = [
        '# Motiva Context',
        '',
        '## MANDATORY: Goal Clarification Required',
        'Before starting ANY work, you MUST ask the user to clarify the following for each unrefined goal:',
        '1. What are the specific completion criteria for this goal?',
        '2. What quality standards apply? (review, testing, etc.)',
        '3. What is the most important aspect to focus on?',
        '',
        'Goals requiring clarification:',
        goalList,
        '',
        'Do NOT begin implementation until the user has answered these questions.',
        'After getting answers, use `motiva refine-goal --id <goal-id> --criteria "<answers>"` to record them.',
        '',
      ].join('\n');
      const truncated = clarificationBlock.length > ContextInjector.MAX_CHARS
        ? clarificationBlock.slice(0, ContextInjector.MAX_CHARS) + '\n...(truncated)\n'
        : clarificationBlock;
      debug('context-injector', 'unrefined goals — mandatory clarification block emitted', { count: unrefinedGoals.length });
      return truncated;
    }

    const lines: string[] = ['# Motiva Context\n'];

    // Sort goals by motivation score descending
    const sorted = [...resolvedGoals].sort((a, b) => b.motivation_score - a.motivation_score);

    // Top priority goal
    const topGoal = sorted[0];
    const deadlineNote = topGoal.deadline ? ` | 締切: ${topGoal.deadline}` : '';
    lines.push(`## 現在のゴール`);
    lines.push(`「${topGoal.title}」(${topGoal.type}, score: ${topGoal.motivation_score.toFixed(2)}${deadlineNote})\n`);

    // Checklist-aware section
    if (topGoal.checklist_created === false) {
      // No checklist yet — instruct the agent to create one
      const goalId = topGoal.id;
      const criteria = topGoal.completion_criteria ?? '(not specified)';
      lines.push('## Action Required: Create Checklist');
      lines.push(`Goal: ${topGoal.title}`);
      lines.push(`Create a checklist file at \`.motive/goals/${goalId}-checklist.json\` with this format:`);
      lines.push('```json');
      lines.push('{');
      lines.push(`  "goal_id": "${goalId}",`);
      lines.push('  "items": [');
      lines.push('    { "id": "1", "description": "What to verify", "verification": { "type": "bash", "command": "npm test" }, "status": "pending" },');
      lines.push('    { "id": "2", "description": "File exists", "verification": { "type": "file_exists", "glob": "src/**/*.ts" }, "status": "pending" },');
      lines.push('    { "id": "3", "description": "Contains pattern", "verification": { "type": "file_contains", "glob": "src/index.ts", "pattern": "export" }, "status": "pending" },');
      lines.push('    { "id": "4", "description": "Manual check", "verification": { "type": "manual" }, "status": "pending" }');
      lines.push('  ],');
      lines.push('  "created_at": "ISO timestamp",');
      lines.push('  "updated_at": "ISO timestamp"');
      lines.push('}');
      lines.push('```');
      lines.push('Break down the goal into 5-15 verifiable items. Use `bash` verification (test commands) wherever possible.');
      lines.push(`Criteria: ${criteria}`);
      lines.push('');
    } else {
      // Has checklist — load and show progress
      const checklist: Checklist | null = this.manager.loadChecklist(topGoal.id);
      if (checklist) {
        const total = checklist.items.length;
        const verified = checklist.items.filter(i => i.status === 'verified').length;
        const selfVerified = checklist.items.filter(i => i.status === 'self_verified').length;
        const pending = checklist.items.filter(i => i.status === 'pending').map(i => i.description);
        const failed = checklist.items.filter(i => i.status === 'failed').map(i => i.description);
        const verifiedItems = checklist.items.filter(i => i.status === 'verified' || i.status === 'self_verified').map(i => i.description);
        const doneCount = verified + selfVerified;
        const percentage = total > 0 ? ((doneCount / total) * 100).toFixed(0) : '0';

        lines.push(`## Goal: ${topGoal.title} — Progress: ${doneCount}/${total} (${percentage}%)`);
        if (verifiedItems.length > 0) {
          lines.push(`Verified: ${verifiedItems.join(', ')}`);
        }
        if (pending.length > 0) {
          lines.push(`Pending: ${pending.join(', ')}`);
        }
        if (failed.length > 0) {
          lines.push(`Failed: ${failed.join(', ')}`);
        }
        if (selfVerified > 0) {
          lines.push(`Self-verified (unconfirmed): ${selfVerified} item(s)`);
        }
        lines.push('Next: Focus on pending/failed items.');
        lines.push('');
      }

      // Standard gap analysis for remaining work
      const topGaps = this.gapEngine.computeGaps(topGoal, checklist ?? undefined)
        .filter(g => g.magnitude > 0.05)
        .slice(0, 3);

      if (topGaps.length > 0) {
        lines.push('## ギャップ');
        for (const g of topGaps) {
          const magPct = (g.magnitude * 100).toFixed(0);
          const confPct = (g.confidence * 100).toFixed(0);
          lines.push(`- ${g.dimension}: ${g.current.toFixed(1)}→${g.target.toFixed(1)} (${magPct}% gap, 確信度:${confPct}%)`);
        }
        lines.push('');
      }

      // Suggested next action from top task
      const topTask = this.taskEngine.getTopTask(topGaps, topGoal);
      if (topTask) {
        lines.push('## 次のアクション');
        lines.push(`${topTask.description}\n`);
      }
    }

    // Progress summary for remaining active goals (if any)
    if (sorted.length > 1) {
      lines.push('## その他のゴール');
      for (const goal of sorted.slice(1)) {
        const progressEl = goal.state_vector.progress;
        const progressStr = progressEl
          ? `${(progressEl.value * 100).toFixed(0)}%`
          : '不明';
        lines.push(`- ${goal.title}: progress=${progressStr}, score=${goal.motivation_score.toFixed(2)}`);
      }
      lines.push('');
    }

    // Behavioral directives
    const trust = resolvedState.trust_balance.global;
    const stallCount = resolvedState.stall_state.stall_count;
    lines.push('## 行動指示');
    lines.push(`- このゴールの達成を最優先にタスクを選択・実行せよ`);
    lines.push(`- 各応答でゴールへの進捗を意識し、ギャップを縮める行動を取れ`);
    if (trust < 0.4) {
      lines.push(`- 信頼残高: ${trust.toFixed(2)} (低) — 可逆的な操作を優先し、不可逆操作は必ず人間に確認を取れ`);
    } else {
      lines.push(`- 信頼残高: ${trust.toFixed(2)} — 不可逆操作は必ず人間に確認を取れ`);
    }
    if (stallCount > 2) {
      lines.push(`- 停滞検知 (${stallCount}回) — 戦略を切り替えるか、ユーザーに確認せよ`);
    }
    lines.push('');

    let content = lines.join('\n');
    if (content.length > ContextInjector.MAX_CHARS) {
      content = content.slice(0, ContextInjector.MAX_CHARS) + '\n...(truncated)\n';
    }

    debug('context-injector', 'context generated', { goals_count: resolvedGoals.length, content_length: content.length, token_estimate: Math.ceil(content.length / 4) });
    return content;
  }

  /**
   * Write motiva.md to .claude/rules/motiva.md and return the output path.
   * Accepts optional explicit state/goals; falls back to loading from disk.
   */
  inject(projectRoot: string, state: MotiveState, goals: Goal[]): void {
    const content = this.generate(state, goals);
    const outPath = join(projectRoot, '.claude', 'rules', 'motiva.md');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content);
  }

  /**
   * Write motiva.md using state loaded from disk. Returns the output path.
   */
  write(): string {
    const content = this.generate();
    mkdirSync(dirname(this.outputPath), { recursive: true });
    writeFileSync(this.outputPath, content);
    debug('context-injector', 'token count', { output_path: this.outputPath, content_length: content.length });
    return this.outputPath;
  }
}
