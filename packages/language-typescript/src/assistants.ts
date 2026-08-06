import {
  type AnalysisFeature,
  type AnalysisPattern,
  type Finding,
  type MigrationResolution,
  REPORT_SCHEMA_VERSION,
  type ResourceRef,
  sha256,
} from "@migration-doctor/core";
import ts from "typescript";
import type { OpenAiClientBinding } from "./bindings.js";
import { propertyChain } from "./bindings.js";

export const ASSISTANTS_RESOURCE: ResourceRef = {
  kind: "product",
  id: "assistants-api",
  displayName: "Assistants API",
};

type AssistantsResolution = Exclude<MigrationResolution, { status: "unmapped" }>;
type SupportedPattern = Extract<
  AnalysisPattern,
  "direct" | "import-alias" | "property-alias" | "client-alias"
>;

type ReceiverBinding = {
  segments: string[];
  availableAt: number;
  pattern: SupportedPattern | "wrapper";
};

type MethodAlias = {
  rule: MethodRule;
  availableAt: number;
};

type MethodRule = {
  features: AnalysisFeature[];
  requestIndex?: number;
  streaming?: boolean;
  tools?: boolean;
};

type FeatureResult = {
  feature: AnalysisFeature;
  disposition: "supported" | "abstained";
  pattern: AnalysisPattern;
  reasonCode?: string;
  reason: string;
};

const SUPPORTED_REASON =
  "Assistants API usage is confirmed, but Phase 3 does not transform stateful API integrations.";

const METHOD_RULES = new Map<string, MethodRule>([
  ["beta.assistants.create", { features: ["assistants"], requestIndex: 0 }],
  ["beta.assistants.retrieve", { features: ["assistants"] }],
  ["beta.assistants.update", { features: ["assistants"], requestIndex: 1 }],
  ["beta.assistants.list", { features: ["assistants"] }],
  ["beta.assistants.delete", { features: ["assistants"] }],
  ["beta.assistants.del", { features: ["assistants"] }],
  ["beta.threads.create", { features: ["threads"], requestIndex: 0 }],
  ["beta.threads.retrieve", { features: ["threads"] }],
  ["beta.threads.update", { features: ["threads"], requestIndex: 1 }],
  ["beta.threads.delete", { features: ["threads"] }],
  ["beta.threads.del", { features: ["threads"] }],
  ["beta.threads.createAndRun", { features: ["threads", "runs"], requestIndex: 0 }],
  ["beta.threads.createAndRunPoll", { features: ["threads", "runs"], requestIndex: 0 }],
  [
    "beta.threads.createAndRunStream",
    { features: ["threads", "runs"], requestIndex: 0, streaming: true },
  ],
  ["beta.threads.messages.create", { features: ["threads"], requestIndex: 1 }],
  ["beta.threads.messages.retrieve", { features: ["threads"] }],
  ["beta.threads.messages.update", { features: ["threads"], requestIndex: 1 }],
  ["beta.threads.messages.list", { features: ["threads"] }],
  ["beta.threads.messages.delete", { features: ["threads"] }],
  ["beta.threads.messages.del", { features: ["threads"] }],
  ["beta.threads.runs.create", { features: ["threads", "runs"], requestIndex: 1 }],
  ["beta.threads.runs.retrieve", { features: ["threads", "runs"] }],
  ["beta.threads.runs.update", { features: ["threads", "runs"] }],
  ["beta.threads.runs.list", { features: ["threads", "runs"] }],
  ["beta.threads.runs.cancel", { features: ["threads", "runs"] }],
  ["beta.threads.runs.createAndPoll", { features: ["threads", "runs"], requestIndex: 1 }],
  [
    "beta.threads.runs.createAndStream",
    { features: ["threads", "runs"], requestIndex: 1, streaming: true },
  ],
  ["beta.threads.runs.poll", { features: ["threads", "runs"] }],
  ["beta.threads.runs.stream", { features: ["threads", "runs"], requestIndex: 1, streaming: true }],
  ["beta.threads.runs.submitToolOutputs", { features: ["threads", "runs"], tools: true }],
  ["beta.threads.runs.submitToolOutputsAndPoll", { features: ["threads", "runs"], tools: true }],
  [
    "beta.threads.runs.submitToolOutputsStream",
    { features: ["threads", "runs"], streaming: true, tools: true },
  ],
  ["beta.threads.runs.steps.retrieve", { features: ["threads", "runs"] }],
  ["beta.threads.runs.steps.list", { features: ["threads", "runs"] }],
]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(node: ts.PropertyName): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

type DirectProperty =
  | { status: "missing" }
  | { status: "dynamic" }
  | { status: "found"; value: ts.Expression };

function directProperty(object: ts.ObjectLiteralExpression, name: string): DirectProperty {
  let value: ts.Expression | undefined;
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member) || ts.isComputedPropertyName(member.name)) {
      return { status: "dynamic" };
    }
    if (propertyName(member.name) !== name) {
      continue;
    }
    if (value || !ts.isPropertyAssignment(member)) {
      return { status: "dynamic" };
    }
    value = member.initializer;
  }
  return value ? { status: "found", value } : { status: "missing" };
}

