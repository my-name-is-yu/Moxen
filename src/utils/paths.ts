// ─── Tavori Path Utilities ───
//
// Centralizes ~/.tavori path construction.
// TAVORI_HOME env var overrides the default ~/.tavori location.

import * as os from "node:os";
import * as path from "node:path";

/**
 * Returns the Tavori base directory.
 * Defaults to ~/.tavori; can be overridden via TAVORI_HOME env var.
 */
export function getTavoriDirPath(): string {
  return process.env["TAVORI_HOME"] ?? path.join(os.homedir(), ".tavori");
}

export function getGoalsDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "goals");
}

export function getEventsDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "events");
}

export function getArchiveDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "archive");
}

export function getPluginsDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "plugins");
}

export function getLogsDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "logs");
}

export function getDatasourcesDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "datasources");
}

export function getScheduleDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "schedule");
}

export function getReportsDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "reports");
}
