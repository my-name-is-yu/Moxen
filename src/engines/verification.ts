import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import glob from 'glob';
import type { ChecklistItem } from '../state/models.js';
import { debug } from '../debug.js';

/**
 * Runs verifications on checklist items and returns updated items.
 *
 * Supported verification types:
 *   - bash:         runs a shell command; passes if exit code === 0
 *   - file_exists:  checks that at least one file matching glob exists
 *   - file_contains: checks that a file matching glob contains a pattern
 *   - manual:       left as-is (cannot be auto-verified)
 */
export class VerificationRunner {
  private readonly projectRoot: string;
  /** Max wall-clock ms allowed for all verifications in one run */
  private readonly budgetMs: number;

  constructor(projectRoot: string, budgetMs = 200) {
    this.projectRoot = projectRoot;
    this.budgetMs = budgetMs;
  }

  /**
   * Verify a subset of items.  Only items with status 'pending' or 'failed'
   * are re-evaluated; others are returned unchanged.
   *
   * Returns a NEW array (original items are not mutated).
   */
  verifyAll(items: ChecklistItem[]): ChecklistItem[] {
    const deadline = Date.now() + this.budgetMs;
    const result: ChecklistItem[] = [];

    for (const item of items) {
      // Skip already-verified and manual items
      if (item.status === 'verified' || item.status === 'self_verified') {
        result.push(item);
        continue;
      }
      if (item.verification.type === 'manual') {
        result.push(item);
        continue;
      }

      // Budget guard: stop verifying if we're over time
      if (Date.now() >= deadline) {
        debug('verification', 'budget exceeded — skipping remaining items', { remaining: items.length - result.length });
        result.push(item);
        continue;
      }

      const passed = this.runVerification(item);
      const now = new Date().toISOString();
      result.push({
        ...item,
        status: passed ? 'verified' : 'failed',
        verified_at: now,
      });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private runVerification(item: ChecklistItem): boolean {
    try {
      const v = item.verification;
      switch (v.type) {
        case 'bash':
          return this.runBash(v.command);
        case 'file_exists':
          return this.runFileExists(v.glob);
        case 'file_contains':
          return this.runFileContains(v.glob, v.pattern);
        case 'manual':
          return false; // unreachable — filtered above, but satisfies TS
        default:
          return false;
      }
    } catch (err) {
      debug('verification', 'runVerification error', { item_id: item.id, err: String(err) });
      return false;
    }
  }

  private runBash(command: string): boolean {
    try {
      execSync(command, {
        cwd: this.projectRoot,
        stdio: 'pipe',
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private runFileExists(globPattern: string): boolean {
    try {
      const absoluteGlob = globPattern.startsWith('/') ? globPattern : join(this.projectRoot, globPattern);
      const matches = glob.sync(absoluteGlob);
      return matches.length > 0;
    } catch {
      return false;
    }
  }

  private runFileContains(globPattern: string, pattern: string): boolean {
    try {
      const absoluteGlob = globPattern.startsWith('/') ? globPattern : join(this.projectRoot, globPattern);
      const matches = glob.sync(absoluteGlob);
      if (matches.length === 0) return false;

      const regex = new RegExp(pattern);
      return matches.some((filePath: string) => {
        if (!existsSync(filePath)) return false;
        const content = readFileSync(filePath, 'utf-8');
        return regex.test(content);
      });
    } catch {
      return false;
    }
  }
}

/**
 * Compute a progress value [0, 1] from a list of checklist items.
 *
 * - verified / self_verified items count as complete
 * - pending / failed items count as incomplete
 * - manual items are excluded from the denominator (can't auto-verify)
 * - Returns 0 if there are no auto-verifiable items
 */
export function calculateProgress(items: ChecklistItem[]): number {
  const autoItems = items.filter(i => i.verification.type !== 'manual');
  if (autoItems.length === 0) return 0;

  const done = autoItems.filter(
    i => i.status === 'verified' || i.status === 'self_verified',
  ).length;

  return done / autoItems.length;
}
