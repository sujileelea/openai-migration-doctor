#!/usr/bin/env node

import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPatchPreview,
  createPlanReport,
  loadMigrationRegistry,
  MigrationDoctorError,
  type Report,
  scanRepository,
  verifyPatchPlan,
} from "@migration-doctor/core";
import { TypeScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { renderJson, renderMarkdown } from "@migration-doctor/reporters";
import { Command, CommanderError, Option } from "commander";

type OutputFormat = "json" | "markdown";

export type CliIo = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

const defaultIo: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function implementationRoot(): string {
  if (process.env.MIGRATION_DOCTOR_HOME) {
    return path.resolve(process.env.MIGRATION_DOCTOR_HOME);
  }
  return fileURLToPath(new URL("../../../", import.meta.url));
}

function render(report: Report, format: OutputFormat): string {
  return format === "json" ? renderJson(report) : renderMarkdown(report);
}

function formatOption(): Option {
  return new Option("--format <format>", "output format")
    .choices(["json", "markdown"])
    .default("markdown");
}

async function scanTarget(repository: string) {
  const registry = await loadMigrationRegistry(implementationRoot());
  const adapters = [new TypeScriptLanguageAdapter()];
  const scan = await scanRepository({
    repositoryRoot: path.resolve(repository),
    registry,
    adapters,
  });
  return { registry, adapters, scan };
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let commandExitCode = 0;
  let commandExecuted = false;
  const program = new Command();
  program
    .name("migration-doctor")
    .description("Source-grounded OpenAI API migration diagnostics")
    .version("0.0.0")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: io.stderr,
    });

  async function runMeasured(
    operation: () => Promise<Report>,
    format: OutputFormat,
  ): Promise<void> {
    const startedAt = performance.now();
    const report = await operation();
    io.stdout(render(report, format));
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    io.stderr(`[telemetry] durationMs=${durationMs} cache=disabled\n`);
  }

  program
    .command("scan")
    .description("find supported deprecated OpenAI usage without modifying the repository")
    .argument("[repository]", "repository to scan", ".")
    .addOption(formatOption())
    .action(async (repository: string, options: { format: OutputFormat }) => {
      commandExecuted = true;
      await runMeasured(async () => {
        const { scan } = await scanTarget(repository);
        commandExitCode = scan.summary.blocking > 0 ? 1 : 0;
        return scan;
      }, options.format);
    });

  program
    .command("plan")
    .description("create a source-backed deterministic migration plan")
    .argument("[repository]", "repository to scan", ".")
    .addOption(formatOption())
    .action(async (repository: string, options: { format: OutputFormat }) => {
      commandExecuted = true;
      await runMeasured(async () => {
        const { scan } = await scanTarget(repository);
        const report = createPlanReport(scan);
        commandExitCode = scan.summary.blocking > 0 ? 1 : 0;
        return report;
      }, options.format);
    });

  program
    .command("migrate")
    .description("preview a deterministic migration patch; never applies it in this release")
    .argument("[repository]", "repository to scan", ".")
    .addOption(
      new Option("--risk <tier>", "maximum automation risk").choices(["safe"]).default("safe"),
    )
    .addOption(formatOption())
    .action(async (repository: string, options: { format: OutputFormat; risk: "safe" }) => {
      commandExecuted = true;
      void options.risk;
      await runMeasured(async () => {
        const { scan } = await scanTarget(repository);
        const planReport = createPlanReport(scan);
        const preview = await createPatchPreview(path.resolve(repository), scan, planReport.plan);
        commandExitCode = scan.summary.blocking > 0 ? 1 : 0;
        return preview;
      }, options.format);
    });

  program
    .command("verify")
    .description("apply the preview in a temporary tree and verify deterministic patch contracts")
    .argument("[repository]", "repository to scan", ".")
    .addOption(formatOption())
    .action(async (repository: string, options: { format: OutputFormat }) => {
      commandExecuted = true;
      await runMeasured(async () => {
        const { registry, adapters, scan } = await scanTarget(repository);
        const planReport = createPlanReport(scan);
        const preview = await createPatchPreview(path.resolve(repository), scan, planReport.plan);
        const report = await verifyPatchPlan({
          repositoryRoot: path.resolve(repository),
          scan,
          plan: planReport.plan,
          preview,
          registry,
          adapters,
        });
        commandExitCode = report.verification.passed ? 0 : 5;
        return report;
      }, options.format);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    if (!commandExecuted) {
      io.stderr(program.helpInformation());
      return 2;
    }
    return commandExitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    if (error instanceof MigrationDoctorError) {
      io.stderr(`${error.errorCode}: ${error.message}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`UNEXPECTED_ERROR: ${message}\n`);
    return 5;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
