import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

export const REVIEWED_CODEX_CLI_VERSION = "0.146.0" as const;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const VERSION_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_EVENT_COUNT = 100_000;
const KILL_GRACE_MS = 1_000;

const ENVIRONMENT_ALLOWLIST = new Set(["CODEX_API_KEY", "PATH", "SSL_CERT_DIR", "SSL_CERT_FILE"]);

const FORBIDDEN_SYSTEM_CONFIG_PATHS =
  process.platform === "win32"
    ? [
        path.join(process.env.ProgramData ?? "C:\\ProgramData", "OpenAI", "Codex", "config.toml"),
        path.join(
          process.env.ProgramData ?? "C:\\ProgramData",
          "OpenAI",
          "Codex",
          "managed_config.toml",
        ),
        path.join(
          process.env.ProgramData ?? "C:\\ProgramData",
          "OpenAI",
          "Codex",
          "requirements.toml",
        ),
        path.join(process.env.ProgramData ?? "C:\\ProgramData", "OpenAI", "Codex", "skills"),
      ]
    : [
        "/etc/codex/config.toml",
        "/etc/codex/managed_config.toml",
        "/etc/codex/requirements.toml",
        "/etc/codex/skills",
      ];

const ALLOWED_ITEM_TYPES = new Set(["agent_message", "file_change", "reasoning"]);
const REVIEWED_BUNDLED_SKILLS = [
  "imagegen",
  "openai-docs",
  "plugin-creator",
  "review-agent",
  "skill-creator",
  "skill-installer",
] as const;

export const CODEX_EXEC_POLICY_ID = "workspace-only-no-shell-v2" as const;

export type CodexJsonValue =
  | boolean
  | null
  | number
  | string
  | CodexJsonValue[]
  | { [key: string]: CodexJsonValue };

