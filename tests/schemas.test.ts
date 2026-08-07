import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalJson,
  createPlanReport,
  createSemanticPatchPlan,
  FindingSchema,
  loadMigrationRegistry,
  ManualActionSchema,
  PatchPlanSchema,
  REPORT_SCHEMA_VERSION,
  ScanResultSchema,
  SEMANTIC_PLAN_SCHEMA_VERSION,
  SEMANTIC_VERIFICATION_CONTRACTS,
  SemanticPatchPlanSchema,
  scanRepository,
  sha256,
} from "@migration-doctor/core";
import { TypeScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, PROJECT_ROOT } from "./helpers.js";

let validScan: Awaited<ReturnType<typeof scanRepository>>;
let registry: Awaited<ReturnType<typeof loadMigrationRegistry>>;

function semanticScan() {
  const finding = validScan.findings[0];
  expect(finding).toBeDefined();
  if (!finding) {
    throw new Error("Expected the deterministic fixture to contain one finding.");
  }

  return ScanResultSchema.parse({
    ...validScan,
    repository: { revision: "a".repeat(40) },
    migrationEdges: validScan.migrationEdges.map((edge) => ({
      ...edge,
      automationTier: "B" as const,
      reviewRequired: true,
    })),
    findings: [
      {
        ...finding,
        kind: "migration-blocked" as const,
        automationTier: "B" as const,
        reviewRequired: true,
        abstentionReason: "The migration requires a semantic source change.",
        remediation: { kind: "none" as const },
      },
    ],
  });
}

function semanticPlanRequest() {
  const finding = validScan.findings[0];
  if (!finding) {
    throw new Error("Expected the deterministic fixture to contain one finding.");
  }
  return {
    sourceFiles: [{ path: "src/transcribe.ts", beforeHash: finding.fileHash }],
    forbiddenFiles: ["src/secrets.ts"],
    requiredFiles: ["src/transcribe.ts"],
    instructions: [
      "Replace the deprecated transcription request while preserving its response contract.",
    ],
    behaviorContractHash: "b".repeat(64),
    baselineObservationHash: "c".repeat(64),
  };
}

beforeAll(async () => {
  registry = await loadMigrationRegistry(PROJECT_ROOT);
  validScan = await scanRepository({
    repositoryRoot: fixturePath("direct-model-literal"),
    registry,
    adapters: [new TypeScriptLanguageAdapter()],
  });
});

