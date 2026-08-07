import { z } from "zod";
import { REPORT_SCHEMA_VERSION, VerifyReportSchema } from "./schemas.js";

export const RepositoryCommandStatusSchema = z.enum([
  "passed",
  "failed",
  "timed-out",
  "output-limit",
  "spawn-error",
  "skipped-static-verification",
  "skipped-source-changed",
  "skipped-prior-command-failure",
]);

export const RepositoryCommandEvidenceSchema = z
  .object({
    id: z.string().regex(/^repository_command_[1-9][0-9]*$/u),
    argvHash: z.string().regex(/^[a-f0-9]{64}$/u),
    passed: z.boolean(),
    status: RepositoryCommandStatusSchema,
    exitCode: z.number().int().nonnegative().nullable(),
    timeoutMs: z.number().int().positive().max(600_000),
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.passed !== (command.status === "passed" && command.exitCode === 0)) {
      context.addIssue({
        code: "custom",
        message: "Repository command status, exit code, and pass state must agree.",
        path: ["passed"],
      });
    }
  });

export const RepositoryVerifyReportSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    kind: z.literal("repository-verify"),
    evidenceScope: z.literal("operator-supplied-commands"),
    executionBoundary: z.literal("temporary-copy"),
    shellUsed: z.literal(false),
    ambientCredentialsInherited: z.literal(false),
    networkIsolationEnforced: z.literal(false),
    runtimeBehaviorVerified: z.literal(false),
    treeHashScope: z.literal("scanner-visible-files"),
    passed: z.boolean(),
    staticVerification: VerifyReportSchema,
    commands: z.array(RepositoryCommandEvidenceSchema).min(1),
    candidatePatchPreserved: z.boolean(),
    originalAnalyzedTreeUnchanged: z.boolean(),
  })
  .strict()
  .superRefine((report, context) => {
    for (const [index, command] of report.commands.entries()) {
      if (command.id !== `repository_command_${index + 1}`) {
        context.addIssue({
          code: "custom",
          message: "Repository command IDs must be sequential and ordered.",
          path: ["commands", index, "id"],
        });
      }
    }
    const expectedPassed =
      report.staticVerification.verification.passed &&
      report.commands.every((command) => command.passed) &&
      report.candidatePatchPreserved &&
      report.originalAnalyzedTreeUnchanged;
    if (report.passed !== expectedPassed) {
      context.addIssue({
        code: "custom",
        message: "Repository verification status must match every recorded check.",
        path: ["passed"],
      });
    }
  });

export type RepositoryCommandStatus = z.infer<typeof RepositoryCommandStatusSchema>;
export type RepositoryCommandEvidence = z.infer<typeof RepositoryCommandEvidenceSchema>;
export type RepositoryVerifyReport = z.infer<typeof RepositoryVerifyReportSchema>;

export function createRepositoryVerifyReport(input: {
  staticVerification: z.infer<typeof VerifyReportSchema>;
  commands: RepositoryCommandEvidence[];
  candidatePatchPreserved: boolean;
  originalAnalyzedTreeUnchanged: boolean;
}): RepositoryVerifyReport {
  return RepositoryVerifyReportSchema.parse({
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "repository-verify",
    evidenceScope: "operator-supplied-commands",
    executionBoundary: "temporary-copy",
    shellUsed: false,
    ambientCredentialsInherited: false,
    networkIsolationEnforced: false,
    runtimeBehaviorVerified: false,
    treeHashScope: "scanner-visible-files",
    passed:
      input.staticVerification.verification.passed &&
      input.commands.every((command) => command.passed) &&
      input.candidatePatchPreserved &&
      input.originalAnalyzedTreeUnchanged,
    staticVerification: input.staticVerification,
    commands: input.commands,
    candidatePatchPreserved: input.candidatePatchPreserved,
    originalAnalyzedTreeUnchanged: input.originalAnalyzedTreeUnchanged,
  });
}
