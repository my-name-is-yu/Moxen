import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceContextProvider } from "../src/context-providers/workspace-context.js";

// Helper: write a temp file and clean it up after each test
const tmpFiles: string[] = [];

function writeTmpFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  tmpFiles.push(filePath);
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

describe("createWorkspaceContextProvider — external file reading", () => {
  const workDir = os.tmpdir(); // safe workDir that exists

  it("reads a /tmp/ file mentioned in goal description", async () => {
    const tmpPath = path.join("/tmp", `motiva-test-${Date.now()}.txt`);
    writeTmpFile(tmpPath, "hello from tmp file");

    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Check output in ${tmpPath}`
    );

    const result = await provider("goal-1", "quality");
    expect(result).toContain("External file:");
    expect(result).toContain("hello from tmp file");
  });

  it("reads a file under home directory mentioned in goal description", async () => {
    const homePath = path.join(os.homedir(), `.motiva-test-${Date.now()}.txt`);
    writeTmpFile(homePath, "home dir file content");

    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Evaluate ${homePath} for completeness`
    );

    const result = await provider("goal-2", "completeness");
    expect(result).toContain("External file:");
    expect(result).toContain("home dir file content");
  });

  it("does NOT read a file outside allowed prefixes (e.g. /etc/passwd)", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir },
      () => "Inspect /etc/passwd for issues"
    );

    const result = await provider("goal-3", "security");
    // Should not contain /etc/passwd content (root:x:0:0...)
    expect(result).not.toContain("root:");
    expect(result).not.toContain("External file: /etc/passwd");
  });

  it("skips a /tmp/ path that does not exist", async () => {
    const missingPath = "/tmp/motiva-nonexistent-file-xyz-9999.txt";

    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Read output from ${missingPath}`
    );

    const result = await provider("goal-4", "output");
    expect(result).not.toContain("External file: " + missingPath);
  });

  it("skips a file that exceeds externalFileMaxBytes", async () => {
    const largePath = path.join("/tmp", `motiva-large-${Date.now()}.txt`);
    writeTmpFile(largePath, "x".repeat(100));

    const provider = createWorkspaceContextProvider(
      { workDir, externalFileMaxBytes: 10 }, // limit to 10 bytes
      () => `Read ${largePath}`
    );

    const result = await provider("goal-5", "size");
    expect(result).not.toContain("External file: " + largePath);
  });

  it("deduplicates the same path mentioned multiple times", async () => {
    const tmpPath = path.join("/tmp", `motiva-dedup-${Date.now()}.txt`);
    writeTmpFile(tmpPath, "dedup content");

    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Check ${tmpPath} and also ${tmpPath} again`
    );

    const result = await provider("goal-6", "quality");
    // Should appear exactly once
    const count = (result.match(/dedup content/g) ?? []).length;
    expect(count).toBe(1);
  });
});

describe("createWorkspaceContextProvider — existing workspace behavior unchanged", () => {
  let tmpWorkDir: string;

  beforeEach(() => {
    tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-ws-test-"));
    fs.writeFileSync(path.join(tmpWorkDir, "README.md"), "# Test Project", "utf-8");
    fs.writeFileSync(path.join(tmpWorkDir, "package.json"), '{"name":"test"}', "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
  });

  it("includes README.md and package.json in output", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir },
      () => "Improve code quality"
    );

    const result = await provider("goal-ws", "quality");
    expect(result).toContain("README.md");
    expect(result).toContain("package.json");
    expect(result).toContain("# Test Project");
  });

  it("returns workspace header line", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir },
      () => "some goal"
    );

    const result = await provider("goal-header", "dim");
    expect(result).toContain(`# Workspace: ${tmpWorkDir}`);
  });
});
