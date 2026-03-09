#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateManager } from './state/manager.js';
import { Goal, MotiveState } from './state/models.js';
import { ContextInjector } from './context/injector.js';
import { VerificationRunner, calculateProgress } from './engines/verification.js';

const program = new Command();

function getManager(project?: string): StateManager {
  return new StateManager(project ? resolve(project) : process.cwd());
}

program
  .name('motiva')
  .description('Motiva CLI — motivation framework for AI agents')
  .option('-p, --project <path>', 'Project root directory');

program
  .command('init')
  .description('Initialize .motiva/ directory with default state')
  .action(() => {
    const mgr = getManager(program.opts().project);
    const state = mgr.init();
    console.log(`Initialized .motiva/ in ${mgr.projectRoot}`);
    console.log(`Session: ${state.session_id}`);

    // Copy agent instructions template to .claude/rules/motiva-usage.md
    const claudeDir = join(mgr.projectRoot, '.claude');
    const rulesDir = join(claudeDir, 'rules');
    mkdirSync(rulesDir, { recursive: true });

    const destPath = join(rulesDir, 'motiva-usage.md');
    if (!existsSync(destPath)) {
      const selfPath = fileURLToPath(import.meta.url);
      const distTemplatesPath = join(dirname(selfPath), 'templates', 'motiva-usage.md');
      const srcTemplatesPath = join(dirname(selfPath), '..', 'src', 'templates', 'motiva-usage.md');

      let templatePath: string | null = null;
      if (existsSync(distTemplatesPath)) {
        templatePath = distTemplatesPath;
      } else if (existsSync(srcTemplatesPath)) {
        templatePath = srcTemplatesPath;
      }

      if (templatePath) {
        copyFileSync(templatePath, destPath);
        console.log(`Copied agent instructions to ${destPath}`);
      } else {
        console.warn(`Warning: template not found — skipped copying agent instructions`);
        console.warn(`Run 'npm run build' first if you are working from source`);
      }
    } else {
      console.log(`Agent instructions already exist at ${destPath}`);
    }
  });

program
  .command('status')
  .description('Show current motiva state summary')
  .action(() => {
    const mgr = getManager(program.opts().project);
    const state = mgr.loadState();
    const goals = mgr.loadActiveGoals();
    console.log(`Session: ${state.session_id}`);
    console.log(`Trust: ${state.trust_balance.global.toFixed(2)}`);
    console.log(`Active goals: ${goals.length}`);
    for (const g of goals) {
      console.log(`  [${g.id}] ${g.title} (score: ${g.motivation_score.toFixed(2)}, status: ${g.status})`);
      const checklist = mgr.loadChecklist(g.id);
      if (checklist) {
        const total = checklist.items.length;
        const done = checklist.items.filter(i => i.status === 'verified' || i.status === 'self_verified').length;
        const pct = Math.round(calculateProgress(checklist.items) * 100);
        console.log(`    Checklist: ${done}/${total} (${pct}%)`);
      } else {
        console.log(`    Checklist: Awaiting checklist`);
      }
    }
  });

program
  .command('goals')
  .description('List all goals')
  .action(() => {
    const mgr = getManager(program.opts().project);
    const allGoals = mgr.listGoals();
    if (allGoals.length === 0) {
      console.log('No goals defined.');
      return;
    }
    const icons: Record<string, string> = { active: '●', completed: '✓', paused: '⏸', abandoned: '✗' };
    for (const g of allGoals) {
      console.log(`  ${icons[g.status] ?? '?'} [${g.id}] ${g.title} (${g.type})`);
    }
  });

program
  .command('add-goal')
  .description('Add a new goal')
  .requiredOption('-t, --title <title>', 'Goal title')
  .requiredOption('-d, --description <desc>', 'Goal description for better AI context (keyword matching + task generation)')
  .option('--type <type>', 'Motivation type (deadline|dissatisfaction|opportunity)', 'dissatisfaction')
  .action((opts) => {
    const mgr = getManager(program.opts().project);
    const goal = Goal.parse({
      title: opts.title,
      description: opts.description,
      type: opts.type,
      state_vector: {
        progress: { value: 0.0, confidence: 0.5 },
      },
    });
    mgr.addGoal(goal);
    console.log(`Added goal: ${goal.id} — ${goal.title}`);
  });

