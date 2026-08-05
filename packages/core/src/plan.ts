import { SourceLockError } from "./errors.js";
import { sha256 } from "./hash.js";
import {
  type MigrationEdge,
  type PatchPlan,
  PatchPlanSchema,
  type PlanReport,
  PlanReportSchema,
  SCHEMA_VERSION,
  type ScanResult,
  type TextEdit,
} from "./schemas.js";

function resourceKey(resource: MigrationEdge["from"]): string {
  return `${resource.kind}:${resource.id}`;
}

function compareEdits(left: TextEdit, right: TextEdit): number {
  return (
    left.file.localeCompare(right.file) ||
    left.startOffset - right.startOffset ||
    left.endOffset - right.endOffset ||
    left.id.localeCompare(right.id)
  );
}

export function createPatchPlan(scan: ScanResult): PatchPlan {
  const edgeById = new Map(scan.migrationEdges.map((edge) => [edge.id, edge]));
  const deprecatedResources = new Set(scan.migrationEdges.map((edge) => resourceKey(edge.from)));
  const edits: TextEdit[] = [];
  const abstentionReasons: string[] = [];

  for (const finding of scan.findings) {
    const edgeId = finding.migrationEdgeIds[0];
    const edge = edgeId ? edgeById.get(edgeId) : undefined;
    if (!edge) {
      throw new SourceLockError(`Finding ${finding.id} references an unknown migration edge.`);
    }
    if (!edge.to) {
      abstentionReasons.push(`${finding.id}: official migration destination is missing.`);
      continue;
    }
    if (edge.automationTier !== "A" || finding.automationTier !== "A") {
      abstentionReasons.push(`${finding.id}: migration is not eligible for a Tier A edit.`);
      continue;
    }
    if (deprecatedResources.has(resourceKey(edge.to))) {
      abstentionReasons.push(`${finding.id}: recommended destination is deprecated in this lock.`);
      continue;
    }

    edits.push({
      id: sha256(
        [
          finding.id,
          finding.location.file,
          finding.location.startOffset,
          finding.location.endOffset,
          finding.remediation.replacement,
        ].join("\u0000"),
      ),
      findingId: finding.id,
      file: finding.location.file,
      line: finding.location.line,
      column: finding.location.column,
      startOffset: finding.location.startOffset,
      endOffset: finding.location.endOffset,
      expectedText: finding.evidence,
      replacementText: finding.remediation.replacement,
      originalFileHash: finding.fileHash,
    });
  }

  edits.sort(compareEdits);
  abstentionReasons.sort();
  const findingIds = scan.findings.map((finding) => finding.id).sort();
  const allowedFiles = [...new Set(edits.map((edit) => edit.file))].sort();
  const status = abstentionReasons.length > 0 ? "blocked" : edits.length > 0 ? "ready" : "no-op";

  return PatchPlanSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    status,
    findingIds,
    allowedFiles,
    forbiddenFiles: [],
    sourceLockHash: scan.sourceLockHash,
    verificationContracts: [
      "changed_files_allowlist",
      "finding_resolved",
      "literal_replacement_only",
      "original_repository_unchanged",
    ],
    requiresCodex: false,
    abstentionReasons,
    edits,
  });
}

export function createPlanReport(scan: ScanResult): PlanReport {
  return PlanReportSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    kind: "plan",
    sourceLockHash: scan.sourceLockHash,
    migrationEdges: scan.migrationEdges,
    findings: scan.findings,
    plan: createPatchPlan(scan),
  });
}
