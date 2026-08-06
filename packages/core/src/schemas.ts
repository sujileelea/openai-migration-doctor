import { z } from "zod";
import type { BehaviorVerifyReport } from "./behavior.js";

export const SOURCE_SCHEMA_VERSION = "1.0.0" as const;
export const REPORT_SCHEMA_VERSION = "3.0.0" as const;

export const DETERMINISTIC_VERIFICATION_CONTRACTS = [
  "changed_files_allowlist",
  "finding_resolved",
  "literal_replacement_only",
  "original_repository_unchanged",
] as const;

export const ANALYSIS_ONLY_VERIFICATION_CONTRACTS = [
  "manual_migration_resolved",
  "no_automatic_transformation",
  "original_repository_unchanged",
] as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const IsoTimestampSchema = z.string().datetime({ offset: true });
export const MigrationLanguageSchema = z.enum(["typescript", "python"]);
export const AnalysisFamilySchema = z.enum(["model-snapshot", "assistants-api"]);
export const AnalysisFeatureSchema = z.enum([
  "model-snapshot",
  "assistants",
  "threads",
  "runs",
  "streaming",
  "tools",
  "file-search",
  "code-interpreter",
]);
export const AnalysisPatternSchema = z.enum([
  "direct",
  "import-alias",
  "property-alias",
  "client-alias",
  "wrapper",
  "method-alias",
  "dynamic-member",
  "dynamic-request",
  "indirect-invocation",
]);
export const AnalysisDispositionSchema = z.enum(["supported", "abstained"]);
const StableReasonCodeSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Expected a stable kebab-case reason code.");
const RelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "Expected a safe relative POSIX path.",
  });

const resourceShape = {
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
};

export const ResourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model"), ...resourceShape }),
  z.object({ kind: z.literal("api"), ...resourceShape }),
  z.object({ kind: z.literal("sdk-symbol"), ...resourceShape }),
  z.object({ kind: z.literal("product"), ...resourceShape }),
]);

export const SourceRefSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  retrievedAt: IsoTimestampSchema,
  contentHash: Sha256Schema,
});

export const SourceRecordSchema = z.object({
  schemaVersion: z.literal(SOURCE_SCHEMA_VERSION),
  id: z.string().min(1),
  source: SourceRefSchema,
  claims: z.array(z.string().min(1)).min(1),
});

export const MigrationEdgeSchema = z.object({
  id: z.string().min(1),
  from: ResourceRefSchema,
  to: ResourceRefSchema.nullable(),
  announcedAt: IsoDateSchema.optional(),
  shutdownAt: IsoDateSchema.optional(),
  sources: z.array(SourceRefSchema).min(1),
  languages: z.array(MigrationLanguageSchema).min(1),
  sdkConstraints: z.array(z.string().min(1)).optional(),
  behaviorChanges: z.array(z.string().min(1)),
  automationTier: z.enum(["A", "B", "C"]),
  reviewRequired: z.boolean(),
});

export const MigrationRecordSchema = z.object({
  schemaVersion: z.literal(SOURCE_SCHEMA_VERSION),
  edge: MigrationEdgeSchema,
});

export const MigrationGraphIssueSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    id: Sha256Schema,
    kind: z.enum(["source-conflict", "cycle", "missing-destination", "unverified-constraint"]),
    language: MigrationLanguageSchema,
    resource: ResourceRefSchema,
    edgeIds: z.array(z.string().min(1)).min(1),
    sources: z.array(SourceRefSchema).min(1),
    message: z.string().min(1),
    reviewRequired: z.literal(true),
  })
  .superRefine((issue, context) => {
    if (new Set(issue.edgeIds).size !== issue.edgeIds.length) {
      context.addIssue({
        code: "custom",
        message: "Graph issue edge IDs must be unique.",
        path: ["edgeIds"],
      });
    }
  });

export const SourceLockSchema = z.object({
  schemaVersion: z.literal(SOURCE_SCHEMA_VERSION),
  createdAt: IsoTimestampSchema,
  artifacts: z
    .array(
      z.object({
        kind: z.enum(["source", "migration"]),
        path: RelativePathSchema,
        sha256: Sha256Schema,
      }),
    )
    .min(1),
});

