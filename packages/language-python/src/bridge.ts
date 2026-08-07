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

  async scan(files: LibCstSourceFile[], sourceModel: string): Promise<LibCstScanResponse> {
    const response = await this.run({
      schemaVersion: LIBCST_PROTOCOL_VERSION,
      operation: "scan",
      sourceModel,
      files,
    });
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
    files: LibCstSourceFile[],
    sourceModel: string,
    targetModel: string,
  ): Promise<LibCstRewriteResponse> {
    const response = await this.run({
      schemaVersion: LIBCST_PROTOCOL_VERSION,
      operation: "rewrite",
      sourceModel,
      targetModel,
      files,
    });
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

  private async run(request: object): Promise<unknown> {
    const input = `${JSON.stringify(request)}\n`;
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
