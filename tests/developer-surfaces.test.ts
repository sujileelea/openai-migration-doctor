import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MigrationEdge } from "@migration-doctor/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_ROOT, syntheticSource, writeLockedRegistry } from "./helpers.js";

const temporaryDirectories: string[] = [];
let toolSource: string;
let cyclicToolSource: string;
let cyclicActionSource: string;

async function projectFile(relativePath: string): Promise<string> {
  return readFile(path.join(PROJECT_ROOT, relativePath), "utf8");
}

function run(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  },
) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout,
  });
}

function requireSuccess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): string {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

async function createCommittedToolSnapshot(): Promise<string> {
  const snapshot = await mkdtemp(path.join(tmpdir(), "migration-doctor-tool-source-"));
  temporaryDirectories.push(snapshot);
  const listed = requireSuccess(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: PROJECT_ROOT },
  );

  for (const relativePath of listed.split("\0").filter(Boolean)) {
    const source = path.join(PROJECT_ROOT, relativePath);
    const destination = path.join(snapshot, relativePath);
    const metadata = await lstat(source);
    await mkdir(path.dirname(destination), { recursive: true });
    if (metadata.isSymbolicLink()) {
      await symlink(await readlink(source), destination);
    } else {
      await copyFile(source, destination);
      await chmod(destination, metadata.mode & 0o777);
    }
  }

  requireSuccess("git", ["init", "--quiet"], { cwd: snapshot });
  requireSuccess("git", ["add", "."], { cwd: snapshot });
  requireSuccess(
    "git",
    [
      "-c",
      "user.name=Migration Doctor Tests",
      "-c",
      "user.email=migration-doctor@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "test snapshot",
    ],
    { cwd: snapshot },
  );
  return snapshot;
}

async function createCyclicToolSnapshot(source: string): Promise<string> {
  const snapshot = await mkdtemp(path.join(tmpdir(), "migration-doctor-cycle-source-"));
  temporaryDirectories.push(snapshot);
  requireSuccess("git", ["clone", "--quiet", source, snapshot], { cwd: PROJECT_ROOT });

  const officialSource = syntheticSource("action-cycle", "c");
  const sourceModel = {
    kind: "model" as const,
    id: "gpt-4o-mini-transcribe-2025-03-20",
    displayName: "Synthetic source model",
  };
  const destinationModel = {
    kind: "model" as const,
    id: "synthetic-cycle-destination",
    displayName: "Synthetic cycle destination",
  };
  const edges: MigrationEdge[] = [
    {
      id: "synthetic.action-cycle.forward",
      from: sourceModel,
      to: destinationModel,
      sources: [officialSource],
      languages: ["python"],
      behaviorChanges: [],
      automationTier: "A",
      reviewRequired: false,
    },
    {
      id: "synthetic.action-cycle.return",
      from: destinationModel,
      to: sourceModel,
      sources: [officialSource],
      languages: ["python"],
      behaviorChanges: [],
      automationTier: "C",
      reviewRequired: true,
    },
  ];
  await writeLockedRegistry(snapshot, [officialSource], edges);
  requireSuccess("git", ["add", "."], { cwd: snapshot });
  requireSuccess(
    "git",
    [
      "-c",
      "user.name=Migration Doctor Tests",
      "-c",
      "user.email=migration-doctor@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "cyclic registry",
    ],
    { cwd: snapshot },
  );
  return snapshot;
}

async function createArchiveSource(source: string): Promise<string> {
  const archiveSource = await mkdtemp(path.join(tmpdir(), "migration-doctor-action-source-"));
  temporaryDirectories.push(archiveSource);
  requireSuccess(
    "bash",
    [
      "-c",
      'set -o pipefail; git -C "$1" archive --format=tar HEAD | tar -xf - -C "$2"',
      "migration-doctor-action-archive",
      source,
      archiveSource,
    ],
    { cwd: PROJECT_ROOT },
  );
  return archiveSource;
}

async function createPythonTarget(): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), "migration-doctor-python-target-"));
  temporaryDirectories.push(target);
  await writeFile(
    path.join(target, "transcribe.py"),
    [
      "from openai import OpenAI",
      "",
      "client = OpenAI()",
      "client.audio.transcriptions.create(",
      '    model="gpt-4o-mini-transcribe-2025-03-20",',
      '    file=b"synthetic-audio",',
      ")",
      "",
    ].join("\n"),
  );
  requireSuccess("git", ["init", "--quiet"], { cwd: target });
  requireSuccess("git", ["add", "."], { cwd: target });
  requireSuccess(
    "git",
    [
      "-c",
      "user.name=Migration Doctor Tests",
      "-c",
      "user.email=migration-doctor@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "python target",
    ],
    { cwd: target },
  );
  return target;
}

