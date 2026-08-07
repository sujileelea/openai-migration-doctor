import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  type AdapterScanResult,
  AnalysisError,
  type AnalysisFeature,
  createModelSnapshotFinding,
  type Finding,
  type LanguageAdapter,
  listRepositoryFiles,
  type MigrationResolution,
  REPORT_SCHEMA_VERSION,
  RepositoryFileLimitError,
  type ResourceRef,
  resolveMigrationPath,
  resolveRepositoryFile,
  sha256,
} from "@migration-doctor/core";
import {
  LibCstBridge,
  type LibCstBridgeOptions,
  PYTHON_MAX_CANDIDATE_FILES,
  PYTHON_MAX_CANDIDATE_SOURCE_BYTES,
  PYTHON_MAX_SOURCE_FILE_BYTES,
} from "./bridge.js";
import type {
  LibCstAssistantCall,
  LibCstAssistantFeature,
  LibCstPosition,
  LibCstWorkerIdentity,
} from "./protocol.js";

export const PYTHON_SOURCE_MODEL = "gpt-4o-mini-transcribe-2025-03-20";
export const PYTHON_MODEL_RULE_ID = "openai.transcriptions.model.gpt-4o-mini-transcribe-2025-03-20";
export const PYTHON_MAX_SOURCE_FILES = 4096;
export const PYTHON_ASSISTANTS_RESOURCE: ResourceRef = {
  kind: "product",
  id: "assistants-api",
  displayName: "Assistants API",
};
const PYTHON_EXTENSIONS = [".py", ".pyi"] as const;

type AssistantsResolution = Exclude<MigrationResolution, { status: "unmapped" }>;

const ASSISTANTS_REASONS: Record<LibCstAssistantFeature["reasonCode"], string> = {
  "manual-migration-required":
    "Assistants API usage is confirmed, but Migration Doctor does not transform stateful API integrations.",
  "unsupported-method":
    "The OpenAI client uses an Assistants API method outside the reviewed Python allowlist.",
  "dynamic-stream": "The Assistants streaming flag is not a boolean literal.",
  "dynamic-tools": "Assistants tool configuration is not a fully static inline list.",
  "dynamic-tool-resources": "Assistants tool resources are not a fully static inline dictionary.",
};

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

function assistantRuleId(feature: Exclude<AnalysisFeature, "model-snapshot">): string {
  return feature === "assistants" || feature === "threads" || feature === "runs"
    ? `openai.assistants.api.${feature}`
    : `openai.assistants.feature.${feature}`;
}

