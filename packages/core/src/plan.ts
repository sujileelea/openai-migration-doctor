import { canonicalJson } from "./canonical-json.js";
import { compareStrings } from "./compare.js";
import { SourceLockError } from "./errors.js";
import { resolveMigrationPath } from "./graph.js";
import { sha256 } from "./hash.js";
import {
  type PatchPlan,
  PatchPlanSchema,
  type PlanReport,
  PlanReportSchema,
  REPORT_SCHEMA_VERSION,
  type ScanResult,
  type TextEdit,
} from "./schemas.js";

function compareEdits(left: TextEdit, right: TextEdit): number {
  return (
    compareStrings(left.file, right.file) ||
    left.startOffset - right.startOffset ||
    left.endOffset - right.endOffset ||
    compareStrings(left.id, right.id)
  );
}

export function createPatchPlan(scan: ScanResult): PatchPlan {
  const edgeById = new Map(scan.migrationEdges.map((edge) => [edge.id, edge]));
  const graphIssueById = new Map(scan.graphIssues.map((issue) => [issue.id, issue]));
  const referencedGraphIssueIds = new Set(
    scan.findings.flatMap((finding) => finding.graphIssueIds),
  );
  const edits: TextEdit[] = [];
  const abstentionReasons = scan.graphIssues
    .filter((issue) => issue.kind === "source-conflict" || issue.kind === "cycle")
    .filter((issue) => !referencedGraphIssueIds.has(issue.id))
    .map((issue) => `graph ${issue.id}: ${issue.message}`);

  for (const finding of scan.findings) {
    const edgeId = finding.migrationEdgeIds[0];
    const edge = edgeId ? edgeById.get(edgeId) : undefined;
    if (!edge) {
      throw new SourceLockError(`Finding ${finding.id} references an unknown migration edge.`);
    }
    if (edge.from.kind !== finding.resource.kind || edge.from.id !== finding.resource.id) {
      throw new SourceLockError(
        `Finding ${finding.id} migration edge does not match detected resource ${finding.resource.kind}:${finding.resource.id}.`,
      );
    }
    if (
      finding.remediation.kind === "replace-string-literal" &&
      (finding.resource.kind !== "model" || finding.evidence !== finding.resource.id)
    ) {
      throw new SourceLockError(
        `Finding ${finding.id} replacement evidence does not match its detected model resource.`,
      );
    }
    for (const referencedEdgeId of finding.migrationEdgeIds) {
      if (!edgeById.has(referencedEdgeId)) {
        throw new SourceLockError(
          `Finding ${finding.id} references unknown migration edge ${referencedEdgeId}.`,
        );
      }
    }

    const resolution = resolveMigrationPath(
      scan.migrationEdges,
      finding.resource,
      finding.language,
    );
    if (resolution.status === "unmapped") {
      throw new SourceLockError(`Finding ${finding.id} references an unmapped migration resource.`);
    }
    if (
      resolution.edgeIds.length !== finding.migrationEdgeIds.length ||
      !resolution.edgeIds.every((id, index) => id === finding.migrationEdgeIds[index])
    ) {
      throw new SourceLockError(
        `Finding ${finding.id} migration path does not match the locked graph resolution.`,
      );
    }

    if (resolution.status === "blocked") {
      const reportedIssue = graphIssueById.get(resolution.issue.id);
      if (
        finding.graphIssueIds.length !== 1 ||
        finding.graphIssueIds[0] !== resolution.issue.id ||
        !reportedIssue ||
        canonicalJson(reportedIssue) !== canonicalJson(resolution.issue) ||
        finding.remediation.kind !== "none"
      ) {
        throw new SourceLockError(
          `Finding ${finding.id} does not preserve its blocked graph resolution.`,
        );
      }
      abstentionReasons.push(`${finding.id}: ${resolution.issue.message}`);
      continue;
    }

    if (finding.graphIssueIds.length > 0) {
      throw new SourceLockError(`Finding ${finding.id} references an issue on a resolved path.`);
    }
    if (finding.remediation.kind === "none") {
      abstentionReasons.push(
        `${finding.id}: ${finding.abstentionReason ?? "no deterministic remediation is available."}`,
      );
      continue;
    }
    if (resolution.to.kind !== "model" || finding.remediation.replacement !== resolution.to.id) {
      throw new SourceLockError(
        `Finding ${finding.id} replacement does not match locked destination ${resolution.to.kind}:${resolution.to.id}.`,
      );
    }
    if (resolution.automationTier !== "A" || finding.automationTier !== "A") {
      abstentionReasons.push(`${finding.id}: migration is not eligible for a Tier A edit.`);
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
  abstentionReasons.sort(compareStrings);
  const plannedEdits = abstentionReasons.length > 0 ? [] : edits;
  const findingIds = scan.findings.map((finding) => finding.id).sort(compareStrings);
  const allowedFiles = [...new Set(plannedEdits.map((edit) => edit.file))].sort(compareStrings);
  const status =
    abstentionReasons.length > 0 ? "blocked" : plannedEdits.length > 0 ? "ready" : "no-op";

  return PatchPlanSchema.parse({
    schemaVersion: REPORT_SCHEMA_VERSION,
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
    edits: plannedEdits,
  });
}

export function createPlanReport(scan: ScanResult): PlanReport {
  return PlanReportSchema.parse({
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "plan",
    sourceLockHash: scan.sourceLockHash,
    migrationEdges: scan.migrationEdges,
    graphIssues: scan.graphIssues,
    findings: scan.findings,
    plan: createPatchPlan(scan),
  });
}
