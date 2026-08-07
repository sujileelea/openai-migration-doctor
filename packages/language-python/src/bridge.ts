import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisError } from "@migration-doctor/core";
import {
  LIBCST_PROTOCOL_VERSION,
  type LibCstRewriteResponse,
  type LibCstScanResponse,
  type LibCstSourceFile,
  parseLibCstRewriteResponse,
  parseLibCstScanResponse,
} from "./protocol.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_WORKER_PATH = path.join(PACKAGE_ROOT, "python", "worker.py");
const DEFAULT_PYTHON_EXECUTABLE = path.join(
  PACKAGE_ROOT,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
export const REQUIRED_LIBCST_VERSION = "1.9.0" as const;
export const PYTHON_MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
export const PYTHON_MAX_CANDIDATE_FILES = 256;
export const PYTHON_MAX_CANDIDATE_SOURCE_BYTES = 16 * 1024 * 1024;
export const PYTHON_MAX_WORKER_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_PATH_CHARACTERS = 4096;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function assertModelIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !MODEL_IDENTIFIER.test(value)) {
    throw new AnalysisError(
      `${label} must be a stable model identifier of at most 256 characters.`,
    );
  }
}

function snapshotBoundedSourceFiles(
  files: readonly LibCstSourceFile[],
  operation: "scan" | "rewrite",
): LibCstSourceFile[] {
  if (!Array.isArray(files)) {
    throw new AnalysisError(`LibCST ${operation} request files must be an array.`);
  }
  if (files.length > PYTHON_MAX_CANDIDATE_FILES) {
    throw new AnalysisError(
      `LibCST ${operation} request has ${files.length} source files; the limit is ${PYTHON_MAX_CANDIDATE_FILES}.`,
    );
  }

  const snapshot: LibCstSourceFile[] = [];
  const seenPaths = new Set<string>();
  let aggregateBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const value: unknown = files[index];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AnalysisError(`LibCST ${operation} request files[${index}] must be an object.`);
    }
    const file = value as Partial<LibCstSourceFile>;
    const sourcePath = file.path;
    const content = file.content;
    if (
      typeof sourcePath !== "string" ||
      sourcePath.length === 0 ||
      sourcePath.length > MAX_SOURCE_PATH_CHARACTERS
    ) {
      throw new AnalysisError(
        `LibCST ${operation} request files[${index}].path must contain 1 to ${MAX_SOURCE_PATH_CHARACTERS} characters.`,
      );
    }
    if (seenPaths.has(sourcePath)) {
      throw new AnalysisError(`LibCST ${operation} request contains duplicate path ${sourcePath}.`);
    }
    if (typeof content !== "string") {
      throw new AnalysisError(
        `LibCST ${operation} request file ${sourcePath} content must be a string.`,
      );
    }

    const sourceBytes = Buffer.byteLength(content, "utf8");
    if (sourceBytes > PYTHON_MAX_SOURCE_FILE_BYTES) {
      throw new AnalysisError(
        `LibCST ${operation} request file ${sourcePath} is ${sourceBytes} bytes; the per-file source limit is ${PYTHON_MAX_SOURCE_FILE_BYTES} bytes.`,
      );
    }
    aggregateBytes += sourceBytes;
    if (aggregateBytes > PYTHON_MAX_CANDIDATE_SOURCE_BYTES) {
      throw new AnalysisError(
        `LibCST ${operation} request source total is ${aggregateBytes} bytes after ${sourcePath}; the aggregate source limit is ${PYTHON_MAX_CANDIDATE_SOURCE_BYTES} bytes.`,
      );
    }

    seenPaths.add(sourcePath);
    snapshot.push({ path: sourcePath, content });
  }
  return snapshot;
}

function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      bytes += 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function workerInputBytes(
  operation: "scan" | "rewrite",
  files: readonly LibCstSourceFile[],
  sourceModel: string,
  targetModel?: string,
): number {
  const shell =
    operation === "scan"
      ? {
          schemaVersion: LIBCST_PROTOCOL_VERSION,
          operation,
          sourceModel: "",
          files: [],
        }
      : {
          schemaVersion: LIBCST_PROTOCOL_VERSION,
          operation,
          sourceModel: "",
          targetModel: "",
          files: [],
        };
  let bytes = Buffer.byteLength(JSON.stringify(shell), "utf8") + 1;
  bytes += jsonStringByteLength(sourceModel) - 2;
  if (targetModel !== undefined) {
    bytes += jsonStringByteLength(targetModel) - 2;
  }
  for (const file of files) {
    bytes += 20 + jsonStringByteLength(file.path) + jsonStringByteLength(file.content);
  }
  if (files.length > 1) {
    bytes += files.length - 1;
  }
  return bytes;
}

function assertWorkerInputBudget(
  operation: "scan" | "rewrite",
  files: readonly LibCstSourceFile[],
  sourceModel: string,
  targetModel?: string,
): number {
  const inputBytes = workerInputBytes(operation, files, sourceModel, targetModel);
  if (inputBytes > PYTHON_MAX_WORKER_INPUT_BYTES) {
    throw new AnalysisError(
      `LibCST ${operation} request serializes to ${inputBytes} bytes; the worker input limit is ${PYTHON_MAX_WORKER_INPUT_BYTES} bytes.`,
    );
  }
  return inputBytes;
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR"]) {
      const value = process.env[name];
      if (value !== undefined) {
        environment[name] = value;
      }
    }
  }
  return environment;
}

