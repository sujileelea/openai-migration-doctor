import { canonicalJson } from "./canonical-json.js";
import { compareStrings } from "./compare.js";
import { SourceLockError } from "./errors.js";
import { resolveMigrationPath } from "./graph.js";
import { sha256 } from "./hash.js";
import {
  ANALYSIS_ONLY_VERIFICATION_CONTRACTS,
  DETERMINISTIC_VERIFICATION_CONTRACTS,
  type ManualAction,
  type PatchPlan,
  PatchPlanSchema,
  type PlanReport,
  PlanReportSchema,
  REPORT_SCHEMA_VERSION,
  type ScanResult,
  SEMANTIC_PLAN_SCHEMA_VERSION,
  SEMANTIC_VERIFICATION_CONTRACTS,
  type SemanticPatchPlan,
  SemanticPatchPlanSchema,
  type SemanticPlanReport,
  SemanticPlanReportSchema,
  type SemanticRemediationScope,
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

function compareManualActions(left: ManualAction, right: ManualAction): number {
  return compareStrings(left.findingId, right.findingId);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export type CreateSemanticPatchPlanRequest = Pick<
  SemanticRemediationScope,
  | "instructions"
  | "sourceFiles"
  | "requiredFiles"
  | "behaviorContractHash"
  | "baselineObservationHash"
> & {
  forbiddenFiles?: string[];
};

export function createPatchPlan(scan: ScanResult): PatchPlan {
  const edgeById = new Map(scan.migrationEdges.map((edge) => [edge.id, edge]));
  const graphIssueById = new Map(scan.graphIssues.map((issue) => [issue.id, issue]));
  const referencedGraphIssueIds = new Set(
    scan.findings.flatMap((finding) => finding.graphIssueIds),
  );
  const edits: TextEdit[] = [];
  const manualActions: ManualAction[] = [];
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
      const reason = resolution.issue.message;
      abstentionReasons.push(`${finding.id}: ${reason}`);
      manualActions.push({
        findingId: finding.id,
        migrationEdgeIds: resolution.edgeIds,
        target: null,
        reason,
        reasonCode: `graph-${resolution.issue.kind}`,
        behaviorChanges: [
          ...new Set(
            resolution.edgeIds.flatMap(
              (resolvedEdgeId) => edgeById.get(resolvedEdgeId)?.behaviorChanges ?? [],
            ),
          ),
        ].sort(compareStrings),
      });
      continue;
    }

    if (finding.graphIssueIds.length > 0) {
      throw new SourceLockError(`Finding ${finding.id} references an issue on a resolved path.`);
    }
    if (finding.remediation.kind === "none") {
      const reason = finding.abstentionReason ?? "No deterministic remediation is available.";
      abstentionReasons.push(`${finding.id}: ${reason}`);
      manualActions.push({
        findingId: finding.id,
        migrationEdgeIds: resolution.edgeIds,
        target: resolution.to,
        reason,
        reasonCode: finding.analysis.reasonCode ?? "manual-migration-required",
        behaviorChanges: [
          ...new Set(
            resolution.edgeIds.flatMap(
              (resolvedEdgeId) => edgeById.get(resolvedEdgeId)?.behaviorChanges ?? [],
            ),
          ),
        ].sort(compareStrings),
      });
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
  manualActions.sort(compareManualActions);
  abstentionReasons.sort(compareStrings);
  const plannedEdits = abstentionReasons.length > 0 ? [] : edits;
  const findingIds = scan.findings.map((finding) => finding.id).sort(compareStrings);
  const allowedFiles = [...new Set(plannedEdits.map((edit) => edit.file))].sort(compareStrings);
  const status =
    abstentionReasons.length > 0 ? "blocked" : plannedEdits.length > 0 ? "ready" : "no-op";
  const verificationContracts =
    status === "blocked"
      ? [...ANALYSIS_ONLY_VERIFICATION_CONTRACTS]
      : [...DETERMINISTIC_VERIFICATION_CONTRACTS];

  return PatchPlanSchema.parse({
    schemaVersion: REPORT_SCHEMA_VERSION,
    status,
    findingIds,
    allowedFiles,
    forbiddenFiles: [],
    sourceLockHash: scan.sourceLockHash,
    verificationContracts,
    requiresCodex: false,
    abstentionReasons,
    manualActions,
    edits: plannedEdits,
  });
}

export function createSemanticPatchPlan(
  scan: ScanResult,
  request: CreateSemanticPatchPlanRequest,
): SemanticPatchPlan {
  if (!scan.repository.revision) {
    throw new SourceLockError(
      "Semantic remediation requires a scan bound to the repository's full Git revision.",
    );
  }
  if (scan.findings.length === 0) {
    throw new SourceLockError("Semantic remediation requires at least one migration finding.");
  }

  const migrationEdgeIds = new Set<string>();
  let semanticVerifier: SemanticRemediationScope["semanticVerifier"] | undefined;
  for (const finding of scan.findings) {
    if (
      finding.kind !== "migration-blocked" ||
      finding.automationTier !== "B" ||
      !finding.reviewRequired ||
      finding.analysis.disposition !== "supported" ||
      finding.graphIssueIds.length > 0 ||
      finding.remediation.kind !== "none"
    ) {
      throw new SourceLockError(
        `Finding ${finding.id} is not eligible for frozen Tier B semantic remediation.`,
      );
    }

    const resolution = resolveMigrationPath(
      scan.migrationEdges,
      finding.resource,
      finding.language,
    );
    if (resolution.status !== "resolved" || resolution.automationTier !== "B") {
      throw new SourceLockError(
        `Finding ${finding.id} does not resolve to an unambiguous Tier B migration path.`,
      );
    }
    if (!sameStrings(finding.migrationEdgeIds, resolution.edgeIds)) {
      throw new SourceLockError(
        `Finding ${finding.id} migration path does not match the locked graph resolution.`,
      );
    }
    if (
      finding.language !== "typescript" ||
      finding.ruleId !== "openai.transcriptions.model.gpt-4o-mini-transcribe-2025-03-20" ||
      finding.resource.kind !== "model" ||
      finding.resource.id !== "gpt-4o-mini-transcribe-2025-03-20" ||
      resolution.to.kind !== "model"
    ) {
      throw new SourceLockError(
        `Finding ${finding.id} has no trusted deterministic semantic postcondition.`,
      );
    }
    const findingVerifier: SemanticRemediationScope["semanticVerifier"] = {
      id: "typescript-transcription-model-exact-rewrite-v1",
      sourceModel: finding.resource.id,
      targetModel: resolution.to.id,
    };
    if (
      semanticVerifier !== undefined &&
      canonicalJson(semanticVerifier) !== canonicalJson(findingVerifier)
    ) {
      throw new SourceLockError(
        "Semantic remediation findings do not share one trusted deterministic postcondition.",
      );
    }
    semanticVerifier = findingVerifier;
    for (const migrationEdgeId of resolution.edgeIds) {
      migrationEdgeIds.add(migrationEdgeId);
    }
  }
  if (semanticVerifier === undefined) {
    throw new SourceLockError("Semantic remediation has no trusted deterministic postcondition.");
  }

  const sourceFiles = [...request.sourceFiles].sort((left, right) =>
    compareStrings(left.path, right.path),
  );
  const allowedFiles = sourceFiles.map((file) => file.path);
  const requiredFiles = [...request.requiredFiles].sort(compareStrings);
  const findingFiles = [...new Set(scan.findings.map((finding) => finding.location.file))].sort(
    compareStrings,
  );
  if (!sameStrings(allowedFiles, findingFiles) || !sameStrings(requiredFiles, findingFiles)) {
    throw new SourceLockError(
      "Semantic remediation source and required files must exactly match finding files.",
    );
  }
  const verificationAdapterIds = ["typescript"];
  const selectedMigrationEdges = scan.migrationEdges
    .filter((edge) => migrationEdgeIds.has(edge.id))
    .sort((left, right) => compareStrings(left.id, right.id));
  if (selectedMigrationEdges.length !== migrationEdgeIds.size) {
    throw new SourceLockError("Semantic remediation cannot bind every selected migration edge.");
  }
  const allowedFileSet = new Set(allowedFiles);
  const requiredFileSet = new Set(requiredFiles);
  for (const finding of scan.findings) {
    if (!allowedFileSet.has(finding.location.file)) {
      throw new SourceLockError(
        `Semantic remediation does not expose finding file ${finding.location.file}.`,
      );
    }
    if (!requiredFileSet.has(finding.location.file)) {
      throw new SourceLockError(
        `Semantic remediation does not require finding file ${finding.location.file}.`,
      );
    }
    const frozenSource = sourceFiles.find((file) => file.path === finding.location.file);
    if (!frozenSource || frozenSource.beforeHash !== finding.fileHash) {
      throw new SourceLockError(
        `Semantic remediation source hash does not match finding file ${finding.location.file}.`,
      );
    }
  }

  return SemanticPatchPlanSchema.parse({
    schemaVersion: SEMANTIC_PLAN_SCHEMA_VERSION,
    kind: "semantic-patch-plan",
    status: "ready",
    findingIds: scan.findings.map((finding) => finding.id).sort(compareStrings),
    allowedFiles,
    forbiddenFiles: [...(request.forbiddenFiles ?? [])].sort(compareStrings),
    sourceLockHash: scan.sourceLockHash,
    verificationContracts: [...SEMANTIC_VERIFICATION_CONTRACTS],
    requiresCodex: true,
    semanticRemediation: {
      repositoryRevision: scan.repository.revision,
      instructions: [...request.instructions],
      sourceFiles,
      requiredFiles,
      migrationEdgeIds: [...migrationEdgeIds].sort(compareStrings),
      migrationEdgesHash: sha256(canonicalJson(selectedMigrationEdges)),
      verificationAdapterIds,
      semanticVerifier,
      behaviorContractHash: request.behaviorContractHash,
      baselineObservationHash: request.baselineObservationHash,
    },
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

export function createSemanticPlanReport(
  scan: ScanResult,
  request: CreateSemanticPatchPlanRequest,
): SemanticPlanReport {
  return SemanticPlanReportSchema.parse({
    schemaVersion: SEMANTIC_PLAN_SCHEMA_VERSION,
    kind: "semantic-plan",
    sourceLockHash: scan.sourceLockHash,
    migrationEdges: scan.migrationEdges,
    graphIssues: scan.graphIssues,
    findings: scan.findings,
    plan: createSemanticPatchPlan(scan, request),
  });
}
