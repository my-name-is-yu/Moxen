import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IEmbeddingClient } from "./embedding-client.js";
import type { VectorIndex } from "./vector-index.js";
import {
  ShortTermEntrySchema,
  LessonEntrySchema,
  RetentionConfigSchema,
  StatisticalSummarySchema,
} from "../types/memory-lifecycle.js";
import type {
  ShortTermEntry,
  LessonEntry,
  StatisticalSummary,
  MemoryIndex,
  CompressionResult,
  RetentionConfig,
  MemoryDataType,
} from "../types/memory-lifecycle.js";
import type { IDriveScorer } from "./drive-score-adapter.js";
export type { IDriveScorer } from "./drive-score-adapter.js";
export { DriveScoreAdapter } from "./drive-score-adapter.js";
import {
  atomicWrite,
  readJsonFile,
  getDataFile,
  generateId,
  getDirectorySize,
  getRetentionLimit,
} from "./memory-persistence.js";
import {
  initializeIndex,
  loadIndex,
  saveIndex,
  updateIndex,
  removeFromIndex,
  removeGoalFromIndex,
  touchIndexEntry,
  archiveOldestLongTermEntries,
  storeLessonsLongTerm,
  updateStatistics,
  queryLessons,
  queryCrossGoalLessons,
  extractPatterns,
  distillLessons,
  validateCompressionQuality,
} from "./memory-phases.js";

// ─── MemoryLifecycleManager ───

/**
 * MemoryLifecycleManager handles the 3-tier memory model:
 *   - Working Memory: view/selection from Short-term + Long-term (1 session lifetime)
 *   - Short-term Memory: raw data, configurable retention (default: 100 loops)
 *   - Long-term Memory: compressed lessons + statistics (permanent)
 *
 * Directory layout:
 *   <base>/memory/short-term/goals/<goal_id>/{experience-log,observations,strategies,tasks}.json
 *   <base>/memory/short-term/index.json
 *   <base>/memory/long-term/lessons/by-goal/<goal_id>.json
 *   <base>/memory/long-term/lessons/by-dimension/<dim>.json
 *   <base>/memory/long-term/lessons/global.json
 *   <base>/memory/long-term/statistics/<goal_id>.json
 *   <base>/memory/long-term/index.json
 *   <base>/memory/archive/<goal_id>/{lessons,statistics}.json
 */
export class MemoryLifecycleManager {
  private readonly baseDir: string;
  private readonly memoryDir: string;
  private readonly llmClient: ILLMClient;
  private readonly config: RetentionConfig;
  private readonly embeddingClient?: IEmbeddingClient;
  private readonly vectorIndex?: VectorIndex;
  private readonly driveScorer?: IDriveScorer;

  // Phase 2: internal map for early compression candidates
  private readonly earlyCompressionCandidates: Map<string, Set<string>> = new Map();

  constructor(
    baseDir: string,
    llmClient: ILLMClient,
    config?: Partial<RetentionConfig>,
    embeddingClient?: IEmbeddingClient,
    vectorIndex?: VectorIndex,
    driveScorer?: IDriveScorer
  ) {
    this.baseDir = baseDir;
    this.memoryDir = path.join(baseDir, "memory");
    this.llmClient = llmClient;
    this.config = RetentionConfigSchema.parse(config ?? {});
    this.embeddingClient = embeddingClient;
    this.vectorIndex = vectorIndex;
    this.driveScorer = driveScorer;
  }

  // ─── Directory Initialization ───

  /** Create directory structure for memory storage */
  initializeDirectories(): void {
    const dirs = [
      path.join(this.memoryDir, "short-term", "goals"),
      path.join(this.memoryDir, "long-term", "lessons", "by-goal"),
      path.join(this.memoryDir, "long-term", "lessons", "by-dimension"),
      path.join(this.memoryDir, "long-term", "statistics"),
      path.join(this.memoryDir, "archive"),
    ];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Initialize index files if they don't exist
    initializeIndex(this.memoryDir, "short-term");
    initializeIndex(this.memoryDir, "long-term");
    // Initialize global lessons file
    const globalPath = path.join(
      this.memoryDir,
      "long-term",
      "lessons",
      "global.json"
    );
    if (!fs.existsSync(globalPath)) {
      atomicWrite(globalPath, []);
    }
  }

  // ─── Short-term Memory ───

