import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { compareStrings } from "./compare.js";
import { ConfigurationError } from "./errors.js";
import { sha256 } from "./hash.js";
import { MigrationEdgeSchema, REPORT_SCHEMA_VERSION } from "./schemas.js";
import type { MigrationRegistry } from "./source-lock.js";

export const BEHAVIOR_FIXTURE_SCHEMA_VERSION = "1.0.0" as const;

export const BEHAVIOR_VERIFICATION_CHECKS = [
  "text_output_shape",
  "conversation_state",
  "streaming_sequence",
  "tool_call_sequence_and_arguments",
  "error_retry_behavior",
  "changed_files_allowlist",
] as const;

export type BehaviorJsonValue =
  | boolean
  | null
  | number
  | string
  | BehaviorJsonValue[]
  | { [key: string]: BehaviorJsonValue };

export type BehaviorJsonObject = { [key: string]: BehaviorJsonValue };

function isBehaviorJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): value is BehaviorJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.hasOwn(value, "__proto__")
  ) {
    return false;
  }

  ancestors.add(value);
  try {
    const children = Array.isArray(value)
      ? value
      : Object.keys(value).map((key) => (value as Record<string, unknown>)[key]);
    return children.every((child) => isBehaviorJsonValue(child, ancestors));
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function isBehaviorJsonObject(value: unknown): value is BehaviorJsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isBehaviorJsonValue(value)
  );
}

export const BehaviorJsonValueSchema = z.custom<BehaviorJsonValue>(isBehaviorJsonValue, {
  message: "Expected a finite, acyclic JSON value without an own __proto__ key.",
});

export const BehaviorJsonObjectSchema = z.custom<BehaviorJsonObject>(isBehaviorJsonObject, {
  message: "Expected a JSON object without an own __proto__ key.",
});

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const BehaviorCheckIdSchema = z.enum(BEHAVIOR_VERIFICATION_CHECKS);
const StableIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "Expected a stable report-safe identifier.");
const BehaviorMismatchPathSchema = z
  .string()
  .min(2)
  .refine((value) => value.startsWith("$.") && !/[\r\n]/u.test(value), {
    message: "Expected a single path-only behavior mismatch reference.",
  });
const BehaviorRelativePathSchema = z
  .string()
  .min(1)
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
      return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
    },
    { message: "Expected a safe relative POSIX path." },
  );

function addUniqueArrayIssue(
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

export const BehaviorContractSchema = z
  .object({
    schemaVersion: z.literal(BEHAVIOR_FIXTURE_SCHEMA_VERSION),
    id: StableIdentifierSchema,
    scenarioId: StableIdentifierSchema,
    migrationEdgeIds: z.array(StableIdentifierSchema).min(1),
    changedFiles: z
      .object({
        allowed: z.array(BehaviorRelativePathSchema),
        required: z.array(BehaviorRelativePathSchema),
      })
      .strict(),
  })
  .strict()
  .superRefine((contract, context) => {
    addUniqueArrayIssue(
      contract.migrationEdgeIds,
      context,
      ["migrationEdgeIds"],
      "Migration edge IDs",
    );
    addUniqueArrayIssue(
      contract.changedFiles.allowed,
      context,
      ["changedFiles", "allowed"],
      "Allowed changed files",
    );
    addUniqueArrayIssue(
      contract.changedFiles.required,
      context,
      ["changedFiles", "required"],
      "Required changed files",
    );

    const allowed = new Set(contract.changedFiles.allowed);
    for (const [index, file] of contract.changedFiles.required.entries()) {
      if (!allowed.has(file)) {
        context.addIssue({
          code: "custom",
          message: "Every required changed file must also be allowed.",
          path: ["changedFiles", "required", index],
        });
      }
    }
  });

const TextOutputSchema = z
  .object({
    caseId: z.string().min(1),
    value: BehaviorJsonValueSchema,
  })
  .strict();

const ConversationItemSchema = z
  .object({
    sequence: z.number().int().positive(),
    key: z.string().min(1),
    type: z.string().min(1),
    role: z.string().min(1).optional(),
    parentKey: z.string().min(1).optional(),
    metadata: BehaviorJsonObjectSchema,
  })
  .strict();

const StreamEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    type: z.string().min(1),
    itemKey: z.string().min(1).optional(),
    payload: BehaviorJsonValueSchema,
  })
  .strict();

