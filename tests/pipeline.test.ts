import { appendFile, cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyTextEdits,
  canonicalJson,
  createPatchPreview,
  createPlanReport,
  hashRepositoryTree,
  loadMigrationRegistry,
  MigrationError,
  scanRepository,
  sha256,
  verifyPatchPlan,
} from "@migration-doctor/core";
import { TypeScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixturePath, PROJECT_ROOT } from "./helpers.js";

const temporaryDirectories: string[] = [];
const adapter = new TypeScriptLanguageAdapter();
let registry: Awaited<ReturnType<typeof loadMigrationRegistry>>;

beforeAll(async () => {
  registry = await loadMigrationRegistry(PROJECT_ROOT);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scanFixture(name: string) {
  return scanRepository({
    repositoryRoot: fixturePath(name),
    registry,
    adapters: [adapter],
  });
}

describe("deterministic TypeScript vertical slice", () => {
  it("finds only the direct OpenAI transcriptions model literal", async () => {
    const root = fixturePath("direct-model-literal");
    const before = await hashRepositoryTree(root);
    const scan = await scanFixture("direct-model-literal");

    expect(scan.summary).toEqual({ total: 1, blocking: 1, graphIssues: 0 });
    expect(scan.findings[0]).toMatchObject({
      ruleId: "openai.transcriptions.model.gpt-4o-mini-transcribe-2025-03-20",
      evidence: "gpt-4o-mini-transcribe-2025-03-20",
      confidence: "high",
      automationTier: "A",
      location: {
        file: "src/transcribe.ts",
        line: 11,
        column: 13,
      },
    });
    expect(await hashRepositoryTree(root)).toBe(before);
  });

  it.each([
    "comment-only",
    "unrelated-model-property",
    "already-migrated",
    "shadowed-client",
    "reassigned-client",
    "ambiguous-model-property",
    "use-before-construction",
  ])("does not report the %s negative fixture", async (name) => {
    const scan = await scanFixture(name);
    expect(scan.findings).toEqual([]);
    expect(scan.summary).toEqual({ total: 0, blocking: 0, graphIssues: 0 });
  });

  it("creates a byte-stable literal-only patch preview without mutating the source", async () => {
    const root = fixturePath("direct-model-literal");
    const originalTreeHash = await hashRepositoryTree(root);
    const scan = await scanFixture("direct-model-literal");
    const report = createPlanReport(scan);
    const previewOne = await createPatchPreview(root, scan, report.plan);
    const previewTwo = await createPatchPreview(root, scan, report.plan);

    expect(report.plan).toMatchObject({
      status: "ready",
      requiresCodex: false,
      allowedFiles: ["src/transcribe.ts"],
    });
    expect(canonicalJson(previewOne)).toBe(canonicalJson(previewTwo));
    expect(previewOne.files[0]?.diff).toBe(
      [
        "--- a/src/transcribe.ts",
        "+++ b/src/transcribe.ts",
        "@@ -11,1 +11,1 @@",
        '-    model: "gpt-4o-mini-transcribe-2025-03-20",',
        '+    model: "gpt-4o-mini-transcribe-2025-12-15",',
        "",
      ].join("\n"),
    );

    const original = await readFile(path.join(root, "src/transcribe.ts"), "utf8");
    const patched = applyTextEdits(original, report.plan.edits);
    expect(patched).toContain('const documentationExample = "gpt-4o-mini-transcribe-2025-03-20";');
    expect(patched).toContain('model: "gpt-4o-mini-transcribe-2025-12-15"');
    expect(await hashRepositoryTree(root)).toBe(originalTreeHash);
  });

  it("verifies the patch in a temporary tree and explicitly leaves runtime behavior unverified", async () => {
    const root = fixturePath("direct-model-literal");
    const originalTreeHash = await hashRepositoryTree(root);
    const scan = await scanFixture("direct-model-literal");
    const plan = createPlanReport(scan).plan;
    const preview = await createPatchPreview(root, scan, plan);
    const report = await verifyPatchPlan({
      repositoryRoot: root,
      scan,
      plan,
      preview,
      registry,
      adapters: [adapter],
    });

    expect(report.verification.passed).toBe(true);
    expect(report.verification.runtimeBehaviorVerified).toBe(false);
    expect(report.verification.changedFiles).toEqual(["src/transcribe.ts"]);
    expect(report.verification.checks.every((check) => check.passed)).toBe(true);
    expect(await hashRepositoryTree(root)).toBe(originalTreeHash);
  });

  it("fails a stale plan after the source file changes", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-stale-"));
    temporaryDirectories.push(temporaryRoot);
    await cp(fixturePath("direct-model-literal"), temporaryRoot, { recursive: true });
    const scan = await scanRepository({
      repositoryRoot: temporaryRoot,
      registry,
      adapters: [adapter],
    });
    const plan = createPlanReport(scan).plan;
    await appendFile(
      path.join(temporaryRoot, "src/transcribe.ts"),
      "\n// changed after planning\n",
    );

    await expect(createPatchPreview(temporaryRoot, scan, plan)).rejects.toBeInstanceOf(
      MigrationError,
    );
    await expect(createPatchPreview(temporaryRoot, scan, plan)).rejects.toThrow(
      "file hash changed",
    );
  });

  it("rejects a finding whose replacement is not the locked destination", async () => {
    const scan = await scanFixture("direct-model-literal");
    const finding = scan.findings[0];
    expect(finding).toBeDefined();
    if (!finding) {
      return;
    }

    const tampered = {
      ...scan,
      findings: [
        {
          ...finding,
          remediation: {
            ...finding.remediation,
            replacement: "not-the-locked-destination",
          },
        },
      ],
    };

    expect(() => createPlanReport(tampered)).toThrow("does not match locked destination");
  });

  it("rejects a finding redirected to an unrelated locked resource", async () => {
    const scan = await scanFixture("direct-model-literal");
    const finding = scan.findings[0];
    const reviewedEdge = scan.migrationEdges[0];
    expect(finding).toBeDefined();
    expect(reviewedEdge).toBeDefined();
    if (!finding || !reviewedEdge) {
      return;
    }

    const unrelatedEdge = {
      ...reviewedEdge,
      id: "synthetic.unrelated-source.to.wrong-terminal",
      from: { kind: "model" as const, id: "synthetic-unrelated-source" },
      to: { kind: "model" as const, id: "synthetic-wrong-terminal" },
    };
    const tampered = {
      ...scan,
      migrationEdges: [...scan.migrationEdges, unrelatedEdge],
      findings: [
        {
          ...finding,
          resource: unrelatedEdge.from,
          migrationEdgeIds: [unrelatedEdge.id],
          remediation: {
            kind: "replace-string-literal" as const,
            replacement: unrelatedEdge.to.id,
          },
        },
      ],
    };

    expect(() => createPlanReport(tampered)).toThrow(
      "replacement evidence does not match its detected model resource",
    );
  });

  it("drops every candidate edit when any finding requires abstention", async () => {
    const root = fixturePath("direct-model-literal");
    const scan = await scanFixture("direct-model-literal");
    const finding = scan.findings[0];
    expect(finding).toBeDefined();
    if (!finding) {
      return;
    }

    const blockedFinding = {
      ...finding,
      id: sha256("synthetic-blocked-copy"),
      kind: "migration-blocked" as const,
      automationTier: "B" as const,
      reviewRequired: true,
      abstentionReason: "Synthetic review is required.",
      remediation: { kind: "none" as const },
    };
    const mixedScan = {
      ...scan,
      findings: [finding, blockedFinding],
      summary: { ...scan.summary, total: 2, blocking: 2 },
    };
    const plan = createPlanReport(mixedScan).plan;
    const preview = await createPatchPreview(root, mixedScan, plan);

    expect(plan.status).toBe("blocked");
    expect(plan.edits).toEqual([]);
    expect(plan.allowedFiles).toEqual([]);
    expect(preview.files).toEqual([]);
  });

  it("verifies a repository whose root name matches an excluded directory", async () => {
    const temporaryParent = await mkdtemp(path.join(tmpdir(), "migration-doctor-root-"));
    temporaryDirectories.push(temporaryParent);
    const root = path.join(temporaryParent, "dist");
    await cp(fixturePath("direct-model-literal"), root, { recursive: true });

    const scan = await scanRepository({ repositoryRoot: root, registry, adapters: [adapter] });
    const plan = createPlanReport(scan).plan;
    const preview = await createPatchPreview(root, scan, plan);
    const report = await verifyPatchPlan({
      repositoryRoot: root,
      scan,
      plan,
      preview,
      registry,
      adapters: [adapter],
    });

    expect(report.verification.passed).toBe(true);
  });

  it("verifies through a symlinked repository root without following nested symlinks", async () => {
    const temporaryParent = await mkdtemp(path.join(tmpdir(), "migration-doctor-symlink-root-"));
    temporaryDirectories.push(temporaryParent);
    const actualRoot = path.join(temporaryParent, "actual");
    const linkedRoot = path.join(temporaryParent, "repository");
    await cp(fixturePath("direct-model-literal"), actualRoot, { recursive: true });
    await symlink(actualRoot, linkedRoot);

    const scan = await scanRepository({
      repositoryRoot: linkedRoot,
      registry,
      adapters: [adapter],
    });
    const plan = createPlanReport(scan).plan;
    const preview = await createPatchPreview(linkedRoot, scan, plan);
    const report = await verifyPatchPlan({
      repositoryRoot: linkedRoot,
      scan,
      plan,
      preview,
      registry,
      adapters: [adapter],
    });

    expect(report.verification.passed).toBe(true);
  });

  it("produces identical canonical scan JSON from different absolute roots", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-copy-"));
    temporaryDirectories.push(temporaryRoot);
    await cp(fixturePath("direct-model-literal"), temporaryRoot, { recursive: true });

    const original = await scanFixture("direct-model-literal");
    const copied = await scanRepository({
      repositoryRoot: temporaryRoot,
      registry,
      adapters: [adapter],
    });
    expect(canonicalJson(copied)).toBe(canonicalJson(original));
  });
});
