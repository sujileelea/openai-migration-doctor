import { access, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(PROJECT_ROOT, "packages", "cli", "dist", "index.js");
const FIXTURE_PATH = path.join(PROJECT_ROOT, "fixtures", "typescript", "direct-model-literal");
const EXPECTED_REPORT_FILES = [
  "migration-report.html",
  "migration-report.json",
  "migration-report.md",
  "migration-report.sarif",
];
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;

export class DemoPreflightError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DemoPreflightError";
  }
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
    ...options,
  });
  if (result.error) {
    throw new DemoPreflightError(`Unable to run ${commandName}.`, { cause: result.error });
  }
  return result;
}

function git(args) {
  const result = command("git", args);
  if (result.status !== 0) {
    throw new DemoPreflightError(`Git preflight failed: ${result.stderr.trim() || "unknown error"}.`);
  }
  return result.stdout.trim();
}

function requireCleanWorktree() {
  const status = git(["status", "--short", "--untracked-files=all"]);
  if (status !== "") {
    throw new DemoPreflightError("Demo recording requires a clean worktree.");
  }
}

function currentRevision() {
  const revision = git(["rev-parse", "HEAD"]);
  if (!REVISION_PATTERN.test(revision)) {
    throw new DemoPreflightError("Demo revision must be a lowercase 40-character Git SHA.");
  }
  return revision;
}

export function parseRemoteRefs(value) {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry !== "origin/HEAD");
}

function publicRemoteRefs(revision) {
  return parseRemoteRefs(
    git([
      "for-each-ref",
      "--format=%(refname:short)",
      `--contains=${revision}`,
      "refs/remotes/origin",
    ]),
  );
}

export async function validateReportBundle(reportDirectory) {
  const entries = await readdir(reportDirectory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length !== EXPECTED_REPORT_FILES.length ||
    names.some((name, index) => name !== EXPECTED_REPORT_FILES[index]) ||
    entries.some((entry) => !entry.isFile())
  ) {
    throw new DemoPreflightError(
      `Report bundle must contain exactly: ${EXPECTED_REPORT_FILES.join(", ")}.`,
    );
  }

  for (const fileName of EXPECTED_REPORT_FILES) {
    const filePath = path.join(reportDirectory, fileName);
    if ((await stat(filePath)).size === 0) {
      throw new DemoPreflightError(`${fileName} must not be empty.`);
    }
  }

  const jsonPath = path.join(reportDirectory, "migration-report.json");
  const report = JSON.parse(await readFile(jsonPath, "utf8"));
  if (!Array.isArray(report.findings) || report.findings.length === 0) {
    throw new DemoPreflightError("Demo JSON must contain at least one finding.");
  }
}

export async function prepareDemo({ rehearsal }) {
  requireCleanWorktree();
  const revision = currentRevision();
  const remoteRefs = publicRemoteRefs(revision);
  if (!rehearsal && remoteRefs.length === 0) {
    throw new DemoPreflightError(
      "Recording mode requires HEAD to be contained by an origin remote-tracking branch.",
    );
  }

  await access(CLI_PATH);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-demo-"));
  const reportDirectory = path.join(temporaryRoot, "report");
  const reportResult = command(process.execPath, [
    CLI_PATH,
    "report",
    FIXTURE_PATH,
    "--output",
    reportDirectory,
  ]);
  if (reportResult.status !== 1) {
    throw new DemoPreflightError(
      `Demo report must finish with finding exit 1, received ${String(reportResult.status)}.`,
    );
  }

  await validateReportBundle(reportDirectory);
  requireCleanWorktree();
  return { reportDirectory, remoteRefs, rehearsal, revision };
}

function usage() {
  return "Usage: node scripts/prepare-demo.mjs [--rehearsal]\n";
}

export async function runCli(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(usage());
    return 0;
  }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--rehearsal")) {
    process.stderr.write(usage());
    return 2;
  }

  try {
    const result = await prepareDemo({ rehearsal: argv[0] === "--rehearsal" });
    process.stdout.write(
      [
        "Demo preflight passed.",
        `Mode: ${result.rehearsal ? "rehearsal only; unpublished revisions are allowed" : "recording ready"}`,
        `Revision: ${result.revision}`,
        `Public remote refs: ${result.remoteRefs.join(", ") || "none"}`,
        "Expected report exit: 1",
        `Report bundle: ${result.reportDirectory}`,
        "Keep the recording output outside the repository and remove this temporary bundle after QA.",
        "",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Demo preflight failed: ${message}\n`);
    return 2;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}

export { EXPECTED_REPORT_FILES, PROJECT_ROOT };