function createAssistantFindings(
  relativeFile: string,
  content: string,
  calls: readonly LibCstAssistantCall[],
  resolution: AssistantsResolution,
): Finding[] {
  const fileHash = sha256(content);
  return calls.flatMap((call) => {
    const startOffset = pythonPositionToUtf16Offset(content, call.start);
    const endOffset = pythonPositionToUtf16Offset(content, call.end);
    if (endOffset <= startOffset) {
      throw new AnalysisError("LibCST returned an empty Assistants callee range.");
    }
    const lineOffset = lineBounds(content, call.start.line).start;
    const evidence = content.slice(startOffset, endOffset);
    return call.features.map((feature) => {
      const ruleId = assistantRuleId(feature.feature);
      return {
        schemaVersion: REPORT_SCHEMA_VERSION,
        id: sha256(
          [
            ruleId,
            feature.pattern,
            feature.reasonCode,
            resolution.edgeIds.join("\u0001"),
            relativeFile,
            startOffset,
            endOffset,
          ].join("\u0000"),
        ),
        kind: feature.disposition === "supported" ? "analysis-only" : "unsupported-pattern",
        language: "python",
        resource: PYTHON_ASSISTANTS_RESOURCE,
        ruleId,
        severity:
          feature.feature === "assistants" ||
          feature.feature === "threads" ||
          feature.feature === "runs"
            ? "error"
            : "warning",
        location: {
          file: relativeFile,
          line: call.start.line,
          column: startOffset - lineOffset + 1,
          startOffset,
          endOffset,
        },
        fileHash,
        evidence,
        migrationEdgeIds: resolution.edgeIds,
        graphIssueIds: resolution.issue ? [resolution.issue.id] : [],
        confidence: feature.disposition === "supported" ? "high" : "medium",
        automationTier: "C",
        reviewRequired: true,
        analysis: {
          family: "assistants-api",
          feature: feature.feature,
          pattern: feature.pattern,
          disposition: feature.disposition,
          reasonCode: feature.reasonCode,
        },
        abstentionReason: ASSISTANTS_REASONS[feature.reasonCode],
        remediation: { kind: "none" },
      } satisfies Finding;
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
    const modelResolution = resolveMigrationPath(
      request.migrationEdges,
      { kind: "model", id: PYTHON_SOURCE_MODEL },
      "python",
    );
    const assistantsResolution = resolveMigrationPath(
      request.migrationEdges,
      PYTHON_ASSISTANTS_RESOURCE,
      "python",
    );
    let files: string[];
    try {
      files = await listRepositoryFiles(request.repositoryRoot, new Set(this.extensions), {
        maxFiles: PYTHON_MAX_SOURCE_FILES,
      });
    } catch (error) {
      if (error instanceof RepositoryFileLimitError) {
        throw new AnalysisError(
          `Python repository contains more than ${PYTHON_MAX_SOURCE_FILES} .py/.pyi source files; the source file limit is ${PYTHON_MAX_SOURCE_FILES}.`,
          { cause: error },
        );
      }
      throw new AnalysisError("Unable to enumerate candidate Python files.", { cause: error });
    }

    const repositoryFiles = new Set(files);
    const analyzableCandidates: Array<{ path: string; content: string }> = [];
    let candidateFiles = 0;
    let candidateSourceBytes = 0;
    for (const relativeFile of files) {
      const absoluteFile = resolveRepositoryFile(request.repositoryRoot, relativeFile);
      let preReadBytes: number;
      try {
        preReadBytes = (await stat(absoluteFile)).size;
      } catch (error) {
        throw new AnalysisError(`Unable to inspect candidate Python file ${relativeFile}.`, {
          cause: error,
        });
      }
      if (preReadBytes > PYTHON_MAX_SOURCE_FILE_BYTES) {
        throw new AnalysisError(
          `Python source file ${relativeFile} is ${preReadBytes} bytes before read; the per-file source limit is ${PYTHON_MAX_SOURCE_FILE_BYTES} bytes.`,
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await readFile(absoluteFile);
      } catch (error) {
        throw new AnalysisError(`Unable to read candidate Python file ${relativeFile}.`, {
          cause: error,
        });
      }
      if (bytes.byteLength > PYTHON_MAX_SOURCE_FILE_BYTES) {
        throw new AnalysisError(
          `Python source file ${relativeFile} is ${bytes.byteLength} bytes after read; the per-file source limit is ${PYTHON_MAX_SOURCE_FILE_BYTES} bytes.`,
        );
      }

      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (error) {
        throw new AnalysisError(`Candidate Python file ${relativeFile} is not valid UTF-8.`, {
          cause: error,
        });
      }
      const hasModelCandidate = content.includes(PYTHON_SOURCE_MODEL);
      const hasAssistantsCandidate =
        content.includes("openai") &&
        content.includes("beta") &&
        (content.includes("assistants") || content.includes("threads"));
      if (!hasModelCandidate && !hasAssistantsCandidate) {
        continue;
      }

      candidateFiles += 1;
      if (candidateFiles > PYTHON_MAX_CANDIDATE_FILES) {
        throw new AnalysisError(
          `Python analysis found ${candidateFiles} candidate files after ${relativeFile}; the candidate file limit is ${PYTHON_MAX_CANDIDATE_FILES}.`,
        );
      }
      candidateSourceBytes += bytes.byteLength;
      if (candidateSourceBytes > PYTHON_MAX_CANDIDATE_SOURCE_BYTES) {
        throw new AnalysisError(
          `Python candidate source total is ${candidateSourceBytes} bytes after ${relativeFile}; the aggregate source limit is ${PYTHON_MAX_CANDIDATE_SOURCE_BYTES} bytes.`,
        );
      }
      if (!hasLocalOpenAiModule(relativeFile, repositoryFiles)) {
        analyzableCandidates.push({ path: relativeFile, content });
      }
    }

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
    const modelMatchCount = workerResult.files.reduce(
      (total, file) => total + file.matches.length,
      0,
    );
    const assistantsMatchCount = workerResult.files.reduce(
      (total, file) => total + file.assistants.length,
      0,
    );
    if (modelMatchCount > 0 && modelResolution.status === "unmapped") {
      throw new AnalysisError(`No locked Python migration edge exists for ${PYTHON_SOURCE_MODEL}.`);
    }
    if (assistantsMatchCount > 0 && assistantsResolution.status === "unmapped") {
      throw new AnalysisError("No locked Python migration edge exists for the Assistants API.");
    }

    const findings = workerResult.files.flatMap((file, index) => {
      const content = analyzableCandidates[index]?.content ?? "";
      return [
        ...(modelResolution.status === "unmapped"
          ? []
          : createFindings(file.path, content, file.matches, modelResolution)),
        ...(assistantsResolution.status === "unmapped"
          ? []
          : createAssistantFindings(file.path, content, file.assistants, assistantsResolution)),
      ];
    });
    const hasModelFindings = findings.some(
      (finding) => finding.analysis.family === "model-snapshot",
    );
    const hasAssistantsFindings = findings.some(
      (finding) => finding.analysis.family === "assistants-api",
    );
    return {
      result: {
        findings,
        graphIssues: [
          ...(hasModelFindings && modelResolution.status === "blocked"
            ? [modelResolution.issue]
            : []),
          ...(hasAssistantsFindings && assistantsResolution.status === "blocked"
            ? [assistantsResolution.issue]
            : []),
        ],
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