const ToolCallSchema = z
  .object({
    sequence: z.number().int().positive(),
    name: z.string().min(1),
    arguments: BehaviorJsonObjectSchema,
  })
  .strict();

const RetryAttemptSchema = z
  .object({
    sequence: z.number().int().positive(),
    operation: z.string().min(1),
    attempt: z.number().int().positive(),
    outcome: z.enum(["error", "success"]),
    errorCode: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
  })
  .strict();

export const BehaviorObservationSchema = z
  .object({
    schemaVersion: z.literal(BEHAVIOR_FIXTURE_SCHEMA_VERSION),
    id: StableIdentifierSchema,
    scenarioId: StableIdentifierSchema,
    textOutputs: z.array(TextOutputSchema),
    conversationItems: z.array(ConversationItemSchema),
    streamEvents: z.array(StreamEventSchema),
    toolCalls: z.array(ToolCallSchema),
    retryAttempts: z.array(RetryAttemptSchema),
    changedFiles: z.array(BehaviorRelativePathSchema),
  })
  .strict()
  .superRefine((observation, context) => {
    addUniqueArrayIssue(
      observation.textOutputs.map((output) => output.caseId),
      context,
      ["textOutputs"],
      "Text output case IDs",
    );
    addUniqueArrayIssue(
      observation.conversationItems.map((item) => item.key),
      context,
      ["conversationItems"],
      "Conversation item keys",
    );
    addUniqueArrayIssue(
      observation.streamEvents.map((event) => String(event.sequence)),
      context,
      ["streamEvents"],
      "Stream event sequence numbers",
    );
    addUniqueArrayIssue(
      observation.toolCalls.map((call) => String(call.sequence)),
      context,
      ["toolCalls"],
      "Tool call sequence numbers",
    );
    addUniqueArrayIssue(
      observation.retryAttempts.map((attempt) => String(attempt.sequence)),
      context,
      ["retryAttempts"],
      "Retry attempt sequence numbers",
    );
    addUniqueArrayIssue(observation.changedFiles, context, ["changedFiles"], "Changed files");

    for (const field of [
      "conversationItems",
      "streamEvents",
      "toolCalls",
      "retryAttempts",
    ] as const) {
      for (const [index, item] of observation[field].entries()) {
        if (item.sequence !== index + 1) {
          context.addIssue({
            code: "custom",
            message: "Sequence numbers must be contiguous, one-based, and match array order.",
            path: [field, index, "sequence"],
          });
        }
      }
    }

    const earlierConversationKeys = new Set<string>();
    for (const [index, item] of observation.conversationItems.entries()) {
      if (item.parentKey !== undefined && !earlierConversationKeys.has(item.parentKey)) {
        context.addIssue({
          code: "custom",
          message: "Conversation parent keys must reference a unique earlier item.",
          path: ["conversationItems", index, "parentKey"],
        });
      }
      earlierConversationKeys.add(item.key);
    }

    const retryStateByOperation = new Map<string, { lastAttempt: number; terminal: boolean }>();
    for (const [index, attempt] of observation.retryAttempts.entries()) {
      const previous = retryStateByOperation.get(attempt.operation);
      const expectedAttempt = previous ? previous.lastAttempt + 1 : 1;
      if (attempt.attempt !== expectedAttempt) {
        context.addIssue({
          code: "custom",
          message: "Retry attempts must start at one and increment by one for each operation.",
          path: ["retryAttempts", index, "attempt"],
        });
      }
      if (previous?.terminal) {
        context.addIssue({
          code: "custom",
          message: "A retry operation cannot continue after terminal evidence.",
          path: ["retryAttempts", index],
        });
      }
      retryStateByOperation.set(attempt.operation, {
        lastAttempt: attempt.attempt,
        terminal: attempt.outcome === "success" || attempt.retryable === false,
      });
    }
  });

export const BehaviorVerificationCheckSchema = z
  .object({
    id: BehaviorCheckIdSchema,
    passed: z.boolean(),
    mismatchPaths: z.array(BehaviorMismatchPathSchema),
  })
  .strict()
  .superRefine((check, context) => {
    if (check.passed !== (check.mismatchPaths.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "A behavior check passes if and only if it has no mismatch paths.",
        path: ["passed"],
      });
    }
    addUniqueArrayIssue(check.mismatchPaths, context, ["mismatchPaths"], "Mismatch paths");
  });

