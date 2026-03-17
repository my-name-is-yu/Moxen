import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";
import {
  LessonEntrySchema,
  StatisticalSummarySchema,
  MemoryIndexSchema,
} from "../types/memory-lifecycle.js";
import type {
  ShortTermEntry,
  LessonEntry,
  StatisticalSummary,
  MemoryIndex,
  MemoryIndexEntry,
} from "../types/memory-lifecycle.js";
import { atomicWrite, readJsonFile, generateId } from "./memory-persistence.js";

// ─── LLM response schemas ───

const PatternExtractionResponseSchema = z.object({
  patterns: z.array(z.string()),
});

const LessonDistillationResponseSchema = z.object({
  lessons: z.array(
    z.object({
      type: z.enum(["strategy_outcome", "success_pattern", "failure_pattern"]),
      context: z.string(),
      action: z.string().optional(),
      outcome: z.string().optional(),
      lesson: z.string(),
      relevance_tags: z.array(z.string()).default([]),
      failure_reason: z.string().optional(),
      avoidance_hint: z.string().optional(),
      applicability: z.string().optional(),
    })
  ),
});

// ─── Index management ───

export function initializeIndex(memoryDir: string, layer: "short-term" | "long-term"): void {
  const indexPath = path.join(memoryDir, layer, "index.json");
  if (!fs.existsSync(indexPath)) {
    const emptyIndex: MemoryIndex = MemoryIndexSchema.parse({
      version: 1,
      last_updated: new Date().toISOString(),
      entries: [],
    });
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    atomicWrite(indexPath, emptyIndex);
  }
}

export function loadIndex(memoryDir: string, layer: "short-term" | "long-term"): MemoryIndex {
  const indexPath = path.join(memoryDir, layer, "index.json");
  const raw = readJsonFile<MemoryIndex>(indexPath, MemoryIndexSchema);
  if (raw === null) {
    return MemoryIndexSchema.parse({
      version: 1,
      last_updated: new Date().toISOString(),
      entries: [],
    });
  }
  return raw;
}

export function saveIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  index: MemoryIndex
): void {
  const indexPath = path.join(memoryDir, layer, "index.json");
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const updated = MemoryIndexSchema.parse({
    ...index,
    last_updated: new Date().toISOString(),
  });
  atomicWrite(indexPath, updated);
}

export function updateIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  entry: MemoryIndexEntry
): void {
  const index = loadIndex(memoryDir, layer);
  index.entries.push(entry);
  saveIndex(memoryDir, layer, index);
}

export function removeFromIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  entryIds: Set<string>
): void {
  const index = loadIndex(memoryDir, layer);
  index.entries = index.entries.filter(
    (ie) => !entryIds.has(ie.entry_id)
  );
  saveIndex(memoryDir, layer, index);
}

export function removeGoalFromIndex(
  memoryDir: string,
  layer: "short-term" | "long-term",
  goalId: string
): void {
  const index = loadIndex(memoryDir, layer);
  index.entries = index.entries.filter((ie) => ie.goal_id !== goalId);
  saveIndex(memoryDir, layer, index);
}

export function touchIndexEntry(
  memoryDir: string,
  layer: "short-term" | "long-term",
  indexId: string
): void {
  const index = loadIndex(memoryDir, layer);
  const now = new Date().toISOString();
  const updated = index.entries.map((ie) => {
    if (ie.id === indexId) {
      return { ...ie, last_accessed: now, access_count: ie.access_count + 1 };
    }
    return ie;
  });
  saveIndex(memoryDir, layer, { ...index, entries: updated });
}

export function archiveOldestLongTermEntries(memoryDir: string): void {
  const index = loadIndex(memoryDir, "long-term");

  // Sort by last_accessed ascending (oldest first)
  const sorted = [...index.entries].sort(
    (a, b) =>
      new Date(a.last_accessed).getTime() -
      new Date(b.last_accessed).getTime()
  );

  // Archive oldest 10% of entries
  const archiveCount = Math.max(1, Math.floor(sorted.length * 0.1));
  const toArchive = sorted.slice(0, archiveCount);
  const toArchiveIds = new Set(toArchive.map((ie) => ie.entry_id));

  // Remove from active index
  index.entries = index.entries.filter(
    (ie) => !toArchiveIds.has(ie.entry_id)
  );
  saveIndex(memoryDir, "long-term", index);
}

