import { canonicalJson, SemanticVerifierSchema, sha256 } from "@migration-doctor/core";
import { z } from "zod";

export const CODEX_SCHEMA_VERSION = "1.0.0" as const;

export const CODEX_AUDIT_CHECKS = [
  "plan_binding",
  "repository_revision_binding",
  "workspace_isolation",
  "structured_output",
  "external_action_policy",
  "changed_files_allowlist",
  "proposal_hashes_match",
  "repository_contracts",
  "declared_behavior_fixture",
  "original_repository_revision_unchanged",
] as const;

export const CodexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const CodexGitRevisionSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, "Expected a full Git object ID.");

export const CodexRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => {
      if (
        value.startsWith("/") ||
        /^[a-zA-Z]:/u.test(value) ||
        value.includes("\\") ||
        [...value].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
        })
      ) {
        return false;
      }

      const segments = value.split("/");
      return (
        segments.length <= 32 &&
        segments.every(
          (segment) =>
            segment.length > 0 &&
            segment !== "." &&
            segment !== ".." &&
            !segment.includes(":") &&
            !/[. ]$/u.test(segment) &&
            !/^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment),
        )
      );
    },
    { message: "Expected a safe relative POSIX path." },
  );

const StableIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "Expected a stable report-safe identifier.");
const StableReasonCodeSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Expected a stable kebab-case reason code.");
const SemanticVerificationContractsSchema = z.tuple([
  z.literal("changed_files_allowlist"),
  z.literal("finding_resolved"),
  z.literal("semantic_postcondition"),
  z.literal("original_repository_revision_unchanged"),
]);
const TypeScriptVerificationAdaptersSchema = z.tuple([z.literal("typescript")]);

function addUniqueIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      message: `${label} must be unique.`,
      path,
    });
  }
}

function addPortablePathCollisionIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string,
): void {
  const portableKeys = values.map((value) => value.normalize("NFC").toLowerCase());
  if (new Set(portableKeys).size !== portableKeys.length) {
    context.addIssue({
      code: "custom",
      message: `${label} must not collide by case or Unicode normalization.`,
      path,
    });
  }
}

function portablePathKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function isSensitiveExposure(value: string): boolean {
  const segments = value.toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments.includes(".git") ||
    segments.includes(".codex") ||
    segments.includes(".agents") ||
    name === "agents.md" ||
    name === "agents.override.md" ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name === "auth.json" ||
    name === "credentials.json" ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    name.endsWith(".key") ||
    name.endsWith(".pem") ||
    name.endsWith(".p12") ||
    name.endsWith(".pfx")
  );
}

export const CodexExposedFileSchema = z
  .object({
    path: CodexRelativePathSchema.refine((value) => !isSensitiveExposure(value), {
      message: "Codex scope cannot expose a credential or secret-bearing path.",
    }),
    beforeHash: CodexSha256Schema,
  })
  .strict();

