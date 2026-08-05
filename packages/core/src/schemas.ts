import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const IsoTimestampSchema = z.string().datetime({ offset: true });
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
  schemaVersion: z.literal(SCHEMA_VERSION),
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
  languages: z.array(z.enum(["typescript", "python"])).min(1),
  sdkConstraints: z.array(z.string().min(1)).optional(),
  behaviorChanges: z.array(z.string().min(1)),
  automationTier: z.enum(["A", "B", "C"]),
  reviewRequired: z.boolean(),
});

export const MigrationRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  edge: MigrationEdgeSchema,
});

export const SourceLockSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
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

export const FindingSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: Sha256Schema,
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
  confidence: z.enum(["low", "medium", "high"]),
  automationTier: z.enum(["A", "B", "C"]),
  abstentionReason: z.string().min(1).optional(),
  remediation: z.object({
    kind: z.literal("replace-string-literal"),
    replacement: z.string().min(1),
  }),
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

export const PatchPlanSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  status: z.enum(["ready", "no-op", "blocked"]),
  findingIds: z.array(Sha256Schema),
  allowedFiles: z.array(RelativePathSchema),
  forbiddenFiles: z.array(RelativePathSchema),
  sourceLockHash: Sha256Schema,
  verificationContracts: z.array(z.string().min(1)),
  requiresCodex: z.boolean(),
  abstentionReasons: z.array(z.string().min(1)),
  edits: z.array(TextEditSchema),
});

export const ScanResultSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kind: z.literal("scan"),
  repository: z.object({ revision: z.string().min(1).nullable() }),
  sourceLockHash: Sha256Schema,
  scope: z.object({
    extensions: z.array(z.string().min(1)),
    exclusions: z.array(z.string().min(1)),
  }),
  migrationEdges: z.array(MigrationEdgeSchema),
  findings: z.array(FindingSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    blocking: z.number().int().nonnegative(),
  }),
});

export const PlanReportSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kind: z.literal("plan"),
  sourceLockHash: Sha256Schema,
  migrationEdges: z.array(MigrationEdgeSchema),
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
  schemaVersion: z.literal(SCHEMA_VERSION),
  kind: z.literal("migrate"),
  sourceLockHash: Sha256Schema,
  migrationEdges: z.array(MigrationEdgeSchema),
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

export const VerificationResultSchema = z.object({
  passed: z.boolean(),
  runtimeBehaviorVerified: z.boolean(),
  checks: z.array(VerificationCheckSchema),
  changedFiles: z.array(RelativePathSchema),
});

export const VerifyReportSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kind: z.literal("verify"),
  sourceLockHash: Sha256Schema,
  migrationEdges: z.array(MigrationEdgeSchema),
  findings: z.array(FindingSchema),
  plan: PatchPlanSchema,
  verification: VerificationResultSchema,
});

export type ResourceRef = z.infer<typeof ResourceRefSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export type MigrationEdge = z.infer<typeof MigrationEdgeSchema>;
export type SourceLock = z.infer<typeof SourceLockSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type TextEdit = z.infer<typeof TextEditSchema>;
export type PatchPlan = z.infer<typeof PatchPlanSchema>;
export type ScanResult = z.infer<typeof ScanResultSchema>;
export type PlanReport = z.infer<typeof PlanReportSchema>;
export type PatchPreview = z.infer<typeof PatchPreviewSchema>;
export type PatchPreviewFile = z.infer<typeof PatchPreviewFileSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export type VerifyReport = z.infer<typeof VerifyReportSchema>;
export type Report = ScanResult | PlanReport | PatchPreview | VerifyReport;