function isStaticObject(object: ts.ObjectLiteralExpression): boolean {
  const names = new Set<string>();
  for (const member of object.properties) {
    if (
      ts.isSpreadAssignment(member) ||
      ts.isComputedPropertyName(member.name) ||
      !ts.isPropertyAssignment(member)
    ) {
      return false;
    }
    const name = propertyName(member.name);
    if (name === null || names.has(name)) {
      return false;
    }
    names.add(name);
  }
  return true;
}

function addSupportedFeature(
  results: FeatureResult[],
  feature: AnalysisFeature,
  pattern: AnalysisPattern,
): void {
  if (!results.some((result) => result.feature === feature && result.disposition === "supported")) {
    results.push({
      feature,
      disposition: "supported",
      pattern,
      reasonCode: "manual-migration-required",
      reason: SUPPORTED_REASON,
    });
  }
}

function addAbstainedFeature(
  results: FeatureResult[],
  feature: AnalysisFeature,
  pattern: AnalysisPattern,
  reasonCode: string,
  reason: string,
): void {
  if (
    !results.some(
      (result) =>
        result.feature === feature &&
        result.disposition === "abstained" &&
        result.reasonCode === reasonCode,
    )
  ) {
    results.push({ feature, disposition: "abstained", pattern, reasonCode, reason });
  }
}

function collectToolFeatures(
  request: ts.ObjectLiteralExpression,
  pattern: AnalysisPattern,
  results: FeatureResult[],
): void {
  const tools = directProperty(request, "tools");
  if (tools.status === "dynamic") {
    addAbstainedFeature(
      results,
      "tools",
      "dynamic-request",
      "dynamic-tools",
      "Tool configuration uses a spread, computed key, duplicate key, or unsupported property form.",
    );
  } else if (tools.status === "found") {
    const value = unwrapExpression(tools.value);
    if (!ts.isArrayLiteralExpression(value)) {
      addAbstainedFeature(
        results,
        "tools",
        "dynamic-request",
        "dynamic-tools",
        "Tool configuration is not an inline array literal.",
      );
    } else if (value.elements.length > 0) {
      let allToolTypesKnown = true;
      const knownTypes = new Set<string>();
      for (const element of value.elements) {
        const candidate = unwrapExpression(element);
        if (!ts.isObjectLiteralExpression(candidate) || !isStaticObject(candidate)) {
          allToolTypesKnown = false;
          continue;
        }
        const type = directProperty(candidate, "type");
        if (type.status !== "found") {
          allToolTypesKnown = false;
          continue;
        }
        const typeValue = unwrapExpression(type.value);
        if (!ts.isStringLiteral(typeValue)) {
          allToolTypesKnown = false;
          continue;
        }
        knownTypes.add(typeValue.text);
      }

      if (allToolTypesKnown) {
        addSupportedFeature(results, "tools", pattern);
      } else {
        addAbstainedFeature(
          results,
          "tools",
          "dynamic-request",
          "dynamic-tools",
          "At least one tool type cannot be determined from an inline string literal.",
        );
      }
      if (knownTypes.has("file_search")) {
        addSupportedFeature(results, "file-search", pattern);
      }
      if (knownTypes.has("code_interpreter")) {
        addSupportedFeature(results, "code-interpreter", pattern);
      }
    }
  }

  const resources = directProperty(request, "tool_resources");
  if (resources.status === "dynamic") {
    addAbstainedFeature(
      results,
      "tools",
      "dynamic-request",
      "dynamic-tool-resources",
      "Tool resources use a spread, computed key, duplicate key, or unsupported property form.",
    );
  } else if (resources.status === "found") {
    const value = unwrapExpression(resources.value);
    if (!ts.isObjectLiteralExpression(value) || !isStaticObject(value)) {
      addAbstainedFeature(
        results,
        "tools",
        "dynamic-request",
        "dynamic-tool-resources",
        "Tool resources are not an inline object literal.",
      );
    } else {
      const fileSearch = directProperty(value, "file_search");
      const codeInterpreter = directProperty(value, "code_interpreter");
      if (fileSearch.status === "found") {
        addSupportedFeature(results, "tools", pattern);
        addSupportedFeature(results, "file-search", pattern);
      }
      if (codeInterpreter.status === "found") {
        addSupportedFeature(results, "tools", pattern);
        addSupportedFeature(results, "code-interpreter", pattern);
      }
    }
  }
}

