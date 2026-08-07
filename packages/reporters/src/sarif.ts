import {
  canonicalJson,
  type Finding,
  type MigrationEdge,
  type Report,
} from "@migration-doctor/core";

const SARIF_SCHEMA =
  "https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json";
const TOOL_VERSION = "0.1.0-alpha.1";

function findingsFor(report: Report): Finding[] {
  return "findings" in report ? report.findings : [];
}

function edgesFor(report: Report): MigrationEdge[] {
  return "migrationEdges" in report ? report.migrationEdges : report.selectedMigrationEdges;
}

function sarifLevel(severity: Finding["severity"]): "error" | "note" | "warning" {
  return severity === "info" ? "note" : severity;
}

function artifactUri(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

function edgeFor(finding: Finding, edges: MigrationEdge[]): MigrationEdge | undefined {
  const edgeIds = new Set(finding.migrationEdgeIds);
  return edges.find((edge) => edgeIds.has(edge.id));
}

function findingMessage(finding: Finding): string {
  const resource = `${finding.resource.kind}:${finding.resource.id}`;
  if (finding.abstentionReason) {
    return `${resource}: ${finding.abstentionReason}`;
  }
  if (finding.remediation.kind === "replace-string-literal") {
    return `${resource}: replace the deprecated value with ${finding.remediation.replacement}.`;
  }
  return `${resource}: review this OpenAI migration finding.`;
}

export function renderSarif(report: Report): string {
  const findings = findingsFor(report);
  const edges = edgesFor(report);
  const rules = new Map<string, Finding>();
  for (const finding of findings) {
    if (!rules.has(finding.ruleId)) {
      rules.set(finding.ruleId, finding);
    }
  }

  return canonicalJson({
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Migration Doctor for OpenAI APIs",
            informationUri: "https://github.com/sujileelea/openai-migration-doctor",
            semanticVersion: TOOL_VERSION,
            rules: [...rules.values()].map((finding) => {
              const edge = edgeFor(finding, edges);
              return {
                id: finding.ruleId,
                shortDescription: {
                  text: `OpenAI migration: ${finding.resource.id}`,
                },
                fullDescription: {
                  text: `Migration Doctor ${finding.analysis.disposition} finding for ${finding.resource.kind}:${finding.resource.id}.`,
                },
                helpUri: edge?.sources[0]?.url,
                properties: {
                  analysisFamily: finding.analysis.family,
                  automationTier: finding.automationTier,
                  confidence: finding.confidence,
                  reviewRequired: finding.reviewRequired,
                  tags: ["openai", "migration", finding.language],
                },
              };
            }),
          },
        },
        results: findings.map((finding) => ({
          ruleId: finding.ruleId,
          level: sarifLevel(finding.severity),
          message: { text: findingMessage(finding) },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: artifactUri(finding.location.file),
                  uriBaseId: "%SRCROOT%",
                },
                region: {
                  startLine: finding.location.line,
                  startColumn: finding.location.column,
                },
              },
            },
          ],
          properties: {
            analysisDisposition: finding.analysis.disposition,
            analysisFeature: finding.analysis.feature,
            analysisPattern: finding.analysis.pattern,
            automationTier: finding.automationTier,
            findingKind: finding.kind,
            migrationEdgeIds: finding.migrationEdgeIds,
            reviewRequired: finding.reviewRequired,
            sourceLockHash: report.sourceLockHash,
          },
        })),
      },
    ],
  });
}