function assertWorkerVersion(version: string): void {
  if (version !== REQUIRED_LIBCST_VERSION) {
    throw new AnalysisError(
      `Python analysis requires LibCST ${REQUIRED_LIBCST_VERSION}; worker reported ${version}.`,
    );
  }
}

export type LibCstBridgeOptions = {
  pythonExecutable?: string;
  workerPath?: string;
  timeoutMs?: number;
};

export class LibCstBridge {
  readonly pythonExecutable: string;
  readonly workerPath: string;
  readonly timeoutMs: number;

  constructor(options: LibCstBridgeOptions = {}) {
    this.pythonExecutable = options.pythonExecutable ?? DEFAULT_PYTHON_EXECUTABLE;
    this.workerPath = options.workerPath ?? DEFAULT_WORKER_PATH;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!path.isAbsolute(this.pythonExecutable) || !path.isAbsolute(this.workerPath)) {
      throw new AnalysisError("LibCST Python executable and worker paths must be absolute.");
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new AnalysisError("LibCST worker timeout must be a positive integer.");
    }
  }

  async scan(files: readonly LibCstSourceFile[], sourceModel: string): Promise<LibCstScanResponse> {
    assertModelIdentifier(sourceModel, "LibCST scan sourceModel");
    const boundedFiles = snapshotBoundedSourceFiles(files, "scan");
    const expectedInputBytes = assertWorkerInputBudget("scan", boundedFiles, sourceModel);
    const response = await this.run(
      {
        schemaVersion: LIBCST_PROTOCOL_VERSION,
        operation: "scan",
        sourceModel,
        files: boundedFiles,
      },
      expectedInputBytes,
    );
    try {
      const parsed = parseLibCstScanResponse(response);
      assertWorkerVersion(parsed.worker.libcstVersion);
      return parsed;
    } catch (error) {
      if (error instanceof AnalysisError) {
        throw error;
      }
      throw new AnalysisError("LibCST worker returned an invalid scan response.", { cause: error });
    }
  }

  async rewrite(
    files: readonly LibCstSourceFile[],
    sourceModel: string,
    targetModel: string,
  ): Promise<LibCstRewriteResponse> {
    assertModelIdentifier(sourceModel, "LibCST rewrite sourceModel");
    assertModelIdentifier(targetModel, "LibCST rewrite targetModel");
    const boundedFiles = snapshotBoundedSourceFiles(files, "rewrite");
    const expectedInputBytes = assertWorkerInputBudget(
      "rewrite",
      boundedFiles,
      sourceModel,
      targetModel,
    );
    const response = await this.run(
      {
        schemaVersion: LIBCST_PROTOCOL_VERSION,
        operation: "rewrite",
        sourceModel,
        targetModel,
        files: boundedFiles,
      },
      expectedInputBytes,
    );
    try {
      const parsed = parseLibCstRewriteResponse(response);
      assertWorkerVersion(parsed.worker.libcstVersion);
      return parsed;
    } catch (error) {
      if (error instanceof AnalysisError) {
        throw error;
      }
      throw new AnalysisError("LibCST worker returned an invalid rewrite response.", {
        cause: error,
      });
    }
  }

  private async run(request: object, expectedInputBytes: number): Promise<unknown> {
    const input = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(input, "utf8") !== expectedInputBytes) {
      throw new AnalysisError("LibCST worker input size calculation did not match serialization.");
    }
    return await new Promise<unknown>((resolve, reject) => {
      const child = spawn(this.pythonExecutable, ["-I", "-X", "utf8", this.workerPath], {
        cwd: PACKAGE_ROOT,
        env: workerEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      let stdout = "";
      let stderr = "";
      let completed = false;
      const fail = (error: Error): void => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new AnalysisError(`LibCST worker exceeded the ${this.timeoutMs} ms timeout.`));
      }, this.timeoutMs);

      child.on("error", (error) => {
        fail(new AnalysisError("Unable to start the LibCST worker.", { cause: error }));
      });
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > MAX_WORKER_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          fail(new AnalysisError("LibCST worker output exceeded the 64 MiB limit."));
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr, "utf8") > MAX_WORKER_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          fail(new AnalysisError("LibCST worker error output exceeded the 64 MiB limit."));
        }
      });
      child.on("close", (code, signal) => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new AnalysisError(
              `LibCST worker exited with code ${code ?? "none"} and signal ${signal ?? "none"}${stderr ? `: ${stderr.trim()}` : "."}`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new AnalysisError("LibCST worker emitted malformed JSON.", { cause: error }));
        }
      });
      child.stdin.on("error", (error) => {
        fail(new AnalysisError("Unable to send input to the LibCST worker.", { cause: error }));
      });
      child.stdin.end(input);
    });
  }
}
