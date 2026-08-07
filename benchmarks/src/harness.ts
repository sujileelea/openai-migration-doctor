import { execFile } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { loadMigrationRegistry, scanRepository } from "@migration-doctor/core";
import {
  MemoryTypeScriptAnalysisCache,
  TypeScriptLanguageAdapter,
  type TypeScriptScanTelemetry,
} from "@migration-doctor/language-typescript";
import {
  type BenchmarkFixtureClass,
  benchmarkCorpusHash,
  createTypeScriptBenchmarkCorpus,
  TYPESCRIPT_BENCHMARK_AUTHORED_TEMPLATE_COUNT,
  TYPESCRIPT_BENCHMARK_CORPUS_ID,
  type TypeScriptBenchmarkFixture,
} from "./corpus.js";
import { type AccuracyMetrics, measureAccuracy } from "./metrics.js";

const execFileAsync = promisify(execFile);
export const BENCHMARK_SCHEMA_VERSION = "1.0.0" as const;

export type BenchmarkBudgets = {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  corpus: { minimumAuthoredTemplates: number; minimumFixtures: number };
  accuracy: {
    minimumPrecision: number;
    minimumRecall: number;
    minimumAbstentionRecall: number;
  };
  performance: {
    minimumLines: number;
    maximumColdDurationMs: number;
    maximumWarmDurationMs: number;
    minimumWarmCacheHitRate: number;
  };
  network: { maximumObservedNodeHttpRequests: number };
};

export type PerformanceSample = {
  mode: "cold" | "warm-incremental";
  lines: number;
  files: number;
  durationMs: number;
  peakRssBytes: number;
  observedNodeHttpRequests: number;
  cache: TypeScriptScanTelemetry;
};

export type BudgetCheck = {
  id: string;
  actual: number;
  operator: ">=" | "<=";
  budget: number;
  passed: boolean;
};

export type Phase6BenchmarkLedger = {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  kind: "phase6-benchmark";
  toolVersion: "0.1.0-alpha.1";
  commitSha: string;
  repositoryWorkingTreeClean: boolean;
  sourceLockHash: string;
  environment: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    release: string;
    architecture: string;
    cpuModel: string;
    logicalCpuCount: number;
    totalMemoryBytes: number;
  };
  corpus: {
    id: typeof TYPESCRIPT_BENCHMARK_CORPUS_ID;
    authoredSynthetic: true;
    authoredTemplates: number;
    fixtures: number;
    fixtureClasses: Record<BenchmarkFixtureClass, number>;
    accuracyLines: number;
    performanceLines: number;
    performanceFiles: number;
    performanceCandidateFiles: number;
    sha256: string;
  };
  accuracy: AccuracyMetrics;
  performance: {
    cold: PerformanceSample;
    warmIncremental: PerformanceSample;
  };
  budgets: {
    checks: BudgetCheck[];
    passed: boolean;
  };
};

type PerformanceCorpus = {
  lines: number;
  files: number;
  candidateFiles: number;
  mutableFile: string;
  modifiedSource: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`Benchmark budget ${key} must be a non-negative finite number.`);
  }
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string): number {
  const value = requiredNumber(record, key);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`Benchmark budget ${key} must be a non-negative safe integer.`);
  }
  return value;
}