  /**
   * Record an entry to short-term memory.
   * Appends to the appropriate data file and updates the short-term index.
   */
  recordToShortTerm(
    goalId: string,
    dataType: MemoryDataType,
    data: Record<string, unknown>,
    options?: {
      loopNumber?: number;
      dimensions?: string[];
      tags?: string[];
    }
  ): ShortTermEntry {
    // Ensure goal directory exists
    const goalDir = path.join(
      this.memoryDir,
      "short-term",
      "goals",
      goalId
    );
    fs.mkdirSync(goalDir, { recursive: true });

    const now = new Date().toISOString();
    const entry = ShortTermEntrySchema.parse({
      id: generateId("st"),
      goal_id: goalId,
      data_type: dataType,
      loop_number: options?.loopNumber ?? 0,
      timestamp: now,
      dimensions: options?.dimensions ?? [],
      tags: options?.tags ?? [],
      data,
    });

    // Append to appropriate file
    const dataFile = getDataFile(this.memoryDir, goalId, dataType);
    const existing = readJsonFile<ShortTermEntry[]>(
      dataFile,
      z.array(ShortTermEntrySchema)
    );
    const entries = existing ?? [];
    entries.push(entry);
    atomicWrite(dataFile, entries);

    // Update short-term index
    updateIndex(this.memoryDir, "short-term", {
      id: generateId("idx"),
      goal_id: goalId,
      dimensions: entry.dimensions,
      tags: entry.tags,
      timestamp: entry.timestamp,
      data_file: path.relative(
        path.join(this.memoryDir, "short-term"),
        dataFile
      ),
      entry_id: entry.id,
      last_accessed: now,
      access_count: 0,
      embedding_id: null,
    });

    // Phase 2: fire-and-forget embedding indexing
    if (this.vectorIndex) {
      const textToEmbed = `${dataType}: ${JSON.stringify(data).slice(0, 500)}`;
      this.vectorIndex
        .add(entry.id, textToEmbed, { goal_id: goalId, data_type: dataType })
        .then(() => {
          entry.embedding_id = entry.id;
        })
        .catch(() => {
          // Non-fatal: embedding failures are ignored
        });
    }

    return entry;
  }

  // ─── Long-term Compression ───

  /**
   * Compress short-term entries to long-term using LLM-based pattern extraction.
   * Never deletes short-term data if LLM compression fails.
   */
  async compressToLongTerm(
    goalId: string,
    dataType: MemoryDataType
  ): Promise<CompressionResult> {
    const now = new Date().toISOString();
    const dataFile = getDataFile(this.memoryDir, goalId, dataType);
    const allEntries =
      readJsonFile<ShortTermEntry[]>(
        dataFile,
        z.array(ShortTermEntrySchema)
      ) ?? [];

    // Determine the retention limit for this goal
    const retentionLimit = getRetentionLimit(this.config, goalId);

    // Find entries eligible for compression (loop_number exceeds retention limit)
    const maxLoopNumber = allEntries.reduce(
      (max, e) => Math.max(max, e.loop_number),
      0
    );
    const cutoffLoop = maxLoopNumber - retentionLimit;
    const expiredEntries = allEntries.filter(
      (e) => e.loop_number <= cutoffLoop
    );

    if (expiredEntries.length === 0) {
      return {
        goal_id: goalId,
        data_type: dataType,
        entries_compressed: 0,
        lessons_generated: 0,
        statistics_updated: false,
        quality_check: {
          passed: true,
          failure_coverage_ratio: 1,
          contradictions_found: 0,
        },
        compressed_at: now,
      };
    }

    let lessons: LessonEntry[] = [];
    let qualityCheck: {
      passed: boolean;
      failure_coverage_ratio: number;
      contradictions_found: number;
    } = {
      passed: false,
      failure_coverage_ratio: 0,
      contradictions_found: 0,
    };

    try {
      // Step 1: Extract patterns from entries
      const patterns = await extractPatterns(this.llmClient, expiredEntries);

      // Step 2: Distill lessons from patterns
      const rawLessons = await distillLessons(this.llmClient, patterns, expiredEntries);

      // Attach metadata to each lesson
      const sourceLoops = expiredEntries.map((e) => `loop_${e.loop_number}`);
      lessons = rawLessons.map((l) =>
        LessonEntrySchema.parse({
          ...l,
          lesson_id: generateId("lesson"),
          goal_id: goalId,
          source_loops: sourceLoops,
          extracted_at: now,
          status: "active",
          superseded_by: undefined,
        })
      );

      // Step 3: Quality check
      qualityCheck = validateCompressionQuality(lessons, expiredEntries);

      if (!qualityCheck.passed) {
        // Quality check failed — do NOT delete short-term data
        return {
          goal_id: goalId,
          data_type: dataType,
          entries_compressed: 0,
          lessons_generated: 0,
          statistics_updated: false,
          quality_check: {
            passed: false,
            failure_coverage_ratio: qualityCheck.failure_coverage_ratio,
            contradictions_found: qualityCheck.contradictions_found,
          },
          compressed_at: now,
        };
      }

      // Step 4: Store lessons in long-term (by-goal, by-dimension, global)
      storeLessonsLongTerm(this.memoryDir, goalId, lessons, expiredEntries);

      // Phase 2 (5.2c): Auto-register lesson entries in VectorIndex
      if (this.vectorIndex) {
        for (const lesson of lessons) {
          const lessonText = `${lesson.type}: ${lesson.context}. ${lesson.lesson}`;
          this.vectorIndex
            .add(lesson.lesson_id, lessonText, {
              goal_id: goalId,
              is_lesson: true,
              lesson_type: lesson.type,
            })
            .catch(() => {
              // Non-fatal: embedding failures are ignored
            });
        }
      }

      // Step 5: Update statistics
      updateStatistics(this.memoryDir, goalId, expiredEntries);

      // Step 6: Purge compressed short-term entries (only if compression succeeded)
      const compressedIds = new Set(expiredEntries.map((e) => e.id));
      const remaining = allEntries.filter((e) => !compressedIds.has(e.id));
      atomicWrite(dataFile, remaining);

      // Remove purged entries from the short-term index
      removeFromIndex(this.memoryDir, "short-term", compressedIds);
    } catch {
      // LLM failure — never delete short-term data
      return {
        goal_id: goalId,
        data_type: dataType,
        entries_compressed: 0,
        lessons_generated: 0,
        statistics_updated: false,
        quality_check: {
          passed: false,
          failure_coverage_ratio: 0,
          contradictions_found: 0,
        },
        compressed_at: now,
      };
    }

    return {
      goal_id: goalId,
      data_type: dataType,
      entries_compressed: expiredEntries.length,
      lessons_generated: lessons.length,
      statistics_updated: true,
      quality_check: {
        passed: qualityCheck.passed,
        failure_coverage_ratio: qualityCheck.failure_coverage_ratio,
        contradictions_found: qualityCheck.contradictions_found,
      },
      compressed_at: now,
    };
  }

