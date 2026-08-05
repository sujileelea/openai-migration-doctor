import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPatchPreview,
  createPlanReport,
  loadMigrationRegistry,
  type MigrationEdge,
  type SourceRef,
  scanRepository,
  verifyPatchPlan,
} from "@migration-doctor/core";
import { TypeScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { renderMarkdown } from "@migration-doctor/reporters";
import { afterEach, describe, expect, it } from "vitest";
import {
  fixturePath,
  syntheticSource,
  syntheticTranscriptionConflict,
  writeLockedRegistry,
} from "./helpers.js";

const temporaryDirectories: string[] = [];
const adapter = new TypeScriptLanguageAdapter();

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function registryFrom(sources: SourceRef[], edges: MigrationEdge[]) {
  const root = await mkdtemp(path.join(tmpdir(), "migration-doctor-graph-registry-"));
  temporaryDirectories.push(root);
  await writeLockedRegistry(root, sources, edges);
  return loadMigrationRegistry(root);
}

describe("migration graph integration", () => {
  it("emits a Tier C source-conflict finding and reports every source", async () => {
    const conflict = syntheticTranscriptionConflict();
    const registry = await registryFrom(conflict.sources, conflict.edges);
    const unaffected = await scanRepository({
      repositoryRoot: fixturePath("comment-only"),
      registry,
      adapters: [adapter],
    });
    const scan = await scanRepository({
      repositoryRoot: fixturePath("direct-model-literal"),
      registry,
      adapters: [adapter],
    });

    expect(unaffected.summary).toEqual({ total: 0, blocking: 0, graphIssues: 0 });
    expect(unaffected.graphIssues).toEqual([]);
    expect(scan.summary).toEqual({ total: 1, blocking: 1, graphIssues: 1 });
    expect(scan.graphIssues[0]).toMatchObject({
      kind: "source-conflict",
      reviewRequired: true,
      edgeIds: ["synthetic.transcribe.to.replacement-a", "synthetic.transcribe.to.replacement-b"],
    });
    expect(scan.findings[0]).toMatchObject({
      kind: "source-conflict",
      automationTier: "C",
      reviewRequired: true,
      remediation: { kind: "none" },
    });

    const plan = createPlanReport(scan).plan;
    expect(plan.status).toBe("blocked");
    expect(plan.edits).toEqual([]);

    const preview = await createPatchPreview(fixturePath("direct-model-literal"), scan, plan);
    expect(preview.files).toEqual([]);

    const markdown = renderMarkdown(preview);
    expect(markdown).toContain("Human review: required");
    expect(markdown).toContain("https://conflict-a.example.invalid/migration");
    expect(markdown).toContain("https://conflict-b.example.invalid/migration");
    expect(markdown).toContain("src/transcribe.ts:11:13");
    expect(markdown).toContain("No deterministic patch is available while the plan is blocked.");

    const verification = await verifyPatchPlan({
      repositoryRoot: fixturePath("direct-model-literal"),
      scan,
      plan,
      preview,
      registry,
      adapters: [adapter],
    });
    const verificationMarkdown = renderMarkdown(verification);
    expect(verificationMarkdown).toContain("src/transcribe.ts:11:13");
    expect(verificationMarkdown).toContain(
      "No source change was verified; resolve the blocked plan before evaluating runtime behavior.",
    );
    expect(verificationMarkdown).not.toContain(
      "The snapshot change can alter transcription output",
    );
  });

  it("plans directly to the terminal destination when the first destination is deprecated", async () => {
    const sourceA = syntheticSource("chain-a", "c");
    const sourceB = syntheticSource("chain-b", "d");
    const sourceModel = "gpt-4o-mini-transcribe-2025-03-20";
    const intermediateModel = "synthetic-transcribe-intermediate";
    const terminalModel = "synthetic-transcribe-terminal";
    const edges: MigrationEdge[] = [
      {
        id: "synthetic.transcribe.source.to.intermediate",
        from: { kind: "model", id: sourceModel },
        to: { kind: "model", id: intermediateModel },
        sources: [sourceA],
        languages: ["typescript"],
        behaviorChanges: [],
        automationTier: "A",
        reviewRequired: false,
      },
      {
        id: "synthetic.transcribe.intermediate.to.terminal",
        from: { kind: "model", id: intermediateModel },
        to: { kind: "model", id: terminalModel },
        sources: [sourceB],
        languages: ["typescript"],
        behaviorChanges: [],
        automationTier: "A",
        reviewRequired: true,
      },
    ];
    const registry = await registryFrom([sourceA, sourceB], edges);
    const repositoryRoot = fixturePath("direct-model-literal");
    const scan = await scanRepository({ repositoryRoot, registry, adapters: [adapter] });

    expect(scan.findings[0]?.migrationEdgeIds).toEqual([
      "synthetic.transcribe.source.to.intermediate",
      "synthetic.transcribe.intermediate.to.terminal",
    ]);
    expect(scan.findings[0]?.remediation).toEqual({
      kind: "replace-string-literal",
      replacement: terminalModel,
    });

    const plan = createPlanReport(scan).plan;
    const preview = await createPatchPreview(repositoryRoot, scan, plan);
    expect(plan.status).toBe("ready");
    expect(preview.files[0]?.diff).toContain(`model: "${terminalModel}"`);
    expect(preview.files[0]?.diff).not.toContain(`model: "${intermediateModel}"`);
  });
});