export function parseBenchmarkBudgets(value: unknown): BenchmarkBudgets {
  if (!isRecord(value) || value.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new TypeError(`Benchmark budgets must use schema ${BENCHMARK_SCHEMA_VERSION}.`);
  }
  assertExactKeys(
    value,
    ["schemaVersion", "corpus", "accuracy", "performance", "network"],
    "Benchmark budgets",
  );
  const corpus = value.corpus;
  const accuracy = value.accuracy;
  const performanceBudget = value.performance;
  const network = value.network;
  if (
    !isRecord(corpus) ||
    !isRecord(accuracy) ||
    !isRecord(performanceBudget) ||
    !isRecord(network)
  ) {
    throw new TypeError("Benchmark budgets are incomplete.");
  }
  assertExactKeys(
    corpus,
    ["minimumAuthoredTemplates", "minimumFixtures"],
    "Benchmark corpus budgets",
  );
  assertExactKeys(
    accuracy,
    ["minimumPrecision", "minimumRecall", "minimumAbstentionRecall"],
    "Benchmark accuracy budgets",
  );
  assertExactKeys(
    performanceBudget,
    ["minimumLines", "maximumColdDurationMs", "maximumWarmDurationMs", "minimumWarmCacheHitRate"],
    "Benchmark performance budgets",
  );
  assertExactKeys(network, ["maximumObservedNodeHttpRequests"], "Benchmark network budgets");
  const budgets: BenchmarkBudgets = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    corpus: {
      minimumAuthoredTemplates: requiredInteger(corpus, "minimumAuthoredTemplates"),
      minimumFixtures: requiredInteger(corpus, "minimumFixtures"),
    },
    accuracy: {
      minimumPrecision: requiredNumber(accuracy, "minimumPrecision"),
      minimumRecall: requiredNumber(accuracy, "minimumRecall"),
      minimumAbstentionRecall: requiredNumber(accuracy, "minimumAbstentionRecall"),
    },
    performance: {
      minimumLines: requiredInteger(performanceBudget, "minimumLines"),
      maximumColdDurationMs: requiredNumber(performanceBudget, "maximumColdDurationMs"),
      maximumWarmDurationMs: requiredNumber(performanceBudget, "maximumWarmDurationMs"),
      minimumWarmCacheHitRate: requiredNumber(performanceBudget, "minimumWarmCacheHitRate"),
    },
    network: {
      maximumObservedNodeHttpRequests: requiredInteger(network, "maximumObservedNodeHttpRequests"),
    },
  };
  for (const ratio of [
    budgets.accuracy.minimumPrecision,
    budgets.accuracy.minimumRecall,
    budgets.accuracy.minimumAbstentionRecall,
    budgets.performance.minimumWarmCacheHitRate,
  ]) {
    if (ratio > 1) throw new TypeError("Benchmark ratio budgets cannot exceed 1.");
  }
  return budgets;
}

export async function loadBenchmarkBudgets(file: string): Promise<BenchmarkBudgets> {
  return parseBenchmarkBudgets(JSON.parse(await readFile(file, "utf8")) as unknown);
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  const newlines = source.match(/\n/gu)?.length ?? 0;
  return source.endsWith("\n") ? newlines : newlines + 1;
}

function resolveCorpusFile(root: string, relativeFile: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativeFile);
  if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new TypeError(`Benchmark fixture path escapes the corpus root: ${relativeFile}`);
  }
  return target;
}

export async function materializeAccuracyCorpus(
  root: string,
  fixtures: readonly TypeScriptBenchmarkFixture[],
): Promise<number> {
  await Promise.all(
    fixtures.map(async (fixture) => {
      const target = resolveCorpusFile(root, fixture.relativeFile);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, fixture.source);
    }),
  );
  return fixtures.reduce((total, fixture) => total + countLines(fixture.source), 0);
}

function performanceSource(fileIndex: number, lines: number, candidate: boolean): string {
  const output: string[] = [];
  if (candidate && lines >= 3) {
    output.push('import OpenAI from "openai";');
    output.push(`const client${fileIndex} = new OpenAI();`);
    output.push(
      `void client${fileIndex}.audio.transcriptions.create({ model: "gpt-4o-mini-transcribe-2025-03-20", file: input });`,
    );
  }
  while (output.length < lines) {
    output.push(`export const synthetic_${fileIndex}_${output.length} = ${output.length};`);
  }
  return `${output.join("\n")}\n`;
}

export async function materializePerformanceCorpus(
  root: string,
  requestedLines: number,
  requestedFiles: number,
): Promise<PerformanceCorpus> {
  if (!Number.isSafeInteger(requestedLines) || requestedLines < 1) {
    throw new TypeError("Performance corpus lines must be a positive safe integer.");
  }
  if (
    !Number.isSafeInteger(requestedFiles) ||
    requestedFiles < 1 ||
    requestedFiles > requestedLines
  ) {
    throw new TypeError("Performance corpus files must be between one and the line count.");
  }
  const sourceDirectory = path.join(root, "src");
  await mkdir(sourceDirectory, { recursive: true });
  const baseLines = Math.floor(requestedLines / requestedFiles);
  const remainder = requestedLines % requestedFiles;
  const candidateInterval = Math.max(1, Math.floor(requestedFiles / 20));
  const candidateFiles = Array.from(
    { length: requestedFiles },
    (_, fileIndex) =>
      baseLines + (fileIndex < remainder ? 1 : 0) >= 3 && fileIndex % candidateInterval === 0,
  ).filter(Boolean).length;
  let mutableFile = "";
  let modifiedSource = "";
  await Promise.all(
    Array.from({ length: requestedFiles }, async (_, fileIndex) => {
      const lines = baseLines + (fileIndex < remainder ? 1 : 0);
      const candidate = lines >= 3 && fileIndex % candidateInterval === 0;
      const relativeFile = `src/performance-${String(fileIndex).padStart(5, "0")}.ts`;
      const source = performanceSource(fileIndex, lines, candidate);
      await writeFile(path.join(root, relativeFile), source);
      if (fileIndex === 0) {
        mutableFile = relativeFile;
        const replacement = source.includes(" = 0;")
          ? source.replace(" = 0;", " = 1;")
          : source.replace("new OpenAI()", "new OpenAI({})");
        modifiedSource = replacement;
      }
    }),
  );
  return {
    lines: requestedLines,
    files: requestedFiles,
    candidateFiles,
    mutableFile,
    modifiedSource,
  };
}