program
  .command('log')
  .description('Show recent action log entries')
  .action(() => {
    const mgr = getManager(program.opts().project);
    try {
      const content = readFileSync(mgr.logPath, 'utf-8').trim();
      if (!content) { console.log('No log entries.'); return; }
      const lines = content.split('\n');
      for (const line of lines.slice(-10)) {
        const entry = JSON.parse(line);
        console.log(`  [${entry.timestamp ?? '?'}] ${entry.action?.tool ?? '?'} → ${entry.outcome ?? '?'}`);
      }
    } catch {
      console.log('No log entries.');
    }
  });

program
  .command('reset')
  .description('Reset motiva state (keeps goals)')
  .action(() => {
    const mgr = getManager(program.opts().project);
    const current = mgr.loadState();
    const fresh = MotiveState.parse({
      ...current,
      session_id: crypto.randomUUID(),
      last_updated: new Date().toISOString(),
    });
    mgr.saveState(fresh);
    console.log('State reset.');
  });

program
  .command('gc')
  .description('Garbage collect old log entries')
  .option('--days <n>', 'Keep logs newer than N days', '30')
  .action((opts) => {
    const mgr = getManager(program.opts().project);
    try {
      const content = readFileSync(mgr.logPath, 'utf-8').trim();
      if (!content) { console.log('No logs to clean.'); return; }
      const lines = content.split('\n');
      const cutoff = new Date(Date.now() - parseInt(opts.days) * 86400000);
      const kept = lines.filter(line => {
        try {
          const entry = JSON.parse(line);
          return new Date(entry.timestamp ?? '2000-01-01') > cutoff;
        } catch { return false; }
      });
      writeFileSync(mgr.logPath, kept.length ? kept.join('\n') + '\n' : '');
      console.log(`Removed ${lines.length - kept.length} old entries, kept ${kept.length}.`);
    } catch {
      console.log('No logs to clean.');
    }
  });

// ---------------------------------------------------------------------------
// setup command
// ---------------------------------------------------------------------------

const HOOK_EVENTS = [
  { event: 'SessionStart',     file: 'session-start.js' },
  { event: 'UserPromptSubmit', file: 'user-prompt.js' },
  { event: 'PreToolUse',       file: 'pre-tool-use.js' },
  { event: 'PostToolUse',      file: 'post-tool-use.js' },
  { event: 'Stop',             file: 'stop.js' },
] as const;

/** Resolve the absolute path to dist/hooks/ at runtime using this file's location. */
function resolveHooksDir(): string {
  // When compiled, this file lives at dist/cli.js → dist/hooks/ is a sibling dir.
  const selfPath = fileURLToPath(import.meta.url);
  return join(dirname(selfPath), 'hooks');
}