function methodFeatures(
  call: ts.CallExpression,
  rule: MethodRule,
  pattern: SupportedPattern,
): FeatureResult[] {
  const results: FeatureResult[] = [];
  const requestArgument =
    rule.requestIndex === undefined ? undefined : call.arguments[rule.requestIndex];
  let request: ts.ObjectLiteralExpression | undefined;

  for (const feature of rule.features) {
    addSupportedFeature(results, feature, pattern);
  }
  if (rule.streaming) {
    addSupportedFeature(results, "streaming", pattern);
  }
  if (rule.tools) {
    addSupportedFeature(results, "tools", pattern);
  }

  if (rule.requestIndex !== undefined && requestArgument) {
    const candidate = unwrapExpression(requestArgument);
    if (!ts.isObjectLiteralExpression(candidate)) {
      return results;
    }
    request = candidate;
  }

  if (request) {
    const stream = directProperty(request, "stream");
    if (stream.status === "dynamic") {
      addAbstainedFeature(
        results,
        "streaming",
        "dynamic-request",
        "dynamic-stream",
        "Streaming configuration uses a spread, computed key, duplicate key, or unsupported property form.",
      );
    } else if (stream.status === "found") {
      const value = unwrapExpression(stream.value);
      if (value.kind === ts.SyntaxKind.TrueKeyword) {
        addSupportedFeature(results, "streaming", pattern);
      } else if (value.kind !== ts.SyntaxKind.FalseKeyword) {
        addAbstainedFeature(
          results,
          "streaming",
          "dynamic-request",
          "dynamic-stream",
          "The streaming flag is not a boolean literal.",
        );
      }
    }
    collectToolFeatures(request, pattern, results);
  }

  return results;
}

function staticRuleFeatures(rule: MethodRule): AnalysisFeature[] {
  return [
    ...rule.features,
    ...(rule.streaming ? (["streaming"] as const) : []),
    ...(rule.tools ? (["tools"] as const) : []),
  ];
}

function resolveReceiverChain(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  receivers: Map<ts.Symbol, ReceiverBinding>,
  useAt: number,
): { path: string[]; pattern: ReceiverBinding["pattern"] } | null {
  const chain = propertyChain(expression);
  if (!chain) {
    return null;
  }
  const symbol = checker.getSymbolAtLocation(chain.root);
  const binding = symbol ? receivers.get(symbol) : undefined;
  if (!binding || useAt <= binding.availableAt) {
    return null;
  }
  return {
    path: [...binding.segments, ...chain.segments.slice(1)],
    pattern: binding.pattern,
  };
}

function isAssistantsPrefix(path: readonly string[]): boolean {
  return path[0] === "beta" && (path[1] === "assistants" || path[1] === "threads");
}

function featuresForPrefix(path: readonly string[]): AnalysisFeature[] {
  if (path[1] === "assistants") {
    return ["assistants"];
  }
  return path.includes("runs") ? ["threads", "runs"] : ["threads"];
}

type LooseChain = {
  root: ts.Identifier;
  segments: string[];
  computed: boolean;
  optional: boolean;
};

function looseChain(expression: ts.Expression): LooseChain | null {
  if (ts.isIdentifier(expression)) {
    return { root: expression, segments: [expression.text], computed: false, optional: false };
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const prefix = looseChain(expression.expression);
    return prefix
      ? {
          ...prefix,
          segments: [...prefix.segments, expression.name.text],
          optional: prefix.optional || Boolean(expression.questionDotToken),
        }
      : null;
  }
  if (ts.isElementAccessExpression(expression)) {
    const prefix = looseChain(expression.expression);
    if (!prefix) {
      return null;
    }
    const argument = expression.argumentExpression;
    return {
      ...prefix,
      segments: [
        ...prefix.segments,
        argument && ts.isStringLiteral(argument) ? argument.text : "*",
      ],
      computed: true,
      optional: prefix.optional || Boolean(expression.questionDotToken),
    };
  }
  return null;
}

