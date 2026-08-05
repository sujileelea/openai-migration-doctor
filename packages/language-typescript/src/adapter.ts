import { readFile } from "node:fs/promises";
import path from "node:path";
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

const SOURCE_MODEL = "gpt-4o-mini-transcribe-2025-03-20";
const RULE_ID = "openai.transcriptions.model.gpt-4o-mini-transcribe-2025-03-20";
const TYPESCRIPT_EXTENSIONS = [".cts", ".mts", ".ts", ".tsx"] as const;

function scriptKindFor(file: string): ts.ScriptKind {
  return path.extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function collectOpenAiConstructors(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): Set<ts.Symbol> {
  const constructors = new Set<ts.Symbol>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (statement.moduleSpecifier.text !== "openai" || !statement.importClause) {
      continue;
    }

    if (statement.importClause.name) {
      const symbol = checker.getSymbolAtLocation(statement.importClause.name);
      if (symbol) {
        constructors.add(symbol);
      }
    }

    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === "OpenAI") {
          const symbol = checker.getSymbolAtLocation(element.name);
          if (symbol) {
            constructors.add(symbol);
          }
        }
      }
    }
  }
  return constructors;
}

function collectOpenAiClients(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  constructors: Set<ts.Symbol>,
): Map<ts.Symbol, number> {
  const clients = new Map<ts.Symbol, number>();

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      constructors.has(checker.getSymbolAtLocation(node.initializer.expression) as ts.Symbol)
    ) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) {
        clients.set(symbol, node.getEnd());
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return clients;
}

type PropertyChain = {
  root: ts.Identifier;
  segments: string[];
};

function propertyChain(expression: ts.Expression): PropertyChain | null {
  if (ts.isIdentifier(expression)) {
    return { root: expression, segments: [expression.text] };
  }
  if (!ts.isPropertyAccessExpression(expression)) {
    return null;
  }
  const prefix = propertyChain(expression.expression);
  return prefix
    ? { root: prefix.root, segments: [...prefix.segments, expression.name.text] }
    : null;
}

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

function createBoundSource(relativeFile: string, content: string) {
  const fileName = path.resolve("/migration-doctor-input", relativeFile);
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ES2023,
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(relativeFile),
  );
  const canonicalFileName = (value: string) =>
    ts.sys.useCaseSensitiveFileNames ? value : value.toLowerCase();
  const host: ts.CompilerHost = {
    fileExists: (requested) => canonicalFileName(requested) === canonicalFileName(fileName),
    getCanonicalFileName: canonicalFileName,
    getCurrentDirectory: () => path.dirname(fileName),
    getDefaultLibFileName: () => "",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (requested) =>
      canonicalFileName(requested) === canonicalFileName(fileName) ? sourceFile : undefined,
    readFile: (requested) =>
      canonicalFileName(requested) === canonicalFileName(fileName) ? content : undefined,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    writeFile: () => undefined,
  };
  const program = ts.createProgram([fileName], options, host);
  const boundSource = program.getSourceFile(fileName) ?? sourceFile;
  return {
    sourceFile: boundSource,
    checker: program.getTypeChecker(),
    diagnostics: program.getSyntacticDiagnostics(boundSource),
  };
}

function scanSource(
  relativeFile: string,
  content: string,
  resolution: Exclude<MigrationResolution, { status: "unmapped" }>,
): Finding[] {
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
      const constructedAt = rootSymbol ? clients.get(rootSymbol) : undefined;
      if (
        chain &&
        chain.segments.length === 4 &&
        constructedAt !== undefined &&
        node.getStart(sourceFile) > constructedAt &&
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
    const resolution = resolveMigrationPath(
      request.migrationEdges,
      { kind: "model", id: SOURCE_MODEL },
      "typescript",
    );
    if (resolution.status === "unmapped") {
      throw new AnalysisError(`No locked TypeScript migration edge exists for ${SOURCE_MODEL}.`);
    }

    const extensions = new Set<string>(this.extensions);
    let files: string[];
    try {
      files = await listRepositoryFiles(request.repositoryRoot, extensions);
    } catch (error) {
      throw new AnalysisError("Unable to enumerate candidate TypeScript files.", { cause: error });
    }
    const findings = await Promise.all(
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
        if (!content.includes(SOURCE_MODEL)) {
          return [];
        }
        return scanSource(relativeFile, content, resolution);
      }),
    );
    const normalizedFindings = findings.flat();
    return {
      findings: normalizedFindings,
      graphIssues: normalizedFindings.length > 0 && resolution.issue ? [resolution.issue] : [],
    };
  }
}
