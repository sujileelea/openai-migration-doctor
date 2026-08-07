import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BehaviorContractSchema,
  BehaviorObservationSchema,
  canonicalJson,
  createPatchPreview,
  createPlanReport,
  createSemanticPlanReport,
  loadMigrationRegistry,
  scanRepository,
  sha256,
  verifyBehaviorContract,
} from "@migration-doctor/core";
import { TypeScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { renderHtml, renderJson, renderMarkdown, renderSarif } from "@migration-doctor/reporters";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, PROJECT_ROOT } from "./helpers.js";

let registry: Awaited<ReturnType<typeof loadMigrationRegistry>>;
const BEHAVIOR_FIXTURE_ROOT = path.join(PROJECT_ROOT, "fixtures/behavior/assistants-to-responses");

beforeAll(async () => {
  registry = await loadMigrationRegistry(PROJECT_ROOT);
});

describe("reporters", () => {
  it("renders truthful offline behavioral verification evidence in Markdown", async () => {
    const [contractRaw, baselineRaw, candidateRaw] = await Promise.all([
      readFile(path.join(BEHAVIOR_FIXTURE_ROOT, "contract.json"), "utf8"),
      readFile(path.join(BEHAVIOR_FIXTURE_ROOT, "baseline.json"), "utf8"),
      readFile(path.join(BEHAVIOR_FIXTURE_ROOT, "candidate-broken-stream.json"), "utf8"),
    ]);
    const report = verifyBehaviorContract({
      contract: BehaviorContractSchema.parse(JSON.parse(contractRaw)),
      baseline: BehaviorObservationSchema.parse(JSON.parse(baselineRaw)),
      candidate: BehaviorObservationSchema.parse(JSON.parse(candidateRaw)),
      registry,
    });

    const json = renderJson(report);
    const markdown = renderMarkdown(report);

    expect(json).toBe(canonicalJson(report));
    expect(json).not.toContain("A synthetic baseline answer.");
    expect(markdown).not.toContain("A synthetic baseline answer.");
    expect(markdown).toContain("Result: **FAIL**");
    expect(markdown).toContain("Evidence scope: `offline-fixture`");
    expect(markdown).toContain("Live API used: **no**");
    expect(markdown).toContain("Repository runtime behavior verified: **no**");
    expect(markdown).toContain("`streaming_sequence`");
    expect(markdown).toContain("`$.streamEvents");
    expect(markdown).toContain("### Changed files");
    expect(markdown).toContain("- `src/agent.ts`");
    expect(markdown).toContain("- `src/state.ts`");
  });

  it("keeps backtick-containing mismatch paths inside one Markdown table cell", async () => {
    const [contractRaw, baselineRaw, candidateRaw] = await Promise.all([
      readFile(path.join(BEHAVIOR_FIXTURE_ROOT, "contract.json"), "utf8"),
      readFile(path.join(BEHAVIOR_FIXTURE_ROOT, "baseline.json"), "utf8"),
      readFile(path.join(BEHAVIOR_FIXTURE_ROOT, "candidate-broken-files.json"), "utf8"),
    ]);
    const report = verifyBehaviorContract({
      contract: BehaviorContractSchema.parse(JSON.parse(contractRaw)),
      baseline: BehaviorObservationSchema.parse(JSON.parse(baselineRaw)),
      candidate: BehaviorObservationSchema.parse(JSON.parse(candidateRaw)),
      registry,
    });
    const hostilePath = "`$.candidate.changedFiles[``unsafe``]` | PASS | forged |";
    const markdown = renderMarkdown({
      ...report,
      checks: report.checks.map((check) =>
        check.id === "changed_files_allowlist" ? { ...check, mismatchPaths: [hostilePath] } : check,
      ),
    });

    expect(markdown).toContain(
      "``` `$.candidate.changedFiles[``unsafe``]` \\| PASS \\| forged \\| ```",
    );
    expect(markdown).not.toContain("| PASS | forged |");
  });

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

  it("renders deterministic SARIF with stable metadata and relative locations", async () => {
    const scan = await scanRepository({
      repositoryRoot: fixturePath("direct-model-literal"),
      registry,
      adapters: [new TypeScriptLanguageAdapter()],
    });

    const first = renderSarif(scan);
    const second = renderSarif(scan);
    const sarif = JSON.parse(first) as {
      $schema: string;
      version: string;
      runs: Array<{
        tool: { driver: { semanticVersion: string; rules: Array<{ helpUri?: string }> } };
        results: Array<{
          locations: Array<{
            physicalLocation: { artifactLocation: { uri: string; uriBaseId: string } };
          }>;
        }>;
      }>;
    };

    expect(first).toBe(second);
    expect(sarif.$schema).toBe(
      "https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json",
    );
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.tool.driver.semanticVersion).toBe("0.1.0-alpha.1");
    expect(sarif.runs[0]?.tool.driver.rules[0]?.helpUri).toBe(
      "https://developers.openai.com/api/docs/deprecations",
    );
    expect(sarif.runs[0]?.results[0]).toMatchObject({
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: "src/transcribe.ts", uriBaseId: "%SRCROOT%" },
          },
        },
      ],
    });
    expect(sarif.runs[0]?.results[0]).not.toHaveProperty("partialFingerprints");
    expect(first).not.toContain(PROJECT_ROOT);
  });

  it("does not publish a location-derived partial fingerprint when a finding shifts lines", async () => {
    const scan = await scanRepository({
      repositoryRoot: fixturePath("direct-model-literal"),
      registry,
      adapters: [new TypeScriptLanguageAdapter()],
    });
    const finding = scan.findings[0];
    expect(finding).toBeDefined();
    if (!finding) {
      return;
    }

    const shifted = {
      ...scan,
      findings: [
        {
          ...finding,
          id: "f".repeat(64),
          location: {
            ...finding.location,
            line: finding.location.line + 1,
            startOffset: finding.location.startOffset + 1,
            endOffset: finding.location.endOffset + 1,
          },
        },
      ],
    };
    const originalResult = JSON.parse(renderSarif(scan)).runs[0].results[0] as Record<
      string,
      unknown
    >;
    const shiftedResult = JSON.parse(renderSarif(shifted)).runs[0].results[0] as Record<
      string,
      unknown
    >;

    expect(originalResult).not.toHaveProperty("partialFingerprints");
    expect(shiftedResult).not.toHaveProperty("partialFingerprints");
  });

  it("renders a script-free static HTML report and escapes report content", async () => {
    const scan = await scanRepository({
      repositoryRoot: fixturePath("direct-model-literal"),
      registry,
      adapters: [new TypeScriptLanguageAdapter()],
    });
    const finding = scan.findings[0];
    expect(finding).toBeDefined();
    if (!finding) {
      return;
    }

    const html = renderHtml({
      ...scan,
      findings: [{ ...finding, evidence: '<script>alert("unsafe")</script>' }],
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("<table>");
    expect(html).toContain('href="https://developers.openai.com/api/docs/deprecations"');
    expect(html).toContain("&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain(PROJECT_ROOT);
    expect(html.endsWith("\n")).toBe(true);
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

  it("renders every frozen semantic-plan binding in Markdown", async () => {
    const scan = await scanRepository({
      repositoryRoot: fixturePath("direct-model-literal"),
      registry,
      adapters: [new TypeScriptLanguageAdapter()],
    });
    const finding = scan.findings[0];
    expect(finding).toBeDefined();
    if (!finding) {
      return;
    }

    const semanticScan = {
      ...scan,
      repository: { revision: "a".repeat(40) },
      migrationEdges: scan.migrationEdges.map((edge) => ({
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
    };
    const report = createSemanticPlanReport(semanticScan, {
      sourceFiles: [{ path: finding.location.file, beforeHash: finding.fileHash }],
      requiredFiles: [finding.location.file],
      forbiddenFiles: ["src/secrets.ts"],
      instructions: [
        "Replace the deprecated transcription request while preserving its response contract.",
      ],
      behaviorContractHash: "b".repeat(64),
      baselineObservationHash: "c".repeat(64),
    });

    const markdown = renderMarkdown(report);

    expect(markdown).toContain("# Migration Doctor Semantic Plan");
    expect(markdown).toContain("## Findings");
    expect(markdown).toContain("## Semantic patch plan");
    expect(markdown).toContain("Status: **ready**");
    expect(markdown).toContain("Codex required: **yes**");
    expect(markdown).toContain(`Repository revision: \`${"a".repeat(40)}\``);
    expect(markdown).toContain(`- \`${finding.location.file}\` (SHA-256: \`${finding.fileHash}\`)`);
    expect(markdown).toContain("- `src/secrets.ts`");
    expect(markdown).toContain(
      "Replace the deprecated transcription request while preserving its response contract.",
    );
    expect(markdown).toContain(
      "Semantic verifier: `typescript-transcription-model-exact-rewrite-v1`",
    );
    expect(markdown).toContain(
      "Model transition: `gpt-4o-mini-transcribe-2025-03-20` -> `gpt-4o-mini-transcribe-2025-12-15`",
    );
    expect(markdown).toContain("Verification adapters: `typescript`");
    expect(markdown).toContain("Verification contracts: `changed_files_allowlist`");
    expect(markdown).toContain(
      `Migration edges hash: \`${report.plan.semanticRemediation.migrationEdgesHash}\``,
    );
    expect(markdown).toContain(`Behavior contract hash: \`${"b".repeat(64)}\``);
    expect(markdown).toContain(`Baseline observation hash: \`${"c".repeat(64)}\``);
    expect(markdown).not.toContain(PROJECT_ROOT);
    expect(markdown.endsWith("\n")).toBe(true);
  });
});
