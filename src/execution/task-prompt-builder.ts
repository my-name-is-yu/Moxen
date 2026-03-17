import * as _fs from "node:fs";
import * as _path from "node:path";
import type { StateManager } from "../state-manager.js";

/**
 * Build the LLM prompt used to generate a task for the given goal and target dimension.
 *
 * Extracted from TaskLifecycle to keep prompt construction logic separate from
 * orchestration logic.
 */
export function buildTaskGenerationPrompt(
  stateManager: StateManager,
  goalId: string,
  targetDimension: string,
  knowledgeContext?: string,
  adapterType?: string,
  existingTasks?: string[],
  workspaceContext?: string
): string {
  // Load goal context to enrich the prompt
  const goal = stateManager.loadGoal(goalId);
  const dim = goal?.dimensions.find((d) => d.name === targetDimension);

  // Build goal context section
  let goalSection: string;
  if (goal) {
    const titleLine = `Goal: ${goal.title}`;
    const descLine = goal.description ? `Description: ${goal.description}` : "";
    goalSection = [titleLine, descLine].filter(Boolean).join("\n");
  } else {
    goalSection = `Goal ID: ${goalId}`;
  }

  // Build dimension context section
  let dimensionSection: string;
  if (dim) {
    const currentVal = dim.current_value !== null && dim.current_value !== undefined
      ? String(dim.current_value)
      : "unknown";
    const threshold = dim.threshold;
    let targetDesc: string;
    if (threshold.type === "min") {
      targetDesc = `at least ${threshold.value}`;
    } else if (threshold.type === "max") {
      targetDesc = `at most ${threshold.value}`;
    } else if (threshold.type === "range") {
      targetDesc = `between ${threshold.low} and ${threshold.high}`;
    } else if (threshold.type === "present") {
      targetDesc = "present (non-null)";
    } else {
      targetDesc = `equal to ${(threshold as { value: unknown }).value}`;
    }
    const gapDesc = (() => {
      if (threshold.type === "min") {
        const val = typeof dim.current_value === "number" ? dim.current_value : null;
        if (val !== null) return `${(threshold.value as number) - val} below minimum`;
        return "current value unknown";
      } else if (threshold.type === "max") {
        const val = typeof dim.current_value === "number" ? dim.current_value : null;
        if (val !== null) return `${val - (threshold.value as number)} above maximum`;
        return "current value unknown";
      } else if (threshold.type === "present") {
        return dim.current_value == null ? "value is absent (needs to be set)" : "value is present";
      }
      return "gap exists";
    })();
    dimensionSection = `Dimension to improve: "${targetDimension}" (label: ${dim.label})

Gap Analysis:
- Current value: ${currentVal}
- Target threshold: ${targetDesc}
- Gap: ${gapDesc}`;
  } else {
    dimensionSection = `Dimension to improve: "${targetDimension}"`;
  }

  // Build adapter context section
  let adapterSection = "";
  if (adapterType === "github_issue") {
    adapterSection = `\nExecution context: This task will be executed via GitHub issue creation.\nIMPORTANT: The work_description should contain the issue title on the first line, followed by the issue body. Generate a SPECIFIC, actionable issue — not a vague review task.\n`;
  } else if (adapterType === "openai_codex_cli" || adapterType === "claude_code_cli") {
    adapterSection = `\nExecution context: This task will be executed via the "${adapterType}" adapter (a CLI-based code agent).
IMPORTANT constraints for success_criteria:
- The agent runs in a sandbox and CANNOT perform git commit, git push, or merge operations.
- Success criteria MUST focus on file creation/modification only (e.g., "file X exists with content Y").
- Do NOT include "merged into repository", "committed", or "pushed" as success criteria.
- The verification_method should check file existence or content (e.g., "test -f README.md").\n`;
  } else if (adapterType) {
    adapterSection = `\nExecution context: This task will be executed via the "${adapterType}" adapter.\n`;
  }

  const knowledgeSection = knowledgeContext
    ? `\nRelevant domain knowledge:\n${knowledgeContext}\n`
    : "";

  // Read package.json for project identity (best-effort, no throw)
  let projectName = "";
  let projectDescription = "";
  try {
    const pkgPath = _path.join(process.cwd(), "package.json");
    if (_fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(_fs.readFileSync(pkgPath, "utf-8")) as {
        name?: string;
        description?: string;
      };
      projectName = pkg.name ?? "";
      projectDescription = pkg.description ?? "";
    }
  } catch {
    // silently ignore — repo context is best-effort
  }

  const repoContextParts: string[] = [];
  if (projectName) repoContextParts.push(`Project name: ${projectName}`);
  if (projectDescription) repoContextParts.push(`Project description: ${projectDescription}`);
  const repoSection = repoContextParts.length > 0
    ? `\nRepository context:\n${repoContextParts.join("\n")}\n`
    : "";

  const existingTasksSection = existingTasks && existingTasks.length > 0
    ? `\n=== Previously Generated Tasks (avoid duplication) ===\n${existingTasks.join("\n")}\nGenerate a task that addresses a DIFFERENT aspect of the goal than the existing tasks above.\n`
    : "";

  const workspaceSection = workspaceContext
    ? `\n=== Current Workspace State ===\n${workspaceContext}\n`
    : "\n=== Current Workspace State ===\nNo workspace context available.\n";

  return `${goalSection}
${dimensionSection}
${repoSection}${adapterSection}${knowledgeSection}${workspaceSection}${existingTasksSection}
IMPORTANT: Generate a task that is SPECIFIC to the actual project described above (goal title, description, and repository context). Do NOT suggest generic software improvements (e.g., user authentication, social media login, unrelated features) unless they are explicitly mentioned in the goal description. Base the task entirely on what the goal and project are actually about.

Generate ONE specific, concrete, actionable task that will directly improve the "${targetDimension}" dimension toward its target. The task should produce a single measurable output achievable in a single work session. Do not generate vague review or triage tasks — generate a task with a precise, well-defined deliverable.

IMPORTANT: The task's work_description MUST include:
1. Target file path(s) to modify or create
2. Specific changes (not "improve X" but "add section Y to file Z")
3. Completion criteria that can be verified

Return a JSON object with the following schema:
{
  "work_description": "string — what to do",
  "rationale": "string — why this task matters",
  "approach": "string — how to accomplish it",
  "success_criteria": [
    {
      "description": "string — what success looks like",
      "verification_method": "string — how to verify",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["string — what is included"],
    "out_of_scope": ["string — what is excluded"],
    "blast_radius": "string — what could be affected"
  },
  "constraints": ["string — any constraints"],
  "reversibility": "reversible" | "irreversible" | "unknown",
  "estimated_duration": { "value": number, "unit": "minutes" | "hours" | "days" | "weeks" } | null
}

Respond with only the JSON object inside a markdown code block.`;
}