export const BehaviorVerifyReportSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    kind: z.literal("behavior-verify"),
    contractId: StableIdentifierSchema,
    scenarioId: StableIdentifierSchema,
    observationIds: z
      .object({
        baseline: StableIdentifierSchema,
        candidate: StableIdentifierSchema,
      })
      .strict(),
    inputHashes: z
      .object({
        contract: Sha256Schema,
        baseline: Sha256Schema,
        candidate: Sha256Schema,
      })
      .strict(),
    sourceLockHash: Sha256Schema,
    selectedMigrationEdges: z.array(MigrationEdgeSchema).min(1),
    evidenceScope: z.literal("offline-fixture"),
    liveApiUsed: z.literal(false),
    changedFiles: z.array(BehaviorRelativePathSchema),
    passed: z.boolean(),
    checks: z.array(BehaviorVerificationCheckSchema),
  })
  .strict()
  .superRefine((report, context) => {
    const checkIds = report.checks.map((check) => check.id);
    if (
      checkIds.length !== BEHAVIOR_VERIFICATION_CHECKS.length ||
      !checkIds.every((id, index) => id === BEHAVIOR_VERIFICATION_CHECKS[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Behavior verification checks must use the fixed contract order.",
        path: ["checks"],
      });
    }
    if (report.passed !== report.checks.every((check) => check.passed)) {
      context.addIssue({
        code: "custom",
        message: "Behavior verification passes if and only if every check passes.",
        path: ["passed"],
      });
    }
    addUniqueArrayIssue(
      report.selectedMigrationEdges.map((edge) => edge.id),
      context,
      ["selectedMigrationEdges"],
      "Selected migration edge IDs",
    );
    addUniqueArrayIssue(report.changedFiles, context, ["changedFiles"], "Changed files");
  });

export type BehaviorContract = z.infer<typeof BehaviorContractSchema>;
export type BehaviorObservation = z.infer<typeof BehaviorObservationSchema>;
export type BehaviorCheckId = z.infer<typeof BehaviorCheckIdSchema>;
export type BehaviorVerificationCheck = z.infer<typeof BehaviorVerificationCheckSchema>;
export type BehaviorVerifyReport = z.infer<typeof BehaviorVerifyReportSchema>;

export type VerifyBehaviorContractRequest = {
  contract: BehaviorContract;
  baseline: BehaviorObservation;
  candidate: BehaviorObservation;
  registry: MigrationRegistry;
};

