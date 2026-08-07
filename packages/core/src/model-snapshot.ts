import { AnalysisError } from "./errors.js";
import type { MigrationResolution } from "./graph.js";
import { sha256 } from "./hash.js";
import {
  type AnalysisPattern,
  type Finding,
  type MigrationLanguage,
  REPORT_SCHEMA_VERSION,
} from "./schemas.js";

export type ModelSnapshotResolution = Exclude<MigrationResolution, { status: "unmapped" }>;

export type ModelSnapshotFindingPolicy = Pick<
  Finding,
  | "kind"
  | "migrationEdgeIds"
  | "graphIssueIds"
  | "automationTier"
  | "reviewRequired"
  | "abstentionReason"
  | "remediation"
>;

export function deriveModelSnapshotFindingPolicy(
  resolution: ModelSnapshotResolution,
): ModelSnapshotFindingPolicy {
  const deterministicReplacement =
    resolution.status === "resolved" &&
    resolution.automationTier === "A" &&
    resolution.to.kind === "model";
  const automationTier =
    resolution.status === "blocked"
      ? "C"
      : resolution.to.kind !== "model"
        ? "C"
        : resolution.automationTier;
  const abstentionReason =
    resolution.status === "blocked"
      ? resolution.issue.message
      : resolution.to.kind !== "model"
        ? `Terminal migration destination ${resolution.to.kind}:${resolution.to.id} is not a model literal.`
        : resolution.automationTier !== "A"
          ? `Migration path requires Tier ${resolution.automationTier} review.`
          : undefined;

  return {
    kind:
      resolution.status === "blocked" && resolution.issue.kind === "source-conflict"
        ? "source-conflict"
        : deterministicReplacement
          ? "deprecated-usage"
          : "migration-blocked",
    migrationEdgeIds: resolution.edgeIds,
    graphIssueIds: resolution.issue ? [resolution.issue.id] : [],
    automationTier,
    reviewRequired:
      resolution.reviewRequired || !deterministicReplacement || automationTier !== "A",
    ...(abstentionReason ? { abstentionReason } : {}),
    remediation: deterministicReplacement
      ? { kind: "replace-string-literal", replacement: resolution.to.id }
      : { kind: "none" },
  };
}

export function createModelSnapshotFinding(request: {
  language: MigrationLanguage;
  ruleId: string;
  sourceModel: string;
  analysisPattern?: AnalysisPattern;
  relativeFile: string;
  content: string;
  location: Finding["location"];
  resolution: ModelSnapshotResolution;
}): Finding {
  if (
    request.location.file !== request.relativeFile ||
    request.content.slice(request.location.startOffset, request.location.endOffset) !==
      request.sourceModel
  ) {
    throw new AnalysisError(`Model-snapshot source range does not match ${request.relativeFile}.`);
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    id: sha256(
      [
        request.ruleId,
        request.resolution.edgeIds.join("\u0001"),
        request.relativeFile,
        request.location.startOffset,
        request.location.endOffset,
      ].join("\u0000"),
    ),
    language: request.language,
    resource: { kind: "model", id: request.sourceModel },
    ruleId: request.ruleId,
    severity: "error",
    location: request.location,
    fileHash: sha256(request.content),
    evidence: request.sourceModel,
    confidence: "high",
    analysis: {
      family: "model-snapshot",
      feature: "model-snapshot",
      pattern: request.analysisPattern ?? "direct",
      disposition: "supported",
    },
    ...deriveModelSnapshotFindingPolicy(request.resolution),
  };
}
