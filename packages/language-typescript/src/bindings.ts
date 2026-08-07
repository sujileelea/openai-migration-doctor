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
  importPattern: Extract<AnalysisPattern, "commonjs" | "direct" | "import-alias">;
};

export type PropertyChain = {
  root: ts.Identifier;
  segments: string[];
};

function scriptKindFor(file: string): ts.ScriptKind {
  switch (path.extname(file)) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

export function createBoundSource(relativeFile: string, content: string): BoundSource {
  const fileName = path.resolve("/migration-doctor-input", relativeFile);
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
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
): Map<ts.Symbol, Extract<AnalysisPattern, "commonjs" | "direct" | "import-alias">> {
  const constructors = new Map<
    ts.Symbol,
    Extract<AnalysisPattern, "commonjs" | "direct" | "import-alias">
  >();
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

  if (!hasLocalRequireBinding(sourceFile)) {
    for (const statement of sourceFile.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        !isConstDeclarationList(statement.declarationList)
      ) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        const requireKind = openAiRequireKind(declaration.initializer);
        if (!requireKind) {
          continue;
        }
        if (ts.isIdentifier(declaration.name)) {
          const symbol = checker.getSymbolAtLocation(declaration.name);
          if (symbol) {
            constructors.set(symbol, "commonjs");
          }
          continue;
        }
        if (ts.isObjectBindingPattern(declaration.name) && requireKind === "namespace") {
          for (const element of declaration.name.elements) {
            const importedName =
              element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
            if (
              element.dotDotDotToken ||
              importedName !== "OpenAI" ||
              !ts.isIdentifier(element.name)
            ) {
              continue;
            }
            const symbol = checker.getSymbolAtLocation(element.name);
            if (symbol) {
              constructors.set(symbol, "commonjs");
            }
          }
        }
      }
    }
  }
  return constructors;
}

function isConstDeclarationList(node: ts.VariableDeclarationList): boolean {
  return (node.flags & ts.NodeFlags.Const) !== 0;
}

function isOpenAiRequireCall(node: ts.Expression | undefined): node is ts.CallExpression {
  if (!node || !ts.isCallExpression(node)) {
    return false;
  }
  const argument = node.arguments[0];
  return Boolean(
    ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      argument &&
      ts.isStringLiteral(argument) &&
      argument.text === "openai",
  );
}

function openAiRequireKind(
  node: ts.Expression | undefined,
): "constructor" | "namespace" | undefined {
  if (!node) {
    return undefined;
  }
  if (isOpenAiRequireCall(node)) {
    return "namespace";
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    (node.name.text === "default" || node.name.text === "OpenAI") &&
    isOpenAiRequireCall(node.expression)
  ) {
    return "constructor";
  }
  return undefined;
}

function hasLocalRequireBinding(sourceFile: ts.SourceFile): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) {
      return;
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === "require"
    ) {
      found = true;
      return;
    }
    if (ts.isImportDeclaration(node) && node.importClause?.name?.text === "require") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
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
  constructors: Map<ts.Symbol, Extract<AnalysisPattern, "commonjs" | "direct" | "import-alias">>,
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
