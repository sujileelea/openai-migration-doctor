import {
  createPlanReport,
  FindingSchema,
  loadMigrationRegistry,
  ManualActionSchema,
  PatchPlanSchema,
  REPORT_SCHEMA_VERSION,
  ScanResultSchema,
  scanRepository,
} from "@migration-doctor/core";
import { TypeScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, PROJECT_ROOT } from "./helpers.js";

let validScan: Awaited<ReturnType<typeof scanRepository>>;

beforeAll(async () => {
  const registry = await loadMigrationRegistry(PROJECT_ROOT);
  validScan = await scanRepository({
    repositoryRoot: fixturePath("direct-model-literal"),
    registry,
    adapters: [new TypeScriptLanguageAdapter()],
  });
});

describe("serialized schema invariants", () => {
  it("uses the version 3 report contract independently of registry schema version 1", () => {
    expect(REPORT_SCHEMA_VERSION).toBe("3.0.0");
    expect(validScan.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(ScanResultSchema.safeParse({ ...validScan, schemaVersion: "1.0.0" }).success).toBe(
      false,
    );
  });

  it("requires a structured analysis classification on every finding", () => {
    const finding = validScan.findings[0];
    expect(finding).toBeDefined();
    if (!finding) {
      return;
    }

    const { analysis: _analysis, ...withoutAnalysis } = finding;
    expect(FindingSchema.safeParse(withoutAnalysis).success).toBe(false);
    expect(finding.analysis).toEqual({
      family: "model-snapshot",
      feature: "model-snapshot",
      pattern: "direct",
      disposition: "supported",
    });
  });

  it("accepts supported analysis-only findings without a remediation", () => {
    const finding = validScan.findings[0];
    expect(finding).toBeDefined();

    expect(
      FindingSchema.safeParse({
        ...finding,
        kind: "analysis-only",
        automationTier: "C",
        reviewRequired: true,
        analysis: {
          family: "assistants-api",
          feature: "runs",
          pattern: "direct",
          disposition: "supported",
          reasonCode: "manual-migration-required",
        },
        abstentionReason: "Run orchestration requires a manual migration.",
        remediation: { kind: "none" },
      }).success,
    ).toBe(true);
  });

  it("requires unsupported patterns to abstain with a stable reason code", () => {
    const finding = validScan.findings[0];
    expect(finding).toBeDefined();
    const unsupported = {
      ...finding,
      kind: "unsupported-pattern",
      automationTier: "C",
      reviewRequired: true,
      analysis: {
        family: "assistants-api",
        feature: "runs",
        pattern: "dynamic-member",
        disposition: "abstained",
        reasonCode: "computed-member-access",
      },
      abstentionReason: "Computed SDK members cannot be classified safely.",
      remediation: { kind: "none" },
    };

    expect(FindingSchema.safeParse(unsupported).success).toBe(true);
    expect(
      FindingSchema.safeParse({
        ...unsupported,
        analysis: { ...unsupported.analysis, reasonCode: undefined },
      }).success,
    ).toBe(false);
    expect(
      FindingSchema.safeParse({
        ...unsupported,
        analysis: { ...unsupported.analysis, disposition: "supported" },
      }).success,
    ).toBe(false);
  });

  it("rejects a source-conflict finding that proposes a deterministic replacement", () => {
    const finding = validScan.findings[0];
    expect(finding).toBeDefined();

    expect(
      FindingSchema.safeParse({
        ...finding,
        kind: "source-conflict",
        automationTier: "A",
        graphIssueIds: [],
        reviewRequired: false,
      }).success,
    ).toBe(false);
  });

  it("requires an abstention reason when no remediation is available", () => {
    const finding = validScan.findings[0];
    expect(finding).toBeDefined();

    expect(
      FindingSchema.safeParse({
        ...finding,
        kind: "migration-blocked",
        automationTier: "C",
        remediation: { kind: "none" },
      }).success,
    ).toBe(false);
  });

  it("binds string-literal evidence to the detected model resource", () => {
    const finding = validScan.findings[0];
    expect(finding).toBeDefined();

    expect(
      FindingSchema.safeParse({
        ...finding,
        resource: { kind: "model", id: "different-model" },
      }).success,
    ).toBe(false);
  });

  it("rejects scan summaries that disagree with their normalized records", () => {
    expect(
      ScanResultSchema.safeParse({
        ...validScan,
        summary: { ...validScan.summary, total: validScan.summary.total + 1 },
      }).success,
    ).toBe(false);
  });

  it("rejects partial edits in a blocked patch plan", () => {
    const finding = validScan.findings[0];
    expect(finding).toBeDefined();
    if (!finding) {
      return;
    }

    const ready = createPlanReport(validScan).plan;
    expect(
      PatchPlanSchema.safeParse({
        ...ready,
        status: "blocked",
        abstentionReasons: [`${finding.id}: synthetic abstention`],
      }).success,
    ).toBe(false);
  });

  it("requires every manual action to have a stable reason code", () => {
    const finding = validScan.findings[0];
    const edge = validScan.migrationEdges[0];
    expect(finding).toBeDefined();
    expect(edge).toBeDefined();
    if (!finding || !edge) {
      return;
    }

    expect(
      ManualActionSchema.safeParse({
        findingId: finding.id,
        migrationEdgeIds: [edge.id],
        target: edge.to,
        reason: "Manual migration is required.",
        behaviorChanges: edge.behaviorChanges,
      }).success,
    ).toBe(false);
  });
});