export type CodexRunRequest = {
  workingDirectory: string;
  prompt: string;
  outputSchema: { [key: string]: CodexJsonValue };
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type CodexTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type CodexRunResult = {
  cliVersion: string;
  executableHash: string;
  finalResponse: string;
  usage: CodexTokenUsage;
  completedItemTypes: readonly string[];
  observedItemTypes: readonly string[];
  policyViolationCodes: readonly string[];
  eventTypeCounts: Readonly<Record<string, number>>;
};

export interface CodexRunner {
  run(request: CodexRunRequest): Promise<CodexRunResult>;
}

export type CodexExecRunnerOptions = {
  executable?: string;
  expectedExecutableHash: string;
  timeoutMs?: number;
  environment?: Readonly<Record<string, string | undefined>>;
};

export type CodexRunnerErrorCode =
  | "CODEX_ABORTED"
  | "CODEX_EXEC_FAILED"
  | "CODEX_EXECUTABLE_CHANGED"
  | "CODEX_INVALID_REQUEST"
  | "CODEX_MALFORMED_OUTPUT"
  | "CODEX_OUTPUT_LIMIT"
  | "CODEX_TIMEOUT"
  | "CODEX_UNTRUSTED_EXECUTABLE"
  | "CODEX_UNSUPPORTED_VERSION";

export class CodexRunnerError extends Error {
  readonly code: CodexRunnerErrorCode;
  readonly runtimeIdentity?: { cliVersion: string; executableHash: string };

  constructor(
    code: CodexRunnerErrorCode,
    message: string,
    options?: ErrorOptions & {
      runtimeIdentity?: { cliVersion: string; executableHash: string };
    },
  ) {
    super(message, options);
    this.name = "CodexRunnerError";
    this.code = code;
    if (options?.runtimeIdentity !== undefined) {
      this.runtimeIdentity = options.runtimeIdentity;
    }
  }
}

/**
 * Builds the complete argument vector used for every remediation run. Keeping this pure makes the
 * security boundary reviewable without launching Codex.
 */
export function buildCodexExecArgs(
  request: Pick<CodexRunRequest, "model" | "workingDirectory">,
  schemaPath: string,
  codexHome: string,
): string[] {
  if (!path.isAbsolute(codexHome)) {
    throw new CodexRunnerError(
      "CODEX_INVALID_REQUEST",
      "Codex argument construction requires an absolute disposable home.",
    );
  }
  const disabledSkills = REVIEWED_BUNDLED_SKILLS.map((name) => {
    const skillPath = path.join(codexHome, "skills", ".system", name, "SKILL.md");
    return `{path=${JSON.stringify(skillPath)},enabled=false}`;
  }).join(",");
  const args = [
    "exec",
    "--strict-config",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-C",
    request.workingDirectory,
    "-c",
    'approval_policy="never"',
    "-c",
    'default_permissions="migration_doctor"',
    "-c",
    'permissions.migration_doctor.extends=":workspace"',
    "-c",
    'permissions.migration_doctor.filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"}',
    "-c",
    "permissions.migration_doctor.network.enabled=false",
    "-c",
    "project_root_markers=[]",
    "-c",
    "project_doc_fallback_filenames=[]",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "mcp_servers={}",
    "-c",
    `skills.config=[${disabledSkills}]`,
    "-c",
    "hooks={}",
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    'model_provider="openai"',
    "-c",
    "notify=[]",
    "-c",
    "features.shell_tool=false",
    "-c",
    "features.shell_snapshot=false",
    "-c",
    "features.unified_exec=false",
    "-c",
    "features.code_mode=false",
    "-c",
    "features.code_mode_host=false",
    "-c",
    "features.js_repl=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.goals=false",
    "-c",
    "features.memories=false",
    "-c",
    "features.plugins=false",
    "-c",
    "features.browser_use=false",
    "-c",
    "features.browser_use_external=false",
    "-c",
    "features.browser_use_full_cdp_access=false",
    "-c",
    "features.computer_use=false",
    "-c",
    "features.image_generation=false",
    "-c",
    "features.in_app_browser=false",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.skill_search=false",
    "-c",
    "features.skill_mcp_dependency_install=false",
    "-c",
    "features.hooks=false",
    "-c",
    "features.enable_mcp_apps=false",
    "-c",
    "features.auth_elicitation=false",
    "-c",
    "features.tool_call_mcp_elicitation=false",
    "-c",
    "features.request_permissions_tool=false",
    "-c",
    "features.plugin_sharing=false",
    "-c",
    "features.remote_plugin=false",
    "-c",
    "features.external_agent_memory_import=false",
    "-c",
    "features.fast_mode=false",
    "-c",
    "features.network_proxy=false",
    "-c",
    "features.personality=false",
    "-c",
    "features.respect_system_proxy=false",
    "-c",
    "features.tool_suggest=false",
    "-c",
    "features.workspace_dependencies=false",
    "-c",
    "memories.generate_memories=false",
    "-c",
    "memories.use_memories=false",
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
    "-c",
    'web_search="disabled"',
    "-c",
    "tools.web_search=false",
  ];

  if (request.model !== undefined) {
    args.push("--model", request.model);
  }
  args.push("--output-schema", schemaPath, "-");
  return args;
}

/** Only explicitly supported process variables cross into the Codex process. */
export function sanitizeCodexEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    TERM: "dumb",
  };

  for (const [key, value] of Object.entries(source)) {
    if (!ENVIRONMENT_ALLOWLIST.has(key) || value === undefined) {
      continue;
    }
    if (value.includes("\0")) {
      throw new CodexRunnerError(
        "CODEX_INVALID_REQUEST",
        `Codex environment value contains a null byte: ${key}`,
      );
    }
    environment[key] = value;
  }
  return environment;
}

type ProcessResult = {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type ProcessFailure = {
  code: CodexRunnerErrorCode;
  message: string;
  cause?: unknown;
};

type InternalEvent = Record<string, unknown> & { type: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is CodexJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((child) => isJsonValue(child, ancestors))
    : isPlainObject(value) && Object.values(value).every((child) => isJsonValue(child, ancestors));
  ancestors.delete(value);
  return valid;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new CodexRunnerError(
      "CODEX_INVALID_REQUEST",
      "Codex timeout must be a positive integer number of milliseconds.",
    );
  }
  return timeout;
}

