import {
  canonicalJson,
  createPatchPreview,
  createPlanReport,
  loadMigrationRegistry,
  scanRepository,
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
});