  // ─── Working Memory Selection ───

  /**
   * Select relevant entries for working memory.
   * Phase 1: tag exact-match + recency sort.
   * Phase 2 (5.2b): semantic search fallback via VectorIndex if tag results are insufficient.
   * Phase 2 (5.2c): includes cross-goal lessons (up to 25% of budget).
   */
  selectForWorkingMemory(
    goalId: string,
    dimensions: string[],
    tags: string[],
    maxEntries: number = 10
  ): { shortTerm: ShortTermEntry[]; lessons: LessonEntry[] } {
    // 1. Tag-based query: short-term entries for this goal matching dimensions/tags
    const stIndex = loadIndex(this.memoryDir, "short-term");
    const matchingIndexEntries = stIndex.entries.filter(
      (ie) =>
        ie.goal_id === goalId &&
        (dimensions.some((d) => ie.dimensions.includes(d)) ||
          tags.some((t) => ie.tags.includes(t)))
    );

    // Sort by last_accessed descending
    matchingIndexEntries.sort(
      (a, b) =>
        new Date(b.last_accessed).getTime() -
        new Date(a.last_accessed).getTime()
    );

    // Load the actual entries
    const shortTermEntries: ShortTermEntry[] = [];
    const seenEntryIds = new Set<string>();

    for (const idxEntry of matchingIndexEntries) {
      if (shortTermEntries.length >= maxEntries) break;
      if (seenEntryIds.has(idxEntry.entry_id)) continue;

      const dataFilePath = path.join(
        this.memoryDir,
        "short-term",
        idxEntry.data_file
      );
      const allEntries =
        readJsonFile<ShortTermEntry[]>(
          dataFilePath,
          z.array(ShortTermEntrySchema)
        ) ?? [];
      const found = allEntries.find((e) => e.id === idxEntry.entry_id);
      if (found) {
        shortTermEntries.push(found);
        seenEntryIds.add(idxEntry.entry_id);

        // Update access metadata in index
        touchIndexEntry(this.memoryDir, "short-term", idxEntry.id);
      }
    }

    // Phase 2 (5.2b): If results are fewer than needed and VectorIndex available, do sync lookup
    // Note: selectForWorkingMemory is sync — semantic search via vectorIndex happens in
    // selectForWorkingMemorySemantic (async). Here we merge from the index directly.
    if (shortTermEntries.length < maxEntries && this.vectorIndex) {
      // Pull all goal entries from the short-term index (not yet in result set) as semantic candidates
      const remaining = stIndex.entries.filter(
        (ie) => ie.goal_id === goalId && !seenEntryIds.has(ie.entry_id)
      );

      // Sort by access count + recency as a proxy
      remaining.sort(
        (a, b) =>
          b.access_count - a.access_count ||
          new Date(b.last_accessed).getTime() - new Date(a.last_accessed).getTime()
      );

      for (const idxEntry of remaining) {
        if (shortTermEntries.length >= maxEntries) break;
        if (seenEntryIds.has(idxEntry.entry_id)) continue;

        const dataFilePath = path.join(
          this.memoryDir,
          "short-term",
          idxEntry.data_file
        );
        const allEntries =
          readJsonFile<ShortTermEntry[]>(
            dataFilePath,
            z.array(ShortTermEntrySchema)
          ) ?? [];
        const found = allEntries.find((e) => e.id === idxEntry.entry_id);
        if (found) {
          shortTermEntries.push(found);
          seenEntryIds.add(idxEntry.entry_id);
        }
      }

      // Re-sort by relevanceScore if driveScorer is available
      if (this.driveScorer) {
        shortTermEntries.sort(
          (a, b) =>
            this.relevanceScore(b, { goalId, dimensions, tags }) -
            this.relevanceScore(a, { goalId, dimensions, tags })
        );
      }
    }

    // 2. Query long-term lessons matching tags (cross-goal OK for lessons)
    const goalLessons = queryLessons(this.memoryDir, tags, dimensions, Math.ceil(maxEntries * 0.75));

    // Phase 2 (5.2c): Include cross-goal lessons (up to 25% of budget)
    const crossGoalBudget = Math.max(1, Math.floor(maxEntries * 0.25));
    const crossGoalLessonList = queryCrossGoalLessons(
      this.memoryDir,
      tags,
      dimensions,
      goalId,
      crossGoalBudget
    );

    // Deduplicate cross-goal lessons against goal lessons
    const seenLessonIds = new Set(goalLessons.map((l) => l.lesson_id));
    const dedupedCrossGoal = crossGoalLessonList.filter(
      (l) => !seenLessonIds.has(l.lesson_id)
    );

    const lessons = [...goalLessons, ...dedupedCrossGoal];

    return { shortTerm: shortTermEntries, lessons };
  }