function typeRefersToConstructor(
  type: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  openAiTypes: ReadonlySet<ts.Symbol>,
): boolean {
  if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(type.typeName);
  return Boolean(symbol && openAiTypes.has(symbol));
}

function collectReceivers(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  clients: ReadonlyMap<ts.Symbol, OpenAiClientBinding>,
  openAiTypes: ReadonlySet<ts.Symbol>,
): { receivers: Map<ts.Symbol, ReceiverBinding>; methods: Map<ts.Symbol, MethodAlias> } {
  const receivers = new Map<ts.Symbol, ReceiverBinding>();
  const methods = new Map<ts.Symbol, MethodAlias>();
  for (const [symbol, client] of clients) {
    receivers.set(symbol, {
      segments: [],
      availableAt: client.constructedAt,
      pattern: client.importPattern,
    });
  }

  function registerWrapperParameters(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      for (const parameter of node.parameters) {
        if (
          !ts.isIdentifier(parameter.name) ||
          !typeRefersToConstructor(parameter.type, checker, openAiTypes)
        ) {
          continue;
        }
        const symbol = checker.getSymbolAtLocation(parameter.name);
        if (symbol) {
          receivers.set(symbol, { segments: [], availableAt: -1, pattern: "wrapper" });
        }
      }
    }
    ts.forEachChild(node, registerWrapperParameters);
  }
  registerWrapperParameters(sourceFile);

  const declarations: ts.VariableDeclaration[] = [];
  function collectDeclarations(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
      node.initializer
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(sourceFile);
  declarations.sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile));

  for (const declaration of declarations) {
    const initializer = unwrapExpression(declaration.initializer as ts.Expression);
    const resolved = resolveReceiverChain(
      initializer,
      checker,
      receivers,
      declaration.getStart(sourceFile),
    );
    if (!resolved) {
      continue;
    }
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol) {
      continue;
    }
    const rule = METHOD_RULES.get(resolved.path.join("."));
    if (rule) {
      methods.set(symbol, { rule, availableAt: declaration.getEnd() });
      continue;
    }
    if (
      resolved.path.length === 0 ||
      resolved.path[0] === "beta" ||
      isAssistantsPrefix(resolved.path)
    ) {
      receivers.set(symbol, {
        segments: resolved.path,
        availableAt: declaration.getEnd(),
        pattern:
          resolved.pattern === "wrapper"
            ? "wrapper"
            : resolved.path.length === 0
              ? "client-alias"
              : "property-alias",
      });
    }
  }

  return { receivers, methods };
}

function createFindings(
  relativeFile: string,
  content: string,
  sourceFile: ts.SourceFile,
  callee: ts.Expression,
  resolution: AssistantsResolution,
  results: FeatureResult[],
): Finding[] {
  const startOffset = callee.getStart(sourceFile);
  const endOffset = callee.getEnd();
  const position = sourceFile.getLineAndCharacterOfPosition(startOffset);
  const evidence = callee.getText(sourceFile);
  const fileHash = sha256(content);

  return results.map((result) => {
    const ruleId =
      result.feature === "assistants" || result.feature === "threads" || result.feature === "runs"
        ? `openai.assistants.api.${result.feature}`
        : `openai.assistants.feature.${result.feature}`;
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      id: sha256(
        [
          ruleId,
          result.pattern,
          result.reasonCode ?? "",
          resolution.edgeIds.join("\u0001"),
          relativeFile,
          startOffset,
          endOffset,
        ].join("\u0000"),
      ),
      kind: result.disposition === "supported" ? "analysis-only" : "unsupported-pattern",
      language: "typescript",
      resource: ASSISTANTS_RESOURCE,
      ruleId,
      severity:
        result.feature === "assistants" || result.feature === "threads" || result.feature === "runs"
          ? "error"
          : "warning",
      location: {
        file: relativeFile,
        line: position.line + 1,
        column: position.character + 1,
        startOffset,
        endOffset,
      },
      fileHash,
      evidence,
      migrationEdgeIds: resolution.edgeIds,
      graphIssueIds: resolution.issue ? [resolution.issue.id] : [],
      confidence: result.disposition === "supported" ? "high" : "medium",
      automationTier: "C",
      reviewRequired: true,
      analysis: {
        family: "assistants-api",
        feature: result.feature,
        pattern: result.pattern,
        disposition: result.disposition,
        ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
      },
      abstentionReason: result.reason,
      remediation: { kind: "none" },
    } satisfies Finding;
  });
}

