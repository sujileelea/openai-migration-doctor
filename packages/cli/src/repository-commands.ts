import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyTextEdits,
  ConfigurationError,
  canonicalJson,
  createRepositoryVerifyReport,
  DEFAULT_EXCLUSIONS,
  hashRepositoryTree,
  normalizeRepositoryRoot,
  type PatchPreview,
  type RepositoryCommandEvidence,
  type RepositoryCommandStatus,
  type RepositoryVerifyReport,
  resolveRepositoryFile,
  sha256,
  type VerifyReport,
} from "@migration-doctor/core";

const MAX_COMMANDS = 8;
const MAX_ARGV_ITEMS = 64;
const MAX_ARG_LENGTH_BYTES = 4_096;
const MAX_ARGV_BYTES = 65_536;
const MAX_CAPTURE_BYTES = 8_192;
const MAX_OUTPUT_BYTES = 1_048_576;

export const DEFAULT_REPOSITORY_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_REPOSITORY_COMMAND_TIMEOUT_MS = 600_000;

export type RepositoryCommandOutput = {
  commandId: string;
  stream: "stderr" | "stdout";
  text: string;
};

type CommandRunResult = {
  evidence: RepositoryCommandEvidence;
  outputs: RepositoryCommandOutput[];
};

type CommandTermination = "output-limit" | "spawn-error" | "timed-out";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function parseRepositoryCommands(values: string[]): string[][] {
  if (values.length === 0) {
    throw new ConfigurationError(
      "verify-repository requires at least one --command JSON argv array.",
    );
  }
  if (values.length > MAX_COMMANDS) {
    throw new ConfigurationError(`verify-repository accepts at most ${MAX_COMMANDS} commands.`);
  }

  return values.map((value, commandIndex) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ConfigurationError(
        `Repository command ${commandIndex + 1} must be a valid JSON argv array.`,
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.length > MAX_ARGV_ITEMS ||
      !parsed.every((item) => typeof item === "string")
    ) {
      throw new ConfigurationError(
        `Repository command ${commandIndex + 1} must contain 1 to ${MAX_ARGV_ITEMS} string argv items.`,
      );
    }

    const argv = parsed as string[];
    if (argv[0]?.length === 0) {
      throw new ConfigurationError(
        `Repository command ${commandIndex + 1} has an empty executable.`,
      );
    }
    if (
      argv.some((item) => item.includes("\0") || byteLength(item) > MAX_ARG_LENGTH_BYTES) ||
      byteLength(canonicalJson(argv)) > MAX_ARGV_BYTES
    ) {
      throw new ConfigurationError(
        `Repository command ${commandIndex + 1} exceeds the argv safety limits.`,
      );
    }
    return argv;
  });
}

export function parseRepositoryCommandTimeout(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new ConfigurationError("Repository command timeout must be a positive integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_REPOSITORY_COMMAND_TIMEOUT_MS) {
    throw new ConfigurationError(
      `Repository command timeout cannot exceed ${MAX_REPOSITORY_COMMAND_TIMEOUT_MS} ms.`,
    );
  }
  return parsed;
}

function replaceAllLiteral(value: string, target: string, replacement: string): string {
  return target.length === 0 ? value : value.split(target).join(replacement);
}

function redactOutput(value: string, repositoryRoot: string, temporaryRoot: string): string {
  let redacted = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  redacted = replaceAllLiteral(redacted, temporaryRoot, "<temporary-candidate>");
  redacted = replaceAllLiteral(redacted, repositoryRoot, "<source-repository>");
  redacted = redacted.replace(/sk-[A-Za-z0-9_-]{8,}/gu, "<redacted>");
  redacted = redacted.replace(
    /((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*)([^\s]+)/giu,
    "$1<redacted>",
  );
  redacted = [...redacted]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined &&
        ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) || codePoint === 0x7f)
        ? "?"
        : character;
    })
    .join("");
  return redacted.trimEnd();
}

async function minimalCommandEnvironment(temporaryParent: string): Promise<NodeJS.ProcessEnv> {
  const home = path.join(temporaryParent, "home");
  const commandTemp = path.join(temporaryParent, "tmp");
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(commandTemp, { mode: 0o700 })]);

  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    FORCE_COLOR: "0",
    HOME: home,
    NO_COLOR: "1",
    TEMP: commandTemp,
    TMP: commandTemp,
    TMPDIR: commandTemp,
    USERPROFILE: home,
  };
  for (const key of ["ComSpec", "LANG", "LC_ALL", "PATH", "PATHEXT", "SystemRoot", "WINDIR"]) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The command may have exited between the limit check and termination.
    }
  }
}

function killRemainingProcessGroup(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" || child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // A command without surviving descendants has no remaining process group.
  }
}