export const AnalysisClassificationSchema = z.object({
  family: AnalysisFamilySchema,
  feature: AnalysisFeatureSchema,
  pattern: AnalysisPatternSchema,
  disposition: AnalysisDispositionSchema,
  reasonCode: StableReasonCodeSchema.optional(),
});

export const FindingSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    id: Sha256Schema,
    kind: z.enum([
      "deprecated-usage",
      "source-conflict",
      "migration-blocked",
      "analysis-only",
      "unsupported-pattern",
    ]),
    language: MigrationLanguageSchema,
    resource: ResourceRefSchema,
    ruleId: z.string().min(1),
    severity: z.enum(["info", "warning", "error"]),
    location: z.object({
      file: RelativePathSchema,
      line: z.number().int().positive(),
      column: z.number().int().positive(),
      startOffset: z.number().int().nonnegative(),
      endOffset: z.number().int().positive(),
    }),
    fileHash: Sha256Schema,
    evidence: z.string().min(1),
    migrationEdgeIds: z.array(z.string().min(1)).min(1),
    graphIssueIds: z.array(Sha256Schema),
    confidence: z.enum(["low", "medium", "high"]),
    automationTier: z.enum(["A", "B", "C"]),
    reviewRequired: z.boolean(),
    analysis: AnalysisClassificationSchema,
    abstentionReason: z.string().min(1).optional(),
    remediation: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("replace-string-literal"),
        replacement: z.string().min(1),
      }),
      z.object({ kind: z.literal("none") }),
    ]),
  })
  .superRefine((finding, context) => {
    if (finding.location.endOffset <= finding.location.startOffset) {
      context.addIssue({
        code: "custom",
        message: "Finding end offset must be greater than its start offset.",
        path: ["location", "endOffset"],
      });
    }
    if (new Set(finding.migrationEdgeIds).size !== finding.migrationEdgeIds.length) {
      context.addIssue({
        code: "custom",
        message: "Finding migration edge IDs must be unique.",
        path: ["migrationEdgeIds"],
      });
    }
    if (new Set(finding.graphIssueIds).size !== finding.graphIssueIds.length) {
      context.addIssue({
        code: "custom",
        message: "Finding graph issue IDs must be unique.",
        path: ["graphIssueIds"],
      });
    }
    if (finding.remediation.kind === "none" && !finding.abstentionReason) {
      context.addIssue({
        code: "custom",
        message: "A finding without remediation requires an abstention reason.",
        path: ["abstentionReason"],
      });
    }
    if (
      finding.kind === "deprecated-usage" &&
      finding.automationTier === "A" &&
      finding.remediation.kind !== "replace-string-literal"
    ) {
      context.addIssue({
        code: "custom",
        message: "A Tier A deprecated-usage finding requires a replacement.",
        path: ["remediation"],
      });
    }
    if (
      finding.remediation.kind === "replace-string-literal" &&
      (finding.resource.kind !== "model" || finding.evidence !== finding.resource.id)
    ) {
      context.addIssue({
        code: "custom",
        message: "A string-literal replacement must be bound to its detected model resource.",
        path: ["remediation"],
      });
    }
    if (finding.kind === "migration-blocked" && finding.remediation.kind !== "none") {
      context.addIssue({
        code: "custom",
        message: "A blocked migration cannot contain a deterministic replacement.",
        path: ["remediation"],
      });
    }
    if (
      finding.kind === "analysis-only" &&
      (finding.automationTier !== "C" ||
        !finding.reviewRequired ||
        finding.analysis.disposition !== "supported" ||
        finding.remediation.kind !== "none")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An analysis-only finding must be a supported Tier C detection with human review and no remediation.",
        path: ["kind"],
      });
    }
    if (
      finding.kind === "unsupported-pattern" &&
      (finding.automationTier !== "C" ||
        !finding.reviewRequired ||
        finding.analysis.disposition !== "abstained" ||
        !finding.analysis.reasonCode ||
        finding.remediation.kind !== "none")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An unsupported-pattern finding must abstain at Tier C with a stable reason code, human review, and no remediation.",
        path: ["kind"],
      });
    }
    if (
      finding.kind === "source-conflict" &&
      (finding.automationTier !== "C" ||
        !finding.reviewRequired ||
        finding.graphIssueIds.length === 0 ||
        finding.remediation.kind !== "none")
    ) {
      context.addIssue({
        code: "custom",
        message: "A source conflict must abstain at Tier C with a graph issue and human review.",
        path: ["kind"],
      });
    }
  });

