import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hashRepositoryTree, type MigrationEdge } from "@migration-doctor/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  fixturePath,
  PROJECT_ROOT,
  syntheticSource,
  syntheticTranscriptionConflict,
  writeLockedRegistry,
} from "./helpers.js";

const CLI_PATH = path.join(PROJECT_ROOT, "packages/cli/dist/index.js");
const BEHAVIOR_FIXTURE_ROOT = path.join(PROJECT_ROOT, "fixtures/behavior/assistants-to-responses");
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

function runCliAsync(args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stderr }));
  });
}

async function waitForFilesystemState<T>(
  probe: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) {
        return value;
      }
    } catch {
      // Publication paths are expected to appear and move while this probe is active.
    }
    await delay(1);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function createLargeReportRepository(): Promise<string> {
  const repository = await mkdtemp(path.join(tmpdir(), "migration-doctor-publication-race-"));
  temporaryDirectories.push(repository);
  const calls = Array.from(
    { length: 5_000 },
    (_, index) =>
      `client.audio.transcriptions.create({ model: "gpt-4o-mini-transcribe-2025-03-20", file: audio${index} });`,
  );
  await writeFile(
    path.join(repository, "transcribe.ts"),
    ['import OpenAI from "openai";', "const client = new OpenAI();", ...calls, ""].join("\n"),
  );
  return repository;
}

function runBehaviorVerification(candidate: string) {
  return runCli([
    "verify-behavior",
    path.join(BEHAVIOR_FIXTURE_ROOT, "contract.json"),
    path.join(BEHAVIOR_FIXTURE_ROOT, "baseline.json"),
    path.join(BEHAVIOR_FIXTURE_ROOT, candidate),
    "--format",
    "json",
  ]);
}

async function createSyntheticHome(edge: MigrationEdge, sourceLabel: string): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), `migration-doctor-${sourceLabel}-home-`));
  temporaryDirectories.push(home);
  await writeLockedRegistry(home, edge.sources, [edge]);
  return home;
}

function runBlockedCommands(home: string) {
  const environment = { MIGRATION_DOCTOR_HOME: home };
  const repository = fixturePath("direct-model-literal");
  return {
    scan: runCli(["scan", repository, "--format", "json"], environment),
    plan: runCli(["plan", repository, "--format", "json"], environment),
    migrate: runCli(["migrate", repository, "--format", "json"], environment),
    verify: runCli(["verify", repository, "--format", "json"], environment),
  };
}