program
  .command('setup')
  .description('One-step Motiva setup: init state, configure hooks, copy agent instructions')
  .option('--project-root <path>', 'Target project root (default: cwd)')
  .option('--force', 'Overwrite existing Motiva config')
  .action((opts) => {
    const projectRoot = opts.projectRoot
      ? resolve(opts.projectRoot)
      : process.cwd();

    const hooksDir = resolveHooksDir();

    // -----------------------------------------------------------------------
    // Step 1: Init .motiva/ directory
    // -----------------------------------------------------------------------
    const mgr = new StateManager(projectRoot);
    const alreadyInited = existsSync(mgr.statePath);

    if (alreadyInited && !opts.force) {
      console.log(`Motiva is already initialized in ${projectRoot}`);
      console.log('Use --force to reinitialize.');
    } else {
      mgr.init();
      console.log(`[1/3] Initialized .motiva/ in ${projectRoot}`);
    }

    // -----------------------------------------------------------------------
    // Step 2: Configure hooks in .claude/settings.json
    // -----------------------------------------------------------------------
    const claudeDir = join(projectRoot, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');

    mkdirSync(claudeDir, { recursive: true });

    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      } catch {
        console.warn(`  Warning: could not parse ${settingsPath}, starting fresh`);
        settings = {};
      }
    }

    // Ensure hooks key exists
    if (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks)) {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown[]>;

    let hooksAdded = 0;
    for (const { event, file } of HOOK_EVENTS) {
      const hookPath = join(hooksDir, file);
      const command = `MOTIVA_PROJECT_ROOT='${projectRoot}' node '${hookPath}'`;

      if (!Array.isArray(hooks[event])) {
        hooks[event] = [];
      }
      const entries = hooks[event];

      // Check if a motiva hook for this file is already registered
      const alreadyRegistered = entries.some(
        (e) =>
          typeof e === 'object' &&
          e !== null &&
          'hooks' in e &&
          Array.isArray((e as { hooks: unknown[] }).hooks) &&
          (e as { hooks: { command?: string }[] }).hooks.some(
            (h) => typeof h === 'object' && h !== null && typeof h.command === 'string' && h.command.includes(file)
          )
      );

      if (!alreadyRegistered || opts.force) {
        if (opts.force) {
          // Remove any existing motiva entry for this event when forcing
          hooks[event] = entries.filter(
            (e) =>
              !(
                typeof e === 'object' &&
                e !== null &&
                'hooks' in e &&
                Array.isArray((e as { hooks: unknown[] }).hooks) &&
                (e as { hooks: { command?: string }[] }).hooks.some(
                  (h) => typeof h === 'object' && h !== null && typeof h.command === 'string' && h.command.includes(file)
                )
              )
          );
        }
        hooks[event].push({ hooks: [{ type: 'command', command }] });
        hooksAdded++;
      }
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    console.log(`[2/3] Configured ${hooksAdded} hook(s) in ${settingsPath}`);

    // -----------------------------------------------------------------------
    // Step 3: Copy agent instructions template
    // -----------------------------------------------------------------------
    const rulesDir = join(claudeDir, 'rules');
    mkdirSync(rulesDir, { recursive: true });

    const destPath = join(rulesDir, 'motiva-usage.md');
    if (!existsSync(destPath) || opts.force) {
      // Resolve template path relative to this source file's compiled location.
      // Compiled layout: dist/cli.js, templates are copied to dist/templates/
      // (tsc copies only .ts; we handle .md via a post-build copy or keep in src).
      // To be safe, resolve from both possible locations.
      const selfPath = fileURLToPath(import.meta.url);
      const distTemplatesPath = join(dirname(selfPath), 'templates', 'motiva-usage.md');
      // Also try src/templates relative to project root (for development / ts-node use)
      const srcTemplatesPath = join(dirname(selfPath), '..', 'src', 'templates', 'motiva-usage.md');

      let templatePath: string | null = null;
      if (existsSync(distTemplatesPath)) {
        templatePath = distTemplatesPath;
      } else if (existsSync(srcTemplatesPath)) {
        templatePath = srcTemplatesPath;
      }

      if (templatePath) {
        copyFileSync(templatePath, destPath);
        console.log(`[3/3] Copied agent instructions to ${destPath}`);
      } else {
        console.warn(`[3/3] Warning: template not found — skipped copying agent instructions`);
        console.warn(`      Run 'npm run build' first if you are working from source`);
      }
    } else {
      console.log(`[3/3] Agent instructions already exist at ${destPath} (use --force to overwrite)`);
    }

    // -----------------------------------------------------------------------
    // Success message
    // -----------------------------------------------------------------------
    console.log('');
    console.log('Motiva setup complete!');
    console.log('');
    console.log('Next steps:');
    console.log(`  motiva add-goal --title "My first goal" --type opportunity --description "What this goal means"`);;
    console.log(`  motiva status`);
  });

// ---------------------------------------------------------------------------
// refine-goal command
// ---------------------------------------------------------------------------