async function removeOwnedTemporaryDirectory(
  directory: string,
  identity: { dev: number; ino: number },
): Promise<void> {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino) {
    await rm(directory, { recursive: true, force: true });
  }
}

function commandStatus(
  termination: CommandTermination | undefined,
  exitCode: number | null,
): RepositoryCommandStatus {
  if (termination !== undefined) {
    return termination;
  }
  return exitCode === 0 ? "passed" : "failed";
}

async function runCommand(request: {
  argv: string[];
  candidateRoot: string;
  repositoryRoot: string;
  temporaryParent: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  commandIndex: number;
}): Promise<CommandRunResult> {
  const [executable, ...args] = request.argv;
  if (executable === undefined) {
    throw new ConfigurationError("Repository command executable is missing.");
  }
  const commandId = `repository_command_${request.commandIndex + 1}`;
  const argvHash = sha256(canonicalJson(request.argv));

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: request.candidateRoot,
      detached: process.platform !== "win32",
      env: request.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let termination: CommandTermination | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutCapturedBytes = 0;
    let stderrCapturedBytes = 0;

    const stop = (reason: CommandTermination): void => {
      if (termination === undefined) {
        termination = reason;
        killProcessGroup(child);
      }
    };

    const capture = (stream: "stderr" | "stdout", chunk: Buffer): void => {
      if (stream === "stdout") {
        stdoutBytes += chunk.byteLength;
        if (stdoutCapturedBytes < MAX_CAPTURE_BYTES) {
          const slice = chunk.subarray(0, MAX_CAPTURE_BYTES - stdoutCapturedBytes);
          stdoutChunks.push(slice);
          stdoutCapturedBytes += slice.byteLength;
        }
      } else {
        stderrBytes += chunk.byteLength;
        if (stderrCapturedBytes < MAX_CAPTURE_BYTES) {
          const slice = chunk.subarray(0, MAX_CAPTURE_BYTES - stderrCapturedBytes);
          stderrChunks.push(slice);
          stderrCapturedBytes += slice.byteLength;
        }
      }
      if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
        stop("output-limit");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

    const timeout = setTimeout(() => stop("timed-out"), request.timeoutMs);
    timeout.unref();

    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const status = commandStatus(termination, exitCode);
      const outputs: RepositoryCommandOutput[] = [];
      for (const [stream, chunks] of [
        ["stdout", stdoutChunks],
        ["stderr", stderrChunks],
      ] as const) {
        const text = redactOutput(
          Buffer.concat(chunks).toString("utf8"),
          request.repositoryRoot,
          request.temporaryParent,
        );
        if (text.length > 0) {
          outputs.push({ commandId, stream, text });
        }
      }
      resolve({
        evidence: {
          id: commandId,
          argvHash,
          passed: status === "passed" && exitCode === 0,
          status,
          exitCode,
          timeoutMs: request.timeoutMs,
          stdoutBytes,
          stderrBytes,
        },
        outputs,
      });
    };

    child.once("error", () => {
      termination = "spawn-error";
      finish(null);
    });
    child.once("close", (exitCode) => {
      killRemainingProcessGroup(child);
      finish(exitCode);
    });
  });
}

function skippedCommand(
  argv: string[],
  commandIndex: number,
  timeoutMs: number,
  status:
    | "skipped-prior-command-failure"
    | "skipped-source-changed"
    | "skipped-static-verification",
): RepositoryCommandEvidence {
  return {
    id: `repository_command_${commandIndex + 1}`,
    argvHash: sha256(canonicalJson(argv)),
    passed: false,
    status,
    exitCode: null,
    timeoutMs,
    stdoutBytes: 0,
    stderrBytes: 0,
  };
}

async function copyPatchedCandidate(
  repositoryRoot: string,
  candidateRoot: string,
  preview: PatchPreview,
): Promise<void> {
  await cp(repositoryRoot, candidateRoot, {
    recursive: true,
    filter: async (source) => {
      if (path.resolve(source) === repositoryRoot) {
        return true;
      }
      if (
        DEFAULT_EXCLUSIONS.includes(path.basename(source) as (typeof DEFAULT_EXCLUSIONS)[number])
      ) {
        return false;
      }
      return !(await lstat(source)).isSymbolicLink();
    },
  });

  for (const previewFile of preview.files) {
    const target = resolveRepositoryFile(candidateRoot, previewFile.path);
    const before = await readFile(target, "utf8");
    await writeFile(target, applyTextEdits(before, previewFile.edits), "utf8");
  }
}

