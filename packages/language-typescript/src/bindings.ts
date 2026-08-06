import path from "node:path";
import type { AnalysisPattern } from "@migration-doctor/core";
import ts from "typescript";

export type BoundSource = {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  diagnostics: readonly ts.Diagnostic[];
};

export type OpenAiClientBinding = {
  constructedAt: number;
  importPattern: Extract<AnalysisPattern, "direct" | "import-alias">;
};

export type PropertyChain = {
  root: ts.Identifier;
  segments: string[];
};

function scriptKindFor(file: string): ts.ScriptKind {
  return path.extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

export function createBoundSource(relativeFile: string, content: string): BoundSource {
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

export function collectOpenAiConstructors(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): Map<ts.Symbol, Extract<AnalysisPattern, "direct" | "import-alias">> {
  const constructors = new Map<ts.Symbol, Extract<AnalysisPattern, "direct" | "import-alias">>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "openai" ||
      !statement.importClause ||
      statement.importClause.isTypeOnly
    ) {
      continue;
    }

    const defaultImport = statement.importClause.name;
    if (defaultImport) {
      const symbol = checker.getSymbolAtLocation(defaultImport);
      if (symbol) {
        constructors.set(symbol, defaultImport.text === "OpenAI" ? "direct" : "import-alias");
      }
    }

    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (element.isTypeOnly || importedName !== "OpenAI") {
          continue;
        }
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol) {
          constructors.set(symbol, element.name.text === "OpenAI" ? "direct" : "import-alias");
        }
      }
    }
  }
  return constructors;
}

export function collectOpenAiTypeSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): Set<ts.Symbol> {
  const types = new Set<ts.Symbol>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "openai" ||
      !statement.importClause
    ) {
      continue;
    }

    const defaultImport = statement.importClause.name;
    const defaultSymbol = defaultImport ? checker.getSymbolAtLocation(defaultImport) : undefined;
    if (defaultSymbol) {
      types.add(defaultSymbol);
    }

    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName !== "OpenAI") {
          continue;
        }
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol) {
          types.add(symbol);
        }
      }
    }
  }
  return types;
}

export function collectOpenAiClients(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  constructors: Map<ts.Symbol, Extract<AnalysisPattern, "direct" | "import-alias">>,
): Map<ts.Symbol, OpenAiClientBinding> {
  const clients = new Map<ts.Symbol, OpenAiClientBinding>();

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression)
    ) {
      const constructorSymbol = checker.getSymbolAtLocation(node.initializer.expression);
      const importPattern = constructorSymbol ? constructors.get(constructorSymbol) : undefined;
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol && importPattern) {
        clients.set(symbol, { constructedAt: node.getEnd(), importPattern });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return clients;
}

export function propertyChain(expression: ts.Expression): PropertyChain | null {
  if (ts.isIdentifier(expression)) {
    return { root: expression, segments: [expression.text] };
  }
  if (!ts.isPropertyAccessExpression(expression) || expression.questionDotToken) {
    return null;
  }
  const prefix = propertyChain(expression.expression);
  return prefix
    ? { root: prefix.root, segments: [...prefix.segments, expression.name.text] }
    : null;
}
