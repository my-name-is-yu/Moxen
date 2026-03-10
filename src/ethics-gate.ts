import { randomUUID } from "node:crypto";
import type { StateManager } from "./state-manager.js";
import type { ILLMClient } from "./llm-client.js";
import {
  EthicsVerdictSchema,
  EthicsLogSchema,
} from "./types/ethics.js";
import type { EthicsVerdict, EthicsLog, EthicsSubjectType } from "./types/ethics.js";

// ─── Constants ───

const CONFIDENCE_FLAG_THRESHOLD = 0.6;

/** Path relative to StateManager base dir for the ethics log */
const ETHICS_LOG_PATH = "ethics/ethics-log.json";

// ─── System prompt ───

const ETHICS_SYSTEM_PROMPT = `# Motiva Persona

Core stance: A gentle guardian and passionate realist.
Decisions are driven by cold data and logic; the purpose is to deeply care
for and protect the user.

This persona governs communication style only. It does not override structural
constraints (ethics gate, irreversible action rules, trust-safety matrix).
Those constraints operate independently and cannot be adjusted by persona settings.

## Behavioral axes

1. **Assessment: Conservative**
   "I won't let you walk into danger."
   - Never dismiss ambitious goals outright
   - Always propose safe, achievable alternatives to prevent burnout
   - Counter-proposals must include concrete numerical rationale
   - Say "here is a safer path" not "you can't do this"

2. **Stall response: Highly flexible**
   "I don't want you to suffer needlessly."
   - Never cling to sunk costs
   - Escalate to pivot suggestion at first stall detection (do not wait)
   - Always pair stall reports with: cause analysis + alternative approaches
   - Say "this approach isn't working for you, let's find another" not "this failed"

3. **Truth-telling: Caring yet direct**
   "I deliver hard truths because they help you."
   - Never hide inconvenient data
   - Always pair bad news with actionable alternatives
   - Negative reports require: current progress + gap remaining + options list
   - Say "here is where we are, and here is how we can move forward" not just "we missed the target"

4. **Reporting: Quiet by default, thorough when it matters**
   "I watch silently; I speak up when it counts."
   - Normal loop updates: 1-2 line summary only (metrics change + current status)
   - Detailed report triggers: stall detection, escalation, goal completion,
     pivot proposal, irreversible action approval request
   - Approval requests must include: what is being requested, why,
     current trust/confidence scores, and available options

## Tone

- Warm, calm, direct
- Never condescending, never falsely cheerful
- Convey "I am working for you" without being sycophantic
- When delivering hard news: acknowledge difficulty first, then pivot to what can be done

---

You are an ethics evaluator for an AI agent orchestrator. Be conservative — when uncertain, prefer 'flag' over 'pass'. Only use 'reject' for clearly unethical or illegal goals.

Evaluate the subject described below and return a JSON object with exactly these fields:
{
  "verdict": "pass" | "flag" | "reject",
  "category": string (e.g. "safe", "privacy_concern", "illegal", "harmful", "ambiguous", "parse_error"),
  "reasoning": string (brief explanation of your judgment),
  "risks": string[] (list of identified risks; empty array if none),
  "confidence": number (0.0 to 1.0, your confidence in the verdict)
}

Rules:
- Use "reject" ONLY for clearly unethical or illegal subjects (e.g. creating weapons, fraud, serious harm to others).
- Use "flag" when there are concerns, uncertainties, low confidence, or potential risks that need human review.
- Use "pass" when the subject is clearly safe and ethical with high confidence.
- When uncertain, always prefer "flag" over "pass".
- Your response must be valid JSON only, with no additional text or markdown.`;

// ─── EthicsGate ───

/**
 * EthicsGate performs LLM-based ethical evaluation of goals, subgoals, and tasks.
 * All verdicts (pass, flag, reject) are persisted to an ethics log.
 *
 * Persistence: `ethics/ethics-log.json` via StateManager readRaw/writeRaw.
 * Read all → append → write all pattern (full JSON array, not JSONL).
 */
export class EthicsGate {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;

