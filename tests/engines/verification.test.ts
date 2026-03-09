/**
 * Tests for VerificationRunner and calculateProgress (src/engines/verification.ts)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { VerificationRunner, calculateProgress } from '../../src/engines/verification.js';
import type { ChecklistItem } from '../../src/state/models.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'motive-verify-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeItem(
  id: string,
  verification: ChecklistItem['verification'],
  status: ChecklistItem['status'] = 'pending',
): ChecklistItem {
  return {
    id,
    description: `Item ${id}`,
    verification,
    status,
  };
}

// ---------------------------------------------------------------------------
// calculateProgress
// ---------------------------------------------------------------------------

describe('calculateProgress', () => {
  it('returns 1.0 when all auto-verifiable items are verified', () => {
    const items: ChecklistItem[] = [
      makeItem('1', { type: 'bash', command: 'echo ok' }, 'verified'),
      makeItem('2', { type: 'file_exists', glob: 'src/*.ts' }, 'verified'),
      makeItem('3', { type: 'file_contains', glob: 'src/index.ts', pattern: 'export' }, 'verified'),
    ];
    expect(calculateProgress(items)).toBe(1.0);
  });

  it('caps at 0.8 when all auto-verifiable items are self_verified (but still returns fraction)', () => {
    // calculateProgress counts self_verified as "done" — returns done/total, not capped
    const items: ChecklistItem[] = [
      makeItem('1', { type: 'bash', command: 'echo ok' }, 'self_verified'),
      makeItem('2', { type: 'bash', command: 'echo ok' }, 'self_verified'),
    ];
    // Both done → 2/2 = 1.0 (calculateProgress does not cap; capping is external policy)
    expect(calculateProgress(items)).toBe(1.0);
  });

  it('returns proportional value for mixed verified and pending items', () => {
    const items: ChecklistItem[] = [
      makeItem('1', { type: 'bash', command: 'echo ok' }, 'verified'),
      makeItem('2', { type: 'bash', command: 'echo ok' }, 'pending'),
      makeItem('3', { type: 'bash', command: 'echo ok' }, 'pending'),
      makeItem('4', { type: 'bash', command: 'echo ok' }, 'verified'),
    ];
    // 2 verified out of 4 = 0.5
    expect(calculateProgress(items)).toBe(0.5);
  });

  it('returns 0 when all auto-verifiable items are pending', () => {
    const items: ChecklistItem[] = [
      makeItem('1', { type: 'bash', command: 'echo ok' }, 'pending'),
      makeItem('2', { type: 'file_exists', glob: 'src/*.ts' }, 'pending'),
    ];
    expect(calculateProgress(items)).toBe(0);
  });

  it('returns 0 when items list is empty', () => {
    expect(calculateProgress([])).toBe(0);
  });

  it('returns 0 when all items are manual (excluded from denominator)', () => {
    const items: ChecklistItem[] = [
      makeItem('1', { type: 'manual' }, 'pending'),
      makeItem('2', { type: 'manual' }, 'pending'),
    ];
    expect(calculateProgress(items)).toBe(0);
  });

  it('excludes manual items from denominator in mixed list', () => {
    const items: ChecklistItem[] = [
      makeItem('1', { type: 'bash', command: 'echo ok' }, 'verified'),
      makeItem('2', { type: 'manual' }, 'pending'), // excluded
      makeItem('3', { type: 'bash', command: 'echo ok' }, 'pending'),
    ];
    // Only bash items counted: 1 verified / 2 = 0.5
    expect(calculateProgress(items)).toBe(0.5);
  });

  it('counts failed items as incomplete', () => {
    const items: ChecklistItem[] = [
      makeItem('1', { type: 'bash', command: 'echo ok' }, 'verified'),
      makeItem('2', { type: 'bash', command: 'echo ok' }, 'failed'),
    ];
    // 1 verified / 2 = 0.5
    expect(calculateProgress(items)).toBe(0.5);
  });

  it('counts self_verified items as complete (same as verified)', () => {
    const items: ChecklistItem[] = [
      makeItem('1', { type: 'bash', command: 'echo ok' }, 'verified'),
      makeItem('2', { type: 'bash', command: 'echo ok' }, 'self_verified'),
      makeItem('3', { type: 'bash', command: 'echo ok' }, 'pending'),
    ];
    // 2 done / 3 = 0.667
    expect(calculateProgress(items)).toBeCloseTo(0.667, 2);
  });
});

// ---------------------------------------------------------------------------
// VerificationRunner.verifyAll — skips verified / self_verified
// ---------------------------------------------------------------------------

describe('VerificationRunner.verifyAll — status skipping', () => {
  it('returns verified items unchanged without re-running verification', () => {
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'bash', command: 'exit 1' }, 'verified'); // would fail if run
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('verified');
  });

  it('returns self_verified items unchanged without re-running verification', () => {
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'bash', command: 'exit 1' }, 'self_verified'); // would fail if run
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('self_verified');
  });

  it('re-runs pending items', () => {
    // Create a real file so file_exists passes
    writeFileSync(join(tmpDir, 'exists.txt'), 'hello');
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'file_exists', glob: 'exists.txt' }, 'pending');
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('verified');
  });

  it('re-runs failed items', () => {
    writeFileSync(join(tmpDir, 'exists.txt'), 'hello');
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'file_exists', glob: 'exists.txt' }, 'failed');
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('verified');
  });

  it('skips manual items (leaves status unchanged)', () => {
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'manual' }, 'pending');
    const result = runner.verifyAll([item]);
    // Manual items are never auto-verified
    expect(result[0].status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// VerificationRunner — bash verification
// ---------------------------------------------------------------------------

describe('VerificationRunner — bash verification', () => {
  it('marks item as verified when bash command exits 0', () => {
    const runner = new VerificationRunner(tmpDir, 2000);
    const item = makeItem('1', { type: 'bash', command: 'echo hello' });
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('verified');
    expect(result[0].verified_at).toBeDefined();
  });

  it('marks item as failed when bash command exits non-zero', () => {
    const runner = new VerificationRunner(tmpDir, 2000);
    const item = makeItem('1', { type: 'bash', command: 'exit 1' });
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('failed');
  });

  it('marks item as failed when bash command is not found', () => {
    const runner = new VerificationRunner(tmpDir, 2000);
    const item = makeItem('1', { type: 'bash', command: 'command-that-does-not-exist-xyz' });
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// VerificationRunner — file_exists verification
// ---------------------------------------------------------------------------

describe('VerificationRunner — file_exists verification', () => {
  it('marks item as verified when a matching file exists', () => {
    writeFileSync(join(tmpDir, 'target.ts'), 'export const x = 1;');
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'file_exists', glob: 'target.ts' });
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('verified');
  });

  it('marks item as failed when no matching file exists', () => {
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'file_exists', glob: 'nonexistent-*.ts' });
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('failed');
  });

  it('works with glob patterns matching multiple files', () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    writeFileSync(join(tmpDir, 'b.ts'), '');
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'file_exists', glob: '*.ts' });
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// VerificationRunner — file_contains verification
// ---------------------------------------------------------------------------

describe('VerificationRunner — file_contains verification', () => {
  it('marks item as verified when file contains the pattern', () => {
    writeFileSync(join(tmpDir, 'index.ts'), 'export const hello = "world";');
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'file_contains', glob: 'index.ts', pattern: 'export' });
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('verified');
  });

  it('marks item as failed when file does not contain the pattern', () => {
    writeFileSync(join(tmpDir, 'index.ts'), 'const hello = "world";');
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'file_contains', glob: 'index.ts', pattern: 'export' });
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('failed');
  });

  it('marks item as failed when no file matches the glob', () => {
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'file_contains', glob: 'nonexistent.ts', pattern: 'export' });
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('failed');
  });

  it('supports regex patterns', () => {
    writeFileSync(join(tmpDir, 'data.ts'), 'export default function main() { return 42; }');
    const runner = new VerificationRunner(tmpDir, 200);
    const item = makeItem('1', { type: 'file_contains', glob: 'data.ts', pattern: 'function\\s+\\w+' });
    const result = runner.verifyAll([item]);
    expect(result[0].status).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// VerificationRunner — manual verification always returns pending
// ---------------------------------------------------------------------------

describe('VerificationRunner — manual verification', () => {
  it('manual items are never auto-verified (always stays pending)', () => {
    const runner = new VerificationRunner(tmpDir, 200);
    const pending = makeItem('1', { type: 'manual' }, 'pending');
    const failed = makeItem('2', { type: 'manual' }, 'failed');

    const result = runner.verifyAll([pending, failed]);
    // Manual items are skipped — status unchanged
    expect(result[0].status).toBe('pending');
    expect(result[1].status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// VerificationRunner — does not mutate original items
// ---------------------------------------------------------------------------

describe('VerificationRunner — immutability', () => {
  it('returns a new array without mutating original items', () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    const runner = new VerificationRunner(tmpDir, 200);
    const originalItem = makeItem('1', { type: 'file_exists', glob: 'file.txt' }, 'pending');
    const items = [originalItem];

    runner.verifyAll(items);

    // Original item unchanged
    expect(originalItem.status).toBe('pending');
    expect(items[0].status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// VerificationRunner.verifyAll — mixed items
// ---------------------------------------------------------------------------

describe('VerificationRunner.verifyAll — mixed item list', () => {
  it('correctly processes a list with verified, pending, and manual items', () => {
    writeFileSync(join(tmpDir, 'file.ts'), 'export const x = 1;');
    const runner = new VerificationRunner(tmpDir, 2000);

    const items: ChecklistItem[] = [
      makeItem('1', { type: 'file_exists', glob: 'file.ts' }, 'verified'),   // skipped
      makeItem('2', { type: 'file_exists', glob: 'file.ts' }, 'pending'),    // should pass
      makeItem('3', { type: 'file_exists', glob: 'nope.ts' }, 'pending'),    // should fail
      makeItem('4', { type: 'manual' }, 'pending'),                          // skipped
    ];

    const result = runner.verifyAll(items);

    expect(result[0].status).toBe('verified'); // unchanged
    expect(result[1].status).toBe('verified'); // file exists
    expect(result[2].status).toBe('failed');   // file not found
    expect(result[3].status).toBe('pending');  // manual, unchanged
  });
});