export async function verifyRepositoryCommands(request: {
  repositoryRoot: string;
  expectedRepositoryTreeHash: string;
  preview: PatchPreview;
  staticVerification: VerifyReport;
  commands: string[][];
  timeoutMs: number;
  onOutput?: (output: RepositoryCommandOutput) => void;
}): Promise<RepositoryVerifyReport> {
  if (!request.staticVerification.verification.passed) {
    return createRepositoryVerifyReport({
      staticVerification: request.staticVerification,
      commands: request.commands.map((argv, index) =>
        skippedCommand(argv, index, request.timeoutMs, "skipped-static-verification"),
      ),
      candidatePatchPreserved: false,
      originalAnalyzedTreeUnchanged: request.staticVerification.verification.checks.some(
        (check) => check.id === "original_repository_unchanged" && check.passed,
      ),
    });
  }

  const repositoryRoot = await normalizeRepositoryRoot(request.repositoryRoot);
  if ((await hashRepositoryTree(repositoryRoot)) !== request.expectedRepositoryTreeHash) {
    return createRepositoryVerifyReport({
      staticVerification: request.staticVerification,
      commands: request.commands.map((argv, index) =>
        skippedCommand(argv, index, request.timeoutMs, "skipped-source-changed"),
      ),
      candidatePatchPreserved: false,
      originalAnalyzedTreeUnchanged: false,
    });
  }
  if (process.platform === "win32") {
    throw new ConfigurationError(
      "verify-repository is unavailable on Windows because descendant process containment is not guaranteed.",
    );
  }
  const temporaryParent = await mkdtemp(path.join(tmpdir(), "migration-doctor-repository-verify-"));
  const temporaryIdentity = await lstat(temporaryParent);
  const candidateRoot = path.join(temporaryParent, "repository");

  try {
    await copyPatchedCandidate(repositoryRoot, candidateRoot, request.preview);
    const expectedCandidateTreeHash = await hashRepositoryTree(candidateRoot);
    if ((await hashRepositoryTree(repositoryRoot)) !== request.expectedRepositoryTreeHash) {
      return createRepositoryVerifyReport({
        staticVerification: request.staticVerification,
        commands: request.commands.map((argv, index) =>
          skippedCommand(argv, index, request.timeoutMs, "skipped-source-changed"),
        ),
        candidatePatchPreserved: false,
        originalAnalyzedTreeUnchanged: false,
      });
    }
    const environment = await minimalCommandEnvironment(temporaryParent);
    const commands: RepositoryCommandEvidence[] = [];
    let priorCommandFailed = false;

    for (const [index, argv] of request.commands.entries()) {
      if (priorCommandFailed) {
        commands.push(
          skippedCommand(argv, index, request.timeoutMs, "skipped-prior-command-failure"),
        );
        continue;
      }
      const result = await runCommand({
        argv,
        candidateRoot,
        repositoryRoot,
        temporaryParent,
        environment,
        timeoutMs: request.timeoutMs,
        commandIndex: index,
      });
      commands.push(result.evidence);
      for (const output of result.outputs) {
        request.onOutput?.(output);
      }
      priorCommandFailed = !result.evidence.passed;
    }

    return createRepositoryVerifyReport({
      staticVerification: request.staticVerification,
      commands,
      candidatePatchPreserved:
        (await hashRepositoryTree(candidateRoot)) === expectedCandidateTreeHash,
      originalAnalyzedTreeUnchanged:
        (await hashRepositoryTree(repositoryRoot)) === request.expectedRepositoryTreeHash,
    });
  } finally {
    await removeOwnedTemporaryDirectory(temporaryParent, temporaryIdentity);
  }
}

export function renderRepositoryVerifyMarkdown(report: RepositoryVerifyReport): string {
  const lines = [
    "# Migration Doctor Repository Verification",
    "",
    `Overall: **${report.passed ? "passed" : "failed"}**`,
    "",
    `Deterministic patch verification: **${
      report.staticVerification.verification.passed ? "passed" : "failed"
    }**`,
    `Candidate patch preserved: **${report.candidatePatchPreserved ? "yes" : "no"}**`,
    `Original analyzed tree unchanged: **${report.originalAnalyzedTreeUnchanged ? "yes" : "no"}**`,
    "Runtime behavior verified: **no**",
    "",
    "Commands ran without a shell in a temporary copy. Only a minimal environment allowlist was inherited, ambient credential variables were omitted, and network isolation was not enforced.",
    "",
    "| Check | argv SHA-256 | Status | Exit | Timeout ms | stdout bytes | stderr bytes |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const command of report.commands) {
    lines.push(
      `| \`${command.id}\` | \`${command.argvHash}\` | ${command.status} | ${
        command.exitCode ?? "-"
      } | ${command.timeoutMs} | ${command.stdoutBytes} | ${command.stderrBytes} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