export const CodexRemediationManifestSchema = z
  .object({
    schemaVersion: z.literal(CODEX_SCHEMA_VERSION),
    planHash: CodexSha256Schema,
    sourceLockHash: CodexSha256Schema,
    repositoryRevision: CodexGitRevisionSchema,
    exposedFiles: z.array(CodexExposedFileSchema).min(1).max(64),
    requiredFiles: z.array(CodexRelativePathSchema).min(1).max(64),
    forbiddenFiles: z.array(CodexRelativePathSchema).max(256),
    migrationEdgeIds: z.array(StableIdentifierSchema).min(1).max(64),
    migrationEdgesHash: CodexSha256Schema,
    verificationAdapterIds: TypeScriptVerificationAdaptersSchema,
    semanticVerifier: SemanticVerifierSchema,
    behaviorContractHash: CodexSha256Schema,
    baselineObservationHash: CodexSha256Schema,
    instructions: z.array(z.string().min(1).max(4000)).min(1).max(32),
  })
  .strict()
  .superRefine((manifest, context) => {
    const exposedPaths = manifest.exposedFiles.map((file) => file.path);
    addUniqueIssue(exposedPaths, context, ["exposedFiles"], "Exposed file paths");
    addPortablePathCollisionIssue(exposedPaths, context, ["exposedFiles"], "Exposed file paths");
    addUniqueIssue(manifest.requiredFiles, context, ["requiredFiles"], "Required file paths");
    addPortablePathCollisionIssue(
      manifest.requiredFiles,
      context,
      ["requiredFiles"],
      "Required file paths",
    );
    addUniqueIssue(manifest.forbiddenFiles, context, ["forbiddenFiles"], "Forbidden file paths");
    addPortablePathCollisionIssue(
      manifest.forbiddenFiles,
      context,
      ["forbiddenFiles"],
      "Forbidden file paths",
    );
    addUniqueIssue(manifest.migrationEdgeIds, context, ["migrationEdgeIds"], "Migration edge IDs");
    addUniqueIssue(
      manifest.verificationAdapterIds,
      context,
      ["verificationAdapterIds"],
      "Verification adapter IDs",
    );
    addUniqueIssue(manifest.instructions, context, ["instructions"], "Instructions");

    const exposed = new Set(exposedPaths.map(portablePathKey));
    const forbidden = new Set(manifest.forbiddenFiles.map(portablePathKey));
    for (const [index, file] of manifest.requiredFiles.entries()) {
      if (!exposed.has(portablePathKey(file))) {
        context.addIssue({
          code: "custom",
          message: "Every required file must also be exposed.",
          path: ["requiredFiles", index],
        });
      }
    }
    for (const [index, file] of exposedPaths.entries()) {
      if (forbidden.has(portablePathKey(file))) {
        context.addIssue({
          code: "custom",
          message: "An exposed file cannot also be forbidden.",
          path: ["exposedFiles", index, "path"],
        });
      }
    }
  });

export const CodexProposalSchema = z
  .object({
    schemaVersion: z.literal(CODEX_SCHEMA_VERSION),
    status: z.enum(["completed", "abstained"]),
    planHash: CodexSha256Schema,
    changedFiles: z.array(CodexRelativePathSchema).max(64),
    reasonCode: StableReasonCodeSchema.optional(),
  })
  .strict()
  .superRefine((proposal, context) => {
    addUniqueIssue(proposal.changedFiles, context, ["changedFiles"], "Changed file paths");
    addPortablePathCollisionIssue(
      proposal.changedFiles,
      context,
      ["changedFiles"],
      "Changed file paths",
    );

    if (proposal.status === "completed") {
      if (proposal.changedFiles.length === 0) {
        context.addIssue({
          code: "custom",
          message: "A completed proposal must declare at least one changed file.",
          path: ["changedFiles"],
        });
      }
      if (proposal.reasonCode !== undefined) {
        context.addIssue({
          code: "custom",
          message: "A completed proposal cannot contain an abstention reason code.",
          path: ["reasonCode"],
        });
      }
      return;
    }

    if (proposal.changedFiles.length > 0) {
      context.addIssue({
        code: "custom",
        message: "An abstained proposal cannot declare changed files.",
        path: ["changedFiles"],
      });
    }
    if (proposal.reasonCode === undefined) {
      context.addIssue({
        code: "custom",
        message: "An abstained proposal requires a stable reason code.",
        path: ["reasonCode"],
      });
    }
  });

export const CodexChangeRecordSchema = z
  .object({
    path: CodexRelativePathSchema,
    beforeHash: CodexSha256Schema.nullable(),
    afterHash: CodexSha256Schema.nullable(),
  })
  .strict()
  .superRefine((change, context) => {
    if (change.beforeHash === null && change.afterHash === null) {
      context.addIssue({
        code: "custom",
        message: "A change record must contain a before or after hash.",
        path: ["beforeHash"],
      });
    }
    if (change.beforeHash !== null && change.beforeHash === change.afterHash) {
      context.addIssue({
        code: "custom",
        message: "A change record must describe different before and after states.",
        path: ["afterHash"],
      });
    }
  });

const CodexAuditCheckIdSchema = z.enum(CODEX_AUDIT_CHECKS);

export const CodexAuditCheckSchema = z
  .object({
    id: CodexAuditCheckIdSchema,
    passed: z.boolean(),
    reasonCodes: z.array(StableReasonCodeSchema).max(32),
    paths: z.array(CodexRelativePathSchema).max(256),
  })
  .strict()
  .superRefine((check, context) => {
    addUniqueIssue(check.reasonCodes, context, ["reasonCodes"], "Audit reason codes");
    addUniqueIssue(check.paths, context, ["paths"], "Audit evidence paths");
  });

