import { readFile } from "node:fs/promises";
import {
  type AdapterScanResult,
  AnalysisError,
  canonicalJson,
  createModelSnapshotFinding,
  type Finding,
  FindingSchema,
  type LanguageAdapter,
  listRepositoryFiles,
  type MigrationLanguage,
  resolveMigrationPath,
  resolveRepositoryFile,
  SemanticVerifierSchema,
  sha256,
} from "@migration-doctor/core";
import ts from "typescript";
import { ASSISTANTS_RESOURCE, scanAssistantsSource } from "./assistants.js";
import {
  type BoundSource,
  collectOpenAiClients,
  collectOpenAiConstructors,
  collectOpenAiTypeSymbols,
  createBoundSource,
  propertyChain,
} from "./bindings.js";
import type { TypeScriptAnalysisCache } from "./cache.js";

const SOURCE_MODEL = "gpt-4o-mini-transcribe-2025-03-20";
const RULE_ID = "openai.transcriptions.model.gpt-4o-mini-transcribe-2025-03-20";
const TYPESCRIPT_EXTENSIONS = [".cts", ".mts", ".ts", ".tsx"] as const;
const JAVASCRIPT_EXTENSIONS = [".cjs", ".js", ".jsx", ".mjs"] as const;
const ANALYSIS_CACHE_VERSION = "typescript-analysis-v3";

export type TypeScriptScanTelemetry = {
  cacheEnabled: boolean;
  files: number;
  cacheHits: number;
  cacheMisses: number;
  parsedFiles: number;
};

export type TypeScriptLanguageAdapterOptions = {
  cache?: TypeScriptAnalysisCache;
};

function findModelLiteral(call: ts.CallExpression, expectedModel: string): ts.StringLiteral | null {
  const request = call.arguments[0];
  if (!request || !ts.isObjectLiteralExpression(request)) {
    return null;
  }

  const modelProperties: ts.ObjectLiteralElementLike[] = [];
  for (const property of request.properties) {
    if (ts.isSpreadAssignment(property)) {
      return null;
    }
    if (ts.isComputedPropertyName(property.name)) {
      return null;
    }
    const name = property.name;
    if (
      (ts.isIdentifier(name) && name.text === "model") ||
      (ts.isStringLiteral(name) && name.text === "model")
    ) {
      modelProperties.push(property);
    }
  }

  const modelProperty = modelProperties[0];
  if (
    modelProperties.length !== 1 ||
    !modelProperty ||
    !ts.isPropertyAssignment(modelProperty) ||
    !ts.isStringLiteral(modelProperty.initializer) ||
    modelProperty.initializer.text !== expectedModel
  ) {
    return null;
  }
  return modelProperty.initializer;
}