  // ─── Phase 2: Drive-based Memory Management ───

  /**
   * Dissatisfaction drive: delay compression up to 2x for high-dissatisfaction dimensions.
   * For each dimension, if dissatisfaction > 0.7, delay_factor = 1 + dissatisfaction (max 2.0).
   * Returns map of dimension -> delay_factor.
   */
  getCompressionDelay(
    driveScores: Array<{ dimension: string; dissatisfaction: number }>
  ): Map<string, number> {
    const result = new Map<string, number>();
    for (const { dimension, dissatisfaction } of driveScores) {
      if (dissatisfaction > 0.7) {
        const delayFactor = Math.min(2.0, 1 + dissatisfaction);
        result.set(dimension, delayFactor);
      } else {
        result.set(dimension, 1.0);
      }
    }
    return result;
  }

  /**
   * Deadline drive: boost Working Memory priority up to 30%.
   * For each dimension, bonus = min(deadline * 0.3, 0.3).
   * Returns map of dimension -> bonus_factor.
   */
  getDeadlineBonus(
    driveScores: Array<{ dimension: string; deadline: number }>
  ): Map<string, number> {
    const result = new Map<string, number>();
    for (const { dimension, deadline } of driveScores) {
      result.set(dimension, Math.min(deadline * 0.3, 0.3));
    }
    return result;
  }

  /**
   * SatisficingJudge hook: mark satisfied dimensions for early compression.
   * Records these dimensions as candidates for early compression.
   */
  markForEarlyCompression(goalId: string, satisfiedDimensions: string[]): void {
    if (!this.earlyCompressionCandidates.has(goalId)) {
      this.earlyCompressionCandidates.set(goalId, new Set());
    }
    const candidates = this.earlyCompressionCandidates.get(goalId)!;
    for (const dim of satisfiedDimensions) {
      candidates.add(dim);
    }
  }

  /**
   * Return the set of dimensions marked for early compression for a goal.
   */
  getEarlyCompressionCandidates(goalId: string): Set<string> {
    return this.earlyCompressionCandidates.get(goalId) ?? new Set();
  }

  // ─── Phase 2 (5.2a): Drive-scorer-aware helpers ───

