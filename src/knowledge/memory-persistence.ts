import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { MemoryDataType, RetentionConfig } from "../types/memory-lifecycle.js";

// ─── Atomic file write ───

/**
 * Write data to a file atomically (write to .tmp, then rename).
 */
export function atomicWrite(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

// ─── JSON file read ───

/**
 * Read and parse a JSON file using the provided Zod schema.
 * Returns null if the file doesn't exist or parsing fails.
 */
export function readJsonFile<T>(filePath: string, schema: z.ZodTypeAny): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const raw = JSON.parse(content) as unknown;
    return schema.parse(raw) as T;
  } catch {
    return null;
  }
}

// ─── Data file path resolution ───

/**
 * Map MemoryDataType to the corresponding short-term JSON file path.
 */
export function getDataFile(memoryDir: string, goalId: string, dataType: MemoryDataType): string {
  const fileNames: Record<MemoryDataType, string> = {
    experience_log: "experience-log.json",
    observation: "observations.json",
    strategy: "strategies.json",
    task: "tasks.json",
    knowledge: "knowledge.json",
  };
  return path.join(
    memoryDir,
    "short-term",
    "goals",
    goalId,
    fileNames[dataType]
  );
}

// ─── ID generation ───

/**
 * Generate a short unique ID with the given prefix.
 */
export function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// ─── Directory size ───

/**
 * Compute total size of a directory recursively in bytes.
 */
export function getDirectorySize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirectorySize(entryPath);
    } else {
      try {
        total += fs.statSync(entryPath).size;
      } catch {
        // Ignore stat errors
      }
    }
  }
  return total;
}

// ─── Retention limit ───

/**
 * Get the retention loop limit for a goal, considering goal_type_overrides.
 * Since goalId does not encode goal type in MVP, use default unless caller
 * configures an override keyed by goalId prefix.
 */
export function getRetentionLimit(config: RetentionConfig, goalId: string): number {
  // Check if any override key is a prefix of goalId
  for (const [key, limit] of Object.entries(config.goal_type_overrides)) {
    if (goalId.startsWith(key) || goalId.includes(key)) {
      return limit;
    }
  }
  return config.default_retention_loops;
}
