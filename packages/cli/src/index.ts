#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BehaviorContractSchema,
  BehaviorObservationSchema,
  ConfigurationError,
  createPatchPreview,
  createPlanReport,
  loadMigrationRegistry,
  MigrationDoctorError,
  type Report,
  type ScanResult,
  scanRepository,
  verifyBehaviorContract,
  verifyPatchPlan,
} from "@migration-doctor/core";
import { PythonLanguageAdapter } from "@migration-doctor/language-python";
import { TypeScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { renderHtml, renderJson, renderMarkdown, renderSarif } from "@migration-doctor/reporters";
import { Command, CommanderError, Option } from "commander";

type OutputFormat = "html" | "json" | "markdown" | "sarif";

const REPORT_FILES = {
  html: "migration-report.html",
  json: "migration-report.json",
  markdown: "migration-report.md",
  sarif: "migration-report.sarif",
} as const satisfies Record<OutputFormat, string>;

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
  switch (format) {
    case "html":
      return renderHtml(report);
    case "json":
      return renderJson(report);
    case "markdown":
      return renderMarkdown(report);
    case "sarif":
      return renderSarif(report);
  }
}

function formatOption(): Option {
  return new Option("--format <format>", "output format")
    .choices(["html", "json", "markdown", "sarif"])
    .default("markdown");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function hasFileSystemCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

async function saveReportBundle(
  report: Report,
  repository: string,
  outputDirectory: string,
): Promise<string> {
  const repositoryRoot = await realpath(path.resolve(repository));
  const requestedOutput = path.resolve(outputDirectory);
  const outputName = path.basename(requestedOutput);
  if (!outputName || outputName === "." || outputName === "..") {
    throw new ConfigurationError("Report output must name a new directory.");
  }

  let outputParent: string;
  try {
    outputParent = await realpath(path.dirname(requestedOutput));
    if (!(await stat(outputParent)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    throw new ConfigurationError(
      `Report output parent does not exist or is not a directory: ${path.dirname(requestedOutput)}.`,
      { cause: error },
    );
  }

  const destination = path.join(outputParent, outputName);
  if (isWithin(repositoryRoot, destination)) {
    throw new ConfigurationError(
      "Report output must be outside the scanned repository so scanning remains read-only.",
    );
  }

  const temporaryDirectory = await mkdtemp(path.join(outputParent, ".migration-doctor-report-"));
  let destinationClaimed = false;
  try {
    for (const format of Object.keys(REPORT_FILES) as OutputFormat[]) {
      await writeFile(path.join(temporaryDirectory, REPORT_FILES[format]), render(report, format), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }

    try {
      await mkdir(destination, { mode: 0o700 });
      destinationClaimed = true;
    } catch (error) {
      if (hasFileSystemCode(error, "EEXIST")) {
        throw new ConfigurationError(`Report output already exists: ${destination}.`);
      }
      throw error;
    }

    for (const file of Object.values(REPORT_FILES)) {
      await rename(path.join(temporaryDirectory, file), path.join(destination, file));
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    if (destinationClaimed) {
      await rm(destination, { recursive: true, force: true });
    }
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError(`Unable to save report bundle at ${destination}.`, {
      cause: error,
    });
  }

  return destination;
}

function hasInvalidGraph(scan: ScanResult): boolean {
  return scan.graphIssues.some(
    (issue) => issue.kind === "source-conflict" || issue.kind === "cycle",
  );
}

function scanExitCode(scan: ScanResult): number {
  if (hasInvalidGraph(scan)) {
    return 4;
  }
  return scan.summary.blocking > 0 ? 1 : 0;
}

async function readJsonInput(inputPath: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path.resolve(inputPath), "utf8");
  } catch (error) {
    throw new ConfigurationError(`Unable to read ${label} at ${inputPath}.`, { cause: error });
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigurationError(`${label} at ${inputPath} is not valid JSON.`, { cause: error });
  }
}

async function readBehaviorContract(inputPath: string) {
  const parsed = BehaviorContractSchema.safeParse(await readJsonInput(inputPath, "contract"));
  if (!parsed.success) {
    throw new ConfigurationError(
      `Contract at ${inputPath} failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

async function readBehaviorObservation(inputPath: string, label: string) {
  const parsed = BehaviorObservationSchema.safeParse(await readJsonInput(inputPath, label));
  if (!parsed.success) {
    throw new ConfigurationError(
      `${label[0]?.toUpperCase()}${label.slice(1)} at ${inputPath} failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

async function scanTarget(repository: string) {
  const registry = await loadMigrationRegistry(implementationRoot());
  const adapters = [new TypeScriptLanguageAdapter(), new PythonLanguageAdapter()];
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
        commandExitCode = scanExitCode(scan);
        return scan;
      }, options.format);
    });

  program
    .command("report")
    .description("scan once and save Markdown, JSON, SARIF, and static HTML outside the repository")
    .argument("[repository]", "repository to scan", ".")
    .requiredOption("--output <directory>", "new report bundle directory outside the repository")
    .addOption(formatOption())
    .action(async (repository: string, options: { format: OutputFormat; output: string }) => {
      commandExecuted = true;
      await runMeasured(async () => {
        const { scan } = await scanTarget(repository);
        commandExitCode = scanExitCode(scan);
        const destination = await saveReportBundle(scan, repository, options.output);
        io.stderr(`[report] directory=${destination}\n`);
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
        commandExitCode = scanExitCode(scan);
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
        commandExitCode = scanExitCode(scan);
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
        commandExitCode = hasInvalidGraph(scan)
          ? 4
          : planReport.plan.status === "blocked"
            ? 1
            : report.verification.passed
              ? 0
              : 5;
        return report;
      }, options.format);
    });

  program
    .command("verify-behavior")
    .description("compare offline migration behavior fixtures without calling a live API")
    .argument("<contract>", "behavior contract JSON path")
    .argument("<baseline>", "baseline observation JSON path")
    .argument("<candidate>", "candidate observation JSON path")
    .addOption(formatOption())
    .action(
      async (
        contractPath: string,
        baselinePath: string,
        candidatePath: string,
        options: { format: OutputFormat },
      ) => {
        commandExecuted = true;
        await runMeasured(async () => {
          const [registry, contract, baseline, candidate] = await Promise.all([
            loadMigrationRegistry(implementationRoot()),
            readBehaviorContract(contractPath),
            readBehaviorObservation(baselinePath, "baseline observation"),
            readBehaviorObservation(candidatePath, "candidate observation"),
          ]);
          const report = verifyBehaviorContract({ contract, baseline, candidate, registry });
          commandExitCode = report.passed ? 0 : 5;
          return report;
        }, options.format);
      },
    );

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