  /**
   * Compute a relevance score for a short-term entry given a context.
   *
   * Score = tag_match_ratio * drive_weight * freshness_factor
   *   - tag_match_ratio  = matching tags / total unique tags (0 if no tags)
   *   - drive_weight     = DriveScorer dissatisfaction score for first matching
   *                        dimension (1.0 if no DriveScorer or no dimensions)
   *   - freshness_factor = Math.exp(-daysSinceCreation / 30)
   */
  relevanceScore(
    entry: ShortTermEntry,
    context: { goalId: string; dimensions: string[]; tags: string[] }
  ): number {
    // 1. Tag match ratio
    const allTags = new Set([...entry.tags, ...context.tags]);
    const matchingTags = entry.tags.filter((t) => context.tags.includes(t)).length;
    const tagMatchRatio = allTags.size > 0 ? matchingTags / allTags.size : 0;

    // 2. Drive weight
    let driveWeight = 1.0;
    if (this.driveScorer) {
      // Use the first dimension that matches entry dimensions or context dimensions
      const relevantDimensions = entry.dimensions.length > 0
        ? entry.dimensions
        : context.dimensions;
      if (relevantDimensions.length > 0) {
        const dim = relevantDimensions[0]!;
        driveWeight = this.driveScorer.getDissatisfactionScore(dim);
        // Clamp to [0.1, 2]: floor at 0.1 so satisfied dimensions don't zero out tag-perfect matches
        driveWeight = Math.max(0.1, driveWeight);
      }
    }

    // 3. Freshness factor (exponential decay over 30 days)
    const createdAt = new Date(entry.timestamp).getTime();
    const daysSinceCreation = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
    const freshnessFactor = Math.exp(-daysSinceCreation / 30);

    return tagMatchRatio * driveWeight * freshnessFactor;
  }

  /**
   * Compute the effective retention period for a goal/dimension combination.
   *
   * If DriveScorer is available:
   *   dissatisfaction > 0.7 → retention_period * 2.0
   *   dissatisfaction > 0.4 → retention_period * 1.5
   *   otherwise             → retention_period
   * If no DriveScorer → retention_period (unchanged).
   */
  compressionDelay(goalId: string, dimension: string): number {
    const retentionPeriod = getRetentionLimit(this.config, goalId);

    if (!this.driveScorer) {
      return retentionPeriod;
    }

    const dissatisfaction = this.driveScorer.getDissatisfactionScore(dimension);

    if (dissatisfaction > 0.7) {
      return retentionPeriod * 2.0;
    } else if (dissatisfaction > 0.4) {
      return retentionPeriod * 1.5;
    }
    return retentionPeriod;
  }

  /**
   * Hook called when the SatisficingJudge determines a dimension is satisfied.
   * Marks the dimension for early compression if satisfied, clears the mark if not.
   */
  onSatisficingJudgment(
    goalId: string,
    dimension: string,
    isSatisfied: boolean
  ): void {
    if (isSatisfied) {
      // Mark dimension for early compression
      if (!this.earlyCompressionCandidates.has(goalId)) {
        this.earlyCompressionCandidates.set(goalId, new Set());
      }
      this.earlyCompressionCandidates.get(goalId)!.add(dimension);
    } else {
      // Remove from early compression candidates if previously marked
      const candidates = this.earlyCompressionCandidates.get(goalId);
      if (candidates) {
        candidates.delete(dimension);
      }
    }
  }

  // ─── Phase 2 (5.2c): Cross-Goal Lesson Search ───

  /**
   * Search long-term lessons across ALL goals using semantic search.
   * Falls back to tag-based global search if VectorIndex is unavailable.
   *
   * @param query  - natural language search query
   * @param topK   - maximum number of lessons to return (default 5)
   */
  async searchCrossGoalLessons(query: string, topK = 5): Promise<LessonEntry[]> {
    if (this.vectorIndex) {
      // Semantic search in vector index
      const results = await this.vectorIndex.search(query, topK * 2, 0.0);

      // Filter to lesson entries (metadata.is_lesson === true)
      const lessonResults = results.filter((r) => r.metadata.is_lesson === true);

      // Load actual lessons from global file
      const globalPath = path.join(
        this.memoryDir,
        "long-term",
        "lessons",
        "global.json"
      );
      const globalLessons =
        readJsonFile<LessonEntry[]>(
          globalPath,
          z.array(LessonEntrySchema)
        ) ?? [];

      const lessonMap = new Map(globalLessons.map((l) => [l.lesson_id, l]));
      const matched: LessonEntry[] = [];
      for (const r of lessonResults) {
        const lesson = lessonMap.get(r.id);
        if (lesson && lesson.status === "active") {
          matched.push(lesson);
          if (matched.length >= topK) break;
        }
      }

      // If we got enough results from semantic search, return them
      if (matched.length > 0) {
        return matched;
      }
    }

    // Fallback: tag-based global search
    const globalPath = path.join(
      this.memoryDir,
      "long-term",
      "lessons",
      "global.json"
    );
    const globalLessons =
      readJsonFile<LessonEntry[]>(
        globalPath,
        z.array(LessonEntrySchema)
      ) ?? [];

    // Simple text match on lesson content
    const queryLower = query.toLowerCase();
    const matching = globalLessons.filter(
      (l) =>
        l.status === "active" &&
        (l.lesson.toLowerCase().includes(queryLower) ||
          l.context.toLowerCase().includes(queryLower) ||
          l.relevance_tags.some((t) => t.toLowerCase().includes(queryLower)))
    );

    // Sort by recency
    matching.sort(
      (a, b) =>
        new Date(b.extracted_at).getTime() - new Date(a.extracted_at).getTime()
    );

    return matching.slice(0, topK);
  }