export const ManualActionSchema = z
  .object({
    findingId: Sha256Schema,
    migrationEdgeIds: z.array(z.string().min(1)).min(1),
    target: ResourceRefSchema.nullable(),
    reason: z.string().min(1),
    reasonCode: StableReasonCodeSchema,
    behaviorChanges: z.array(z.string().min(1)),
  })
  .superRefine((action, context) => {
    if (new Set(action.migrationEdgeIds).size !== action.migrationEdgeIds.length) {
      context.addIssue({
        code: "custom",
        message: "Manual action migration edge IDs must be unique.",
        path: ["migrationEdgeIds"],
      });
    }
    if (new Set(action.behaviorChanges).size !== action.behaviorChanges.length) {
      context.addIssue({
        code: "custom",
        message: "Manual action behavior changes must be unique.",
        path: ["behaviorChanges"],
      });
    }
  });

export const TextEditSchema = z.object({
  id: Sha256Schema,
  findingId: Sha256Schema,
  file: RelativePathSchema,
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  expectedText: z.string().min(1),
  replacementText: z.string().min(1),
  originalFileHash: Sha256Schema,
});

export const PatchPlanSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    status: z.enum(["ready", "no-op", "blocked"]),
    findingIds: z.array(Sha256Schema),
    allowedFiles: z.array(RelativePathSchema),
    forbiddenFiles: z.array(RelativePathSchema),
    sourceLockHash: Sha256Schema,
    verificationContracts: z.array(z.string().min(1)),
    requiresCodex: z.boolean(),
    abstentionReasons: z.array(z.string().min(1)),
    manualActions: z.array(ManualActionSchema),
    edits: z.array(TextEditSchema),
  })
  .superRefine((plan, context) => {
    const expectedStatus =
      plan.abstentionReasons.length > 0 || plan.manualActions.length > 0
        ? "blocked"
        : plan.edits.length > 0
          ? "ready"
          : "no-op";
    if (plan.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        message: `Patch plan status must be ${expectedStatus} for its edits and abstentions.`,
        path: ["status"],
      });
    }
    if (plan.status === "blocked" && plan.edits.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A blocked patch plan cannot contain partial edits.",
        path: ["edits"],
      });
    }
    if (
      new Set(plan.manualActions.map((action) => action.findingId)).size !==
      plan.manualActions.length
    ) {
      context.addIssue({
        code: "custom",
        message: "A patch plan can contain at most one manual action per finding.",
        path: ["manualActions"],
      });
    }
    const expectedContracts =
      plan.status === "blocked"
        ? ANALYSIS_ONLY_VERIFICATION_CONTRACTS
        : DETERMINISTIC_VERIFICATION_CONTRACTS;
    if (
      plan.verificationContracts.length !== expectedContracts.length ||
      !plan.verificationContracts.every((contract, index) => contract === expectedContracts[index])
    ) {
      context.addIssue({
        code: "custom",
        message:
          plan.status === "blocked"
            ? "A blocked patch plan must use only analysis verification contracts."
            : "A ready or no-op patch plan must use deterministic edit verification contracts.",
        path: ["verificationContracts"],
      });
    }
    if (plan.status === "blocked" && plan.requiresCodex) {
      context.addIssue({
        code: "custom",
        message: "A blocked analysis plan cannot require Codex.",
        path: ["requiresCodex"],
      });
    }
  });

export const ScanResultSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    kind: z.literal("scan"),
    repository: z.object({ revision: z.string().min(1).nullable() }),
    sourceLockHash: Sha256Schema,
    scope: z.object({
      extensions: z.array(z.string().min(1)),
      exclusions: z.array(z.string().min(1)),
    }),
    migrationEdges: z.array(MigrationEdgeSchema),
    graphIssues: z.array(MigrationGraphIssueSchema),
    findings: z.array(FindingSchema),
    summary: z.object({
      total: z.number().int().nonnegative(),
      blocking: z.number().int().nonnegative(),
      graphIssues: z.number().int().nonnegative(),
    }),
  })
  .superRefine((scan, context) => {
    if (scan.summary.total !== scan.findings.length) {
      context.addIssue({
        code: "custom",
        message: "Scan total must match the finding count.",
        path: ["summary", "total"],
      });
    }
    const blocking = scan.findings.filter((finding) => finding.severity === "error").length;
    if (scan.summary.blocking !== blocking) {
      context.addIssue({
        code: "custom",
        message: "Scan blocking total must match error findings.",
        path: ["summary", "blocking"],
      });
    }
    if (scan.summary.graphIssues !== scan.graphIssues.length) {
      context.addIssue({
        code: "custom",
        message: "Scan graph issue total must match graph issues.",
        path: ["summary", "graphIssues"],
      });
    }
  });

