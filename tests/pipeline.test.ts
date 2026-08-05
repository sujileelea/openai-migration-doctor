import { appendFile, cp, mkdtemp, readFile, rm } from "node:fs/promises";
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

    expect(scan.summary).toEqual({ total: 1, blocking: 1 });
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

  it.each(["comment-only", "unrelated-model-property", "already-migrated", "shadowed-client"])(
    "does not report the %s negative fixture",
    async (name) => {
      const scan = await scanFixture(name);
      expect(scan.findings).toEqual([]);
      expect(scan.summary).toEqual({ total: 0, blocking: 0 });
    },
  );

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
