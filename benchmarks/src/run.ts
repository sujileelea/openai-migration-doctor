#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkLedgerJson, loadBenchmarkBudgets, runPhase6Benchmark } from "./harness.js";

type Arguments = {
  budgetFile: string;
  outputFile: string;
  performanceLines?: number;
  performanceFiles?: number;
};

function parsePositiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${option} must be a positive safe integer.`);
  }
  return parsed;
}

function parseArguments(argv: string[], projectRoot: string): Arguments {
  const result: Arguments = {
    budgetFile: path.join(projectRoot, "benchmarks", "budgets.json"),
    outputFile: path.join(projectRoot, "benchmarks", "results", "latest.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--budgets" && value) result.budgetFile = path.resolve(value);
    else if (argument === "--output" && value) result.outputFile = path.resolve(value);
    else if (argument === "--performance-lines") {
      result.performanceLines = parsePositiveInteger(value, argument);
    } else if (argument === "--performance-files") {
      result.performanceFiles = parsePositiveInteger(value, argument);
    } else {
      throw new TypeError(`Unknown or incomplete benchmark option: ${argument ?? ""}`);
    }
    index += 1;
  }
  return result;
}

async function main(): Promise<void> {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const args = parseArguments(process.argv.slice(2), projectRoot);
  const budgets = await loadBenchmarkBudgets(args.budgetFile);
  const ledger = await runPhase6Benchmark({
    projectRoot,
    budgets,
    ...(args.performanceLines === undefined ? {} : { performanceLines: args.performanceLines }),
    ...(args.performanceFiles === undefined ? {} : { performanceFiles: args.performanceFiles }),
  });
  await mkdir(path.dirname(args.outputFile), { recursive: true });
  await writeFile(args.outputFile, benchmarkLedgerJson(ledger));
  process.stderr.write(
    `[benchmark] fixtures=${ledger.corpus.fixtures} precision=${ledger.accuracy.overall.precision.toFixed(4)} recall=${ledger.accuracy.overall.recall.toFixed(4)} coldMs=${ledger.performance.cold.durationMs} warmMs=${ledger.performance.warmIncremental.durationMs} passed=${ledger.budgets.passed}\n`,
  );
  if (!ledger.budgets.passed) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown benchmark failure.";
  process.stderr.write(`[benchmark] ${message}\n`);
  process.exitCode = 1;
}