// ─── Lesson storage ───

export function storeLessonsLongTerm(
  memoryDir: string,
  goalId: string,
  lessons: LessonEntry[],
  sourceEntries: ShortTermEntry[]
): void {
  // 1. Store by-goal
  const byGoalPath = path.join(
    memoryDir,
    "long-term",
    "lessons",
    "by-goal",
    `${goalId}.json`
  );
  const existingByGoal =
    readJsonFile<LessonEntry[]>(byGoalPath, z.array(LessonEntrySchema)) ?? [];
  atomicWrite(byGoalPath, [...existingByGoal, ...lessons]);

  // 2. Store by-dimension (for each unique dimension in source entries)
  const allDimensions = new Set(sourceEntries.flatMap((e) => e.dimensions));
  for (const dim of allDimensions) {
    if (!dim) continue;
    const byDimPath = path.join(
      memoryDir,
      "long-term",
      "lessons",
      "by-dimension",
      `${dim}.json`
    );
    const existingByDim =
      readJsonFile<LessonEntry[]>(byDimPath, z.array(LessonEntrySchema)) ?? [];
    // Store lessons that have this dimension's tag or are from these source entries
    const relevantLessons = lessons.filter(
      (l) =>
        l.relevance_tags.includes(dim) ||
        l.relevance_tags.length === 0 // include all if no tags
    );
    if (relevantLessons.length > 0) {
      atomicWrite(byDimPath, [...existingByDim, ...relevantLessons]);
    }
  }

  // 3. Store in global (all lessons are cross-goal knowledge)
  const globalPath = path.join(
    memoryDir,
    "long-term",
    "lessons",
    "global.json"
  );
  const existingGlobal =
    readJsonFile<LessonEntry[]>(globalPath, z.array(LessonEntrySchema)) ?? [];
  atomicWrite(globalPath, [...existingGlobal, ...lessons]);

  // 4. Update long-term index
  const now = new Date().toISOString();
  for (const lesson of lessons) {
    updateIndex(memoryDir, "long-term", {
      id: generateId("ltidx"),
      goal_id: goalId,
      dimensions: sourceEntries
        .filter((e) =>
          lesson.source_loops.includes(`loop_${e.loop_number}`)
        )
        .flatMap((e) => e.dimensions),
      tags: lesson.relevance_tags,
      timestamp: lesson.extracted_at,
      data_file: path.join(
        "lessons",
        "by-goal",
        `${goalId}.json`
      ),
      entry_id: lesson.lesson_id,
      last_accessed: now,
      access_count: 0,
      embedding_id: null,
    });
  }
}

// ─── Statistics ───