  // ─── Phase 2: Semantic Working Memory Selection ───

  /**
   * Semantic variant of selectForWorkingMemory.
   * Uses VectorIndex.search() to find semantically relevant entries.
   * Applies deadline bonus to relevance scores.
   * Falls back to existing sync method if no vectorIndex available.
   */
  async selectForWorkingMemorySemantic(
    goalId: string,
    query: string,
    dimensions: string[],
    tags: string[],
    maxEntries: number = 10,
    driveScores?: Array<{ dimension: string; dissatisfaction: number; deadline: number }>
  ): Promise<{ shortTerm: ShortTermEntry[]; lessons: LessonEntry[] }> {
    // Fall back to sync method if no vectorIndex
    if (!this.vectorIndex) {
      return this.selectForWorkingMemory(goalId, dimensions, tags, maxEntries);
    }

    // Compute deadline bonuses per dimension
    const deadlineBonus = driveScores
      ? this.getDeadlineBonus(driveScores.map((d) => ({ dimension: d.dimension, deadline: d.deadline })))
      : new Map<string, number>();

    const maxBonus = deadlineBonus.size > 0
      ? Math.max(...Array.from(deadlineBonus.values()))
      : 0;

    // Search vector index for semantically similar entries
    const searchResults = await this.vectorIndex.search(query, maxEntries * 2, 0.0);

    // Filter to this goal's entries
    const goalResults = searchResults.filter(
      (r) => r.metadata.goal_id === goalId
    );

    // Load short-term index for recency data
    const stIndex = loadIndex(this.memoryDir, "short-term");
    const indexEntryMap = new Map(
      stIndex.entries.map((ie) => [ie.entry_id, ie])
    );

    // Score entries by combining semantic score + recency + deadline bonus
    const now = Date.now();
    const scoredEntries: Array<{ entry: ShortTermEntry; combinedScore: number }> = [];
    const seenEntryIds = new Set<string>();

    for (const result of goalResults) {
      if (seenEntryIds.has(result.id)) continue;

      const idxEntry = indexEntryMap.get(result.id);
      if (!idxEntry) continue;

      // Compute recency score: normalize last_accessed relative to now
      const ageMs = now - new Date(idxEntry.last_accessed).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      const recencyScore = Math.max(0, 1 - ageHours / (24 * 7)); // decay over 1 week

      const combinedScore = result.similarity + recencyScore * 0.3 + maxBonus;

      // Load the actual entry from disk
      const dataFilePath = path.join(
        this.memoryDir,
        "short-term",
        idxEntry.data_file
      );
      const allEntries =
        readJsonFile<ShortTermEntry[]>(
          dataFilePath,
          z.array(ShortTermEntrySchema)
        ) ?? [];
      const found = allEntries.find((e) => e.id === idxEntry.entry_id);
      if (found) {
        scoredEntries.push({ entry: found, combinedScore });
        seenEntryIds.add(result.id);
        touchIndexEntry(this.memoryDir, "short-term", idxEntry.id);
      }
    }

    // Sort by combined score descending and take top maxEntries
    scoredEntries.sort((a, b) => b.combinedScore - a.combinedScore);
    const shortTermEntries = scoredEntries
      .slice(0, maxEntries)
      .map((s) => s.entry);

    // Still use tag/dimension-based lesson query for long-term
    const lessons = queryLessons(this.memoryDir, tags, dimensions, maxEntries);

    return { shortTerm: shortTermEntries, lessons };
  }

  // ─── Retention Policy ───

