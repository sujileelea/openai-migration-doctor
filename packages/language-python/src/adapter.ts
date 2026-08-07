import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  type AdapterScanResult,
  AnalysisError,
  createModelSnapshotFinding,
  type LanguageAdapter,
  listRepositoryFiles,
  resolveMigrationPath,
  resolveRepositoryFile,
} from "@migration-doctor/core";
import { LibCstBridge, type LibCstBridgeOptions } from "./bridge.js";
import type { LibCstPosition, LibCstWorkerIdentity } from "./protocol.js";

export const PYTHON_SOURCE_MODEL = "gpt-4o-mini-transcribe-2025-03-20";
export const PYTHON_MODEL_RULE_ID = "openai.transcriptions.model.gpt-4o-mini-transcribe-2025-03-20";
const PYTHON_EXTENSIONS = [".py", ".pyi"] as const;

export type PythonAdapterScanMetrics = {
  durationMs: number;
  repositoryFiles: number;
  candidateFiles: number;
  candidateBytes: number;
  worker: LibCstWorkerIdentity | null;
};

export type PythonAdapterMeasuredScan = {
  result: AdapterScanResult;
  metrics: PythonAdapterScanMetrics;
};

export type PythonLanguageAdapterOptions = LibCstBridgeOptions;

function lineBounds(content: string, line: number): { start: number; end: number } {
  if (line < 1) {
    throw new AnalysisError("LibCST returned a line before the start of the source file.");
  }
  let currentLine = 1;
  let start = 0;
  for (let offset = 0; offset < content.length && currentLine < line; offset += 1) {
    if (content[offset] === "\r") {
      if (content[offset + 1] === "\n") {
        offset += 1;
      }
      start = offset + 1;
      currentLine += 1;
    } else if (content[offset] === "\n") {
      start = offset + 1;
      currentLine += 1;
    }
  }
  if (currentLine !== line) {
    throw new AnalysisError("LibCST returned a line after the end of the source file.");
  }
  let end = start;
  while (end < content.length && content[end] !== "\r" && content[end] !== "\n") {
    end += 1;
  }
  return { start, end };
}

export function pythonPositionToUtf16Offset(content: string, position: LibCstPosition): number {
  const bounds = lineBounds(content, position.line);
  const codePoints = [...content.slice(bounds.start, bounds.end)];
  const bomBias = position.line === 1 && content.startsWith("\uFEFF") ? 1 : 0;
  if (position.column > codePoints.length - bomBias) {
    throw new AnalysisError("LibCST returned a column after the end of the source line.");
  }
  return bounds.start + codePoints.slice(0, position.column + bomBias).join("").length;
}

function createFindings(
  relativeFile: string,
  content: string,
  positions: ReadonlyArray<{ start: LibCstPosition; end: LibCstPosition }>,
  resolution: Parameters<typeof createModelSnapshotFinding>[0]["resolution"],
) {
  return positions.map(({ start, end }) => {
    const startOffset = pythonPositionToUtf16Offset(content, start);
    const endOffset = pythonPositionToUtf16Offset(content, end);
    const lineOffset = lineBounds(content, start.line).start;
    return createModelSnapshotFinding({
      language: "python",
      ruleId: PYTHON_MODEL_RULE_ID,
      sourceModel: PYTHON_SOURCE_MODEL,
      relativeFile,
      content,
      resolution,
      location: {
        file: relativeFile,
        line: start.line,
        column: startOffset - lineOffset + 1,
        startOffset,
        endOffset,
      },
    });
  });
}

function hasLocalOpenAiModule(relativeFile: string, repositoryFiles: ReadonlySet<string>): boolean {
  let directory = path.posix.dirname(relativeFile);
  for (;;) {
    const prefix = directory === "." ? "" : `${directory}/`;
    if (
      repositoryFiles.has(`${prefix}openai.py`) ||
      repositoryFiles.has(`${prefix}openai/__init__.py`)
    ) {
      return true;
    }
    if (directory === ".") {
      return false;
    }
    directory = path.posix.dirname(directory);
  }
}

export class PythonLanguageAdapter implements LanguageAdapter {
  readonly id = "python";
  readonly extensions = PYTHON_EXTENSIONS;
  readonly bridge: LibCstBridge;

  constructor(options: PythonLanguageAdapterOptions = {}) {
    this.bridge = new LibCstBridge(options);
  }

