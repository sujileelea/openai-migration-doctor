import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Finding, loadMigrationRegistry, scanRepository } from "@migration-doctor/core";
import {
  MemoryTypeScriptAnalysisCache,
  TypeScriptLanguageAdapter,
} from "@migration-doctor/language-typescript";
import { describe, expect, it } from "vitest";
import {
  type BenchmarkBudgets,
  benchmarkCorpusHash,
  benchmarkLedgerJson,
  createTypeScriptBenchmarkCorpus,
  evaluateBenchmarkBudgets,
  loadBenchmarkBudgets,
  materializeAccuracyCorpus,
  measureAccuracy,
  observeNodeHttpRequests,
  type PerformanceSample,
  parseBenchmarkBudgets,
  runPhase6Benchmark,
  TYPESCRIPT_BENCHMARK_AUTHORED_TEMPLATE_COUNT,
} from "../benchmarks/src/index.js";
import { PROJECT_ROOT } from "./helpers.js";

const TEST_BUDGETS: BenchmarkBudgets = {
  schemaVersion: "1.0.0",
  corpus: { minimumAuthoredTemplates: 40, minimumFixtures: 100 },
  accuracy: {
    minimumPrecision: 0.99,
    minimumRecall: 0.95,
    minimumAbstentionRecall: 0.95,
  },
  performance: {
    minimumLines: 1_000,
    maximumColdDurationMs: 30_000,
    maximumWarmDurationMs: 3_000,
    minimumWarmCacheHitRate: 0.99,
  },
  network: { maximumObservedNodeHttpRequests: 0 },
};

