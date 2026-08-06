import { readFile } from "node:fs/promises";
import {
  type AdapterScanResult,
  AnalysisError,
  type Finding,
  type LanguageAdapter,
  listRepositoryFiles,
  type MigrationResolution,
  REPORT_SCHEMA_VERSION,
  resolveMigrationPath,
  resolveRepositoryFile,
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

const SOURCE_MODEL = "gpt-4o-mini-transcribe-2025-03-20";
const RULE_ID = "openai.transcriptions.model.gpt-4o-mini-transcribe-2025-03-20";
const TYPESCRIPT_EXTENSIONS = [".cts", ".mts", ".ts", ".tsx"] as const;

function findModelLiteral(call: ts.CallExpression): ts.StringLiteral | null {
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
    modelProperty.initializer.text !== SOURCE_MODEL
  ) {
    return null;
  }
  return modelProperty.initializer;
}

function parseDiagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}

function scanSource(
  relativeFile: string,
  content: string,
  resolution: Exclude<MigrationResolution, { status: "unmapped" }>,
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

  const fileHash = sha256(content);
  const findings: Finding[] = [];
  const deterministicModelReplacement =
    resolution.status === "resolved" &&
    resolution.automationTier === "A" &&
    resolution.to.kind === "model";
  const findingKind =
    resolution.status === "blocked" && resolution.issue.kind === "source-conflict"
      ? "source-conflict"
      : deterministicModelReplacement
        ? "deprecated-usage"
        : "migration-blocked";
  const automationTier =
    resolution.status === "blocked"
      ? "C"
      : resolution.to.kind !== "model"
        ? "C"
        : resolution.automationTier;
  const abstentionReason =
    resolution.status === "blocked"
      ? resolution.issue.message
      : resolution.to.kind !== "model"
        ? `Terminal migration destination ${resolution.to.kind}:${resolution.to.id} is not a model literal.`
        : resolution.automationTier !== "A"
          ? `Migration path requires Tier ${resolution.automationTier} review.`
          : undefined;

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
        const literal = findModelLiteral(node);
        if (literal) {
          const startOffset = literal.getStart(sourceFile) + 1;
          const endOffset = literal.getEnd() - 1;
          const position = sourceFile.getLineAndCharacterOfPosition(startOffset);
          findings.push({
            schemaVersion: REPORT_SCHEMA_VERSION,
            id: sha256(
              [
                RULE_ID,
                resolution.edgeIds.join("\u0001"),
                relativeFile,
                startOffset,
                endOffset,
              ].join("\u0000"),
            ),
            kind: findingKind,
            language: "typescript",
            resource: { kind: "model", id: SOURCE_MODEL },
            ruleId: RULE_ID,
            severity: "error",
            location: {
              file: relativeFile,
              line: position.line + 1,
              column: position.character + 1,
              startOffset,
              endOffset,
            },
            fileHash,
            evidence: SOURCE_MODEL,
            migrationEdgeIds: resolution.edgeIds,
            graphIssueIds: resolution.issue ? [resolution.issue.id] : [],
            confidence: "high",
            automationTier,
            reviewRequired:
              resolution.reviewRequired || !deterministicModelReplacement || automationTier !== "A",
            analysis: {
              family: "model-snapshot",
              feature: "model-snapshot",
              pattern: "direct",
              disposition: "supported",
            },
            ...(abstentionReason ? { abstentionReason } : {}),
            remediation: deterministicModelReplacement
              ? {
                  kind: "replace-string-literal",
                  replacement: resolution.to.id,
                }
              : { kind: "none" },
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

export class TypeScriptLanguageAdapter implements LanguageAdapter {
  readonly id = "typescript";
  readonly extensions = TYPESCRIPT_EXTENSIONS;

  async scan(request: Parameters<LanguageAdapter["scan"]>[0]): Promise<AdapterScanResult> {
    const modelResolution = resolveMigrationPath(
      request.migrationEdges,
      { kind: "model", id: SOURCE_MODEL },
      "typescript",
    );
    const assistantsResolution = resolveMigrationPath(
      request.migrationEdges,
      ASSISTANTS_RESOURCE,
      "typescript",
    );

    const extensions = new Set<string>(this.extensions);
    let files: string[];
    try {
      files = await listRepositoryFiles(request.repositoryRoot, extensions);
    } catch (error) {
      throw new AnalysisError("Unable to enumerate candidate TypeScript files.", { cause: error });
    }
    const findingGroups = await Promise.all(
      files.map(async (relativeFile) => {
        let content: string;
        try {
          content = await readFile(
            resolveRepositoryFile(request.repositoryRoot, relativeFile),
            "utf8",
          );
        } catch (error) {
          throw new AnalysisError(`Unable to read candidate TypeScript file ${relativeFile}.`, {
            cause: error,
          });
        }
        const hasModelCandidate = content.includes(SOURCE_MODEL);
        const hasAssistantsCandidate =
          content.includes("openai") &&
          content.includes("beta") &&
          (content.includes("assistants") || content.includes("threads"));
        if (!hasModelCandidate && !hasAssistantsCandidate) {
          return [];
        }
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
              `No locked TypeScript migration edge exists for ${SOURCE_MODEL}.`,
            );
          }
          findings.push(...scanSource(relativeFile, content, modelResolution, bound));
        }
        if (hasAssistantsCandidate && (clients.size > 0 || openAiTypes.size > 0)) {
          const assistants = scanAssistantsSource(
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
              "No locked TypeScript migration edge exists for the Assistants API.",
            );
          }
          findings.push(...assistants.findings);
        }
        return findings;
      }),
    );
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
