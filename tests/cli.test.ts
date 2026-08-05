import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixturePath, PROJECT_ROOT } from "./helpers.js";

const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function runCli(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

describe("CLI exit-code contract", () => {
  it("returns 1 for blocking findings and keeps JSON stdout machine-readable", () => {
    const first = runCli(["scan", fixturePath("direct-model-literal"), "--format", "json"]);
    const second = runCli(["scan", fixturePath("direct-model-literal"), "--format", "json"]);

    expect(first.status).toBe(1);
    expect(JSON.parse(first.stdout)).toMatchObject({
      kind: "scan",
      summary: { total: 1, blocking: 1 },
    });
    expect(first.stdout).toBe(second.stdout);
    expect(first.stderr).toContain("[telemetry]");
  });

  it("returns 0 when scan has no blocking findings", () => {
    const result = runCli(["scan", fixturePath("comment-only"), "--format", "json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).findings).toEqual([]);
  });

  it("keeps canonical JSON byte-identical across host locales", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "migration-doctor-locale-"));
    temporaryDirectories.push(repository);
    const source = await readFile(
      path.join(fixturePath("direct-model-literal"), "src/transcribe.ts"),
      "utf8",
    );
    await writeFile(path.join(repository, "z.ts"), source);
    await writeFile(path.join(repository, "ä.ts"), source);

    const english = runCli(["scan", repository, "--format", "json"], {
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    });
    const swedish = runCli(["scan", repository, "--format", "json"], {
      LANG: "sv_SE.UTF-8",
      LC_ALL: "sv_SE.UTF-8",
    });

    expect(english.status).toBe(1);
    expect(swedish.status).toBe(1);
    expect(english.stdout).toBe(swedish.stdout);
    const report = JSON.parse(english.stdout) as {
      findings: Array<{ location: { file: string } }>;
    };
    expect(report.findings.map((finding) => finding.location.file)).toEqual(["z.ts", "ä.ts"]);
  });

  it("returns 0 after deterministic verification passes", () => {
    const result = runCli(["verify", fixturePath("direct-model-literal"), "--format", "json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "verify",
      verification: { passed: true, runtimeBehaviorVerified: false },
    });
  });

  it("returns 2 for invalid invocation", () => {
    const result = runCli(["scan", ".", "--format", "xml"]);
    expect(result.status).toBe(2);
  });

  it("returns 2 and prints help when no command is provided", () => {
    const result = runCli([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: migration-doctor");
  });

  it("returns 3 when a candidate TypeScript file cannot be parsed", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "migration-doctor-parser-"));
    temporaryDirectories.push(repository);
    await mkdir(path.join(repository, "src"));
    await writeFile(
      path.join(repository, "src/broken.ts"),
      [
        'import OpenAI from "openai";',
        "const openai = new OpenAI();",
        "openai.audio.transcriptions.create({",
        '  model: "gpt-4o-mini-transcribe-2025-03-20",',
        "  file: ,",
        "});",
      ].join("\n"),
    );

    const result = runCli(["scan", repository, "--format", "json"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("ANALYSIS_INCOMPLETE");
  });

  it("returns 3 when a candidate TypeScript file cannot be read", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "migration-doctor-unreadable-"));
    temporaryDirectories.push(repository);
    const candidate = path.join(repository, "unreadable.ts");
    await writeFile(candidate, 'const model = "gpt-4o-mini-transcribe-2025-03-20";\n');
    await chmod(candidate, 0o000);

    const result = runCli(["scan", repository, "--format", "json"]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("ANALYSIS_INCOMPLETE");
  });

  it("returns 4 when the source lock is missing", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "migration-doctor-home-"));
    temporaryDirectories.push(home);
    const result = runCli(["scan", fixturePath("comment-only")], {
      MIGRATION_DOCTOR_HOME: home,
    });

    expect(result.status).toBe(4);
    expect(result.stderr).toContain("SOURCE_LOCK_INVALID");
  });
});