  /**
   * Apply retention policy — check each data type and trigger compression if needed.
   * Phase 2 (5.2a): uses compressionDelay() per dimension for drive-based retention.
   */
  async applyRetentionPolicy(goalId: string): Promise<CompressionResult[]> {
    const dataTypes: MemoryDataType[] = [
      "experience_log",
      "observation",
      "strategy",
      "task",
      "knowledge",
    ];

    const results: CompressionResult[] = [];

    for (const dataType of dataTypes) {
      const dataFile = getDataFile(this.memoryDir, goalId, dataType);
      if (!fs.existsSync(dataFile)) continue;

      const entries =
        readJsonFile<ShortTermEntry[]>(
          dataFile,
          z.array(ShortTermEntrySchema)
        ) ?? [];

      if (entries.length === 0) continue;

      const maxLoopNumber = entries.reduce(
        (max, e) => Math.max(max, e.loop_number),
        0
      );
      const minLoopNumber = entries.reduce(
        (min, e) => Math.min(min, e.loop_number),
        Infinity
      );

      // Phase 2 (5.2a): compute effective retention limit using drive-based delay.
      // Use the dimensions present in the entries to find the most conservative (highest) delay.
      const allDimensions = [...new Set(entries.flatMap((e) => e.dimensions))];
      let effectiveRetentionLimit: number;
      if (allDimensions.length > 0 && this.driveScorer) {
        // Take the maximum delay across all dimensions (most conservative = longest retention)
        effectiveRetentionLimit = Math.max(
          ...allDimensions.map((dim) => this.compressionDelay(goalId, dim))
        );
      } else {
        effectiveRetentionLimit = getRetentionLimit(this.config, goalId);
      }

      // Check for early compression candidates — reduce retention limit if any dimension is satisfied
      const earlyDims = this.earlyCompressionCandidates.get(goalId);
      if (earlyDims && allDimensions.some(d => earlyDims.has(d))) {
        effectiveRetentionLimit = Math.min(effectiveRetentionLimit, Math.floor(getRetentionLimit(this.config, goalId) * 0.5));
      }

      // Trigger compression if span of loops exceeds effective retention limit
      if (maxLoopNumber - minLoopNumber >= effectiveRetentionLimit) {
        const result = await this.compressToLongTerm(goalId, dataType);
        results.push(result);
      }
    }

    return results;
  }

  // ─── Goal Close ───

  /**
   * Handle goal completion or cancellation.
   * Compresses all remaining short-term data, then archives.
   */
  async onGoalClose(
    goalId: string,
    reason: "completed" | "cancelled"
  ): Promise<void> {
    const dataTypes: MemoryDataType[] = [
      "experience_log",
      "observation",
      "strategy",
      "task",
      "knowledge",
    ];

    // Step 1: Compress all remaining short-term data (best-effort)
    for (const dataType of dataTypes) {
      const dataFile = getDataFile(this.memoryDir, goalId, dataType);
      if (!fs.existsSync(dataFile)) continue;

      const entries =
        readJsonFile<ShortTermEntry[]>(
          dataFile,
          z.array(ShortTermEntrySchema)
        ) ?? [];
      if (entries.length === 0) continue;

      try {
        // Force-compress all remaining entries regardless of loop count
        await this.compressAllRemainingToLongTerm(goalId, dataType, entries);
      } catch {
        // Failure is acceptable on close — proceed to archive anyway
      }
    }

    // Step 2: Archive short-term data directory
    const goalShortTermDir = path.join(
      this.memoryDir,
      "short-term",
      "goals",
      goalId
    );
    const archiveGoalDir = path.join(this.memoryDir, "archive", goalId);

    if (fs.existsSync(goalShortTermDir)) {
      fs.mkdirSync(archiveGoalDir, { recursive: true });

      // Archive all files from the short-term goal directory
      const files = fs.readdirSync(goalShortTermDir);
      for (const file of files) {
        const srcPath = path.join(goalShortTermDir, file);
        const destPath = path.join(archiveGoalDir, file);
        fs.copyFileSync(srcPath, destPath);
      }

      // Remove from short-term
      fs.rmSync(goalShortTermDir, { recursive: true, force: true });

      // Remove goal's entries from short-term index
      removeGoalFromIndex(this.memoryDir, "short-term", goalId);
    }

    // Step 3: Archive long-term data (lessons + statistics) for this goal
    const byGoalLessonsPath = path.join(
      this.memoryDir,
      "long-term",
      "lessons",
      "by-goal",
      `${goalId}.json`
    );
    const statisticsPath = path.join(
      this.memoryDir,
      "long-term",
      "statistics",
      `${goalId}.json`
    );

    if (fs.existsSync(byGoalLessonsPath)) {
      fs.mkdirSync(archiveGoalDir, { recursive: true });
      const archiveLessonsPath = path.join(archiveGoalDir, "lessons.json");
      const existingArchive =
        readJsonFile<LessonEntry[]>(
          archiveLessonsPath,
          z.array(LessonEntrySchema)
        ) ?? [];
      const goalLessons =
        readJsonFile<LessonEntry[]>(
          byGoalLessonsPath,
          z.array(LessonEntrySchema)
        ) ?? [];
      atomicWrite(archiveLessonsPath, [
        ...existingArchive,
        ...goalLessons,
      ]);
    }

    if (fs.existsSync(statisticsPath)) {
      fs.mkdirSync(archiveGoalDir, { recursive: true });
      const archiveStatsPath = path.join(archiveGoalDir, "statistics.json");
      const stats = readJsonFile<StatisticalSummary>(
        statisticsPath,
        StatisticalSummarySchema
      );
      if (stats) {
        atomicWrite(archiveStatsPath, stats);
      }
    }

    // Step 4: Mark all goal lessons as archived in long-term
    if (fs.existsSync(byGoalLessonsPath)) {
      const lessons =
        readJsonFile<LessonEntry[]>(
          byGoalLessonsPath,
          z.array(LessonEntrySchema)
        ) ?? [];
      const archived = lessons.map((l) =>
        LessonEntrySchema.parse({ ...l, status: "archived" })
      );
      atomicWrite(byGoalLessonsPath, archived);
    }

    void reason; // used for potential future audit logging
  }