export function scanAssistantsSource(
  relativeFile: string,
  content: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  clients: ReadonlyMap<ts.Symbol, OpenAiClientBinding>,
  openAiTypes: ReadonlySet<ts.Symbol>,
  resolution?: AssistantsResolution,
): { findings: Finding[]; matched: boolean } {
  const { receivers, methods } = collectReceivers(sourceFile, checker, clients, openAiTypes);
  const findings: Finding[] = [];
  let matched = false;

  function emit(callee: ts.Expression, results: FeatureResult[]): void {
    if (results.length === 0) {
      return;
    }
    matched = true;
    if (!resolution) {
      return;
    }
    findings.push(
      ...createFindings(relativeFile, content, sourceFile, callee, resolution, results),
    );
  }

  function visit(node: ts.Node): void {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const alias = symbol ? methods.get(symbol) : undefined;
      if (alias && node.getStart(sourceFile) > alias.availableAt) {
        emit(
          node.expression,
          staticRuleFeatures(alias.rule).map((feature) => ({
            feature,
            disposition: "abstained",
            pattern: "method-alias",
            reasonCode: "method-alias",
            reason: "An Assistants API method is invoked through a detached local alias.",
          })),
        );
        ts.forEachChild(node, visit);
        return;
      }
    }

    const exact = resolveReceiverChain(
      node.expression,
      checker,
      receivers,
      node.getStart(sourceFile),
    );
    if (exact) {
      const path = exact.path.join(".");
      const rule = METHOD_RULES.get(path);
      if (rule) {
        if (exact.pattern === "wrapper") {
          emit(
            node.expression,
            staticRuleFeatures(rule).map((feature) => ({
              feature,
              disposition: "abstained",
              pattern: "wrapper",
              reasonCode: "wrapper-parameter",
              reason:
                "The Assistants API receiver is a wrapper parameter rather than a locally constructed client.",
            })),
          );
        } else {
          emit(node.expression, methodFeatures(node, rule, exact.pattern));
        }
        ts.forEachChild(node, visit);
        return;
      }

      const indirect = ["call", "apply", "bind"].includes(exact.path.at(-1) ?? "")
        ? METHOD_RULES.get(exact.path.slice(0, -1).join("."))
        : undefined;
      if (indirect) {
        emit(
          node.expression,
          staticRuleFeatures(indirect).map((feature) => ({
            feature,
            disposition: "abstained",
            pattern: "indirect-invocation",
            reasonCode: "indirect-invocation",
            reason: "An Assistants API method is invoked through call, apply, or bind.",
          })),
        );
      } else if (isAssistantsPrefix(exact.path)) {
        emit(
          node.expression,
          featuresForPrefix(exact.path).map((feature) => ({
            feature,
            disposition: "abstained",
            pattern: "dynamic-member",
            reasonCode: "unsupported-method",
            reason:
              "The OpenAI client uses an Assistants API method outside the reviewed allowlist.",
          })),
        );
      }
      ts.forEachChild(node, visit);
      return;
    }

    const loose = looseChain(node.expression);
    if (loose) {
      const symbol = checker.getSymbolAtLocation(loose.root);
      const receiver = symbol ? receivers.get(symbol) : undefined;
      if (receiver && node.getStart(sourceFile) > receiver.availableAt) {
        const path = [...receiver.segments, ...loose.segments.slice(1)];
        if (isAssistantsPrefix(path)) {
          const reasonCode = loose.optional ? "optional-member-access" : "computed-member-access";
          emit(
            node.expression,
            featuresForPrefix(path).map((feature) => ({
              feature,
              disposition: "abstained",
              pattern: "dynamic-member",
              reasonCode,
              reason: loose.optional
                ? "The Assistants API call uses optional member access."
                : "The Assistants API call uses computed member access.",
            })),
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { findings, matched };
}