async function workingTreeBytes(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (relative === "" && entry.name === ".git") {
      continue;
    }
    const entryRelative = path.join(relative, entry.name);
    const absolute = path.join(root, entryRelative);
    if (entry.isDirectory()) {
      snapshot.push(`directory:${entryRelative}`);
      snapshot.push(...(await workingTreeBytes(root, entryRelative)));
    } else if (entry.isSymbolicLink()) {
      snapshot.push(`symlink:${entryRelative}:${await readlink(absolute)}`);
    } else {
      const bytes = await readFile(absolute);
      snapshot.push(`file:${entryRelative}:${createHash("sha256").update(bytes).digest("hex")}`);
    }
  }
  return snapshot;
}

function parseOutputs(raw: string): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      outputs.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return outputs;
}

beforeAll(async () => {
  toolSource = await createCommittedToolSnapshot();
  cyclicToolSource = await createCyclicToolSnapshot(toolSource);
  cyclicActionSource = await createArchiveSource(cyclicToolSource);
}, 30_000);

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("developer surfaces", () => {
  it("pins the composite action runtimes and builds only in runner temp", async () => {
    const [action, runner] = await Promise.all([
      projectFile("action.yml"),
      projectFile(".github/actions/run-migration-doctor.sh"),
    ]);

    expect(action).toContain("node-version: 20");
    expect(action).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
    expect(action).toContain("actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1");
    expect(action).toContain('python-version: "3.13.7"');
    expect(action).toContain("astral-sh/setup-uv@94527f2e458b27549849d47d273a16bec83a01e9");
    expect(action).toContain('version: "0.9.18"');
    expect(action).toContain("run-migration-doctor.sh");
    expect(action).toContain("GitHub-hosted Linux or macOS");
    expect(action).not.toContain("CODEX_API_KEY");
    expect(action).not.toContain("secrets.");
    expect(runner).toContain('mktemp -d "$RUNNER_TEMP/migration-doctor-action-tool.XXXXXX"');
    expect(runner).toContain('cd "$tool_root"');
    expect(runner).toContain("corepack pnpm install --frozen-lockfile --ignore-scripts");
    expect(runner).toContain("uv sync --project packages/language-python --locked");
    expect(runner).toContain("corepack pnpm --filter @migration-doctor/cli build");
    expect(runner).toContain('node "$tool_root/packages/cli/dist/index.js" report');
  });

  it("uploads complete reports before propagating the original action status", async () => {
    const workflow = await projectFile(".github/workflows/migration-doctor.yml");
    const sarifUpload = workflow.indexOf(
      "github/codeql-action/upload-sarif@24c7eb380a2dc368f2d129e4c65e51d172983a1e",
    );
    const artifactUpload = workflow.indexOf(
      "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
    );
    const enforcement = workflow.indexOf("Enforce migration findings");

    expect(workflow).toContain("uses: ./");
    expect(workflow).toContain("os: [ubuntu-latest, macos-latest]");
    expect(workflow).toContain(`runs-on: \${{ matrix.os }}`);
    expect(workflow).toContain("always() && matrix.os == 'ubuntu-latest'");
    expect(workflow).toContain(`name: migration-doctor-report-\${{ matrix.os }}`);
    expect(workflow).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(`${workflow}\n${await projectFile("action.yml")}`).not.toMatch(
      /uses: (?:actions|astral-sh|github)\/[\w/-]+@v\d/u,
    );
    expect(workflow).toContain("steps.migration-doctor.outputs.sarif-path != ''");
    expect(workflow).toContain("always() && steps.migration-doctor.outputs.report-directory != ''");
    expect(sarifUpload).toBeGreaterThan(0);
    expect(artifactUpload).toBeGreaterThan(sarifUpload);
    expect(enforcement).toBeGreaterThan(artifactUpload);
  });

  it("keeps official SARIF validation reproducible and separate from detection", async () => {
    const [configuration, script, manifest, ci, documentation] = await Promise.all([
      projectFile("config/sarif-schema-lock.json"),
      projectFile("scripts/validate-sarif.mjs"),
      projectFile("package.json"),
      projectFile(".github/workflows/ci.yml"),
      projectFile("docs/sarif-validation.md"),
    ]);
    const lock = JSON.parse(configuration) as Record<string, unknown>;
    const packageManifest = JSON.parse(manifest) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const repositoryFiles = requireSuccess(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: PROJECT_ROOT },
    );

    expect(lock).toEqual({
      schemaVersion: "1.0.0",
      sarifVersion: "2.1.0",
      url: "https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json",
      sha256: "ad6db49878699b091f3eeb765b6e29e92a34bad4da88664d000c923b549c3a25",
      maximumBytes: 1_048_576,
    });
    expect(packageManifest.scripts["validate:sarif"]).toBe(
      "tsc -b --pretty false && node scripts/validate-sarif.mjs",
    );
    expect(packageManifest.devDependencies.ajv).toBe("8.17.1");
    expect(packageManifest.devDependencies["ajv-formats"]).toBe("3.0.1");
    expect(script).toContain("fetch(lock.url");
    expect(script).toContain('createHash("sha256")');
    expect(script).toContain("ajv.compile(schema)");
    expect(ci).toContain("Validate generated SARIF against pinned OASIS schema (network)");
    expect(ci).toContain("run: pnpm validate:sarif");
    expect(documentation).toContain("explicit network gate");
    expect(repositoryFiles).not.toMatch(/(?:^|\/)sarif-schema-2\.1\.0\.json$/mu);
  });

  it("runs the action against Python without changing target bytes and preserves status 4 outputs", async () => {
    await expect(lstat(path.join(cyclicActionSource, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const target = await createPythonTarget();
    const before = await workingTreeBytes(target);
    const runnerTemp = await mkdtemp(path.join(tmpdir(), "migration-doctor-action-runner-"));
    temporaryDirectories.push(runnerTemp);
    const githubOutput = path.join(runnerTemp, "github-output.txt");
    await writeFile(githubOutput, "");

    const result = run(
      "bash",
      [path.join(PROJECT_ROOT, ".github/actions/run-migration-doctor.sh")],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          GITHUB_OUTPUT: githubOutput,
          GITHUB_WORKSPACE: target,
          INPUT_OUTPUT_DIRECTORY: "",
          INPUT_PATH: ".",
          MIGRATION_DOCTOR_ACTION_SOURCE: cyclicActionSource,
          RUNNER_TEMP: runnerTemp,
        },
        timeout: 240_000,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(4);
    const outputs = parseOutputs(await readFile(githubOutput, "utf8"));
    expect(outputs.get("exit-code")).toBe("4");
    expect(outputs.get("report-directory")).toBeDefined();
    expect(outputs.get("sarif-path")).toBe(
      path.join(outputs.get("report-directory") ?? "", "migration-report.sarif"),
    );
    const report = JSON.parse(
      await readFile(
        path.join(outputs.get("report-directory") ?? "", "migration-report.json"),
        "utf8",
      ),
    ) as { findings: Array<{ language: string }>; summary: { graphIssues: number } };
    expect(report.findings).toEqual([expect.objectContaining({ language: "python" })]);
    expect(report.summary.graphIssues).toBeGreaterThan(0);
    expect(await workingTreeBytes(target)).toEqual(before);
    expect(requireSuccess("git", ["status", "--short"], { cwd: target })).toBe("");
  }, 260_000);

  it("runs the checked-in skill from an archived temporary tool root", async () => {
    const target = await createPythonTarget();
    const before = await workingTreeBytes(target);
    const reportParent = await mkdtemp(path.join(tmpdir(), "migration-doctor-skill-report-"));
    temporaryDirectories.push(reportParent);
    const reportDirectory = path.join(reportParent, "report");
    const script = path.join(PROJECT_ROOT, ".agents/skills/migration-audit/scripts/run-audit.sh");

    const result = run("bash", [script, target, reportDirectory], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        MIGRATION_DOCTOR_TOOL_SOURCE: toolSource,
        TMPDIR: reportParent,
      },
      timeout: 240_000,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    const report = JSON.parse(
      await readFile(path.join(reportDirectory, "migration-report.json"), "utf8"),
    ) as { findings: Array<{ language: string }> };
    expect(report.findings).toEqual([expect.objectContaining({ language: "python" })]);
    expect(result.stderr).toContain(
      `[migration-audit] report=${await realpath(reportDirectory)} exitCode=1`,
    );
    expect(await workingTreeBytes(target)).toEqual(before);
    expect(requireSuccess("git", ["status", "--short"], { cwd: target })).toBe("");
  }, 260_000);

  it("documents rule evidence and keeps the skill on its archived CLI audit path", async () => {
    const [guide, skill, script, metadata] = await Promise.all([
      projectFile("docs/rule-authoring.md"),
      projectFile(".agents/skills/migration-audit/SKILL.md"),
      projectFile(".agents/skills/migration-audit/scripts/run-audit.sh"),
      projectFile(".agents/skills/migration-audit/agents/openai.yaml"),
    ]);

    expect(guide).toContain("## 1. Review Official Sources");
    expect(guide).toContain("## 3. Lock Exact Artifacts");
    expect(guide).toContain("## 5. Add Evidence Fixtures");
    expect(guide).toContain("Tier B needs exact revision, preimage, scope");
    expect(skill).toContain('git -C "$TOOL_SOURCE" archive');
    expect(skill).toContain('packages/cli/dist/index.js" report');
    expect(skill).toContain("`1`: blocking findings were reported successfully");
    expect(script).toContain('git -C "$tool_source" archive --format=tar HEAD');
    expect(script).toContain("uv sync --project packages/language-python --locked");
    expect(script).toContain("corepack pnpm --filter @migration-doctor/cli build");
    expect(metadata).toContain("$migration-audit");
  });
});