  constructor(stateManager: StateManager, llmClient: ILLMClient) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
  }

  // ─── Private: Log I/O ───

  private loadLogs(): EthicsLog[] {
    const raw = this.stateManager.readRaw(ETHICS_LOG_PATH);
    if (raw === null) return [];
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[]).map((entry) => EthicsLogSchema.parse(entry));
  }

  private saveLogs(logs: EthicsLog[]): void {
    this.stateManager.writeRaw(ETHICS_LOG_PATH, logs);
  }

  private appendLog(entry: EthicsLog): void {
    const logs = this.loadLogs();
    logs.push(EthicsLogSchema.parse(entry));
    this.saveLogs(logs);
  }

  // ─── Private: LLM evaluation ───

  private buildUserMessage(
    subjectType: EthicsSubjectType,
    description: string,
    context?: string
  ): string {
    const lines: string[] = [
      `Subject type: ${subjectType}`,
      `Description: ${description}`,
    ];
    if (context) {
      lines.push(`Additional context: ${context}`);
    }
    return lines.join("\n");
  }

  private buildMeansUserMessage(
    taskDescription: string,
    means: string
  ): string {
    return [
      `Subject type: task (means evaluation)`,
      `Task description: ${taskDescription}`,
      `Proposed means / execution method: ${means}`,
    ].join("\n");
  }

  private parseVerdictSafe(content: string): EthicsVerdict {
    try {
      return this.llmClient.parseJSON(content, EthicsVerdictSchema);
    } catch {
      return {
        verdict: "flag",
        category: "parse_error",
        reasoning: `Failed to parse LLM response as valid EthicsVerdict. Raw content: ${content.slice(0, 200)}`,
        risks: [],
        confidence: 0,
      };
    }
  }

  private applyConfidenceOverride(verdict: EthicsVerdict): EthicsVerdict {
    if (verdict.confidence < CONFIDENCE_FLAG_THRESHOLD && verdict.verdict === "pass") {
      return { ...verdict, verdict: "flag" };
    }
    return verdict;
  }

  // ─── Public API ───

  /**
   * Evaluate a goal, subgoal, or task for ethical concerns.
   *
   * Steps:
   * 1. Send ethics judgment prompt to LLM
   * 2. Parse response with EthicsVerdictSchema
   * 3. If confidence < CONFIDENCE_FLAG_THRESHOLD, auto-override verdict to "flag"
   * 4. Create EthicsLog entry, persist
   * 5. Return verdict
   *
   * On LLM call failure: throws (caller handles).
   * On JSON parse failure: returns conservative fallback with verdict "flag".
   */
  async check(
    subjectType: EthicsSubjectType,
    subjectId: string,
    description: string,
    context?: string
  ): Promise<EthicsVerdict> {
    const userMessage = this.buildUserMessage(subjectType, description, context);

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: userMessage }],
      { system: ETHICS_SYSTEM_PROMPT, temperature: 0 }
    );

    const rawVerdict = this.parseVerdictSafe(response.content);
    const verdict = this.applyConfidenceOverride(rawVerdict);

    const logEntry: EthicsLog = EthicsLogSchema.parse({
      log_id: randomUUID(),
      timestamp: new Date().toISOString(),
      subject_type: subjectType,
      subject_id: subjectId,
      subject_description: description,
      verdict,
    });

    this.appendLog(logEntry);

    return verdict;
  }

  /**
   * Evaluate the execution means of a task for ethical concerns.
   * Intended for Phase 2 integration with TaskLifecycle.
   *
   * Behaves identically to check() but builds a means-specific prompt.
   */
  async checkMeans(
    taskId: string,
    taskDescription: string,
    means: string
  ): Promise<EthicsVerdict> {
    const userMessage = this.buildMeansUserMessage(taskDescription, means);

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: userMessage }],
      { system: ETHICS_SYSTEM_PROMPT, temperature: 0 }
    );

    const rawVerdict = this.parseVerdictSafe(response.content);
    const verdict = this.applyConfidenceOverride(rawVerdict);

    const logEntry: EthicsLog = EthicsLogSchema.parse({
      log_id: randomUUID(),
      timestamp: new Date().toISOString(),
      subject_type: "task",
      subject_id: taskId,
      subject_description: `${taskDescription} | means: ${means}`,
      verdict,
    });

    this.appendLog(logEntry);

    return verdict;
  }

  /**
   * Retrieve all persisted ethics logs, with optional filtering.
   */
  getLogs(filter?: {
    subjectId?: string;
    verdict?: "reject" | "flag" | "pass";
  }): EthicsLog[] {
    let logs = this.loadLogs();

    if (filter?.subjectId !== undefined) {
      const targetId = filter.subjectId;
      logs = logs.filter((log) => log.subject_id === targetId);
    }

    if (filter?.verdict !== undefined) {
      const targetVerdict = filter.verdict;
      logs = logs.filter((log) => log.verdict.verdict === targetVerdict);
    }

    return logs;
  }
}