function validateRequest(request: CodexRunRequest): void {
  if (request.prompt.trim().length === 0 || request.prompt.includes("\0")) {
    throw new CodexRunnerError(
      "CODEX_INVALID_REQUEST",
      "Codex prompt must be non-empty and contain no null bytes.",
    );
  }
  if (!isPlainObject(request.outputSchema) || !isJsonValue(request.outputSchema)) {
    throw new CodexRunnerError(
      "CODEX_INVALID_REQUEST",
      "Codex output schema must be a finite, acyclic JSON object.",
    );
  }
  if (request.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(request.model)) {
    throw new CodexRunnerError(
      "CODEX_INVALID_REQUEST",
      "Codex model must be non-empty and contain no null bytes.",
    );
  }
  positiveTimeout(request.timeoutMs, DEFAULT_TIMEOUT_MS);
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): NodeJS.Timeout {
  const send = (signal: NodeJS.Signals): void => {
    if (child.pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The process may not have formed a group yet; fall back to the child itself.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Closing is best-effort; the close/error handlers still settle the operation.
    }
  };

  send("SIGTERM");
  const forceTimer = setTimeout(() => send("SIGKILL"), KILL_GRACE_MS);
  forceTimer.unref();
  return forceTimer;
}

function runProcess(options: {
  executable: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  workingDirectory: string;
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new CodexRunnerError("CODEX_ABORTED", "Codex execution was aborted."));
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.executable, [...options.args], {
        cwd: options.workingDirectory,
        detached: process.platform !== "win32",
        env: { ...options.environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new CodexRunnerError("CODEX_EXEC_FAILED", "Unable to launch the Codex CLI.", {
          cause: error,
        }),
      );
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ProcessFailure | undefined;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const fail = (nextFailure: ProcessFailure): void => {
      if (failure !== undefined) {
        return;
      }
      failure = nextFailure;
      forceTimer = terminateProcessTree(child);
    };

    const timeout = setTimeout(() => {
      fail({ code: "CODEX_TIMEOUT", message: "Codex execution timed out." });
    }, options.timeoutMs);
    timeout.unref();

    const onAbort = (): void => {
      fail({ code: "CODEX_ABORTED", message: "Codex execution was aborted." });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceTimer !== undefined) {
        clearTimeout(forceTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail({ code: "CODEX_OUTPUT_LIMIT", message: "Codex JSONL output exceeded its limit." });
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) {
        fail({
          code: "CODEX_OUTPUT_LIMIT",
          message: "Codex diagnostic output exceeded its limit.",
        });
        return;
      }
      stderr.push(chunk);
    });

    child.once("error", (error) => {
      fail({ code: "CODEX_EXEC_FAILED", message: "Codex CLI process failed.", cause: error });
    });

    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      if (failure !== undefined) {
        reject(new CodexRunnerError(failure.code, failure.message, { cause: failure.cause }));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode,
        signal,
      });
    });

    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        fail({
          code: "CODEX_EXEC_FAILED",
          message: "Could not send the prompt to Codex.",
          cause: error,
        });
      }
    });
    child.stdin.end(options.input ?? "");
  });
}

function decodeUtf8(buffer: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new CodexRunnerError("CODEX_MALFORMED_OUTPUT", `${label} was not valid UTF-8.`, {
      cause: error,
    });
  }
}

function parseVersion(raw: string): string {
  const normalized = raw.trim();
  if (normalized !== `codex-cli ${REVIEWED_CODEX_CLI_VERSION}`) {
    throw new CodexRunnerError(
      "CODEX_UNSUPPORTED_VERSION",
      `Codex version output did not identify the exact reviewed release ${REVIEWED_CODEX_CLI_VERSION}.`,
    );
  }
  return REVIEWED_CODEX_CLI_VERSION;
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexRunnerError(
      "CODEX_MALFORMED_OUTPUT",
      `${label}.${key} must be a non-empty string.`,
    );
  }
  return value;
}

function requireTokenCount(usage: Record<string, unknown>, key: string, optional = false): number {
  const value = usage[key];
  if (value === undefined && optional) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CodexRunnerError(
      "CODEX_MALFORMED_OUTPUT",
      `turn.completed.usage.${key} must be a non-negative integer.`,
    );
  }
  return value;
}