  async scan(request: Parameters<LanguageAdapter["scan"]>[0]): Promise<AdapterScanResult> {
    return (await this.scanWithMetrics(request)).result;
  }

  async scanWithMetrics(
    request: Parameters<LanguageAdapter["scan"]>[0],
  ): Promise<PythonAdapterMeasuredScan> {
    const startedAt = performance.now();
    const resolution = resolveMigrationPath(
      request.migrationEdges,
      { kind: "model", id: PYTHON_SOURCE_MODEL },
      "python",
    );
    let files: string[];
    try {
      files = await listRepositoryFiles(request.repositoryRoot, new Set(this.extensions));
    } catch (error) {
      throw new AnalysisError("Unable to enumerate candidate Python files.", { cause: error });
    }

    const candidates = (
      await Promise.all(
        files.map(async (relativeFile) => {
          let bytes: Uint8Array;
          try {
            bytes = await readFile(resolveRepositoryFile(request.repositoryRoot, relativeFile));
          } catch (error) {
            throw new AnalysisError(`Unable to read candidate Python file ${relativeFile}.`, {
              cause: error,
            });
          }
          let content: string;
          try {
            content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          } catch (error) {
            throw new AnalysisError(`Candidate Python file ${relativeFile} is not valid UTF-8.`, {
              cause: error,
            });
          }
          return content.includes(PYTHON_SOURCE_MODEL) ? { path: relativeFile, content } : null;
        }),
      )
    ).filter((candidate): candidate is { path: string; content: string } => candidate !== null);
    const repositoryFiles = new Set(files);
    const analyzableCandidates = candidates.filter(
      (candidate) => !hasLocalOpenAiModule(candidate.path, repositoryFiles),
    );

    if (analyzableCandidates.length === 0) {
      return {
        result: { findings: [], graphIssues: [] },
        metrics: {
          durationMs: performance.now() - startedAt,
          repositoryFiles: files.length,
          candidateFiles: 0,
          candidateBytes: 0,
          worker: null,
        },
      };
    }

    const workerResult = await this.bridge.scan(analyzableCandidates, PYTHON_SOURCE_MODEL);
    if (
      workerResult.files.length !== analyzableCandidates.length ||
      !workerResult.files.every((file, index) => file.path === analyzableCandidates[index]?.path)
    ) {
      throw new AnalysisError("LibCST worker changed the candidate file set or ordering.");
    }
    const matchCount = workerResult.files.reduce((total, file) => total + file.matches.length, 0);
    if (matchCount > 0 && resolution.status === "unmapped") {
      throw new AnalysisError(`No locked Python migration edge exists for ${PYTHON_SOURCE_MODEL}.`);
    }

    const findings =
      resolution.status === "unmapped"
        ? []
        : workerResult.files.flatMap((file, index) =>
            createFindings(
              file.path,
              analyzableCandidates[index]?.content ?? "",
              file.matches,
              resolution,
            ),
          );
    return {
      result: {
        findings,
        graphIssues:
          findings.length > 0 && resolution.status === "blocked" ? [resolution.issue] : [],
      },
      metrics: {
        durationMs: performance.now() - startedAt,
        repositoryFiles: files.length,
        candidateFiles: analyzableCandidates.length,
        candidateBytes: analyzableCandidates.reduce(
          (total, candidate) => total + Buffer.byteLength(candidate.content, "utf8"),
          0,
        ),
        worker: workerResult.worker,
      },
    };
  }

  async rewriteSource(request: {
    relativeFile: string;
    content: string;
    targetModel: string;
  }): Promise<{ content: string; changedCount: number; worker: LibCstWorkerIdentity }> {
    const response = await this.bridge.rewrite(
      [{ path: request.relativeFile, content: request.content }],
      PYTHON_SOURCE_MODEL,
      request.targetModel,
    );
    const rewritten = response.files[0];
    if (response.files.length !== 1 || !rewritten || rewritten.path !== request.relativeFile) {
      throw new AnalysisError("LibCST worker changed the rewrite file set.");
    }
    const content =
      request.content.startsWith("\uFEFF") && !rewritten.content.startsWith("\uFEFF")
        ? `\uFEFF${rewritten.content}`
        : rewritten.content;
    return {
      content,
      changedCount: rewritten.changedCount,
      worker: response.worker,
    };
  }
}