export const CodexSandboxPolicySchema = z
  .object({
    id: z.literal("workspace-only-no-shell-v2"),
    isolation: z.literal("codex-permission-profile"),
    filesystemAccess: z.literal("host-root-denied-workspace-write"),
    toolNetworkAccess: z.literal("disabled"),
    controllerNetworkAccess: z.literal("openai-api-required"),
    configurationIsolation: z.literal("disposable-home-no-managed-layers"),
    authentication: z.literal("single-run-api-key"),
    bundledSkills: z.literal("disabled-reviewed-set"),
    approvalPolicy: z.literal("never"),
    shellAccess: z.literal("disabled"),
    nonFileTools: z.literal("configured-disabled-or-observed-fail-closed"),
    shellEnvironmentInheritance: z.literal("none"),
    externalActions: z.literal("blocked-by-disabled-tools-and-tool-network"),
    persistence: z.literal("disposable-codex-home"),
    secretAccess: z.literal("host-root-denied-sensitive-paths-rejected"),
    migrationExecution: z.literal("blocked-by-disabled-shell"),
  })
  .strict();

export const CodexAdapterIdentitySchema = z
  .object({
    id: z.literal("codex-exec"),
    policyId: z.literal("workspace-only-no-shell-v2"),
    cliVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/u)
      .nullable(),
    requestedExecutableHash: CodexSha256Schema,
    executableHash: CodexSha256Schema.nullable(),
    requestedModel: StableIdentifierSchema,
    tokenUsage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative(),
        cacheWriteInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        reasoningOutputTokens: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const CodexRepositoryProofSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("not-run"),
      verificationContracts: SemanticVerificationContractsSchema,
      candidatePatchHash: CodexSha256Schema,
      verificationAdapterIds: TypeScriptVerificationAdaptersSchema,
      semanticVerifierId: z.literal("typescript-transcription-model-exact-rewrite-v1"),
      repositoryCodeExecuted: z.literal(false),
      reportHash: z.null(),
      passed: z.literal(false),
    })
    .strict(),
  z
    .object({
      status: z.literal("completed"),
      verificationContracts: SemanticVerificationContractsSchema,
      candidatePatchHash: CodexSha256Schema,
      verificationAdapterIds: TypeScriptVerificationAdaptersSchema,
      semanticVerifierId: z.literal("typescript-transcription-model-exact-rewrite-v1"),
      repositoryCodeExecuted: z.literal(false),
      reportHash: CodexSha256Schema,
      passed: z.boolean(),
    })
    .strict(),
]);

export const CodexBehaviorProofSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("not-run"),
      contractHash: CodexSha256Schema,
      baselineObservationHash: CodexSha256Schema,
      candidateObservationHash: z.null(),
      reportHash: z.null(),
      evidenceScope: z.literal("offline-fixture"),
      liveApiUsed: z.literal(false),
      provenance: z.literal("caller-supplied-offline-fixture"),
      repositoryRuntimeVerified: z.literal(false),
      passed: z.literal(false),
    })
    .strict(),
  z
    .object({
      status: z.literal("completed"),
      contractHash: CodexSha256Schema,
      baselineObservationHash: CodexSha256Schema,
      candidateObservationHash: CodexSha256Schema,
      reportHash: CodexSha256Schema,
      evidenceScope: z.literal("offline-fixture"),
      liveApiUsed: z.literal(false),
      provenance: z.literal("caller-supplied-offline-fixture"),
      repositoryRuntimeVerified: z.literal(false),
      passed: z.boolean(),
    })
    .strict(),
]);