describe("CLI exit-code contract", () => {
  it("returns 0 for a compatible offline behavioral fixture", () => {
    const result = runBehaviorVerification("candidate-compatible.json");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "4.0.0",
      kind: "behavior-verify",
      evidenceScope: "offline-fixture",
      liveApiUsed: false,
      passed: true,
      checks: expect.arrayContaining([expect.objectContaining({ passed: true })]),
    });
    expect(result.stderr).toContain("[telemetry]");
  });

  it.each([
    ["candidate-broken-text.json", "text_output_shape"],
    ["candidate-broken-conversation.json", "conversation_state"],
    ["candidate-broken-stream.json", "streaming_sequence"],
    ["candidate-broken-tools.json", "tool_call_sequence_and_arguments"],
    ["candidate-broken-retry.json", "error_retry_behavior"],
    ["candidate-broken-files.json", "changed_files_allowlist"],
  ])("returns 5 when %s violates its behavioral contract", (candidate, failedCheckId) => {
    const result = runBehaviorVerification(candidate);

    expect(result.status).toBe(5);
    const report = JSON.parse(result.stdout) as {
      passed: boolean;
      checks: Array<{ id: string; passed: boolean; mismatchPaths: string[] }>;
    };
    expect(report.passed).toBe(false);
    expect(report.checks.filter((check) => !check.passed)).toEqual([
      expect.objectContaining({ id: failedCheckId, mismatchPaths: [expect.any(String)] }),
    ]);
  });

  it("returns 2 when a behavioral fixture is not valid JSON", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "migration-doctor-behavior-input-"));
    temporaryDirectories.push(directory);
    const candidate = path.join(directory, "candidate.json");
    await writeFile(candidate, "{");

    const result = runCli([
      "verify-behavior",
      path.join(BEHAVIOR_FIXTURE_ROOT, "contract.json"),
      path.join(BEHAVIOR_FIXTURE_ROOT, "baseline.json"),
      candidate,
      "--format",
      "json",
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_CONFIGURATION");
  });

  it("returns 2 instead of hashing a behavior fixture with an own __proto__ key", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "migration-doctor-behavior-prototype-"));
    temporaryDirectories.push(directory);
    const candidate = path.join(directory, "candidate.json");
    const fixture = JSON.parse(
      await readFile(path.join(BEHAVIOR_FIXTURE_ROOT, "candidate-compatible.json"), "utf8"),
    ) as {
      textOutputs: Array<{ value: Record<string, unknown> }>;
    };
    const output = fixture.textOutputs[0];
    if (!output) {
      throw new Error("Expected a synthetic text output.");
    }
    Object.defineProperty(output.value, "__proto__", {
      value: { injected: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    await writeFile(candidate, JSON.stringify(fixture));

    const result = runCli([
      "verify-behavior",
      path.join(BEHAVIOR_FIXTURE_ROOT, "contract.json"),
      path.join(BEHAVIOR_FIXTURE_ROOT, "baseline.json"),
      candidate,
      "--format",
      "json",
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_CONFIGURATION");
    expect(result.stderr).toContain("__proto__");
  });

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

  it("saves one scan as a complete Markdown, JSON, SARIF, and HTML report bundle", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "migration-doctor-report-parent-"));
    temporaryDirectories.push(parent);
    const output = path.join(parent, "report");
    const result = runCli([
      "report",
      fixturePath("direct-model-literal"),
      "--output",
      output,
      "--format",
      "json",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`[report] directory=${await realpath(output)}`);
    expect(await readdir(output)).toEqual([
      "migration-report.html",
      "migration-report.json",
      "migration-report.md",
      "migration-report.sarif",
    ]);
    expect((await stat(output)).mode & 0o777).toBe(0o700);

    const [json, markdown, sarif, html] = await Promise.all([
      readFile(path.join(output, "migration-report.json"), "utf8"),
      readFile(path.join(output, "migration-report.md"), "utf8"),
      readFile(path.join(output, "migration-report.sarif"), "utf8"),
      readFile(path.join(output, "migration-report.html"), "utf8"),
    ]);
    expect(json).toBe(result.stdout);
    expect(JSON.parse(json)).toMatchObject({ kind: "scan", summary: { blocking: 1 } });
    expect(markdown).toContain("# Migration Doctor Scan");
    expect(JSON.parse(sarif)).toMatchObject({ version: "2.1.0", runs: [{ results: [{}] }] });
    expect(html).toContain("<!doctype html>");
    for (const file of [
      "migration-report.html",
      "migration-report.json",
      "migration-report.md",
      "migration-report.sarif",
    ]) {
      expect((await stat(path.join(output, file))).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses to save a report inside the scanned repository", () => {
    const repository = fixturePath("comment-only");
    const result = runCli(["report", repository, "--output", path.join(repository, "report")]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Report output must be outside the scanned repository");
  });

  it("refuses to replace an existing report directory", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "migration-doctor-existing-report-"));
    temporaryDirectories.push(parent);
    const output = path.join(parent, "report");
    await mkdir(output);

    const result = runCli(["report", fixturePath("comment-only"), "--output", output]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Report output already exists");
  });

  it("refuses to replace an existing report symlink", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "migration-doctor-existing-symlink-"));
    temporaryDirectories.push(parent);
    const attackerDirectory = path.join(parent, "attacker-directory");
    const output = path.join(parent, "report");
    const sentinel = path.join(attackerDirectory, "sentinel.txt");
    await mkdir(attackerDirectory);
    await writeFile(sentinel, "symlink-target-must-survive\n");
    await symlink(attackerDirectory, output, "dir");

    const result = runCli(["report", fixturePath("comment-only"), "--output", output]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Report output already exists");
    expect((await lstat(output)).isSymbolicLink()).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("symlink-target-must-survive\n");
  });

  it("allows only one concurrent publisher to claim a new report directory", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "migration-doctor-report-race-"));
    temporaryDirectories.push(parent);
    const output = path.join(parent, "report");
    const args = [
      "report",
      fixturePath("direct-model-literal"),
      "--output",
      output,
      "--format",
      "json",
    ];

    const results = await Promise.all([runCliAsync(args), runCliAsync(args)]);

    expect(results.map(({ status }) => status).sort()).toEqual([1, 2]);
    expect(results.some(({ stderr }) => stderr.includes("Report output already exists"))).toBe(
      true,
    );
    expect(await readdir(output)).toEqual([
      "migration-report.html",
      "migration-report.json",
      "migration-report.md",
      "migration-report.sarif",
    ]);
  });

  it("fails closed when the resolved output parent becomes a symlink during publication", async () => {
    const container = await mkdtemp(path.join(tmpdir(), "migration-doctor-parent-replacement-"));
    temporaryDirectories.push(container);
    const outputParent = path.join(container, "output-parent");
    const displacedParent = path.join(container, "displaced-parent");
    const attackerParent = path.join(container, "attacker-parent");
    const output = path.join(outputParent, "report");
    const sentinel = path.join(outputParent, "replacement-sentinel.txt");
    const repository = await createLargeReportRepository();
    await mkdir(outputParent);

    const completion = runCliAsync(["report", repository, "--output", output, "--format", "json"]);
    await waitForFilesystemState(async () => {
      const entries = await readdir(output);
      return entries.length > 0 ? true : undefined;
    }, "first published report file");

    await rename(outputParent, displacedParent);
    await mkdir(attackerParent);
    await symlink(attackerParent, outputParent, "dir");
    await writeFile(sentinel, "replacement-parent-must-survive\n");
    const result = await completion;

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("INVALID_CONFIGURATION");
    expect(await readFile(sentinel, "utf8")).toBe("replacement-parent-must-survive\n");
  }, 30_000);

  it("does not adopt a replacement inode for a published report file", async () => {
    const container = await mkdtemp(
      path.join(tmpdir(), "migration-doctor-published-file-replacement-"),
    );
    temporaryDirectories.push(container);
    const outputParent = path.join(container, "output-parent");
    const output = path.join(outputParent, "report");
    const publishedFile = path.join(output, "migration-report.html");
    const displacedFile = path.join(output, "owned-report.html");
    const repository = await createLargeReportRepository();
    await mkdir(outputParent);

    const completion = runCliAsync(["report", repository, "--output", output, "--format", "json"]);
    await waitForFilesystemState(async () => {
      try {
        return (await stat(publishedFile)).isFile() ? true : undefined;
      } catch {
        return undefined;
      }
    }, "published HTML report file");

    await rename(publishedFile, displacedFile);
    await writeFile(publishedFile, "replacement-published-file-must-survive\n", { mode: 0o600 });
    const result = await completion;

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("INVALID_CONFIGURATION");
    expect(await readFile(publishedFile, "utf8")).toBe("replacement-published-file-must-survive\n");
  }, 30_000);

  it("does not delete a replacement for the claimed destination after publication starts", async () => {
    const container = await mkdtemp(
      path.join(tmpdir(), "migration-doctor-destination-replacement-"),
    );
    temporaryDirectories.push(container);
    const outputParent = path.join(container, "output-parent");
    const output = path.join(outputParent, "report");
    const displacedOutput = path.join(outputParent, "displaced-report");
    const sentinel = path.join(output, "replacement-sentinel.txt");
    const repository = await createLargeReportRepository();
    await mkdir(outputParent);

    const completion = runCliAsync(["report", repository, "--output", output, "--format", "json"]);
    await waitForFilesystemState(async () => {
      const entries = await readdir(output);
      return entries.length > 0 ? true : undefined;
    }, "first published report file");

    await rename(output, displacedOutput);
    await mkdir(output, { mode: 0o700 });
    await writeFile(sentinel, "replacement-destination-must-survive\n", { mode: 0o600 });
    const result = await completion;

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("INVALID_CONFIGURATION");
    expect(await readFile(sentinel, "utf8")).toBe("replacement-destination-must-survive\n");
  }, 30_000);

  it("keeps Assistants analysis review-only across every command", () => {
    const repository = fixturePath("assistants-direct");
    const scan = runCli(["scan", repository, "--format", "json"]);
    const plan = runCli(["plan", repository, "--format", "json"]);
    const migrate = runCli(["migrate", repository, "--format", "json"]);
    const verify = runCli(["verify", repository, "--format", "json"]);

    expect([scan.status, plan.status, migrate.status, verify.status]).toEqual([1, 1, 1, 1]);
    expect(JSON.parse(scan.stdout)).toMatchObject({
      kind: "scan",
      summary: { total: 15, blocking: 9, graphIssues: 0 },
    });
    expect(JSON.parse(plan.stdout)).toMatchObject({
      kind: "plan",
      plan: {
        status: "blocked",
        requiresCodex: false,
        edits: [],
        manualActions: expect.arrayContaining([
          expect.objectContaining({
            target: expect.objectContaining({
              kind: "product",
              id: "responses-and-conversations",
            }),
            reasonCode: "manual-migration-required",
          }),
        ]),
      },
    });
    expect(JSON.parse(migrate.stdout)).toMatchObject({
      kind: "migrate",
      plan: { status: "blocked", edits: [] },
      files: [],
      applied: false,
    });
    expect(JSON.parse(verify.stdout)).toMatchObject({
      kind: "verify",
      verification: {
        passed: false,
        runtimeBehaviorVerified: false,
        changedFiles: [],
        checks: [
          { id: "manual_migration_resolved", passed: false },
          { id: "no_automatic_transformation", passed: true },
          { id: "original_repository_unchanged", passed: true },
        ],
      },
    });
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

  it("keeps default deterministic verification execution-free", async () => {
    const container = await mkdtemp(path.join(tmpdir(), "migration-doctor-no-exec-"));
    temporaryDirectories.push(container);
    const repository = path.join(container, "repository");
    const sentinel = path.join(container, "repository-script-ran.txt");
    await cp(fixturePath("direct-model-literal"), repository, { recursive: true });
    await writeFile(
      path.join(repository, "package.json"),
      JSON.stringify({
        scripts: {
          test: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
            `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`,
          )}`,
        },
      }),
    );

    const result = runCli(["verify", repository, "--format", "json"]);

    expect(result.status).toBe(0);
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses repository execution without an explicit JSON argv command", () => {
    const result = runCli([
      "verify-repository",
      fixturePath("direct-model-literal"),
      "--format",
      "json",
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires at least one --command JSON argv array");
  });

  it("runs explicit argv commands only in the temporary patched candidate", async () => {
    const repository = fixturePath("direct-model-literal");
    const before = await hashRepositoryTree(repository);
    const command = [
      process.execPath,
      "-e",
      [
        'const source = require("node:fs").readFileSync("src/transcribe.ts", "utf8");',
        "if (!source.includes('model: \"gpt-4o-mini-transcribe-2025-12-15\"')) process.exit(9);",
        "if (process.env.MIGRATION_DOCTOR_TEST_SECRET !== undefined) process.exit(10);",
        'console.log("cwd=" + process.cwd() + " OPENAI_API_KEY=sk-test-secret-value");',
      ].join("\n"),
    ];

    const result = runCli(
      [
        "verify-repository",
        repository,
        "--command",
        JSON.stringify(command),
        "--timeout-ms",
        "5000",
        "--format",
        "json",
      ],
      { MIGRATION_DOCTOR_TEST_SECRET: "must-not-be-inherited" },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "4.0.0",
      kind: "repository-verify",
      evidenceScope: "operator-supplied-commands",
      executionBoundary: "temporary-copy",
      shellUsed: false,
      ambientCredentialsInherited: false,
      networkIsolationEnforced: false,
      runtimeBehaviorVerified: false,
      treeHashScope: "scanner-visible-files",
      passed: true,
      staticVerification: { verification: { passed: true } },
      commands: [{ id: "repository_command_1", passed: true, status: "passed", exitCode: 0 }],
      candidatePatchPreserved: true,
      originalAnalyzedTreeUnchanged: true,
    });
    expect(result.stdout).not.toContain("sk-test-secret-value");
    expect(result.stdout).not.toContain(repository);
    expect(result.stderr).toContain("<temporary-candidate>");
    expect(result.stderr).toContain("OPENAI_API_KEY=<redacted>");
    expect(result.stderr).not.toContain("sk-test-secret-value");
    expect(await hashRepositoryTree(repository)).toBe(before);
  });

  it("fails repository verification on an explicit command failure with bounded redaction", () => {
    const command = [
      process.execPath,
      "-e",
      'console.error("secret=super-secret-value cwd=" + process.cwd()); process.exit(7);',
    ];
    const result = runCli([
      "verify-repository",
      fixturePath("direct-model-literal"),
      "--command",
      JSON.stringify(command),
      "--format",
      "json",
    ]);

    expect(result.status).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({
      passed: false,
      commands: [
        {
          id: "repository_command_1",
          passed: false,
          status: "failed",
          exitCode: 7,
          stderrBytes: expect.any(Number),
        },
      ],
      candidatePatchPreserved: true,
      originalAnalyzedTreeUnchanged: true,
    });
    expect(result.stdout).not.toContain("super-secret-value");
    expect(result.stderr).toContain("secret=<redacted>");
    expect(result.stderr).not.toContain("super-secret-value");
  });

  it("terminates an explicit repository command at its configured timeout", () => {
    const result = runCli([
      "verify-repository",
      fixturePath("direct-model-literal"),
      "--command",
      JSON.stringify([process.execPath, "-e", "setTimeout(() => {}, 10_000)"]),
      "--timeout-ms",
      "25",
      "--format",
      "json",
    ]);

    expect(result.status).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({
      passed: false,
      commands: [
        {
          id: "repository_command_1",
          passed: false,
          status: "timed-out",
          exitCode: null,
        },
      ],
      candidatePatchPreserved: true,
      originalAnalyzedTreeUnchanged: true,
    });
  });

  it("fails when a repository command changes the verified candidate patch", () => {
    const command = [
      process.execPath,
      "-e",
      'require("node:fs").appendFileSync("src/transcribe.ts", "\\n// changed by command\\n")',
    ];
    const result = runCli([
      "verify-repository",
      fixturePath("direct-model-literal"),
      "--command",
      JSON.stringify(command),
      "--format",
      "json",
    ]);

    expect(result.status).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({
      passed: false,
      commands: [{ passed: true, status: "passed", exitCode: 0 }],
      candidatePatchPreserved: false,
      originalAnalyzedTreeUnchanged: true,
    });
  });

  it("terminates repository commands that exceed the output limit", () => {
    const command = [
      process.execPath,
      "-e",
      'process.stdout.write("x".repeat(1_100_000)); setTimeout(() => {}, 10_000)',
    ];
    const result = runCli([
      "verify-repository",
      fixturePath("direct-model-literal"),
      "--command",
      JSON.stringify(command),
      "--timeout-ms",
      "5000",
      "--format",
      "json",
    ]);

    expect(result.status).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({
      passed: false,
      commands: [
        {
          passed: false,
          status: "output-limit",
          stdoutBytes: expect.any(Number),
        },
      ],
      candidatePatchPreserved: true,
      originalAnalyzedTreeUnchanged: true,
    });
    expect(result.stderr.length).toBeLessThan(10_000);
  });

  it.skipIf(process.platform === "win32")(
    "terminates surviving POSIX descendants before repository verification returns",
    async () => {
      const container = await mkdtemp(path.join(tmpdir(), "migration-doctor-descendant-"));
      temporaryDirectories.push(container);
      const sentinel = path.join(container, "descendant-survived.txt");
      const descendant = [
        "-e",
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran"), 300)`,
      ];
      const command = [
        process.execPath,
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          `spawn(process.execPath, ${JSON.stringify(descendant)}, { stdio: "ignore" }).unref();`,
        ].join("\n"),
      ];

      const result = runCli([
        "verify-repository",
        fixturePath("direct-model-literal"),
        "--command",
        JSON.stringify(command),
        "--format",
        "json",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(result.status).toBe(0);
      await expect(lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

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

  it("returns 4 with a reviewable report from every command when sources conflict", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "migration-doctor-conflict-home-"));
    temporaryDirectories.push(home);
    const conflict = syntheticTranscriptionConflict();
    await writeLockedRegistry(home, conflict.sources, conflict.edges);

    const results = runBlockedCommands(home);

    expect(Object.values(results).map((result) => result.status)).toEqual([4, 4, 4, 4]);
    const report = JSON.parse(results.scan.stdout) as {
      graphIssues: Array<{ kind: string; sources: unknown[]; reviewRequired: boolean }>;
    };
    expect(report.graphIssues).toEqual([
      expect.objectContaining({
        kind: "source-conflict",
        sources: expect.arrayContaining([expect.any(Object), expect.any(Object)]),
        reviewRequired: true,
      }),
    ]);
    expect(JSON.parse(results.plan.stdout)).toMatchObject({
      kind: "plan",
      plan: { status: "blocked", edits: [] },
    });
    expect(JSON.parse(results.migrate.stdout)).toMatchObject({
      kind: "migrate",
      plan: { status: "blocked", edits: [] },
      files: [],
    });
    expect(JSON.parse(results.verify.stdout)).toMatchObject({
      kind: "verify",
      plan: { status: "blocked", edits: [] },
      verification: { passed: false, changedFiles: [] },
    });
  });

  it("returns reportable exit 1 results when migration guidance has no destination", async () => {
    const source = syntheticSource("missing-destination-cli", "c");
    const home = await createSyntheticHome(
      {
        id: "synthetic.transcribe.destination-missing",
        from: { kind: "model", id: "gpt-4o-mini-transcribe-2025-03-20" },
        to: null,
        sources: [source],
        languages: ["typescript"],
        behaviorChanges: [],
        automationTier: "C",
        reviewRequired: true,
      },
      "missing-destination",
    );

    const results = runBlockedCommands(home);
    expect([results.plan.status, results.migrate.status, results.verify.status]).toEqual([1, 1, 1]);
    expect(JSON.parse(results.plan.stdout)).toMatchObject({
      kind: "plan",
      graphIssues: [expect.objectContaining({ kind: "missing-destination" })],
      plan: { status: "blocked", edits: [] },
    });
    expect(JSON.parse(results.migrate.stdout)).toMatchObject({
      kind: "migrate",
      plan: { status: "blocked", edits: [] },
      files: [],
    });
    expect(JSON.parse(results.verify.stdout)).toMatchObject({
      kind: "verify",
      plan: { status: "blocked", edits: [] },
      verification: { passed: false, changedFiles: [] },
    });
  });

  it("returns reportable exit 1 results for a Tier B migration path", async () => {
    const source = syntheticSource("tier-b-cli", "d");
    const home = await createSyntheticHome(
      {
        id: "synthetic.transcribe.tier-b",
        from: { kind: "model", id: "gpt-4o-mini-transcribe-2025-03-20" },
        to: { kind: "model", id: "synthetic-transcribe-tier-b-target" },
        sources: [source],
        languages: ["typescript"],
        behaviorChanges: ["Synthetic behavior review is required."],
        automationTier: "B",
        reviewRequired: true,
      },
      "tier-b",
    );

    const results = runBlockedCommands(home);
    expect([results.plan.status, results.migrate.status, results.verify.status]).toEqual([1, 1, 1]);
    expect(JSON.parse(results.plan.stdout)).toMatchObject({
      kind: "plan",
      findings: [
        expect.objectContaining({
          kind: "migration-blocked",
          automationTier: "B",
          remediation: { kind: "none" },
        }),
      ],
      plan: { status: "blocked", edits: [] },
    });
    expect(JSON.parse(results.migrate.stdout)).toMatchObject({
      kind: "migrate",
      files: [],
    });
    expect(JSON.parse(results.verify.stdout)).toMatchObject({
      kind: "verify",
      verification: { passed: false, changedFiles: [] },
    });
  });
});