describe("serialized schema invariants", () => {
  it("uses the version 3 report contract independently of registry schema version 1", () => {
    expect(REPORT_SCHEMA_VERSION).toBe("4.0.0");
    expect(SEMANTIC_PLAN_SCHEMA_VERSION).toBe("1.0.0");
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

  it("keeps deterministic patch plans byte-stable without a semantic scope", () => {
    const plan = createPlanReport(validScan).plan;

    expect(Object.hasOwn(plan, "semanticRemediation")).toBe(false);
    expect(canonicalJson(plan)).not.toContain("semanticRemediation");
    expect(plan.requiresCodex).toBe(false);
  });

  it("freezes a production-representable Tier B semantic remediation plan", () => {
    const scan = semanticScan();
    const plan = createSemanticPatchPlan(scan, semanticPlanRequest());
    const selectedEdges = scan.migrationEdges
      .filter((edge) => scan.findings[0]?.migrationEdgeIds.includes(edge.id))
      .sort((left, right) => left.id.localeCompare(right.id));

    expect(plan).toEqual({
      schemaVersion: SEMANTIC_PLAN_SCHEMA_VERSION,
      kind: "semantic-patch-plan",
      status: "ready",
      findingIds: [scan.findings[0]?.id],
      allowedFiles: ["src/transcribe.ts"],
      forbiddenFiles: ["src/secrets.ts"],
      sourceLockHash: scan.sourceLockHash,
      verificationContracts: [...SEMANTIC_VERIFICATION_CONTRACTS],
      requiresCodex: true,
      semanticRemediation: {
        repositoryRevision: "a".repeat(40),
        instructions: [
          "Replace the deprecated transcription request while preserving its response contract.",
        ],
        sourceFiles: [{ path: "src/transcribe.ts", beforeHash: scan.findings[0]?.fileHash }],
        requiredFiles: ["src/transcribe.ts"],
        migrationEdgeIds: scan.findings[0]?.migrationEdgeIds,
        migrationEdgesHash: sha256(canonicalJson(selectedEdges)),
        verificationAdapterIds: ["typescript"],
        semanticVerifier: {
          id: "typescript-transcription-model-exact-rewrite-v1",
          sourceModel: "gpt-4o-mini-transcribe-2025-03-20",
          targetModel: "gpt-4o-mini-transcribe-2025-12-15",
        },
        behaviorContractHash: "b".repeat(64),
        baselineObservationHash: "c".repeat(64),
      },
    });
  });

  it("turns an adapter-produced resolved Tier B scan into a ready semantic plan", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-semantic-plan-"));
    try {
      await cp(fixturePath("direct-model-literal"), repositoryRoot, { recursive: true });
      execFileSync("git", ["init", "--quiet", repositoryRoot]);
      execFileSync("git", ["-C", repositoryRoot, "add", "."]);
      execFileSync("git", [
        "-c",
        "user.name=Migration Doctor Tests",
        "-c",
        "user.email=migration-doctor@example.invalid",
        "-C",
        repositoryRoot,
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ]);

      const tierBRegistry = {
        ...registry,
        edges: registry.edges.map((edge) =>
          edge.from.kind === "model" && edge.from.id === "gpt-4o-mini-transcribe-2025-03-20"
            ? { ...edge, automationTier: "B" as const, reviewRequired: true }
            : edge,
        ),
      };
      const scan = await scanRepository({
        repositoryRoot,
        registry: tierBRegistry,
        adapters: [new TypeScriptLanguageAdapter()],
      });

      expect(scan.repository.revision).toMatch(/^[a-f0-9]{40}$/u);
      expect(scan.findings).toEqual([
        expect.objectContaining({
          kind: "migration-blocked",
          automationTier: "B",
          analysis: expect.objectContaining({ disposition: "supported" }),
          remediation: { kind: "none" },
        }),
      ]);
      expect(createSemanticPatchPlan(scan, semanticPlanRequest())).toMatchObject({
        status: "ready",
        requiresCodex: true,
        semanticRemediation: {
          repositoryRevision: scan.repository.revision,
          migrationEdgeIds: scan.findings[0]?.migrationEdgeIds,
        },
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("rejects nominal Codex flags and semantic scopes that are not internally bound", () => {
    const deterministic = createPlanReport(validScan).plan;
    expect(
      SemanticPatchPlanSchema.safeParse({ ...deterministic, requiresCodex: true }).success,
    ).toBe(false);

    const semantic = createSemanticPatchPlan(semanticScan(), semanticPlanRequest());
    expect(
      SemanticPatchPlanSchema.safeParse({
        ...semantic,
        allowedFiles: ["src/client.ts"],
      }).success,
    ).toBe(false);
    expect(
      SemanticPatchPlanSchema.safeParse({
        ...semantic,
        verificationContracts: [...semantic.verificationContracts, "literal_replacement_only"],
      }).success,
    ).toBe(false);

    expect(
      SemanticPatchPlanSchema.safeParse({
        ...semantic,
        allowedFiles: [...semantic.allowedFiles, "SRC/transcribe.ts"],
      }).success,
    ).toBe(false);
    expect(
      SemanticPatchPlanSchema.safeParse({
        ...semantic,
        allowedFiles: [...semantic.allowedFiles, "src/caf\u00e9.ts"],
        forbiddenFiles: ["src/cafe\u0301.ts"],
      }).success,
    ).toBe(false);
  });

  it("requires revision-backed, supported Tier B findings in semantic plans", () => {
    const scan = semanticScan();
    expect(() =>
      createSemanticPatchPlan({ ...scan, repository: { revision: null } }, semanticPlanRequest()),
    ).toThrow("full Git revision");
    expect(() =>
      createSemanticPatchPlan(
        {
          ...scan,
          findings: scan.findings.map((finding) => ({
            ...finding,
            automationTier: "A" as const,
          })),
        },
        semanticPlanRequest(),
      ),
    ).toThrow("not eligible");
    expect(() =>
      createSemanticPatchPlan(scan, {
        ...semanticPlanRequest(),
        requiredFiles: ["src/client.ts"],
      }),
    ).toThrow("exactly match finding files");
    expect(() =>
      createSemanticPatchPlan(scan, {
        ...semanticPlanRequest(),
        sourceFiles: [{ path: "src/transcribe.ts", beforeHash: "0".repeat(64) }],
      }),
    ).toThrow("source hash does not match");
    expect(() =>
      createSemanticPatchPlan(scan, {
        ...semanticPlanRequest(),
        sourceFiles: [
          ...semanticPlanRequest().sourceFiles,
          { path: "src/unrelated.ts", beforeHash: "0".repeat(64) },
        ],
        requiredFiles: ["src/transcribe.ts", "src/unrelated.ts"],
      }),
    ).toThrow("exactly match finding files");
    expect(() =>
      createSemanticPatchPlan(
        {
          ...scan,
          findings: scan.findings.map((finding) => ({
            ...finding,
            ruleId: "untrusted.semantic.rule",
          })),
        },
        semanticPlanRequest(),
      ),
    ).toThrow("no trusted deterministic semantic postcondition");
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
