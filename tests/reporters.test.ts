import {
  canonicalJson,
  createPatchPreview,
  createPlanReport,
  loadMigrationRegistry,
  scanRepository,
  sha256,
} from "@migration-doctor/core";
import { TypeScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { renderJson, renderMarkdown } from "@migration-doctor/reporters";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, PROJECT_ROOT } from "./helpers.js";

let registry: Awaited<ReturnType<typeof loadMigrationRegistry>>;

beforeAll(async () => {
  registry = await loadMigrationRegistry(PROJECT_ROOT);
});

describe("reporters", () => {
  it("renders stable JSON without volatile telemetry or absolute paths", async () => {
    const scan = await scanRepository({
      repositoryRoot: fixturePath("direct-model-literal"),
      registry,
      adapters: [new TypeScriptLanguageAdapter()],
    });
    const first = renderJson(scan);
    const second = renderJson(scan);

    expect(first).toBe(second);
    expect(first).toBe(canonicalJson(scan));
    expect(first).not.toContain(PROJECT_ROOT);
    expect(first).not.toContain("durationMs");
    expect(first.endsWith("\n")).toBe(true);
  });

  it("renders official sources and a path-stable diff in Markdown", async () => {
    const root = fixturePath("direct-model-literal");
    const scan = await scanRepository({
      repositoryRoot: root,
      registry,
      adapters: [new TypeScriptLanguageAdapter()],
    });
    const plan = createPlanReport(scan).plan;
    const preview = await createPatchPreview(root, scan, plan);
    const scanMarkdown = renderMarkdown(scan);
    const patchMarkdown = renderMarkdown(preview);

    expect(scanMarkdown).toContain("https://developers.openai.com/api/docs/deprecations");
    expect(scanMarkdown).toContain("2027-01-20");
    expect(patchMarkdown).toContain("--- a/src/transcribe.ts");
    expect(patchMarkdown).not.toContain(PROJECT_ROOT);
  });

  it("renders structured analysis and source-backed manual actions in Markdown", async () => {
    const scan = await scanRepository({
      repositoryRoot: fixturePath("direct-model-literal"),
      registry,
      adapters: [new TypeScriptLanguageAdapter()],
    });
    const finding = scan.findings[0];
    const reviewedEdge = scan.migrationEdges[0];
    expect(finding).toBeDefined();
    expect(reviewedEdge).toBeDefined();
    if (!finding || !reviewedEdge) {
      return;
    }

    const manualEdge = {
      ...reviewedEdge,
      id: "synthetic.assistants-api.to.responses-api",
      from: { kind: "product" as const, id: "assistants-api" },
      to: { kind: "product" as const, id: "responses-api" },
      behaviorChanges: ["Application code must own tool orchestration."],
      automationTier: "C" as const,
      reviewRequired: true,
    };
    const manualFinding = {
      ...finding,
      id: sha256("synthetic-reporter-analysis-only"),
      kind: "analysis-only" as const,
      resource: manualEdge.from,
      migrationEdgeIds: [manualEdge.id],
      automationTier: "C" as const,
      reviewRequired: true,
      analysis: {
        family: "assistants-api" as const,
        feature: "runs" as const,
        pattern: "wrapper" as const,
        disposition: "supported" as const,
        reasonCode: "manual-migration-required",
      },
      abstentionReason: "Run orchestration requires a manual migration.",
      remediation: { kind: "none" as const },
    };
    const report = createPlanReport({
      ...scan,
      migrationEdges: [manualEdge],
      findings: [manualFinding],
    });
    const markdown = renderMarkdown(report);

    expect(markdown).toContain("Analysis family: `assistants-api`");
    expect(markdown).toContain("Feature: `runs`");
    expect(markdown).toContain("Pattern: `wrapper`");
    expect(markdown).toContain("Disposition: supported");
    expect(markdown).toContain("### Manual migration actions");
    expect(markdown).toContain("Target: `product:responses-api`");
    expect(markdown).toContain("Reason code: `manual-migration-required`");
    expect(markdown).toContain("Application code must own tool orchestration.");
  });
});