  // ─── Statistics ───

  /**
   * Read and return the statistical summary for a goal.
   */
  getStatistics(goalId: string): StatisticalSummary | null {
    const statsPath = path.join(
      this.memoryDir,
      "long-term",
      "statistics",
      `${goalId}.json`
    );
    return readJsonFile<StatisticalSummary>(
      statsPath,
      StatisticalSummarySchema
    );
  }

  // ─── Garbage Collection ───

  /**
   * Run garbage collection to enforce size limits.
   * Short-term: 10MB per goal (default). Long-term: 100MB total (default).
   */
  async runGarbageCollection(): Promise<void> {
    const shortTermGoalsDir = path.join(
      this.memoryDir,
      "short-term",
      "goals"
    );

    if (!fs.existsSync(shortTermGoalsDir)) return;

    const goalDirs = fs
      .readdirSync(shortTermGoalsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const shortTermLimitBytes =
      this.config.size_limits.short_term_per_goal_mb * 1024 * 1024;

    // Check short-term size per goal
    for (const goalId of goalDirs) {
      const goalDir = path.join(shortTermGoalsDir, goalId);
      const size = getDirectorySize(goalDir);

      if (size > shortTermLimitBytes) {
        // Trigger early compression for all data types
        const dataTypes: MemoryDataType[] = [
          "experience_log",
          "observation",
          "strategy",
          "task",
          "knowledge",
        ];
        for (const dataType of dataTypes) {
          try {
            await this.compressToLongTerm(goalId, dataType);
          } catch {
            // Compression failure is non-fatal for GC
          }
        }
      }
    }

    // Check long-term total size
    const longTermDir = path.join(this.memoryDir, "long-term");
    if (fs.existsSync(longTermDir)) {
      const longTermSize = getDirectorySize(longTermDir);
      const longTermLimitBytes =
        this.config.size_limits.long_term_total_mb * 1024 * 1024;

      if (longTermSize > longTermLimitBytes) {
        // Archive oldest (by last_accessed) lessons from long-term index
        archiveOldestLongTermEntries(this.memoryDir);
      }
    }
  }

  // ─── Private: Force-compress remaining entries on goal close ───

  private async compressAllRemainingToLongTerm(
    goalId: string,
    dataType: MemoryDataType,
    entries: ShortTermEntry[]
  ): Promise<void> {
    if (entries.length === 0) return;

    const now = new Date().toISOString();
    const patterns = await extractPatterns(this.llmClient, entries);
    const rawLessons = await distillLessons(this.llmClient, patterns, entries);
    const sourceLoops = entries.map((e) => `loop_${e.loop_number}`);

    const lessons: LessonEntry[] = rawLessons.map((l) =>
      LessonEntrySchema.parse({
        ...l,
        lesson_id: generateId("lesson"),
        goal_id: goalId,
        source_loops: sourceLoops,
        extracted_at: now,
        status: "active",
        superseded_by: undefined,
      })
    );

    storeLessonsLongTerm(this.memoryDir, goalId, lessons, entries);
    updateStatistics(this.memoryDir, goalId, entries);

    void dataType; // type info available for future audit logging
  }
}

// Re-export types and helpers needed by tests that import from this module
export type {
  ShortTermEntry,
  LessonEntry,
  StatisticalSummary,
  MemoryIndex,
  CompressionResult,
  RetentionConfig,
  MemoryDataType,
} from "../types/memory-lifecycle.js";

// Re-export phase helpers for tests that may import them directly
export {
  extractPatterns,
  distillLessons,
  validateCompressionQuality,
  updateStatistics,
  storeLessonsLongTerm,
  queryLessons,
  queryCrossGoalLessons,
  loadIndex,
  saveIndex,
  updateIndex,
  removeFromIndex,
  removeGoalFromIndex,
  touchIndexEntry,
  archiveOldestLongTermEntries,
  initializeIndex,
  mergeTaskStats,
  mergeDimStats,
  computeTrend,
  computePeriod,
} from "./memory-phases.js";

export {
  atomicWrite,
  readJsonFile,
  getDataFile,
  generateId,
  getDirectorySize,
  getRetentionLimit,
} from "./memory-persistence.js";