function parseUsage(value: unknown): CodexTokenUsage {
  if (!isPlainObject(value)) {
    throw new CodexRunnerError("CODEX_MALFORMED_OUTPUT", "turn.completed.usage must be an object.");
  }
  return {
    inputTokens: requireTokenCount(value, "input_tokens"),
    cachedInputTokens: requireTokenCount(value, "cached_input_tokens"),
    cacheWriteInputTokens: requireTokenCount(value, "cache_write_input_tokens", true),
    outputTokens: requireTokenCount(value, "output_tokens"),
    reasoningOutputTokens: requireTokenCount(value, "reasoning_output_tokens"),
  };
}

function parseJsonLines(stdout: Buffer): InternalEvent[] {
  const raw = decodeUtf8(stdout, "Codex JSONL output");
  const lines = raw.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0 || lines.length > MAX_EVENT_COUNT) {
    throw new CodexRunnerError(
      "CODEX_MALFORMED_OUTPUT",
      "Codex JSONL output contained an invalid number of events.",
    );
  }

  return lines.map((line, index) => {
    if (line.trim().length === 0) {
      throw new CodexRunnerError(
        "CODEX_MALFORMED_OUTPUT",
        `Codex JSONL event ${index + 1} was empty.`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new CodexRunnerError(
        "CODEX_MALFORMED_OUTPUT",
        `Codex JSONL event ${index + 1} was not valid JSON.`,
        { cause: error },
      );
    }
    if (!isPlainObject(value) || typeof value.type !== "string" || value.type.length === 0) {
      throw new CodexRunnerError(
        "CODEX_MALFORMED_OUTPUT",
        `Codex JSONL event ${index + 1} had no valid type.`,
      );
    }
    return value as InternalEvent;
  });
}

function collectResult(
  events: readonly InternalEvent[],
  cliVersion: string,
): Omit<CodexRunResult, "executableHash"> {
  let threadStarted = false;
  let turnStarted = false;
  let usage: CodexTokenUsage | undefined;
  let finalResponse: string | undefined;
  const completedItemTypes: string[] = [];
  const observedItemTypes = new Set<string>();
  const policyViolationCodes = new Set<string>();
  const eventTypeCounts: Record<string, number> = Object.create(null) as Record<string, number>;

  for (const [index, event] of events.entries()) {
    eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;
    switch (event.type) {
      case "thread.started":
        if (index !== 0 || threadStarted) {
          throw new CodexRunnerError(
            "CODEX_MALFORMED_OUTPUT",
            "Codex emitted an invalid thread.started sequence.",
          );
        }
        requireString(event, "thread_id", "thread.started");
        threadStarted = true;
        break;
      case "turn.started":
        if (!threadStarted || turnStarted || usage !== undefined) {
          throw new CodexRunnerError(
            "CODEX_MALFORMED_OUTPUT",
            "Codex emitted an invalid turn.started sequence.",
          );
        }
        turnStarted = true;
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        if (!turnStarted || usage !== undefined || !isPlainObject(event.item)) {
          throw new CodexRunnerError(
            "CODEX_MALFORMED_OUTPUT",
            `Codex emitted an invalid ${event.type} event.`,
          );
        }
        requireString(event.item, "id", event.type);
        const itemType = requireString(event.item, "type", event.type);
        observedItemTypes.add(itemType);
        if (!ALLOWED_ITEM_TYPES.has(itemType)) {
          const reasonCode =
            itemType === "command_execution"
              ? "command-tool-attempted"
              : itemType === "mcp_tool_call"
                ? "mcp-tool-attempted"
                : itemType === "web_search"
                  ? "web-search-attempted"
                  : "unsupported-tool-attempted";
          policyViolationCodes.add(reasonCode);
        }
        if (event.type === "item.completed") {
          completedItemTypes.push(itemType);
          if (itemType === "agent_message") {
            finalResponse = requireString(event.item, "text", "item.completed.agent_message");
          }
        }
        break;
      }
      case "turn.completed":
        if (!turnStarted || usage !== undefined) {
          throw new CodexRunnerError(
            "CODEX_MALFORMED_OUTPUT",
            "Codex emitted an invalid turn.completed sequence.",
          );
        }
        usage = parseUsage(event.usage);
        break;
      case "turn.failed":
        throw new CodexRunnerError("CODEX_EXEC_FAILED", "Codex reported that the turn failed.");
      case "error":
        throw new CodexRunnerError("CODEX_EXEC_FAILED", "Codex emitted a fatal error event.");
      default:
        throw new CodexRunnerError(
          "CODEX_MALFORMED_OUTPUT",
          `Codex emitted an unsupported event type: ${event.type}`,
        );
    }
  }

  if (!threadStarted || !turnStarted || usage === undefined || finalResponse === undefined) {
    throw new CodexRunnerError(
      "CODEX_MALFORMED_OUTPUT",
      "Codex output ended before a complete structured response was available.",
    );
  }
  try {
    JSON.parse(finalResponse);
  } catch (error) {
    throw new CodexRunnerError(
      "CODEX_MALFORMED_OUTPUT",
      "Codex final response was not valid structured JSON.",
      { cause: error },
    );
  }

  // Thread IDs and raw events can contain sensitive or nondeterministic data and are never returned.
  return {
    cliVersion,
    finalResponse,
    usage,
    completedItemTypes,
    observedItemTypes: [...observedItemTypes].sort(),
    policyViolationCodes: [...policyViolationCodes].sort(),
    eventTypeCounts,
  };
}