function findTranscriptionModelLiterals(
  relativeFile: string,
  content: string,
  expectedModel: string,
): ts.StringLiteral[] {
  const bound = createBoundSource(relativeFile, content);
  const parseErrors = bound.diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (parseErrors.length > 0) {
    const message = parseErrors.map(parseDiagnosticMessage).join("; ");
    throw new AnalysisError(`Unable to parse ${relativeFile}: ${message}`);
  }

  const { checker, sourceFile } = bound;
  const constructors = collectOpenAiConstructors(sourceFile, checker);
  const clients = collectOpenAiClients(sourceFile, checker, constructors);
  const literals: ts.StringLiteral[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const chain = propertyChain(node.expression);
      const rootSymbol = chain ? checker.getSymbolAtLocation(chain.root) : undefined;
      const client = rootSymbol ? clients.get(rootSymbol) : undefined;
      if (
        chain &&
        chain.segments.length === 4 &&
        client !== undefined &&
        node.getStart(sourceFile) > client.constructedAt &&
        chain.segments[1] === "audio" &&
        chain.segments[2] === "transcriptions" &&
        chain.segments[3] === "create"
      ) {
        const literal = findModelLiteral(node, expectedModel);
        if (literal) {
          literals.push(literal);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return literals;
}

function parseDiagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}

export function validateTypeScriptSource(relativeFile: string, content: string): void {
  const parseErrors = createBoundSource(relativeFile, content).diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (parseErrors.length > 0) {
    const message = parseErrors.map(parseDiagnosticMessage).join("; ");
    throw new AnalysisError(`Unable to parse ${relativeFile}: ${message}`);
  }
}

export function verifyTypeScriptTranscriptionModelMigration(request: {
  relativeFile: string;
  beforeSource: string;
  afterSource: string;
  sourceModel: string;
  targetModel: string;
}): boolean {
  const verifier = SemanticVerifierSchema.safeParse({
    id: "typescript-transcription-model-exact-rewrite-v1",
    sourceModel: request.sourceModel,
    targetModel: request.targetModel,
  });
  if (!verifier.success) {
    return false;
  }
  const literals = findTranscriptionModelLiterals(
    request.relativeFile,
    request.beforeSource,
    verifier.data.sourceModel,
  );
  if (literals.length === 0) {
    return false;
  }

  let expectedSource = request.beforeSource;
  for (const literal of literals.sort((left, right) => right.getStart() - left.getStart())) {
    const start = literal.getStart() + 1;
    const end = literal.getEnd() - 1;
    expectedSource =
      expectedSource.slice(0, start) + verifier.data.targetModel + expectedSource.slice(end);
  }
  validateTypeScriptSource(request.relativeFile, request.afterSource);
  return request.afterSource === expectedSource;
}

function scanSource(
  language: MigrationLanguage,
  relativeFile: string,
  content: string,
  resolution: Parameters<typeof createModelSnapshotFinding>[0]["resolution"],
  bound: BoundSource = createBoundSource(relativeFile, content),
): Finding[] {
  const parseErrors = bound.diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (parseErrors.length > 0) {
    const message = parseErrors.map(parseDiagnosticMessage).join("; ");
    throw new AnalysisError(`Unable to parse ${relativeFile}: ${message}`);
  }

  const { checker, sourceFile } = bound;
  const constructors = collectOpenAiConstructors(sourceFile, checker);
  const clients = collectOpenAiClients(sourceFile, checker, constructors);
  if (clients.size === 0) {
    return [];
  }

  const findings: Finding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const chain = propertyChain(node.expression);
      const rootSymbol = chain ? checker.getSymbolAtLocation(chain.root) : undefined;
      const client = rootSymbol ? clients.get(rootSymbol) : undefined;
      if (
        chain &&
        chain.segments.length === 4 &&
        client !== undefined &&
        node.getStart(sourceFile) > client.constructedAt &&
        chain.segments[1] === "audio" &&
        chain.segments[2] === "transcriptions" &&
        chain.segments[3] === "create"
      ) {
        const literal = findModelLiteral(node, SOURCE_MODEL);
        if (literal) {
          const startOffset = literal.getStart(sourceFile) + 1;
          const endOffset = literal.getEnd() - 1;
          const position = sourceFile.getLineAndCharacterOfPosition(startOffset);
          findings.push(
            createModelSnapshotFinding({
              language,
              ruleId: RULE_ID,
              sourceModel: SOURCE_MODEL,
              ...(client.importPattern === "commonjs"
                ? { analysisPattern: client.importPattern }
                : {}),
              relativeFile,
              content,
              resolution,
              location: {
                file: relativeFile,
                line: position.line + 1,
                column: position.character + 1,
                startOffset,
                endOffset,
              },
            }),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

abstract class CompilerApiLanguageAdapter implements LanguageAdapter {
  abstract readonly id: "javascript" | "typescript";
  abstract readonly extensions: readonly string[];
  readonly #cache: TypeScriptAnalysisCache | undefined;
  #lastScanTelemetry: TypeScriptScanTelemetry = {
    cacheEnabled: false,
    files: 0,
    cacheHits: 0,
    cacheMisses: 0,
    parsedFiles: 0,
  };

  protected constructor(options: TypeScriptLanguageAdapterOptions = {}) {
    this.#cache = options.cache;
  }

  get lastScanTelemetry(): Readonly<TypeScriptScanTelemetry> {
    return { ...this.#lastScanTelemetry };
  }

  async scan(request: Parameters<LanguageAdapter["scan"]>[0]): Promise<AdapterScanResult> {
    const modelResolution = resolveMigrationPath(
      request.migrationEdges,
      { kind: "model", id: SOURCE_MODEL },
      this.id,
    );
    const assistantsResolution = resolveMigrationPath(
      request.migrationEdges,
      ASSISTANTS_RESOURCE,
      this.id,
    );

    const extensions = new Set<string>(this.extensions);
    let files: string[];
    try {
      files = await listRepositoryFiles(request.repositoryRoot, extensions);
    } catch (error) {
      throw new AnalysisError(`Unable to enumerate candidate ${this.id} files.`, { cause: error });
    }
    const telemetry: TypeScriptScanTelemetry = {
      cacheEnabled: this.#cache !== undefined,
      files: files.length,
      cacheHits: 0,
      cacheMisses: 0,
      parsedFiles: 0,
    };
    const migrationEdgesHash =
      this.#cache === undefined ? "" : sha256(canonicalJson(request.migrationEdges));
    let findingGroups: Finding[][];
    try {
      findingGroups = await Promise.all(
        files.map(async (relativeFile) => {
          let content: string;
          try {
            content = await readFile(
              resolveRepositoryFile(request.repositoryRoot, relativeFile),
              "utf8",
            );
          } catch (error) {
            throw new AnalysisError(`Unable to read candidate ${this.id} file ${relativeFile}.`, {
              cause: error,
            });
          }
          const cacheKey =
            this.#cache === undefined
              ? undefined
              : sha256(
                  [
                    ANALYSIS_CACHE_VERSION,
                    this.id,
                    migrationEdgesHash,
                    relativeFile,
                    sha256(content),
                  ].join("\u0000"),
                );
          if (cacheKey !== undefined && this.#cache !== undefined) {
            const cached = await this.#cache.get(cacheKey);
            if (cached !== undefined) {
              telemetry.cacheHits += 1;
              return cached.map((finding) => FindingSchema.parse(finding));
            }
            telemetry.cacheMisses += 1;
          }
          const hasModelCandidate = content.includes(SOURCE_MODEL);
          const hasAssistantsCandidate =
            content.includes("openai") &&
            content.includes("beta") &&
            (content.includes("assistants") || content.includes("threads"));
          if (!hasModelCandidate && !hasAssistantsCandidate) {
            if (cacheKey !== undefined && this.#cache !== undefined) {
              await this.#cache.set(cacheKey, []);
            }
            return [];
          }
          telemetry.parsedFiles += 1;
          const bound = createBoundSource(relativeFile, content);
          const parseErrors = bound.diagnostics.filter(
            (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
          );
          if (parseErrors.length > 0) {
            const message = parseErrors.map(parseDiagnosticMessage).join("; ");
            throw new AnalysisError(`Unable to parse ${relativeFile}: ${message}`);
          }
          const constructors = collectOpenAiConstructors(bound.sourceFile, bound.checker);
          const openAiTypes = collectOpenAiTypeSymbols(bound.sourceFile, bound.checker);
          const clients = collectOpenAiClients(bound.sourceFile, bound.checker, constructors);
          const findings: Finding[] = [];
          if (hasModelCandidate) {
            if (modelResolution.status === "unmapped") {
              throw new AnalysisError(
                `No locked ${this.id} migration edge exists for ${SOURCE_MODEL}.`,
              );
            }
            findings.push(...scanSource(this.id, relativeFile, content, modelResolution, bound));
          }
          if (hasAssistantsCandidate && (clients.size > 0 || openAiTypes.size > 0)) {
            const assistants = scanAssistantsSource(
              this.id,
              relativeFile,
              content,
              bound.sourceFile,
              bound.checker,
              clients,
              openAiTypes,
              assistantsResolution.status === "unmapped" ? undefined : assistantsResolution,
            );
            if (assistants.matched && assistantsResolution.status === "unmapped") {
              throw new AnalysisError(
                `No locked ${this.id} migration edge exists for the Assistants API.`,
              );
            }
            findings.push(...assistants.findings);
          }
          if (cacheKey !== undefined && this.#cache !== undefined) {
            await this.#cache.set(cacheKey, findings);
          }
          return findings;
        }),
      );
    } finally {
      this.#lastScanTelemetry = telemetry;
    }
    const normalizedFindings = findingGroups.flat();
    const hasModelFindings = normalizedFindings.some(
      (finding) => finding.analysis.family === "model-snapshot",
    );
    const hasAssistantsFindings = normalizedFindings.some(
      (finding) => finding.analysis.family === "assistants-api",
    );
    const graphIssues = [
      ...(hasModelFindings && modelResolution.status === "blocked" ? [modelResolution.issue] : []),
      ...(hasAssistantsFindings && assistantsResolution.status === "blocked"
        ? [assistantsResolution.issue]
        : []),
    ];
    return {
      findings: normalizedFindings,
      graphIssues,
    };
  }
}

export class TypeScriptLanguageAdapter extends CompilerApiLanguageAdapter {
  readonly id = "typescript" as const;
  readonly extensions = TYPESCRIPT_EXTENSIONS;

  constructor(options: TypeScriptLanguageAdapterOptions = {}) {
    super(options);
  }
}

export class JavaScriptLanguageAdapter extends CompilerApiLanguageAdapter {
  readonly id = "javascript" as const;
  readonly extensions = JAVASCRIPT_EXTENSIONS;

  constructor(options: TypeScriptLanguageAdapterOptions = {}) {
    super(options);
  }
}
