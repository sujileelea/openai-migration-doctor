import { cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareStrings } from "./compare.js";
import { applyTextEdits } from "./patch.js";
import type { LanguageAdapter } from "./ports.js";
import {
  DEFAULT_EXCLUSIONS,
  hashRepositoryTree,
  normalizeRepositoryRoot,
  repositoryFileHashes,
  resolveRepositoryFile,
} from "./repository.js";
import { scanRepository } from "./scan.js";
import {
  type PatchPlan,
  type PatchPreview,
  REPORT_SCHEMA_VERSION,
  type ScanResult,
  type VerificationResult,
  type VerifyReport,
  VerifyReportSchema,
} from "./schemas.js";
import type { MigrationRegistry } from "./source-lock.js";

type VerifyPatchPlanRequest = {
  repositoryRoot: string;
  scan: ScanResult;
  plan: PatchPlan;
  preview: PatchPreview;
  registry: MigrationRegistry;
  adapters: LanguageAdapter[];
};

function sameStringArrays(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function verifyPatchPlan(request: VerifyPatchPlanRequest): Promise<VerifyReport> {
  const repositoryRoot = await normalizeRepositoryRoot(request.repositoryRoot);
  const originalTreeHash = await hashRepositoryTree(repositoryRoot);

  if (request.plan.status === "blocked") {
    const noAutomaticTransformation =
      request.plan.edits.length === 0 &&
      request.plan.allowedFiles.length === 0 &&
      request.preview.files.length === 0;
    const originalUnchanged = (await hashRepositoryTree(repositoryRoot)) === originalTreeHash;
    const checks: VerificationResult["checks"] = [
      {
        id: "manual_migration_resolved",
        passed: false,
        evidence: [
          `manualActions=${request.plan.manualActions.length}`,
          `abstentionReasons=${request.plan.abstentionReasons.length}`,
        ],
      },
      {
        id: "no_automatic_transformation",
        passed: noAutomaticTransformation,
        evidence: [
          `plannedEdits=${request.plan.edits.length}`,
          `previewFiles=${request.preview.files.length}`,
        ],
      },
      {
        id: "original_repository_unchanged",
        passed: originalUnchanged,
        evidence: [`treeHash=${originalTreeHash}`],
      },
    ];

    return VerifyReportSchema.parse({
      schemaVersion: REPORT_SCHEMA_VERSION,
      kind: "verify",
      sourceLockHash: request.scan.sourceLockHash,
      migrationEdges: request.scan.migrationEdges,
      graphIssues: request.scan.graphIssues,
      findings: request.scan.findings,
      plan: request.plan,
      verification: {
        passed: false,
        runtimeBehaviorVerified: false,
        checks,
        changedFiles: [],
      },
    });
  }

  const temporaryParent = await mkdtemp(path.join(tmpdir(), "migration-doctor-"));
  const temporaryRoot = path.join(temporaryParent, "repository");

  try {
    await cp(repositoryRoot, temporaryRoot, {
      recursive: true,
      filter: async (source) => {
        if (path.resolve(source) === repositoryRoot) {
          return true;
        }
        if (
          DEFAULT_EXCLUSIONS.includes(path.basename(source) as (typeof DEFAULT_EXCLUSIONS)[number])
        ) {
          return false;
        }
        return !(await lstat(source)).isSymbolicLink();
      },
    });

    const beforeHashes = await repositoryFileHashes(temporaryRoot);
    for (const previewFile of request.preview.files) {
      const target = resolveRepositoryFile(temporaryRoot, previewFile.path);
      const before = await readFile(target, "utf8");
      const after = applyTextEdits(before, previewFile.edits);
      await writeFile(target, after, "utf8");
    }

    const afterHashes = await repositoryFileHashes(temporaryRoot);
    const changedFiles = [...afterHashes.entries()]
      .filter(([file, hash]) => beforeHashes.get(file) !== hash)
      .map(([file]) => file)
      .sort(compareStrings);
    const expectedChangedFiles =
      request.plan.edits.length > 0 ? [...request.plan.allowedFiles] : [];
    expectedChangedFiles.sort(compareStrings);

    const exactEdits = request.preview.files.every(
      (file) => afterHashes.get(file.path) === file.afterHash,
    );
    const allowlistPassed = sameStringArrays(changedFiles, expectedChangedFiles);
    const rescanned = await scanRepository({
      repositoryRoot: temporaryRoot,
      registry: request.registry,
      adapters: request.adapters,
    });
    const findingResolved = rescanned.findings.length === 0;
    const originalUnchanged = (await hashRepositoryTree(repositoryRoot)) === originalTreeHash;

    const checks: VerificationResult["checks"] = [
      {
        id: "changed_files_allowlist",
        passed: allowlistPassed,
        evidence: [
          `expected=${expectedChangedFiles.join(",") || "none"}`,
          `actual=${changedFiles.join(",") || "none"}`,
        ],
      },
      {
        id: "finding_resolved",
        passed: findingResolved,
        evidence: [`remainingFindings=${rescanned.findings.length}`],
      },
      {
        id: "literal_replacement_only",
        passed: exactEdits,
        evidence: [`verifiedFiles=${request.preview.files.length}`],
      },
      {
        id: "original_repository_unchanged",
        passed: originalUnchanged,
        evidence: [`treeHash=${originalTreeHash}`],
      },
    ];

    return VerifyReportSchema.parse({
      schemaVersion: REPORT_SCHEMA_VERSION,
      kind: "verify",
      sourceLockHash: request.scan.sourceLockHash,
      migrationEdges: request.scan.migrationEdges,
      graphIssues: request.scan.graphIssues,
      findings: request.scan.findings,
      plan: request.plan,
      verification: {
        passed: checks.every((check) => check.passed),
        runtimeBehaviorVerified: false,
        checks,
        changedFiles,
      },
    });
  } finally {
    await rm(temporaryParent, { recursive: true, force: true });
  }
}