describe("Phase 6 benchmark", () => {
  it("provides at least 100 deterministic authored fixtures across required classes", () => {
    const fixtures = createTypeScriptBenchmarkCorpus();
    const ids = new Set(fixtures.map((fixture) => fixture.id));
    const files = new Set(fixtures.map((fixture) => fixture.relativeFile));
    const classes = new Set(fixtures.flatMap((fixture) => fixture.classes));

    expect(fixtures).toHaveLength(120);
    expect(TYPESCRIPT_BENCHMARK_AUTHORED_TEMPLATE_COUNT).toBe(42);
    expect(ids.size).toBe(fixtures.length);
    expect(files.size).toBe(fixtures.length);
    expect(benchmarkCorpusHash(fixtures)).toMatch(/^[a-f0-9]{64}$/u);
    expect(classes).toEqual(
      new Set([
        "alias",
        "comment",
        "dead-code",
        "documentation",
        "dynamic-configuration",
        "indirect-invocation",
        "negative-control",
        "positive-control",
        "test-code",
        "unsupported-wrapper",
      ]),
    );
    expect(fixtures.filter((fixture) => fixture.expectedFindings.length === 0)).toHaveLength(48);
    expect(fixtures.every((fixture) => fixture.source.endsWith("\n"))).toBe(true);
  });

  it("measures exact accuracy and a real one-file warm cache invalidation", async () => {
    const ledger = await runPhase6Benchmark({
      projectRoot: PROJECT_ROOT,
      budgets: TEST_BUDGETS,
      performanceLines: 1_000,
      performanceFiles: 100,
      allowDirtyWorktree: true,
    });

    expect(ledger.accuracy).toEqual({
      fixtures: 120,
      expectedFindings: 95,
      actualFindings: 95,
      negativeControls: 48,
      trueNegativeControls: 48,
      falsePositiveFixtures: 0,
      overall: {
        truePositives: 95,
        falsePositives: 0,
        falseNegatives: 0,
        precision: 1,
        recall: 1,
      },
      supported: {
        truePositives: 75,
        falsePositives: 0,
        falseNegatives: 0,
        precision: 1,
        recall: 1,
      },
      abstentions: {
        truePositives: 20,
        falsePositives: 0,
        falseNegatives: 0,
        precision: 1,
        recall: 1,
      },
      mismatches: { falsePositives: [], falseNegatives: [] },
    });
    expect(ledger.performance.cold.cache).toMatchObject({
      cacheEnabled: true,
      files: 100,
      cacheHits: 0,
      cacheMisses: 100,
      parsedFiles: 20,
    });
    expect(ledger.performance.warmIncremental.cache).toMatchObject({
      cacheEnabled: true,
      files: 100,
      cacheHits: 99,
      cacheMisses: 1,
      parsedFiles: 1,
    });
    expect(ledger.performance.cold.observedNodeHttpRequests).toBe(0);
    expect(ledger.performance.warmIncremental.observedNodeHttpRequests).toBe(0);
    expect(ledger.performance.cold.peakRssBytes).toBeGreaterThan(0);
    expect(ledger.budgets.passed).toBe(true);
    expect(ledger.repositoryWorkingTreeClean).toBe(false);

    const serialized = benchmarkLedgerJson(ledger);
    expect(serialized).not.toContain("migration-doctor-benchmark-");
    expect(JSON.parse(serialized)).toEqual(ledger);
  });

  it("scores an incorrect source location as both a false positive and false negative", async () => {
    const fixture = createTypeScriptBenchmarkCorpus().find((candidate) =>
      candidate.id.startsWith("model-positive"),
    );
    expect(fixture).toBeDefined();
    if (!fixture) return;

    const repositoryRoot = await mkdtemp(
      path.join(tmpdir(), "migration-doctor-accuracy-contract-"),
    );
    try {
      await materializeAccuracyCorpus(repositoryRoot, [fixture]);
      const registry = await loadMigrationRegistry(PROJECT_ROOT);
      const scan = await scanRepository({
        repositoryRoot,
        registry,
        adapters: [new TypeScriptLanguageAdapter()],
      });
      const finding = scan.findings[0];
      expect(finding).toBeDefined();
      if (!finding) return;

      expect(measureAccuracy([fixture], scan).supported).toMatchObject({
        truePositives: 1,
        falsePositives: 0,
        falseNegatives: 0,
      });
      const metrics = measureAccuracy([fixture], {
        ...scan,
        findings: [
          {
            ...finding,
            location: { ...finding.location, startOffset: finding.location.startOffset + 1 },
          },
        ],
      });
      expect(metrics.supported).toEqual({
        truePositives: 0,
        falsePositives: 1,
        falseNegatives: 1,
        precision: 0,
        recall: 0,
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("observes a deliberate Node HTTP request", async () => {
    const server = createServer((_request, response) => {
      response.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a local TCP address.");
      }
      const observed = await observeNodeHttpRequests(async () => {
        const response = await fetch(`http://127.0.0.1:${address.port}/benchmark-observation`);
        await response.text();
      });
      expect(observed.requests).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("invalidates cache entries when migration edges change and rejects corrupt entries", async () => {
    const fixture = createTypeScriptBenchmarkCorpus().find((candidate) =>
      candidate.id.startsWith("model-positive"),
    );
    expect(fixture).toBeDefined();
    if (!fixture) return;

    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-cache-contract-"));
    try {
      await materializeAccuracyCorpus(repositoryRoot, [fixture]);
      const registry = await loadMigrationRegistry(PROJECT_ROOT);
      const cache = new MemoryTypeScriptAnalysisCache();
      const adapter = new TypeScriptLanguageAdapter({ cache });
      const request = { repositoryRoot, migrationEdges: registry.edges };

      await adapter.scan(request);
      expect(adapter.lastScanTelemetry).toMatchObject({ cacheHits: 0, cacheMisses: 1 });
      await adapter.scan(request);
      expect(adapter.lastScanTelemetry).toMatchObject({ cacheHits: 1, cacheMisses: 0 });
      await adapter.scan({
        ...request,
        migrationEdges: registry.edges.map((edge) => ({
          ...edge,
          behaviorChanges: [...edge.behaviorChanges, "Synthetic cache-key change."],
        })),
      });
      expect(adapter.lastScanTelemetry).toMatchObject({ cacheHits: 0, cacheMisses: 1 });

      const corruptAdapter = new TypeScriptLanguageAdapter({
        cache: {
          get: async () => [{} as Finding],
          set: async () => undefined,
        },
      });
      await expect(corruptAdapter.scan(request)).rejects.toThrow();
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("loads strict machine-readable budgets and reports each failed regression", async () => {
    const budgets = await loadBenchmarkBudgets(
      path.join(PROJECT_ROOT, "benchmarks", "budgets.json"),
    );
    expect(budgets).toEqual(
      parseBenchmarkBudgets(
        JSON.parse(await readFile(path.join(PROJECT_ROOT, "benchmarks", "budgets.json"), "utf8")),
      ),
    );
    expect(() =>
      parseBenchmarkBudgets({
        ...budgets,
        accuracy: { ...budgets.accuracy, minimumPrecision: 1.01 },
      }),
    ).toThrow("ratio budgets cannot exceed 1");
    expect(() => parseBenchmarkBudgets({ ...budgets, unexpected: true })).toThrow(
      "must contain exactly",
    );
    await expect(
      materializeAccuracyCorpus("/tmp/benchmark-root", [
        {
          id: "escape",
          relativeFile: "../escape.ts",
          classes: ["negative-control"],
          source: "export {};\n",
          expectedFindings: [],
        },
      ]),
    ).rejects.toThrow("escapes the corpus root");

    const sample = (mode: PerformanceSample["mode"]): PerformanceSample => ({
      mode,
      lines: 100,
      files: 2,
      durationMs: 31_000,
      peakRssBytes: 1,
      observedNodeHttpRequests: 1,
      cache: {
        cacheEnabled: true,
        files: 2,
        cacheHits: 0,
        cacheMisses: 2,
        parsedFiles: 2,
      },
    });
    const checks = evaluateBenchmarkBudgets(
      {
        authoredTemplates: 1,
        fixtures: 1,
        accuracy: {
          fixtures: 1,
          expectedFindings: 1,
          actualFindings: 1,
          negativeControls: 0,
          trueNegativeControls: 0,
          falsePositiveFixtures: 0,
          overall: {
            truePositives: 0,
            falsePositives: 0,
            falseNegatives: 1,
            precision: 1,
            recall: 0,
          },
          supported: {
            truePositives: 0,
            falsePositives: 1,
            falseNegatives: 1,
            precision: 0,
            recall: 0,
          },
          abstentions: {
            truePositives: 0,
            falsePositives: 0,
            falseNegatives: 1,
            precision: 1,
            recall: 0,
          },
          mismatches: { falsePositives: [], falseNegatives: [] },
        },
        cold: sample("cold"),
        warmIncremental: sample("warm-incremental"),
      },
      budgets,
    );
    expect(checks.filter((check) => !check.passed).map((check) => check.id)).toEqual([
      "corpus.fixture-count",
      "corpus.authored-template-count",
      "accuracy.supported-precision",
      "accuracy.supported-recall",
      "accuracy.abstention-recall",
      "performance.cold-lines",
      "performance.warm-lines",
      "performance.cold-duration-ms",
      "performance.warm-duration-ms",
      "performance.warm-cache-hit-rate",
      "network.cold-observed-node-http-requests",
      "network.warm-observed-node-http-requests",
    ]);
  });
});