async function measureScan(
  mode: PerformanceSample["mode"],
  lines: number,
  files: number,
  adapter: TypeScriptLanguageAdapter,
  operation: () => Promise<unknown>,
): Promise<PerformanceSample> {
  const observed = await observeNodeHttpRequests(() =>
    measureScanResources(mode, lines, files, adapter, operation),
  );
  return {
    ...observed.value,
    observedNodeHttpRequests: observed.requests,
  };
}

export async function observeNodeHttpRequests<T>(
  operation: () => Promise<T>,
): Promise<{ value: T; requests: number }> {
  let observedNodeHttpRequests = 0;
  const observeRequest = () => {
    observedNodeHttpRequests += 1;
  };
  const networkChannels = [channel("undici:request:create"), channel("http.client.request.start")];
  for (const networkChannel of networkChannels) networkChannel.subscribe(observeRequest);
  try {
    return { value: await operation(), requests: observedNodeHttpRequests };
  } finally {
    for (const networkChannel of networkChannels) networkChannel.unsubscribe(observeRequest);
  }
}

async function measureScanResources(
  mode: PerformanceSample["mode"],
  lines: number,
  files: number,
  adapter: TypeScriptLanguageAdapter,
  operation: () => Promise<unknown>,
): Promise<Omit<PerformanceSample, "observedNodeHttpRequests">> {
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 5);
  sampler.unref();
  const startedAt = performance.now();
  try {
    await operation();
  } finally {
    clearInterval(sampler);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }
  return {
    mode,
    lines,
    files,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    peakRssBytes,
    cache: { ...adapter.lastScanTelemetry },
  };
}

function warmHitRate(sample: PerformanceSample): number {
  const attempts = sample.cache.cacheHits + sample.cache.cacheMisses;
  return attempts === 0 ? 0 : sample.cache.cacheHits / attempts;
}

export function evaluateBenchmarkBudgets(
  input: {
    authoredTemplates: number;
    fixtures: number;
    accuracy: AccuracyMetrics;
    cold: PerformanceSample;
    warmIncremental: PerformanceSample;
  },
  budgets: BenchmarkBudgets,
): BudgetCheck[] {
  const checks: BudgetCheck[] = [];
  const minimum = (id: string, actual: number, budget: number) => {
    checks.push({ id, actual, operator: ">=", budget, passed: actual >= budget });
  };
  const maximum = (id: string, actual: number, budget: number) => {
    checks.push({ id, actual, operator: "<=", budget, passed: actual <= budget });
  };
  minimum("corpus.fixture-count", input.fixtures, budgets.corpus.minimumFixtures);
  minimum(
    "corpus.authored-template-count",
    input.authoredTemplates,
    budgets.corpus.minimumAuthoredTemplates,
  );
  minimum(
    "accuracy.supported-precision",
    input.accuracy.supported.precision,
    budgets.accuracy.minimumPrecision,
  );
  minimum(
    "accuracy.supported-recall",
    input.accuracy.supported.recall,
    budgets.accuracy.minimumRecall,
  );
  minimum(
    "accuracy.abstention-recall",
    input.accuracy.abstentions.recall,
    budgets.accuracy.minimumAbstentionRecall,
  );
  minimum("performance.cold-lines", input.cold.lines, budgets.performance.minimumLines);
  minimum("performance.warm-lines", input.warmIncremental.lines, budgets.performance.minimumLines);
  maximum(
    "performance.cold-duration-ms",
    input.cold.durationMs,
    budgets.performance.maximumColdDurationMs,
  );
  maximum(
    "performance.warm-duration-ms",
    input.warmIncremental.durationMs,
    budgets.performance.maximumWarmDurationMs,
  );
  minimum(
    "performance.warm-cache-hit-rate",
    warmHitRate(input.warmIncremental),
    budgets.performance.minimumWarmCacheHitRate,
  );
  maximum(
    "network.cold-observed-node-http-requests",
    input.cold.observedNodeHttpRequests,
    budgets.network.maximumObservedNodeHttpRequests,
  );
  maximum(
    "network.warm-observed-node-http-requests",
    input.warmIncremental.observedNodeHttpRequests,
    budgets.network.maximumObservedNodeHttpRequests,
  );
  return checks;
}

