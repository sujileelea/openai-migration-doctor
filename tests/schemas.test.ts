import {
  createPlanReport,
  FindingSchema,
  loadMigrationRegistry,
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
  it("uses the version 2 report contract independently of registry schema version 1", () => {
    expect(REPORT_SCHEMA_VERSION).toBe("2.0.0");
    expect(validScan.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(ScanResultSchema.safeParse({ ...validScan, schemaVersion: "1.0.0" }).success).toBe(
      false,
    );
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
});
