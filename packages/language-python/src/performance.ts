import { execFile } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type AdapterScanRequest,
  canonicalJson,
  hashRepositoryTree,
  readRepositoryRevision,
  sha256,
} from "@migration-doctor/core";
import type { PythonLanguageAdapter } from "./adapter.js";

export const PYTHON_PERFORMANCE_SCHEMA_VERSION = "1.0.0" as const;
const TOOL_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const execFileAsync = promisify(execFile);

export type PythonPerformanceLedger = {
  schemaVersion: typeof PYTHON_PERFORMANCE_SCHEMA_VERSION;
  kind: "python-language-adapter-performance";
  measurementScope: "adapter-smoke";
  measuredAt: string;
  toolRevision: string | null;
  toolWorkingTreeClean: boolean;
  migrationEdgesHash: string;
  corpus: {
    repositoryRevision: string | null;
    sha256: string;
    repositoryFiles: number;
    candidateFiles: number;
    candidateBytes: number;
  };
  adapter: "python-libcst";
  environment: {
    platform: NodeJS.Platform;
    release: string;
    architecture: string;
    cpu: string;
    logicalCpuCount: number;
    nodeVersion: string;
    pythonVersion: string | null;
    libcstVersion: string | null;
  };
  measurements: Array<{
    iteration: number;
    mode: "isolated-process";
    durationMs: number;
    workerPeakRssBytes: number | null;
    repositoryFiles: number;
    candidateFiles: number;
    candidateBytes: number;
    findings: number;
    graphIssues: number;
  }>;
};

export async function measurePythonAdapter(request: {
  adapter: PythonLanguageAdapter;
  scan: AdapterScanRequest;
  iterations?: number;
  requireCleanTool?: boolean;
}): Promise<PythonPerformanceLedger> {
  const iterations = request.iterations ?? 3;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) {
    throw new TypeError("Python performance iterations must be an integer from 1 through 100.");
  }
  const toolWorkingTreeClean = await isToolWorkingTreeClean();
  if (request.requireCleanTool === true && !toolWorkingTreeClean) {
    throw new TypeError("Publishable Python performance evidence requires a clean tool worktree.");
  }
  const measurements: PythonPerformanceLedger["measurements"] = [];
  let pythonVersion: string | null = null;
  let libcstVersion: string | null = null;
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const measured = await request.adapter.scanWithMetrics(request.scan);
    pythonVersion ??= measured.metrics.worker?.pythonVersion ?? null;
    libcstVersion ??= measured.metrics.worker?.libcstVersion ?? null;
    measurements.push({
      iteration,
      mode: "isolated-process",
      durationMs: Number(measured.metrics.durationMs.toFixed(3)),
      workerPeakRssBytes: measured.metrics.worker?.peakRssBytes ?? null,
      repositoryFiles: measured.metrics.repositoryFiles,
      candidateFiles: measured.metrics.candidateFiles,
      candidateBytes: measured.metrics.candidateBytes,
      findings: measured.result.findings.length,
      graphIssues: measured.result.graphIssues.length,
    });
  }
  const cpus = os.cpus();
  const firstMeasurement = measurements[0];
  if (!firstMeasurement) {
    throw new TypeError("Python performance measurement did not produce a sample.");
  }
  return {
    schemaVersion: PYTHON_PERFORMANCE_SCHEMA_VERSION,
    kind: "python-language-adapter-performance",
    measurementScope: "adapter-smoke",
    measuredAt: new Date().toISOString(),
    toolRevision: await readRepositoryRevision(TOOL_ROOT),
    toolWorkingTreeClean,
    migrationEdgesHash: sha256(canonicalJson(request.scan.migrationEdges)),
    corpus: {
      repositoryRevision: await readRepositoryRevision(request.scan.repositoryRoot),
      sha256: await hashRepositoryTree(request.scan.repositoryRoot),
      repositoryFiles: firstMeasurement.repositoryFiles,
      candidateFiles: firstMeasurement.candidateFiles,
      candidateBytes: firstMeasurement.candidateBytes,
    },
    adapter: "python-libcst",
    environment: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      cpu: cpus[0]?.model ?? "unknown",
      logicalCpuCount: cpus.length,
      nodeVersion: process.version,
      pythonVersion,
      libcstVersion,
    },
    measurements,
  };
}

async function isToolWorkingTreeClean(): Promise<boolean> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", TOOL_ROOT, "status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8" },
    );
    return result.stdout.length === 0;
  } catch {
    return false;
  }
}