async function gitState(projectRoot: string): Promise<{ revision: string; clean: boolean }> {
  const [revisionResult, statusResult] = await Promise.all([
    execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { encoding: "utf8" }),
    execFileAsync("git", ["-C", projectRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
      encoding: "utf8",
    }),
  ]);
  const revision = revisionResult.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/u.test(revision)) {
    throw new Error("Benchmark requires a full Git commit SHA.");
  }
  return { revision, clean: statusResult.stdout.length === 0 };
}

export async function runPhase6Benchmark(options: {
  projectRoot: string;
  budgets: BenchmarkBudgets;
  performanceLines?: number;
  performanceFiles?: number;
  allowDirtyWorktree?: boolean;
}): Promise<Phase6BenchmarkLedger> {
  const repositoryState = await gitState(options.projectRoot);
  if (!repositoryState.clean && options.allowDirtyWorktree !== true) {
    throw new Error("Benchmark publication requires a clean Git worktree.");
  }
  const fixtures = createTypeScriptBenchmarkCorpus();
  const registry = await loadMigrationRegistry(options.projectRoot);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "migration-doctor-benchmark-"));
  try {
    const accuracyRoot = path.join(temporaryRoot, "accuracy");
    const performanceRoot = path.join(temporaryRoot, "performance");
    const accuracyLines = await materializeAccuracyCorpus(accuracyRoot, fixtures);
    const accuracyScan = await scanRepository({
      repositoryRoot: accuracyRoot,
      registry,
      adapters: [new TypeScriptLanguageAdapter()],
    });
    const accuracy = measureAccuracy(fixtures, accuracyScan);

    const performanceCorpus = await materializePerformanceCorpus(
      performanceRoot,
      options.performanceLines ?? options.budgets.performance.minimumLines,
      options.performanceFiles ?? 1_000,
    );
    const adapter = new TypeScriptLanguageAdapter({ cache: new MemoryTypeScriptAnalysisCache() });
    const scanPerformance = () =>
      scanRepository({ repositoryRoot: performanceRoot, registry, adapters: [adapter] });
    const cold = await measureScan(
      "cold",
      performanceCorpus.lines,
      performanceCorpus.files,
      adapter,
      scanPerformance,
    );
    await writeFile(
      path.join(performanceRoot, performanceCorpus.mutableFile),
      performanceCorpus.modifiedSource,
    );
    const warmIncremental = await measureScan(
      "warm-incremental",
      performanceCorpus.lines,
      performanceCorpus.files,
      adapter,
      scanPerformance,
    );
    const checks = evaluateBenchmarkBudgets(
      {
        authoredTemplates: TYPESCRIPT_BENCHMARK_AUTHORED_TEMPLATE_COUNT,
        fixtures: fixtures.length,
        accuracy,
        cold,
        warmIncremental,
      },
      options.budgets,
    );
    const cpu = os.cpus()[0];
    const fixtureClasses = Object.fromEntries(
      [
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
      ].map((fixtureClass) => [
        fixtureClass,
        fixtures.filter((fixture) =>
          fixture.classes.includes(fixtureClass as BenchmarkFixtureClass),
        ).length,
      ]),
    ) as Record<BenchmarkFixtureClass, number>;
    return {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      kind: "phase6-benchmark",
      toolVersion: "0.1.0-alpha.1",
      commitSha: repositoryState.revision,
      repositoryWorkingTreeClean: repositoryState.clean,
      sourceLockHash: registry.sourceLockHash,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        release: os.release(),
        architecture: process.arch,
        cpuModel: cpu?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      corpus: {
        id: TYPESCRIPT_BENCHMARK_CORPUS_ID,
        authoredSynthetic: true,
        authoredTemplates: TYPESCRIPT_BENCHMARK_AUTHORED_TEMPLATE_COUNT,
        fixtures: fixtures.length,
        fixtureClasses,
        accuracyLines,
        performanceLines: performanceCorpus.lines,
        performanceFiles: performanceCorpus.files,
        performanceCandidateFiles: performanceCorpus.candidateFiles,
        sha256: benchmarkCorpusHash(fixtures),
      },
      accuracy,
      performance: { cold, warmIncremental },
      budgets: { checks, passed: checks.every((check) => check.passed) },
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function benchmarkLedgerJson(ledger: Phase6BenchmarkLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}