export function updateStatistics(
  memoryDir: string,
  goalId: string,
  entries: ShortTermEntry[]
): void {
  const statsPath = path.join(
    memoryDir,
    "long-term",
    "statistics",
    `${goalId}.json`
  );
  const now = new Date().toISOString();

  // Load existing or create fresh
  const existing = readJsonFile<StatisticalSummary>(
    statsPath,
    StatisticalSummarySchema
  );

  // Compute task statistics from task entries
  const taskEntries = entries.filter((e) => e.data_type === "task");
  const taskCategoryMap = new Map<
    string,
    { total: number; success: number; durations: number[] }
  >();

  for (const entry of taskEntries) {
    const category =
      typeof entry.data["task_category"] === "string"
        ? entry.data["task_category"]
        : "unknown";
    const status =
      typeof entry.data["status"] === "string" ? entry.data["status"] : "";
    const durationHours =
      typeof entry.data["duration_hours"] === "number"
        ? entry.data["duration_hours"]
        : 0;

    const current = taskCategoryMap.get(category) ?? {
      total: 0,
      success: 0,
      durations: [],
    };
    current.total++;
    if (status === "completed") current.success++;
    if (durationHours > 0) current.durations.push(durationHours);
    taskCategoryMap.set(category, current);
  }

  const taskStats = Array.from(taskCategoryMap.entries()).map(
    ([category, stats]) => ({
      task_category: category,
      goal_id: goalId,
      stats: {
        total_count: stats.total,
        success_rate:
          stats.total > 0 ? stats.success / stats.total : 0,
        avg_duration_hours:
          stats.durations.length > 0
            ? stats.durations.reduce((a, b) => a + b, 0) /
              stats.durations.length
            : 0,
        common_failure_reason: undefined,
      },
      period: computePeriod(entries),
      updated_at: now,
    })
  );

  // Compute dimension statistics from observation entries
  const observationEntries = entries.filter(
    (e) => e.data_type === "observation"
  );
  const dimMap = new Map<string, number[]>();

  for (const entry of observationEntries) {
    for (const dim of entry.dimensions) {
      const value =
        typeof entry.data["value"] === "number" ? entry.data["value"] : null;
      if (value !== null) {
        const arr = dimMap.get(dim) ?? [];
        arr.push(value);
        dimMap.set(dim, arr);
      }
    }
  }

  const dimensionStats = Array.from(dimMap.entries())
    .filter(([, values]) => values.length > 0)
    .map(([dim, values]) => {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const variance =
        values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) /
        values.length;
      const stdDev = Math.sqrt(variance);
      const trend = computeTrend(values);
      return {
        dimension_name: dim,
        goal_id: goalId,
        stats: {
          avg_value: avg,
          std_deviation: stdDev,
          trend,
          anomaly_frequency: 0,
          observation_count: values.length,
        },
        period: computePeriod(entries),
        updated_at: now,
      };
    });

  // Overall stats
  const totalLoops = entries.length > 0
    ? entries[entries.length - 1]!.loop_number -
      entries[0]!.loop_number +
      1
    : 0;
  const totalTasks = taskEntries.length;
  const successfulTasks = taskEntries.filter(
    (e) => e.data["status"] === "completed"
  ).length;
  const overallSuccessRate =
    totalTasks > 0 ? successfulTasks / totalTasks : 0;

  // Merge with existing stats
  const mergedTaskStats = mergeTaskStats(
    existing?.task_stats ?? [],
    taskStats
  );
  const mergedDimStats = mergeDimStats(
    existing?.dimension_stats ?? [],
    dimensionStats
  );

  const summary = StatisticalSummarySchema.parse({
    goal_id: goalId,
    task_stats: mergedTaskStats,
    dimension_stats: mergedDimStats,
    overall: {
      total_loops:
        (existing?.overall.total_loops ?? 0) + totalLoops,
      total_tasks:
        (existing?.overall.total_tasks ?? 0) + totalTasks,
      overall_success_rate: overallSuccessRate,
      active_period: computePeriod(entries),
    },
    updated_at: now,
  });

  atomicWrite(statsPath, summary);
}

export function mergeTaskStats(
  existing: StatisticalSummary["task_stats"],
  incoming: StatisticalSummary["task_stats"]
): StatisticalSummary["task_stats"] {
  const map = new Map(existing.map((s) => [s.task_category, s]));
  for (const inc of incoming) {
    const prev = map.get(inc.task_category);
    if (!prev) {
      map.set(inc.task_category, inc);
      continue;
    }
    const totalCount = prev.stats.total_count + inc.stats.total_count;
    const prevSuccess = prev.stats.success_rate * prev.stats.total_count;
    const incSuccess = inc.stats.success_rate * inc.stats.total_count;
    map.set(inc.task_category, {
      ...inc,
      stats: {
        total_count: totalCount,
        success_rate: totalCount > 0 ? (prevSuccess + incSuccess) / totalCount : 0,
        avg_duration_hours:
          (prev.stats.avg_duration_hours + inc.stats.avg_duration_hours) / 2,
        common_failure_reason: inc.stats.common_failure_reason,
      },
    });
  }
  return Array.from(map.values());
}

export function mergeDimStats(
  existing: StatisticalSummary["dimension_stats"],
  incoming: StatisticalSummary["dimension_stats"]
): StatisticalSummary["dimension_stats"] {
  const map = new Map(existing.map((s) => [s.dimension_name, s]));
  for (const inc of incoming) {
    map.set(inc.dimension_name, inc); // Replace with latest computation
  }
  return Array.from(map.values());
}

export function computeTrend(
  values: number[]
): "rising" | "falling" | "stable" {
  if (values.length < 2) return "stable";
  const first = values.slice(0, Math.floor(values.length / 2));
  const second = values.slice(Math.floor(values.length / 2));
  const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
  const avgSecond = second.reduce((a, b) => a + b, 0) / second.length;
  const delta = avgSecond - avgFirst;
  const threshold = Math.abs(avgFirst) * 0.05; // 5% change threshold
  if (delta > threshold) return "rising";
  if (delta < -threshold) return "falling";
  return "stable";
}

