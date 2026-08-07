import { canonicalJson, type Finding, type ScanResult, sha256 } from "@migration-doctor/core";
import type { BenchmarkFindingLabel, TypeScriptBenchmarkFixture } from "./corpus.js";

type ScoredFindingLabel = BenchmarkFindingLabel & {
  contract: {
    automationTier: Finding["automationTier"];
    confidence: Finding["confidence"];
    endOffset: number;
    fileHash: string;
    graphIssueIds: string[];
    kind: Finding["kind"];
    language: Finding["language"];
    line: number;
    column: number;
    migrationEdgeIds: string[];
    remediation: Finding["remediation"];
    resource: { kind: Finding["resource"]["kind"]; id: string };
    reviewRequired: boolean;
    ruleId: string;
    severity: Finding["severity"];
    startOffset: number;
  };
};

export type ClassificationMetrics = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
};

export type AccuracyMetrics = {
  fixtures: number;
  expectedFindings: number;
  actualFindings: number;
  negativeControls: number;
  trueNegativeControls: number;
  falsePositiveFixtures: number;
  overall: ClassificationMetrics;
  supported: ClassificationMetrics;
  abstentions: ClassificationMetrics;
  mismatches: {
    falsePositives: Array<{ relativeFile: string; label: ScoredFindingLabel }>;
    falseNegatives: Array<{ relativeFile: string; label: ScoredFindingLabel }>;
  };
};

const MODEL_EDGE_ID = "openai.model.gpt-4o-mini-transcribe-2025-03-20.to.2025-12-15";
const MODEL_RULE_ID = "openai.transcriptions.model.gpt-4o-mini-transcribe-2025-03-20";
const MODEL_SOURCE = "gpt-4o-mini-transcribe-2025-03-20";
const MODEL_TARGET = "gpt-4o-mini-transcribe-2025-12-15";
const ASSISTANTS_EDGE_ID = "openai.product.assistants-api.to.responses-and-conversations";

function labelKey(relativeFile: string, label: ScoredFindingLabel): string {
  return canonicalJson({ relativeFile, ...label }).trimEnd();
}

function sourcePosition(source: string, startOffset: number): { line: number; column: number } {
  const lineStart = source.lastIndexOf("\n", startOffset - 1);
  return {
    line: source.slice(0, startOffset).split("\n").length,
    column: startOffset - lineStart,
  };
}

function expectedKey(fixture: TypeScriptBenchmarkFixture, label: BenchmarkFindingLabel): string {
  const startOffset = fixture.source.lastIndexOf(label.evidence);
  if (startOffset < 0) {
    throw new TypeError(
      `Benchmark evidence is missing from ${fixture.relativeFile}: ${label.evidence}`,
    );
  }
  const location = sourcePosition(fixture.source, startOffset);
  const modelFinding = label.family === "model-snapshot";
  const coreAssistantsFeature = ["assistants", "threads", "runs"].includes(label.feature);
  return labelKey(fixture.relativeFile, {
    ...label,
    contract: {
      automationTier: modelFinding ? "A" : "C",
      confidence: label.disposition === "supported" ? "high" : "medium",
      startOffset,
      endOffset: startOffset + label.evidence.length,
      fileHash: sha256(fixture.source),
      graphIssueIds: [],
      kind: modelFinding
        ? "deprecated-usage"
        : label.disposition === "supported"
          ? "analysis-only"
          : "unsupported-pattern",
      language: "typescript",
      line: location.line,
      column: location.column,
      migrationEdgeIds: [modelFinding ? MODEL_EDGE_ID : ASSISTANTS_EDGE_ID],
      remediation: modelFinding
        ? { kind: "replace-string-literal", replacement: MODEL_TARGET }
        : { kind: "none" },
      resource: modelFinding
        ? { kind: "model", id: MODEL_SOURCE }
        : { kind: "product", id: "assistants-api" },
      reviewRequired: true,
      ruleId: modelFinding
        ? MODEL_RULE_ID
        : coreAssistantsFeature
          ? `openai.assistants.api.${label.feature}`
          : `openai.assistants.feature.${label.feature}`,
      severity: modelFinding || coreAssistantsFeature ? "error" : "warning",
    },
  });
}

