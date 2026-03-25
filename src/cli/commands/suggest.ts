// ─── seedpulse suggest and improve commands ───

import { parseArgs } from "node:util";

import { StateManager } from "../../state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import { buildLLMClient } from "../../llm/provider-factory.js";
import { ReportingEngine } from "../../reporting-engine.js";
import { CapabilityDetector } from "../../observation/capability-detector.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import { Logger } from "../../runtime/logger.js";
import { getLogsDir } from "../../utils/paths.js";
import type { ProgressEvent } from "../../core-loop.js";
import type { Task } from "../../types/task.js";
import {
  normalizeSuggestPayload,
  generateSuggestOutput,
  gatherProjectContext,
} from "./suggest-normalizer.js";

// ─── Shared setup helper ───

type BuildDepsLoopArgs = Parameters<typeof buildDeps> extends [unknown, unknown, ...infer R] ? R : never;

async function buildSuggestContext(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  loopArgs?: BuildDepsLoopArgs
): Promise<{
  deps: Awaited<ReturnType<typeof buildDeps>>;
  existingTitles: string[];
  capabilityDetector: CapabilityDetector;
}> {
  const deps = loopArgs
    ? await buildDeps(stateManager, characterConfigManager, ...loopArgs)
    : await buildDeps(stateManager, characterConfigManager);

  const existingGoalIds = await deps.stateManager.listGoalIds();
  const existingTitles: string[] = [];
  for (const id of existingGoalIds) {
    const goal = await deps.stateManager.loadGoal(id);
    if (goal?.title) {
      existingTitles.push(goal.title);
    }
  }

  const llmClient = await buildLLMClient();
  const reportingEngine = new ReportingEngine(stateManager);
  const capabilityDetector = new CapabilityDetector(stateManager, llmClient, reportingEngine);

  return { deps, existingTitles, capabilityDetector };
}

// ─── cmdSuggest ───

export async function cmdSuggest(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  args: string[]
): Promise<number> {
  const logger = getCliLogger();
  let values: { max?: string; path?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        max: { type: "string", short: "n", default: "5" },
        path: { type: "string", short: "p", default: "." },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { max?: string; path?: string }; positionals: string[] });
  } catch (err) {
    logger.error(formatOperationError("parse suggest command arguments", err));
    return 1;
  }

  const context = positionals[0];
  if (!context) {
    logger.error('Usage: seedpulse suggest "<context>" [--max N] [--path <dir>]');
    return 1;
  }

  try {
    await ensureProviderConfig();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let setupResult: Awaited<ReturnType<typeof buildSuggestContext>>;
  try {
    setupResult = await buildSuggestContext(stateManager, characterConfigManager);
  } catch (err) {
    logger.error(formatOperationError("initialise suggest dependencies", err));
    return 1;
  }

  const { deps, existingTitles, capabilityDetector } = setupResult;
  const targetPath = values.path?.trim() ? values.path : ".";
  const maxSuggestions = parseInt(values.max ?? "5", 10);
  const repoFiles: string[] = [];

  console.log("Generating goal suggestions...\n");

  let suggestions: unknown;
  try {
    suggestions = await generateSuggestOutput(
      deps.goalNegotiator.suggestGoals.bind(deps.goalNegotiator),
      context,
      { maxSuggestions, existingGoals: existingTitles, repoPath: targetPath, capabilityDetector }
    );
  } catch (err) {
    logger.error(formatOperationError("generate goal suggestions", err));
    return 1;
  }

  const finalPayload = normalizeSuggestPayload(suggestions, targetPath, targetPath, context, maxSuggestions, repoFiles);
  console.log(JSON.stringify(finalPayload, null, 2));

  return 0;
}

// ─── cmdImprove ───