export const PlanReportSchema = z.object({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  kind: z.literal("plan"),
  sourceLockHash: Sha256Schema,
  migrationEdges: z.array(MigrationEdgeSchema),
  graphIssues: z.array(MigrationGraphIssueSchema),
  findings: z.array(FindingSchema),
  plan: PatchPlanSchema,
});

export const PatchPreviewFileSchema = z.object({
  path: RelativePathSchema,
  beforeHash: Sha256Schema,
  afterHash: Sha256Schema,
  diff: z.string(),
  edits: z.array(TextEditSchema),
});

export const PatchPreviewSchema = z.object({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  kind: z.literal("migrate"),
  sourceLockHash: Sha256Schema,
  migrationEdges: z.array(MigrationEdgeSchema),
  graphIssues: z.array(MigrationGraphIssueSchema),
  findings: z.array(FindingSchema),
  plan: PatchPlanSchema,
  files: z.array(PatchPreviewFileSchema),
  applied: z.literal(false),
});

export const VerificationCheckSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  evidence: z.array(z.string()),
});

export const VerificationResultSchema = z
  .object({
    passed: z.boolean(),
    runtimeBehaviorVerified: z.boolean(),
    checks: z.array(VerificationCheckSchema),
    changedFiles: z.array(RelativePathSchema),
  })
  .superRefine((verification, context) => {
    if (verification.passed !== verification.checks.every((check) => check.passed)) {
      context.addIssue({
        code: "custom",
        message: "Verification status must match its check results.",
        path: ["passed"],
      });
    }
  });

export const VerifyReportSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    kind: z.literal("verify"),
    sourceLockHash: Sha256Schema,
    migrationEdges: z.array(MigrationEdgeSchema),
    graphIssues: z.array(MigrationGraphIssueSchema),
    findings: z.array(FindingSchema),
    plan: PatchPlanSchema,
    verification: VerificationResultSchema,
  })
  .superRefine((report, context) => {
    const checkIds = report.verification.checks.map((check) => check.id);
    if (
      checkIds.length !== report.plan.verificationContracts.length ||
      !checkIds.every((id, index) => id === report.plan.verificationContracts[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Verification checks must match the patch plan contracts in order.",
        path: ["verification", "checks"],
      });
    }
  });

export type ResourceRef = z.infer<typeof ResourceRefSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export type MigrationEdge = z.infer<typeof MigrationEdgeSchema>;
export type MigrationLanguage = z.infer<typeof MigrationLanguageSchema>;
export type AnalysisFamily = z.infer<typeof AnalysisFamilySchema>;
export type AnalysisFeature = z.infer<typeof AnalysisFeatureSchema>;
export type AnalysisPattern = z.infer<typeof AnalysisPatternSchema>;
export type AnalysisDisposition = z.infer<typeof AnalysisDispositionSchema>;
export type AnalysisClassification = z.infer<typeof AnalysisClassificationSchema>;
export type MigrationGraphIssue = z.infer<typeof MigrationGraphIssueSchema>;
export type SourceLock = z.infer<typeof SourceLockSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type ManualAction = z.infer<typeof ManualActionSchema>;
export type TextEdit = z.infer<typeof TextEditSchema>;
export type PatchPlan = z.infer<typeof PatchPlanSchema>;
export type ScanResult = z.infer<typeof ScanResultSchema>;
export type PlanReport = z.infer<typeof PlanReportSchema>;
export type PatchPreview = z.infer<typeof PatchPreviewSchema>;
export type PatchPreviewFile = z.infer<typeof PatchPreviewFileSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export type VerifyReport = z.infer<typeof VerifyReportSchema>;
export type Report = ScanResult | PlanReport | PatchPreview | VerifyReport | BehaviorVerifyReport;