program
  .command('refine-goal')
  .description('Mark a goal as refined and record completion criteria')
  .requiredOption('--id <goal-id>', 'ID of the goal to refine')
  .requiredOption('--criteria <text>', 'Completion criteria as provided by the user')
  .action((opts) => {
    const mgr = getManager(program.opts().project);
    const goal = mgr.loadGoal(opts.id);
    if (!goal) {
      console.error(`Goal not found: ${opts.id}`);
      process.exit(1);
    }
    const updated = Goal.parse({
      ...goal,
      refined: true,
      completion_criteria: opts.criteria,
    });
    mgr.saveGoal(updated);

    // Regenerate the context file so motiva.md no longer shows the mandatory block
    const injector = new ContextInjector(mgr);
    injector.write();

    console.log(`Goal refined: ${updated.id} — ${updated.title}`);
    console.log(`Criteria: ${opts.criteria}`);
    console.log(`Context file updated: ${injector.outputPath}`);
  });

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveGoal(mgr: StateManager, goalId?: string): Goal | null {
  if (goalId) {
    return mgr.loadGoal(goalId);
  }
  const activeGoals = mgr.loadActiveGoals();
  return activeGoals.length > 0 ? activeGoals[0] : null;
}

// ---------------------------------------------------------------------------
// checklist command
// ---------------------------------------------------------------------------

program
  .command('checklist [goal-id]')
  .description('Show checklist for a goal (defaults to first active goal)')
  .action((goalId?: string) => {
    const mgr = getManager(program.opts().project);

    const goal = resolveGoal(mgr, goalId);
    if (!goal) {
      if (goalId) {
        console.error(`Goal not found: ${goalId}`);
        process.exit(1);
      }
      console.log('No active goals.');
      return;
    }

    const checklist = mgr.loadChecklist(goal.id);
    if (!checklist) {
      console.log('No checklist found. The agent needs to create one first.');
      return;
    }

    const total = checklist.items.length;
    const done = checklist.items.filter(i => i.status === 'verified' || i.status === 'self_verified').length;
    const pct = Math.round(calculateProgress(checklist.items) * 100);

    console.log(`Checklist for: ${goal.title} (${goal.id})`);
    console.log(`Progress: ${done}/${total} (${pct}%)`);
    console.log('');

    const statusIcon: Record<string, string> = {
      verified: '[✓]',
      self_verified: '[~]',
      pending: '[ ]',
      failed: '[!]',
    };

    for (const item of checklist.items) {
      const icon = statusIcon[item.status] ?? '[ ]';
      console.log(`${icon} ${item.description} (${item.status})`);
    }
  });

// ---------------------------------------------------------------------------
// verify command
// ---------------------------------------------------------------------------

program
  .command('verify [goal-id]')
  .description('Run verifications on a goal checklist and show results')
  .action((goalId?: string) => {
    const mgr = getManager(program.opts().project);

    const goal = resolveGoal(mgr, goalId);
    if (!goal) {
      if (goalId) {
        console.error(`Goal not found: ${goalId}`);
        process.exit(1);
      }
      console.log('No active goals.');
      return;
    }

    const checklist = mgr.loadChecklist(goal.id);
    if (!checklist) {
      console.log('No checklist found. The agent needs to create one first.');
      return;
    }

    const projectRoot = program.opts().project ? resolve(program.opts().project) : process.cwd();
    const runner = new VerificationRunner(projectRoot);
    const updatedItems = runner.verifyAll(checklist.items);

    const updatedChecklist = {
      ...checklist,
      items: updatedItems,
      updated_at: new Date().toISOString(),
    };
    mgr.saveChecklist(updatedChecklist);

    const total = updatedItems.length;
    const done = updatedItems.filter(i => i.status === 'verified' || i.status === 'self_verified').length;
    const pct = Math.round(calculateProgress(updatedItems) * 100);

    console.log(`Verification results for: ${goal.title}`);

    for (const item of updatedItems) {
      if (item.status === 'verified' || item.status === 'self_verified') {
        console.log(`  ✓ ${item.description}: passed`);
      } else if (item.status === 'failed') {
        console.log(`  ✗ ${item.description}: failed`);
      } else if (item.verification.type === 'manual') {
        console.log(`  - ${item.description}: skipped (manual)`);
      } else {
        console.log(`  - ${item.description}: ${item.status}`);
      }
    }

    console.log(`Progress: ${done}/${total} (${pct}%)`);
  });

program.parse();
