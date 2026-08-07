import path from "node:path";
import { loadMigrationRegistry, scanRepository } from "@migration-doctor/core";
import { JavaScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "./helpers.js";

const adapter = new JavaScriptLanguageAdapter();
let registry: Awaited<ReturnType<typeof loadMigrationRegistry>>;

beforeAll(async () => {
  registry = await loadMigrationRegistry(PROJECT_ROOT);
});

async function scanFixture(name: string) {
  return scanRepository({
    repositoryRoot: path.join(PROJECT_ROOT, "fixtures", "javascript", name),
    registry,
    adapters: [adapter],
  });
}

describe("JavaScript language adapter", () => {
  it("detects ESM model and Assistants usage as JavaScript", async () => {
    const scan = await scanFixture("esm-direct");

    expect(scan.summary).toEqual({ total: 2, blocking: 2, graphIssues: 0 });
    expect(scan.findings.map((finding) => finding.language)).toEqual(["javascript", "javascript"]);
    expect(scan.findings.map((finding) => finding.analysis.feature)).toEqual([
      "model-snapshot",
      "assistants",
    ]);
  });

  it("detects direct CommonJS model, thread, run, and streaming usage", async () => {
    const scan = await scanFixture("commonjs-direct");

    expect(scan.summary).toEqual({ total: 4, blocking: 3, graphIssues: 0 });
    expect(scan.findings.map((finding) => finding.analysis.feature)).toEqual([
      "model-snapshot",
      "runs",
      "threads",
      "streaming",
    ]);
    expect(scan.findings.every((finding) => finding.analysis.pattern === "commonjs")).toBe(true);
  });

  it("detects destructured CommonJS constructors and literal tool facets", async () => {
    const scan = await scanFixture("commonjs-destructured");

    expect(scan.summary).toEqual({ total: 3, blocking: 1, graphIssues: 0 });
    expect(scan.findings.map((finding) => finding.analysis.feature)).toEqual([
      "assistants",
      "file-search",
      "tools",
    ]);
    expect(scan.findings.every((finding) => finding.analysis.pattern === "commonjs")).toBe(true);
  });

  it("does not trust a locally shadowed require function", async () => {
    const scan = await scanFixture("commonjs-negative");

    expect(scan.findings).toEqual([]);
    expect(scan.summary).toEqual({ total: 0, blocking: 0, graphIssues: 0 });
  });
});