export async function cmdImprove(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  args: string[]
): Promise<number> {
  const logger = getCliLogger();
  let values: { auto?: boolean; max?: string; yes?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        auto: { type: "boolean", default: false },
        max: { type: "string", short: "n", default: "3" },
        yes: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { auto?: boolean; max?: string; yes?: boolean }; positionals: string[] });
  } catch (err) {
    logger.error(formatOperationError("parse improve command arguments", err));
    return 1;
  }

  const targetPath = positionals[0] || ".";
  console.log(`\n[SeedPulse Improve] Analyzing ${targetPath}...\n`);

  try {
    await ensureProviderConfig();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const maxSuggestions = parseInt(values.max || "3", 10);
  const loopIterations = 10;

  // Build loop deps upfront when --yes/--auto so buildDeps is only called once
  let loopArgs: BuildDepsLoopArgs | undefined;
  if (values.auto || values.yes) {
    const approvalFnEarly = async (task: Task): Promise<boolean> => {
      console.log(`\n--- Auto-approved (--yes) ---`);
      console.log(`Task: ${task.work_description.split("\n")[0]}`);
      return true;
    };
    const runLoggerEarly = new Logger({
      dir: getLogsDir(),
      level: "debug",
      consoleOutput: false,
    });
    let lastIterationLoggedEarly = -1;
    const onProgressEarly = (event: ProgressEvent): void => {
      const prefix = `[${event.iteration}/${event.maxIterations}]`;
      if (event.phase === "Observing...") {
        if (event.iteration !== lastIterationLoggedEarly) {
          lastIterationLoggedEarly = event.iteration;
          const gapStr = event.gap !== undefined ? ` gap=${event.gap.toFixed(2)}` : "";
          process.stdout.write(`${prefix} Observing...${gapStr}\n`);
        }
      } else if (event.phase === "Generating task...") {
        const gapStr = event.gap !== undefined ? ` gap=${event.gap.toFixed(2)}` : "";
        const confStr = event.confidence !== undefined ? ` confidence=${Math.round(event.confidence * 100)}%` : "";
        process.stdout.write(`${prefix} Generating task...${gapStr}${confStr}\n`);
      } else if (event.phase === "Skipped") {
        const reason = event.skipReason ?? "unknown";
        process.stdout.write(`${prefix} Skipped — ${reason.replace(/_/g, " ")}\n`);
      } else if (event.phase === "Executing task...") {
        if (event.taskDescription) {
          process.stdout.write(`${prefix} Executing task: "${event.taskDescription}"\n`);
        } else {
          process.stdout.write(`${prefix} Executing task...\n`);
        }
      } else if (event.phase === "Verifying result...") {
        if (event.taskDescription) {
          process.stdout.write(`${prefix} Verifying: "${event.taskDescription}"\n`);
        } else {
          process.stdout.write(`${prefix} Verifying result...\n`);
        }
      } else if (event.phase === "Skipped (no state change)") {
        process.stdout.write(`${prefix} Skipped (no state change detected)\n`);
      }
    };
    loopArgs = [{ maxIterations: loopIterations }, approvalFnEarly, runLoggerEarly, onProgressEarly];
  }

  let setupResult: Awaited<ReturnType<typeof buildSuggestContext>>;
  try {
    setupResult = await buildSuggestContext(stateManager, characterConfigManager, loopArgs);
  } catch (err) {
    logger.error(formatOperationError("initialise improve dependencies", err));
    return 1;
  }

  const { deps, existingTitles, capabilityDetector } = setupResult;
  const context = await gatherProjectContext(targetPath);
  const repoFiles: string[] = [];

  let rawSuggestions: unknown;
  try {
    rawSuggestions = await generateSuggestOutput(
      deps.goalNegotiator.suggestGoals.bind(deps.goalNegotiator),
      context,
      { maxSuggestions, existingGoals: existingTitles, repoPath: targetPath, capabilityDetector }
    );
  } catch (err) {
    logger.error(formatOperationError("generate improvement suggestions", err));
    return 1;
  }

  const normalizedPayload = normalizeSuggestPayload(rawSuggestions, targetPath, targetPath, context, maxSuggestions, repoFiles);
  const suggestions = normalizedPayload.suggestions;

  if (suggestions.length === 0) {
    console.log("No improvement goals found for the given path.");
    return 0;
  }

  // Select goal
  let selectedIndex = 0;
  if (values.auto) {
    console.log(`[Auto] Selected: ${suggestions[0]?.title ?? ""}`);
  } else {
    console.log("=== Suggested Improvements ===\n");
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      if (!s) continue;
      console.log(`${i + 1}. ${s.title}`);
      console.log(`   ${s.rationale}\n`);
    }
    if (values.yes) {
      selectedIndex = 0;
      console.log(`[--yes] Auto-selecting: ${suggestions[0]?.title ?? ""}\n`);
    } else {
      selectedIndex = 0;
      console.log(`Selected: ${suggestions[0]?.title ?? ""}\n`);
    }
  }

  const selected = suggestions[selectedIndex];
  if (!selected) {
    logger.error("Error: no suggestion available at index 0.");
    return 1;
  }

  // Negotiate the selected goal
  const selectedDescription = selected.steps.join("\n");
  console.log(`[SeedPulse Improve] Negotiating goal: "${selected.title}"...`);
  let goal: Awaited<ReturnType<typeof deps.goalNegotiator.negotiate>>["goal"];
  let response: Awaited<ReturnType<typeof deps.goalNegotiator.negotiate>>["response"];
  try {
    ({ goal, response } = await deps.goalNegotiator.negotiate(selectedDescription, {
      constraints: [],
    }));
  } catch (err) {
    logger.error(formatOperationError(`negotiate goal "${selected.title}"`, err));
    return 1;
  }

  const responseType = (response as { type: string }).type;
  if (responseType === "reject") {
    logger.error(`Goal negotiation rejected: ${response.message}`);
    return 1;
  }

  console.log(`[SeedPulse Improve] Goal registered: ${goal.id}`);
  console.log(`  Response: ${responseType} — ${response.message}\n`);

  // Run the loop if --auto or --yes
  if (values.auto || values.yes) {
    console.log(`[SeedPulse Improve] Starting improvement loop for goal ${goal.id}...`);

    const { coreLoop } = deps;

    const shutdown = () => {
      console.log("\nStopping loop...");
      coreLoop.stop();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    let result: Awaited<ReturnType<typeof coreLoop.run>>;
    try {
      result = await coreLoop.run(goal.id);
    } catch (err) {
      logger.error(formatOperationError(`run improvement loop for goal "${goal.id}"`, err));
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      return 1;
    }

    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    console.log(`[SeedPulse Improve] Loop completed for goal ${goal.id}`);

    if (result.finalStatus === "stalled") {
      logger.error("Improvement loop stalled. No further progress detected.");
      return 2;
    }
    if (result.finalStatus === "error") {
      logger.error("Improvement loop ended with an error.");
      return 1;
    }
  } else {
    console.log(`Goal created. Run with: seedpulse run --goal ${goal.id}`);
  }

  return 0;
}