export const CodexRemediationAuditSchema = z
  .object({
    schemaVersion: z.literal(CODEX_SCHEMA_VERSION),
    kind: z.literal("codex-remediation-audit"),
    status: z.enum(["passed", "failed", "abstained"]),
    proposalStatus: z.enum(["completed", "abstained", "unavailable"]),
    sourceLockHash: CodexSha256Schema,
    repositoryRevision: CodexGitRevisionSchema,
    planHash: CodexSha256Schema,
    manifestHash: CodexSha256Schema,
    proposalHash: CodexSha256Schema.nullable(),
    originalRepositoryRevisions: z
      .object({
        before: CodexGitRevisionSchema,
        after: CodexGitRevisionSchema.nullable(),
      })
      .strict(),
    exposedFiles: z.array(CodexExposedFileSchema).min(1).max(64),
    requiredFiles: z.array(CodexRelativePathSchema).min(1).max(64),
    forbiddenFiles: z.array(CodexRelativePathSchema).max(256),
    migrationEdgeIds: z.array(StableIdentifierSchema).min(1).max(64),
    migrationEdgesHash: CodexSha256Schema,
    semanticVerifier: SemanticVerifierSchema,
    workspaceEvidence: z
      .object({
        snapshotComplete: z.boolean(),
        unexpectedEntryCount: z.number().int().nonnegative().nullable(),
        beforeWorkspaceHash: CodexSha256Schema,
        afterWorkspaceHash: CodexSha256Schema.nullable(),
      })
      .strict(),
    changes: z.array(CodexChangeRecordSchema).max(64),
    adapter: CodexAdapterIdentitySchema,
    requestedSandboxPolicy: CodexSandboxPolicySchema,
    repositoryProof: CodexRepositoryProofSchema,
    behaviorProof: CodexBehaviorProofSchema,
    runtimeBehaviorVerified: z.literal(false),
    checks: z.array(CodexAuditCheckSchema),
    passed: z.boolean(),
  })
  .strict()
  .superRefine((audit, context) => {
    if (
      audit.workspaceEvidence.snapshotComplete !==
        (audit.workspaceEvidence.unexpectedEntryCount !== null) ||
      audit.workspaceEvidence.snapshotComplete !==
        (audit.workspaceEvidence.afterWorkspaceHash !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Complete workspace evidence requires both an entry count and after hash.",
        path: ["workspaceEvidence"],
      });
    }
    const exposedPaths = audit.exposedFiles.map((file) => file.path);
    addUniqueIssue(exposedPaths, context, ["exposedFiles"], "Exposed file paths");
    addPortablePathCollisionIssue(exposedPaths, context, ["exposedFiles"], "Exposed file paths");
    addUniqueIssue(audit.requiredFiles, context, ["requiredFiles"], "Required file paths");
    addPortablePathCollisionIssue(
      audit.requiredFiles,
      context,
      ["requiredFiles"],
      "Required file paths",
    );
    addUniqueIssue(audit.forbiddenFiles, context, ["forbiddenFiles"], "Forbidden file paths");
    addPortablePathCollisionIssue(
      audit.forbiddenFiles,
      context,
      ["forbiddenFiles"],
      "Forbidden file paths",
    );
    addUniqueIssue(audit.migrationEdgeIds, context, ["migrationEdgeIds"], "Migration edge IDs");
    addUniqueIssue(
      audit.repositoryProof.verificationAdapterIds,
      context,
      ["repositoryProof", "verificationAdapterIds"],
      "Verification adapter IDs",
    );
    if (audit.repositoryProof.semanticVerifierId !== audit.semanticVerifier.id) {
      context.addIssue({
        code: "custom",
        message: "Repository proof must identify the audit's semantic verifier.",
        path: ["repositoryProof", "semanticVerifierId"],
      });
    }
    addUniqueIssue(
      audit.changes.map((change) => change.path),
      context,
      ["changes"],
      "Changed file paths",
    );
    addPortablePathCollisionIssue(
      audit.changes.map((change) => change.path),
      context,
      ["changes"],
      "Changed file paths",
    );

    const exposed = new Set(exposedPaths.map(portablePathKey));
    const exposedByPath = new Map(audit.exposedFiles.map((file) => [file.path, file]));
    const changesByPath = new Map(audit.changes.map((change) => [change.path, change]));
    const forbidden = new Set(audit.forbiddenFiles.map(portablePathKey));
    for (const [index, file] of audit.requiredFiles.entries()) {
      if (!exposed.has(portablePathKey(file))) {
        context.addIssue({
          code: "custom",
          message: "Every required file must also be exposed.",
          path: ["requiredFiles", index],
        });
      }
    }
    for (const [index, file] of exposedPaths.entries()) {
      if (forbidden.has(portablePathKey(file))) {
        context.addIssue({
          code: "custom",
          message: "An exposed file cannot also be forbidden.",
          path: ["exposedFiles", index, "path"],
        });
      }
    }
    for (const [index, change] of audit.changes.entries()) {
      const exposedFile = exposedByPath.get(change.path);
      if (exposedFile === undefined) {
        context.addIssue({
          code: "custom",
          message: "Every audited change must belong to the exposed file scope.",
          path: ["changes", index, "path"],
        });
        continue;
      }
      if (change.beforeHash !== exposedFile.beforeHash) {
        context.addIssue({
          code: "custom",
          message: "Every audited change must retain its exposed preimage hash.",
          path: ["changes", index, "beforeHash"],
        });
      }
    }

    const expectedCandidatePatchHash = sha256(
      canonicalJson({ repositoryRevision: audit.repositoryRevision, changes: audit.changes }),
    );
    if (audit.repositoryProof.candidatePatchHash !== expectedCandidatePatchHash) {
      context.addIssue({
        code: "custom",
        message: "The repository proof must bind the canonical audited changes.",
        path: ["repositoryProof", "candidatePatchHash"],
      });
    }

    const checkIds = audit.checks.map((check) => check.id);
    if (
      checkIds.length !== CODEX_AUDIT_CHECKS.length ||
      !checkIds.every((id, index) => id === CODEX_AUDIT_CHECKS[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Codex audit checks must use the fixed contract order.",
        path: ["checks"],
      });
    }

    const everyCheckPassed = audit.checks.every((check) => check.passed);
    if (audit.passed !== everyCheckPassed) {
      context.addIssue({
        code: "custom",
        message: "Codex remediation passes if and only if every audit check passes.",
        path: ["passed"],
      });
    }
    if ((audit.status === "passed") !== audit.passed) {
      context.addIssue({
        code: "custom",
        message: "Audit status is passed if and only if the remediation passed.",
        path: ["status"],
      });
    }
    if (audit.passed && audit.proposalStatus !== "completed") {
      context.addIssue({
        code: "custom",
        message: "Only a completed proposal can pass remediation verification.",
        path: ["proposalStatus"],
      });
    }
    if (audit.passed) {
      for (const [index, change] of audit.changes.entries()) {
        if (change.afterHash === null) {
          context.addIssue({
            code: "custom",
            message: "A passing audit cannot contain a deleted exposed file.",
            path: ["changes", index, "afterHash"],
          });
        }
      }
      for (const [index, requiredFile] of audit.requiredFiles.entries()) {
        const change = changesByPath.get(requiredFile);
        if (change === undefined || change.afterHash === null) {
          context.addIssue({
            code: "custom",
            message: "A passing audit requires every required file to have a resulting hash.",
            path: ["requiredFiles", index],
          });
        }
      }
    }
    if (
      audit.passed &&
      (audit.adapter.cliVersion === null ||
        audit.adapter.executableHash === null ||
        audit.adapter.tokenUsage === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A passing audit requires complete Codex runtime identity and token usage.",
        path: ["adapter"],
      });
    }
    if ((audit.adapter.cliVersion === null) !== (audit.adapter.executableHash === null)) {
      context.addIssue({
        code: "custom",
        message: "Codex CLI version and executable hash must be present or absent together.",
        path: ["adapter"],
      });
    }
    if (
      audit.adapter.executableHash !== null &&
      audit.adapter.executableHash !== audit.adapter.requestedExecutableHash
    ) {
      context.addIssue({
        code: "custom",
        message: "The executed Codex binary must match the requested executable hash.",
        path: ["adapter", "executableHash"],
      });
    }
    if (audit.adapter.tokenUsage !== null && audit.adapter.cliVersion === null) {
      context.addIssue({
        code: "custom",
        message: "Codex token usage requires a recorded runtime identity.",
        path: ["adapter", "tokenUsage"],
      });
    }
    if ((audit.proposalStatus === "unavailable") !== (audit.proposalHash === null)) {
      context.addIssue({
        code: "custom",
        message: "Only an unavailable proposal can omit its canonical proposal hash.",
        path: ["proposalHash"],
      });
    }
    if (audit.status === "abstained") {
      if (audit.proposalStatus !== "abstained") {
        context.addIssue({
          code: "custom",
          message: "An abstained audit requires an abstained proposal.",
          path: ["proposalStatus"],
        });
      }
      if (audit.changes.length > 0) {
        context.addIssue({
          code: "custom",
          message: "An abstained audit cannot contain filesystem changes.",
          path: ["changes"],
        });
      }
      for (const checkId of [
        "repository_revision_binding",
        "workspace_isolation",
        "structured_output",
        "external_action_policy",
        "changed_files_allowlist",
        "original_repository_revision_unchanged",
      ] as const) {
        if (!audit.checks.find((check) => check.id === checkId)?.passed) {
          context.addIssue({
            code: "custom",
            message: "An abstained audit requires every safety-boundary check to pass.",
            path: ["status"],
          });
          break;
        }
      }
    }

    const behaviorCheck = audit.checks.find((check) => check.id === "declared_behavior_fixture");
    const behaviorPassed = audit.behaviorProof.status === "completed" && audit.behaviorProof.passed;
    if (behaviorCheck && behaviorCheck.passed !== behaviorPassed) {
      context.addIssue({
        code: "custom",
        message: "The behavior-contract check must match the recorded behavior proof.",
        path: ["checks", CODEX_AUDIT_CHECKS.indexOf("declared_behavior_fixture"), "passed"],
      });
    }
    const repositoryCheck = audit.checks.find((check) => check.id === "repository_contracts");
    const repositoryPassed =
      audit.repositoryProof.status === "completed" && audit.repositoryProof.passed;
    if (repositoryCheck && repositoryCheck.passed !== repositoryPassed) {
      context.addIssue({
        code: "custom",
        message: "The repository-contract check must match the recorded repository proof.",
        path: ["checks", CODEX_AUDIT_CHECKS.indexOf("repository_contracts"), "passed"],
      });
    }
    const revisionBindingCheck = audit.checks.find(
      (check) => check.id === "repository_revision_binding",
    );
    const revisionBound = audit.repositoryRevision === audit.originalRepositoryRevisions.before;
    if (revisionBindingCheck && revisionBindingCheck.passed !== revisionBound) {
      context.addIssue({
        code: "custom",
        message: "The revision-binding check must match the recorded repository revisions.",
        path: ["checks", CODEX_AUDIT_CHECKS.indexOf("repository_revision_binding"), "passed"],
      });
    }
    const originalCheck = audit.checks.find(
      (check) => check.id === "original_repository_revision_unchanged",
    );
    const originalUnchanged =
      audit.originalRepositoryRevisions.after !== null &&
      audit.originalRepositoryRevisions.before === audit.originalRepositoryRevisions.after;
    if (originalCheck && originalCheck.passed !== originalUnchanged) {
      context.addIssue({
        code: "custom",
        message: "The original-repository check must match the recorded revisions.",
        path: [
          "checks",
          CODEX_AUDIT_CHECKS.indexOf("original_repository_revision_unchanged"),
          "passed",
        ],
      });
    }
    if (audit.passed && !originalUnchanged) {
      context.addIssue({
        code: "custom",
        message: "A passing audit requires an unchanged original repository revision and index.",
        path: ["originalRepositoryRevisions", "after"],
      });
    }
  });

export type CodexExposedFile = z.infer<typeof CodexExposedFileSchema>;
export type CodexRemediationManifest = z.infer<typeof CodexRemediationManifestSchema>;
export type CodexProposal = z.infer<typeof CodexProposalSchema>;
export type CodexChangeRecord = z.infer<typeof CodexChangeRecordSchema>;
export type CodexAuditCheck = z.infer<typeof CodexAuditCheckSchema>;
export type CodexSandboxPolicy = z.infer<typeof CodexSandboxPolicySchema>;
export type CodexAdapterIdentity = z.infer<typeof CodexAdapterIdentitySchema>;
export type CodexRepositoryProof = z.infer<typeof CodexRepositoryProofSchema>;
export type CodexBehaviorProof = z.infer<typeof CodexBehaviorProofSchema>;
export type CodexRemediationAudit = z.infer<typeof CodexRemediationAuditSchema>;