type CodexRuntimeIdentity = {
  executable: string;
  cliVersion: string;
  executableHash: string;
};

async function assertNoAmbientCodexConfiguration(
  environment: Readonly<Record<string, string>>,
  workingDirectory: string,
): Promise<void> {
  for (const configPath of FORBIDDEN_SYSTEM_CONFIG_PATHS) {
    try {
      await lstat(configPath);
      throw new CodexRunnerError(
        "CODEX_INVALID_REQUEST",
        "Codex remediation refuses ambient system or managed configuration.",
      );
    } catch (error) {
      if (error instanceof CodexRunnerError) {
        throw error;
      }
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new CodexRunnerError(
          "CODEX_INVALID_REQUEST",
          "Codex remediation could not attest system configuration absence.",
          { cause: error },
        );
      }
    }
  }

  if (process.platform !== "darwin") {
    return;
  }
  for (const key of ["config_toml_base64", "requirements_toml_base64"]) {
    const result = await runProcess({
      executable: "/usr/bin/defaults",
      args: ["read-type", "com.openai.codex", key],
      environment,
      workingDirectory,
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    if (result.exitCode === 0 && result.signal === null) {
      throw new CodexRunnerError(
        "CODEX_INVALID_REQUEST",
        "Codex remediation refuses macOS managed Codex configuration.",
      );
    }
    if (result.exitCode !== 1 || result.signal !== null) {
      throw new CodexRunnerError(
        "CODEX_INVALID_REQUEST",
        "Codex remediation could not attest macOS managed configuration absence.",
      );
    }
  }
}

function attachRuntimeIdentity(
  error: unknown,
  identity: CodexRuntimeIdentity | undefined,
): CodexRunnerError {
  const runtimeIdentity = identity
    ? { cliVersion: identity.cliVersion, executableHash: identity.executableHash }
    : undefined;
  if (error instanceof CodexRunnerError) {
    return new CodexRunnerError(error.code, error.message, {
      cause: error,
      ...(runtimeIdentity === undefined ? {} : { runtimeIdentity }),
    });
  }
  return new CodexRunnerError("CODEX_EXEC_FAILED", "Codex execution failed.", {
    cause: error,
    ...(runtimeIdentity === undefined ? {} : { runtimeIdentity }),
  });
}

export class CodexExecRunner implements CodexRunner {
  readonly policyId = CODEX_EXEC_POLICY_ID;
  readonly executable: string;
  readonly expectedExecutableHash: string;
  readonly timeoutMs: number;
  #environment: Readonly<Record<string, string>>;

  constructor(options: CodexExecRunnerOptions) {
    this.executable = options.executable ?? "codex";
    if (this.executable.trim().length === 0 || this.executable.includes("\0")) {
      throw new CodexRunnerError(
        "CODEX_INVALID_REQUEST",
        "Codex executable must be non-empty and contain no null bytes.",
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(options.expectedExecutableHash)) {
      throw new CodexRunnerError(
        "CODEX_INVALID_REQUEST",
        "Codex remediation requires a pinned executable SHA-256.",
      );
    }
    this.expectedExecutableHash = options.expectedExecutableHash;
    this.timeoutMs = positiveTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.#environment = sanitizeCodexEnvironment(options.environment ?? process.env);
    const apiKey = this.#environment.CODEX_API_KEY;
    if (
      apiKey === undefined ||
      apiKey.trim().length === 0 ||
      apiKey.length > 4_096 ||
      /[\r\n\0]/u.test(apiKey)
    ) {
      throw new CodexRunnerError(
        "CODEX_INVALID_REQUEST",
        "Codex remediation requires a single-run CODEX_API_KEY credential.",
      );
    }
    Object.freeze(this);
  }

  private async resolveExecutable(): Promise<string> {
    if (path.isAbsolute(this.executable) || this.executable.includes(path.sep)) {
      return await realpath(path.resolve(this.executable));
    }
    for (const directory of (this.#environment.PATH ?? "").split(path.delimiter)) {
      if (directory.length === 0) {
        continue;
      }
      const candidate = path.join(directory, this.executable);
      try {
        await access(candidate, constants.X_OK);
        return await realpath(candidate);
      } catch {
        // Keep searching the exact PATH used by the child process.
      }
    }
    throw new CodexRunnerError(
      "CODEX_EXEC_FAILED",
      "Could not resolve the Codex executable from the sanitized PATH.",
    );
  }

  private async hashExecutable(executable: string): Promise<string> {
    try {
      return createHash("sha256")
        .update(await readFile(executable))
        .digest("hex");
    } catch (error) {
      throw new CodexRunnerError(
        "CODEX_EXECUTABLE_CHANGED",
        "The resolved Codex executable could not be hashed.",
        { cause: error },
      );
    }
  }

  private async readIdentity(
    environment: Readonly<Record<string, string>>,
    workingDirectory: string,
  ): Promise<CodexRuntimeIdentity> {
    const executable = await this.resolveExecutable();
    const executableHash = await this.hashExecutable(executable);
    if (executableHash !== this.expectedExecutableHash) {
      throw new CodexRunnerError(
        "CODEX_UNTRUSTED_EXECUTABLE",
        "The resolved Codex executable does not match the pinned SHA-256.",
      );
    }
    const result = await runProcess({
      executable,
      args: ["--version"],
      environment,
      workingDirectory,
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new CodexRunnerError(
        "CODEX_EXEC_FAILED",
        `Codex version preflight failed with exit code ${result.exitCode ?? "unknown"}.`,
      );
    }
    const version = parseVersion(decodeUtf8(result.stdout, "Codex version output"));
    if (version !== REVIEWED_CODEX_CLI_VERSION) {
      throw new CodexRunnerError(
        "CODEX_UNSUPPORTED_VERSION",
        `Codex CLI ${version} is outside the reviewed version ${REVIEWED_CODEX_CLI_VERSION}.`,
      );
    }
    if ((await this.hashExecutable(executable)) !== executableHash) {
      throw new CodexRunnerError(
        "CODEX_EXECUTABLE_CHANGED",
        "The Codex executable changed during version preflight.",
      );
    }
    return { executable, cliVersion: version, executableHash };
  }

  async run(request: CodexRunRequest): Promise<CodexRunResult> {
    validateRequest(request);
    if (request.signal?.aborted) {
      throw new CodexRunnerError("CODEX_ABORTED", "Codex execution was aborted.");
    }
    const workingDirectory = await realpath(request.workingDirectory).catch((error: unknown) => {
      throw new CodexRunnerError(
        "CODEX_INVALID_REQUEST",
        "Codex working directory does not exist.",
        { cause: error },
      );
    });
    if (!(await stat(workingDirectory)).isDirectory()) {
      throw new CodexRunnerError(
        "CODEX_INVALID_REQUEST",
        "Codex working directory is not a directory.",
      );
    }

    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-codex-runtime-"));
    const codexHome = path.join(runtimeRoot, "home");
    const operatingSystemHome = path.join(runtimeRoot, "os-home");
    const schemaDirectory = path.join(runtimeRoot, "schema");
    const schemaPath = path.join(schemaDirectory, "output-schema.json");
    const environment: Record<string, string> = {
      ...this.#environment,
      CODEX_HOME: codexHome,
      HOME: operatingSystemHome,
      USERPROFILE: operatingSystemHome,
      XDG_CACHE_HOME: path.join(operatingSystemHome, ".cache"),
      XDG_CONFIG_HOME: path.join(operatingSystemHome, ".config"),
      XDG_DATA_HOME: path.join(operatingSystemHome, ".local", "share"),
      XDG_STATE_HOME: path.join(operatingSystemHome, ".local", "state"),
    };
    const preflightEnvironment = { ...environment };
    delete preflightEnvironment.CODEX_API_KEY;
    let identity: CodexRuntimeIdentity | undefined;
    let outcome: CodexRunResult | undefined;
    let failure: CodexRunnerError | undefined;

    try {
      await chmod(runtimeRoot, 0o700);
      await mkdir(codexHome, { mode: 0o700 });
      await mkdir(operatingSystemHome, { mode: 0o700 });
      await mkdir(schemaDirectory, { mode: 0o700 });
      await assertNoAmbientCodexConfiguration(preflightEnvironment, runtimeRoot);
      identity = await this.readIdentity(preflightEnvironment, workingDirectory);
      await writeFile(schemaPath, JSON.stringify(request.outputSchema), {
        encoding: "utf8",
        mode: 0o600,
      });
      const normalizedRequest =
        request.model === undefined
          ? { workingDirectory }
          : { workingDirectory, model: request.model };
      if ((await this.hashExecutable(identity.executable)) !== identity.executableHash) {
        throw new CodexRunnerError(
          "CODEX_EXECUTABLE_CHANGED",
          "The Codex executable changed before execution.",
        );
      }

      let processResult: ProcessResult | undefined;
      let processFailure: unknown;
      try {
        processResult = await runProcess({
          executable: identity.executable,
          args: buildCodexExecArgs(normalizedRequest, schemaPath, codexHome),
          environment,
          workingDirectory,
          input: request.prompt,
          timeoutMs: positiveTimeout(request.timeoutMs, this.timeoutMs),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (error) {
        processFailure = error;
      }
      if ((await this.hashExecutable(identity.executable)) !== identity.executableHash) {
        throw new CodexRunnerError(
          "CODEX_EXECUTABLE_CHANGED",
          "The Codex executable changed during execution.",
        );
      }
      if (processFailure !== undefined) {
        throw processFailure;
      }
      if (!processResult || processResult.exitCode !== 0 || processResult.signal !== null) {
        throw new CodexRunnerError(
          "CODEX_EXEC_FAILED",
          `Codex exec failed with exit code ${processResult?.exitCode ?? "unknown"}.`,
        );
      }
      outcome = {
        ...collectResult(parseJsonLines(processResult.stdout), identity.cliVersion),
        executableHash: identity.executableHash,
      };
    } catch (error) {
      failure = attachRuntimeIdentity(error, identity);
    }

    try {
      await rm(runtimeRoot, { force: true, recursive: true });
    } catch (error) {
      failure ??= attachRuntimeIdentity(
        new CodexRunnerError("CODEX_EXEC_FAILED", "Codex disposable runtime cleanup failed.", {
          cause: error,
        }),
        identity,
      );
    }
    if (failure) {
      throw failure;
    }
    if (!outcome) {
      throw new CodexRunnerError("CODEX_EXEC_FAILED", "Codex execution produced no result.");
    }
    return outcome;
  }
}

const REVIEWED_CODEX_RUN = CodexExecRunner.prototype.run;
Object.freeze(CodexExecRunner.prototype);

export function isReviewedCodexExecRunner(value: unknown): value is CodexExecRunner {
  try {
    return (
      value instanceof CodexExecRunner &&
      Object.getPrototypeOf(value) === CodexExecRunner.prototype &&
      value.run === REVIEWED_CODEX_RUN &&
      value.policyId === CODEX_EXEC_POLICY_ID
    );
  } catch {
    return false;
  }
}