export function computePeriod(entries: ShortTermEntry[]): string {
  if (entries.length === 0) return "unknown";
  const timestamps = entries.map((e) => e.timestamp).sort();
  const first = timestamps[0]?.slice(0, 10) ?? "unknown";
  const last = timestamps[timestamps.length - 1]?.slice(0, 10) ?? "unknown";
  return first === last ? first : `${first} to ${last}`;
}

// ─── Lesson query ───

export function queryLessons(
  memoryDir: string,
  tags: string[],
  dimensions: string[],
  maxCount: number
): LessonEntry[] {
  const results: LessonEntry[] = [];
  const seen = new Set<string>();

  // Query by-dimension lessons
  for (const dim of dimensions) {
    const byDimPath = path.join(
      memoryDir,
      "long-term",
      "lessons",
      "by-dimension",
      `${dim}.json`
    );
    const lessons =
      readJsonFile<LessonEntry[]>(byDimPath, z.array(LessonEntrySchema)) ?? [];
    for (const l of lessons) {
      if (
        !seen.has(l.lesson_id) &&
        l.status === "active" &&
        results.length < maxCount
      ) {
        results.push(l);
        seen.add(l.lesson_id);
      }
    }
  }

  // Query global lessons matching tags
  if (results.length < maxCount && tags.length > 0) {
    const globalPath = path.join(
      memoryDir,
      "long-term",
      "lessons",
      "global.json"
    );
    const globalLessons =
      readJsonFile<LessonEntry[]>(globalPath, z.array(LessonEntrySchema)) ?? [];
    const matching = globalLessons.filter(
      (l) =>
        !seen.has(l.lesson_id) &&
        l.status === "active" &&
        tags.some((t) => l.relevance_tags.includes(t))
    );
    // Sort by extracted_at descending (most recent first)
    matching.sort(
      (a, b) =>
        new Date(b.extracted_at).getTime() -
        new Date(a.extracted_at).getTime()
    );
    for (const l of matching) {
      if (results.length >= maxCount) break;
      results.push(l);
      seen.add(l.lesson_id);
    }
  }

  return results;
}

export function queryCrossGoalLessons(
  memoryDir: string,
  tags: string[],
  dimensions: string[],
  excludeGoalId: string,
  maxCount: number
): LessonEntry[] {
  const results: LessonEntry[] = [];
  const seen = new Set<string>();

  // Query global lessons (which include all goals)
  const globalPath = path.join(
    memoryDir,
    "long-term",
    "lessons",
    "global.json"
  );
  const globalLessons =
    readJsonFile<LessonEntry[]>(globalPath, z.array(LessonEntrySchema)) ?? [];

  // Filter to lessons from other goals that match tags or dimensions
  const crossGoalLessons = globalLessons.filter(
    (l) =>
      l.goal_id !== excludeGoalId &&
      l.status === "active" &&
      (tags.some((t) => l.relevance_tags.includes(t)) ||
        dimensions.some((d) => l.relevance_tags.includes(d)))
  );

  // Sort by recency
  crossGoalLessons.sort(
    (a, b) =>
      new Date(b.extracted_at).getTime() - new Date(a.extracted_at).getTime()
  );

  for (const l of crossGoalLessons) {
    if (results.length >= maxCount) break;
    if (!seen.has(l.lesson_id)) {
      results.push(l);
      seen.add(l.lesson_id);
    }
  }

  return results;
}

// ─── LLM helpers ───

/**
 * Call LLM to extract recurring patterns from a set of short-term entries.
 */
export async function extractPatterns(
  llmClient: ILLMClient,
  entries: ShortTermEntry[]
): Promise<string[]> {
  const prompt = `Analyze the following experience log entries and extract recurring patterns, key insights, and lessons learned. Focus on what worked, what failed, and why.

Return a JSON object with a "patterns" array of pattern strings:
{
  "patterns": ["pattern 1", "pattern 2", ...]
}

Entries (${entries.length} total):
${JSON.stringify(
  entries.slice(0, 20).map((e) => ({
    data_type: e.data_type,
    loop_number: e.loop_number,
    dimensions: e.dimensions,
    tags: e.tags,
    data: e.data,
  })),
  null,
  2
)}`;

  const response = await llmClient.sendMessage(
    [{ role: "user", content: prompt }],
    {
      system:
        "You are a pattern extraction engine. Analyze experience logs and identify recurring patterns, successes, and failures. Respond with JSON only.",
      max_tokens: 2048,
    }
  );

  try {
    const parsed = llmClient.parseJSON(
      response.content,
      PatternExtractionResponseSchema
    );
    return parsed.patterns;
  } catch {
    return [];
  }
}

