/**
 * Shell command execution helper for post-execution health checks.
 *
 * runPostExecutionHealthCheck lives in TaskLifecycle so that vi.spyOn(lifecycle, "runShellCommand")
 * works correctly in tests. Only the low-level runShellCommand is extracted here.
 */

/**
 * Run a shell command safely using execFile (not exec) to avoid shell injection.
 */
export async function runShellCommand(
  argv: string[],
  options: { timeout: number; cwd: string }
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout, stderr } = await execFileAsync(argv[0]!, argv.slice(1), {
      timeout: options.timeout,
      cwd: options.cwd,
    });
    return { success: true, stdout, stderr };
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "stdout" in err) {
      const e = err as { stdout: string; stderr: string };
      return { success: false, stdout: e.stdout || "", stderr: e.stderr || "" };
    }
    return { success: false, stdout: "", stderr: String(err) };
  }
}