function findingKey(finding: Finding): string {
  return labelKey(finding.location.file, {
    family: finding.analysis.family,
    feature: finding.analysis.feature,
    pattern: finding.analysis.pattern,
    disposition: finding.analysis.disposition,
    evidence: finding.evidence,
    ...(finding.analysis.reasonCode ? { reasonCode: finding.analysis.reasonCode } : {}),
    contract: {
      automationTier: finding.automationTier,
      confidence: finding.confidence,
      startOffset: finding.location.startOffset,
      endOffset: finding.location.endOffset,
      fileHash: finding.fileHash,
      graphIssueIds: finding.graphIssueIds,
      kind: finding.kind,
      language: finding.language,
      line: finding.location.line,
      column: finding.location.column,
      migrationEdgeIds: finding.migrationEdgeIds,
      remediation: finding.remediation,
      resource: { kind: finding.resource.kind, id: finding.resource.id },
      reviewRequired: finding.reviewRequired,
      ruleId: finding.ruleId,
      severity: finding.severity,
    },
  });
}

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function metric(expected: readonly string[], actual: readonly string[]): ClassificationMetrics {
  const expectedCounts = counts(expected);
  const actualCounts = counts(actual);
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const key of new Set([...expectedCounts.keys(), ...actualCounts.keys()])) {
    const expectedCount = expectedCounts.get(key) ?? 0;
    const actualCount = actualCounts.get(key) ?? 0;
    truePositives += Math.min(expectedCount, actualCount);
    falsePositives += Math.max(0, actualCount - expectedCount);
    falseNegatives += Math.max(0, expectedCount - actualCount);
  }
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision:
      truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives),
    recall:
      truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives),
  };
}

function expandDifference(
  primary: ReadonlyMap<string, number>,
  secondary: ReadonlyMap<string, number>,
): Array<{ relativeFile: string; label: ScoredFindingLabel }> {
  const result: Array<{ relativeFile: string; label: ScoredFindingLabel }> = [];
  for (const key of [...primary.keys()].sort()) {
    const difference = (primary.get(key) ?? 0) - (secondary.get(key) ?? 0);
    if (difference <= 0) continue;
    const parsed = JSON.parse(key) as { relativeFile: string } & ScoredFindingLabel;
    const { relativeFile, ...label } = parsed;
    for (let index = 0; index < difference; index += 1) result.push({ relativeFile, label });
  }
  return result;
}

export function measureAccuracy(
  fixtures: readonly TypeScriptBenchmarkFixture[],
  scan: ScanResult,
): AccuracyMetrics {
  const expected = fixtures.flatMap((fixture) =>
    fixture.expectedFindings.map((label) => expectedKey(fixture, label)),
  );
  const actual = scan.findings.map(findingKey);
  const expectedCounts = counts(expected);
  const actualCounts = counts(actual);
  const expectedSupported = fixtures.flatMap((fixture) =>
    fixture.expectedFindings
      .filter((label) => label.disposition === "supported")
      .map((label) => expectedKey(fixture, label)),
  );
  const actualSupported = scan.findings
    .filter((finding) => finding.analysis.disposition === "supported")
    .map(findingKey);
  const expectedAbstentions = fixtures.flatMap((fixture) =>
    fixture.expectedFindings
      .filter((label) => label.disposition === "abstained")
      .map((label) => expectedKey(fixture, label)),
  );
  const actualAbstentions = scan.findings
    .filter((finding) => finding.analysis.disposition === "abstained")
    .map(findingKey);
  const actualFiles = new Set(scan.findings.map((finding) => finding.location.file));
  const negativeFixtures = fixtures.filter((fixture) => fixture.expectedFindings.length === 0);
  const expectedFiles = new Set(
    fixtures
      .filter((fixture) => fixture.expectedFindings.length > 0)
      .map((fixture) => fixture.relativeFile),
  );

  return {
    fixtures: fixtures.length,
    expectedFindings: expected.length,
    actualFindings: actual.length,
    negativeControls: negativeFixtures.length,
    trueNegativeControls: negativeFixtures.filter(
      (fixture) => !actualFiles.has(fixture.relativeFile),
    ).length,
    falsePositiveFixtures: [...actualFiles].filter((file) => !expectedFiles.has(file)).length,
    overall: metric(expected, actual),
    supported: metric(expectedSupported, actualSupported),
    abstentions: metric(expectedAbstentions, actualAbstentions),
    mismatches: {
      falsePositives: expandDifference(actualCounts, expectedCounts),
      falseNegatives: expandDifference(expectedCounts, actualCounts),
    },
  };
}