/**
 * Call LLM to convert extracted patterns into structured LessonEntry objects.
 */
export async function distillLessons(
  llmClient: ILLMClient,
  patterns: string[],
  entries: ShortTermEntry[]
): Promise<Array<{
  type: "strategy_outcome" | "success_pattern" | "failure_pattern";
  context: string;
  action?: string;
  outcome?: string;
  lesson: string;
  relevance_tags: string[];
  failure_reason?: string;
  avoidance_hint?: string;
  applicability?: string;
}>> {
  if (patterns.length === 0) return [];

  const failureEntries = entries.filter(
    (e) =>
      e.data["status"] === "failed" ||
      e.data["verdict"] === "fail" ||
      e.data["outcome"] === "failure"
  );

  const prompt = `Convert the following patterns into structured lessons. For each pattern, determine if it represents a strategy outcome, success pattern, or failure pattern.

Patterns:
${patterns.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Failure context (${failureEntries.length} failure entries found):
${JSON.stringify(
  failureEntries.slice(0, 5).map((e) => e.data),
  null,
  2
)}

Return a JSON object with a "lessons" array:
{
  "lessons": [
    {
      "type": "strategy_outcome" | "success_pattern" | "failure_pattern",
      "context": "what situation this lesson applies to",
      "action": "what action was taken (optional)",
      "outcome": "what result occurred (optional)",
      "lesson": "the key lesson learned",
      "relevance_tags": ["tag1", "tag2"],
      "failure_reason": "why it failed (for failure_pattern only)",
      "avoidance_hint": "how to avoid next time (for failure_pattern only)",
      "applicability": "when to apply (for success_pattern only)"
    }
  ]
}`;

  const response = await llmClient.sendMessage(
    [{ role: "user", content: prompt }],
    {
      system:
        "You are a lesson distillation engine. Convert experience patterns into structured, actionable lessons. Respond with JSON only.",
      max_tokens: 4096,
    }
  );

  try {
    const parsed = llmClient.parseJSON(
      response.content,
      LessonDistillationResponseSchema
    );
    // Normalize: ensure relevance_tags is always a string[]
    return parsed.lessons.map((l) => ({
      ...l,
      relevance_tags: l.relevance_tags ?? [],
    }));
  } catch {
    return [];
  }
}

/**
 * Validate compression quality.
 * MVP check: lesson_count >= failure_count * 0.5
 */
export function validateCompressionQuality(
  lessons: LessonEntry[],
  entries: ShortTermEntry[]
): { passed: boolean; failure_coverage_ratio: number; contradictions_found: number } {
  // Count failure entries
  const failureCount = entries.filter(
    (e) =>
      e.data["status"] === "failed" ||
      e.data["verdict"] === "fail" ||
      e.data["outcome"] === "failure"
  ).length;

  // MVP ratio check: lessons >= failures * 0.5
  const lessonCount = lessons.length;
  const failure_coverage_ratio =
    failureCount === 0
      ? 1
      : Math.min(1, lessonCount / (failureCount * 0.5));
  const passed =
    failureCount === 0 || lessonCount >= failureCount * 0.5;

  // Contradiction detection: check for lessons with opposite type covering same context
  let contradictions_found = 0;
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) {
      const a = lessons[i]!;
      const b = lessons[j]!;
      const isOppositeType =
        (a.type === "success_pattern" && b.type === "failure_pattern") ||
        (a.type === "failure_pattern" && b.type === "success_pattern");
      const sharesTag = a.relevance_tags.some((t) =>
        b.relevance_tags.includes(t)
      );
      if (isOppositeType && sharesTag) {
        contradictions_found++;
      }
    }
  }

  return {
    passed,
    failure_coverage_ratio,
    contradictions_found,
  };
}