function valueKind(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function propertyPath(parent: string, key: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function collectShapeMismatches(
  baseline: BehaviorJsonValue,
  candidate: BehaviorJsonValue,
  path: string,
  mismatches: string[],
): void {
  if (valueKind(baseline) !== valueKind(candidate)) {
    mismatches.push(path);
    return;
  }

  if (Array.isArray(baseline) && Array.isArray(candidate)) {
    if (baseline.length !== candidate.length) {
      mismatches.push(`${path}.length`);
    }
    const comparableLength = Math.min(baseline.length, candidate.length);
    for (let index = 0; index < comparableLength; index += 1) {
      const baselineValue = baseline[index];
      const candidateValue = candidate[index];
      if (baselineValue !== undefined && candidateValue !== undefined) {
        collectShapeMismatches(baselineValue, candidateValue, `${path}[${index}]`, mismatches);
      }
    }
    return;
  }

  if (
    baseline !== null &&
    candidate !== null &&
    typeof baseline === "object" &&
    typeof candidate === "object"
  ) {
    const baselineObject = baseline as Record<string, BehaviorJsonValue>;
    const candidateObject = candidate as Record<string, BehaviorJsonValue>;
    const keys = [
      ...new Set([...Object.keys(baselineObject), ...Object.keys(candidateObject)]),
    ].sort(compareStrings);
    for (const key of keys) {
      const childPath = propertyPath(path, key);
      if (!(key in baselineObject) || !(key in candidateObject)) {
        mismatches.push(childPath);
        continue;
      }
      const baselineValue = baselineObject[key];
      const candidateValue = candidateObject[key];
      if (baselineValue !== undefined && candidateValue !== undefined) {
        collectShapeMismatches(baselineValue, candidateValue, childPath, mismatches);
      }
    }
  }
}

function collectExactMismatches(
  baseline: unknown,
  candidate: unknown,
  path: string,
  mismatches: string[],
): void {
  if (valueKind(baseline) !== valueKind(candidate)) {
    mismatches.push(path);
    return;
  }

  if (Array.isArray(baseline) && Array.isArray(candidate)) {
    if (baseline.length !== candidate.length) {
      mismatches.push(`${path}.length`);
    }
    const comparableLength = Math.min(baseline.length, candidate.length);
    for (let index = 0; index < comparableLength; index += 1) {
      collectExactMismatches(baseline[index], candidate[index], `${path}[${index}]`, mismatches);
    }
    return;
  }

  if (
    baseline !== null &&
    candidate !== null &&
    typeof baseline === "object" &&
    typeof candidate === "object"
  ) {
    const baselineObject = baseline as Record<string, unknown>;
    const candidateObject = candidate as Record<string, unknown>;
    const keys = [
      ...new Set([...Object.keys(baselineObject), ...Object.keys(candidateObject)]),
    ].sort(compareStrings);
    for (const key of keys) {
      const childPath = propertyPath(path, key);
      if (!(key in baselineObject) || !(key in candidateObject)) {
        mismatches.push(childPath);
        continue;
      }
      collectExactMismatches(baselineObject[key], candidateObject[key], childPath, mismatches);
    }
    return;
  }

  if (baseline !== candidate) {
    mismatches.push(path);
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function compareTextOutputShapes(
  baseline: BehaviorObservation,
  candidate: BehaviorObservation,
): string[] {
  const mismatches: string[] = [];
  if (baseline.textOutputs.length !== candidate.textOutputs.length) {
    mismatches.push("$.textOutputs.length");
  }
  const comparableLength = Math.min(baseline.textOutputs.length, candidate.textOutputs.length);
  for (let index = 0; index < comparableLength; index += 1) {
    const baselineOutput = baseline.textOutputs[index];
    const candidateOutput = candidate.textOutputs[index];
    if (!baselineOutput || !candidateOutput) {
      continue;
    }
    collectExactMismatches(
      baselineOutput.caseId,
      candidateOutput.caseId,
      `$.textOutputs[${index}].caseId`,
      mismatches,
    );
    collectShapeMismatches(
      baselineOutput.value,
      candidateOutput.value,
      `$.textOutputs[${index}].value`,
      mismatches,
    );
  }
  return uniquePaths(mismatches);
}

function compareStreamSequence(
  baseline: BehaviorObservation,
  candidate: BehaviorObservation,
): string[] {
  const mismatches: string[] = [];
  if (baseline.streamEvents.length !== candidate.streamEvents.length) {
    mismatches.push("$.streamEvents.length");
  }
  const comparableLength = Math.min(baseline.streamEvents.length, candidate.streamEvents.length);
  for (let index = 0; index < comparableLength; index += 1) {
    const baselineEvent = baseline.streamEvents[index];
    const candidateEvent = candidate.streamEvents[index];
    if (!baselineEvent || !candidateEvent) {
      continue;
    }
    collectExactMismatches(
      baselineEvent.sequence,
      candidateEvent.sequence,
      `$.streamEvents[${index}].sequence`,
      mismatches,
    );
    collectExactMismatches(
      baselineEvent.type,
      candidateEvent.type,
      `$.streamEvents[${index}].type`,
      mismatches,
    );
    collectExactMismatches(
      baselineEvent.itemKey,
      candidateEvent.itemKey,
      `$.streamEvents[${index}].itemKey`,
      mismatches,
    );
    collectShapeMismatches(
      baselineEvent.payload,
      candidateEvent.payload,
      `$.streamEvents[${index}].payload`,
      mismatches,
    );
  }
  return uniquePaths(mismatches);
}

function compareConversationState(
  baseline: BehaviorObservation,
  candidate: BehaviorObservation,
): string[] {
  const mismatches: string[] = [];
  if (baseline.conversationItems.length !== candidate.conversationItems.length) {
    mismatches.push("$.conversationItems.length");
  }
  const comparableLength = Math.min(
    baseline.conversationItems.length,
    candidate.conversationItems.length,
  );
  for (let index = 0; index < comparableLength; index += 1) {
    const baselineItem = baseline.conversationItems[index];
    const candidateItem = candidate.conversationItems[index];
    if (!baselineItem || !candidateItem) {
      continue;
    }
    for (const field of ["sequence", "key", "type", "role", "parentKey"] as const) {
      collectExactMismatches(
        baselineItem[field],
        candidateItem[field],
        `$.conversationItems[${index}].${field}`,
        mismatches,
      );
    }
    collectExactMismatches(
      baselineItem.metadata,
      candidateItem.metadata,
      `$.conversationItems[${index}].metadata`,
      mismatches,
    );
  }
  return uniquePaths(mismatches);
}

function compareChangedFiles(contract: BehaviorContract, candidate: BehaviorObservation): string[] {
  const mismatches: string[] = [];
  const allowed = new Set(contract.changedFiles.allowed);
  const actual = new Set(candidate.changedFiles);
  for (const file of candidate.changedFiles) {
    if (!allowed.has(file)) {
      mismatches.push(propertyPath("$.candidate.changedFiles", file));
    }
  }
  for (const file of contract.changedFiles.required) {
    if (!actual.has(file)) {
      mismatches.push(propertyPath("$.contract.changedFiles.required", file));
    }
  }
  return uniquePaths(mismatches);
}

function createCheck(id: BehaviorCheckId, mismatchPaths: string[]): BehaviorVerificationCheck {
  return BehaviorVerificationCheckSchema.parse({
    id,
    passed: mismatchPaths.length === 0,
    mismatchPaths,
  });
}

function selectMigrationEdges(
  edgeIds: readonly string[],
  registry: MigrationRegistry,
): BehaviorVerifyReport["selectedMigrationEdges"] {
  const edgeById = new Map(registry.edges.map((edge) => [edge.id, edge]));
  return edgeIds.map((edgeId) => {
    const edge = edgeById.get(edgeId);
    if (!edge) {
      throw new ConfigurationError(
        `Behavior contract references unknown migration edge ${edgeId}.`,
      );
    }
    return edge;
  });
}

export function verifyBehaviorContract(
  request: VerifyBehaviorContractRequest,
): BehaviorVerifyReport {
  const contract = BehaviorContractSchema.parse(request.contract);
  const baseline = BehaviorObservationSchema.parse(request.baseline);
  const candidate = BehaviorObservationSchema.parse(request.candidate);

  if (baseline.scenarioId !== contract.scenarioId) {
    throw new ConfigurationError(
      `Baseline observation scenario ${baseline.scenarioId} does not match behavior contract ${contract.scenarioId}.`,
    );
  }
  if (candidate.scenarioId !== contract.scenarioId) {
    throw new ConfigurationError(
      `Candidate observation scenario ${candidate.scenarioId} does not match behavior contract ${contract.scenarioId}.`,
    );
  }

  const selectedMigrationEdges = selectMigrationEdges(contract.migrationEdgeIds, request.registry);
  const checks: BehaviorVerificationCheck[] = [
    createCheck("text_output_shape", compareTextOutputShapes(baseline, candidate)),
    createCheck("conversation_state", compareConversationState(baseline, candidate)),
    createCheck("streaming_sequence", compareStreamSequence(baseline, candidate)),
    createCheck(
      "tool_call_sequence_and_arguments",
      (() => {
        const mismatches: string[] = [];
        collectExactMismatches(baseline.toolCalls, candidate.toolCalls, "$.toolCalls", mismatches);
        return uniquePaths(mismatches);
      })(),
    ),
    createCheck(
      "error_retry_behavior",
      (() => {
        const mismatches: string[] = [];
        collectExactMismatches(
          baseline.retryAttempts,
          candidate.retryAttempts,
          "$.retryAttempts",
          mismatches,
        );
        return uniquePaths(mismatches);
      })(),
    ),
    createCheck("changed_files_allowlist", compareChangedFiles(contract, candidate)),
  ];

  return BehaviorVerifyReportSchema.parse({
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "behavior-verify",
    contractId: contract.id,
    scenarioId: contract.scenarioId,
    observationIds: {
      baseline: baseline.id,
      candidate: candidate.id,
    },
    inputHashes: {
      contract: sha256(canonicalJson(contract)),
      baseline: sha256(canonicalJson(baseline)),
      candidate: sha256(canonicalJson(candidate)),
    },
    sourceLockHash: request.registry.sourceLockHash,
    selectedMigrationEdges,
    evidenceScope: "offline-fixture",
    liveApiUsed: false,
    changedFiles: candidate.changedFiles,
    passed: checks.every((check) => check.passed),
    checks,
  });
}
