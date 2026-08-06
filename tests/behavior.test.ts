import {
  BEHAVIOR_FIXTURE_SCHEMA_VERSION,
  BEHAVIOR_VERIFICATION_CHECKS,
  type BehaviorContract,
  BehaviorContractSchema,
  BehaviorJsonObjectSchema,
  BehaviorJsonValueSchema,
  type BehaviorObservation,
  BehaviorObservationSchema,
  BehaviorVerifyReportSchema,
  ConfigurationError,
  canonicalJson,
  type MigrationEdge,
  type MigrationRegistry,
  REPORT_SCHEMA_VERSION,
  sha256,
  verifyBehaviorContract,
} from "@migration-doctor/core";
import { describe, expect, it } from "vitest";

const source = {
  url: "https://behavior.example.invalid/migration",
  title: "Synthetic behavior source",
  retrievedAt: "2026-08-06T00:00:00.000Z",
  contentHash: "a".repeat(64),
};

const migrationEdge: MigrationEdge = {
  id: "synthetic.behavior.before.to.after",
  from: { kind: "product", id: "synthetic-before" },
  to: { kind: "product", id: "synthetic-after" },
  sources: [source],
  languages: ["typescript"],
  behaviorChanges: ["Synthetic behavior contract test only."],
  automationTier: "B",
  reviewRequired: true,
};

const registry: MigrationRegistry = {
  sourceLockHash: "b".repeat(64),
  sources: [],
  edges: [migrationEdge],
};

const contract: BehaviorContract = {
  schemaVersion: BEHAVIOR_FIXTURE_SCHEMA_VERSION,
  id: "synthetic-behavior-contract",
  scenarioId: "synthetic-conversation",
  migrationEdgeIds: [migrationEdge.id],
  changedFiles: {
    allowed: ["src/agent.ts", "src/helpers.ts"],
    required: ["src/agent.ts"],
  },
};

const baseline: BehaviorObservation = {
  schemaVersion: BEHAVIOR_FIXTURE_SCHEMA_VERSION,
  id: "synthetic-baseline",
  scenarioId: contract.scenarioId,
  textOutputs: [
    {
      caseId: "answer",
      value: {
        output: [{ type: "output_text", text: "baseline-private-text" }],
        usage: { tokens: 12 },
      },
    },
  ],
  conversationItems: [
    {
      sequence: 1,
      key: "user-1",
      type: "message",
      role: "user",
      metadata: { trace: "baseline-private-trace", retained: true },
    },
    {
      sequence: 2,
      key: "assistant-1",
      type: "message",
      role: "assistant",
      parentKey: "user-1",
      metadata: { trace: "baseline-private-response", retained: true },
    },
  ],
  streamEvents: [
    {
      sequence: 1,
      type: "response.output_text.delta",
      itemKey: "assistant-1",
      payload: { delta: "baseline-private-delta", index: 0 },
    },
    {
      sequence: 2,
      type: "response.completed",
      payload: { status: "completed" },
    },
  ],
  toolCalls: [
    {
      sequence: 1,
      name: "get_weather",
      arguments: { city: "Seoul", units: "metric" },
    },
  ],
  retryAttempts: [
    {
      sequence: 1,
      operation: "response.create",
      attempt: 1,
      outcome: "error",
      errorCode: "rate_limit",
      retryable: true,
    },
    {
      sequence: 2,
      operation: "response.create",
      attempt: 2,
      outcome: "success",
      retryable: false,
    },
  ],
  changedFiles: [],
};

const compatibleCandidate: BehaviorObservation = {
  ...baseline,
  id: "synthetic-compatible-candidate",
  textOutputs: [
    {
      caseId: "answer",
      value: {
        output: [{ type: "message", text: "candidate-private-text" }],
        usage: { tokens: 99 },
      },
    },
  ],
  conversationItems: baseline.conversationItems.map((item) => ({
    ...item,
    metadata: { ...item.metadata },
  })),
  streamEvents: [
    {
      sequence: 1,
      type: "response.output_text.delta",
      itemKey: "assistant-1",
      payload: { delta: "candidate-private-delta", index: 3 },
    },
    {
      sequence: 2,
      type: "response.completed",
      payload: { status: "done" },
    },
  ],
  changedFiles: ["src/agent.ts"],
};

describe("offline behavior contract verification", () => {
  it("canonicalizes prototype-sensitive own keys without hash collisions", () => {
    const baseRaw =
      '{"__proto__":{"value":"base"},"constructor":{"value":"base"},"prototype":{"value":"base"}}';
    const rawValues = [
      baseRaw,
      '{"__proto__":{"value":"changed"},"constructor":{"value":"base"},"prototype":{"value":"base"}}',
      '{"__proto__":{"value":"base"},"constructor":{"value":"changed"},"prototype":{"value":"base"}}',
      '{"__proto__":{"value":"base"},"constructor":{"value":"base"},"prototype":{"value":"changed"}}',
    ];
    const serialized = canonicalJson(JSON.parse(baseRaw));
    const roundTrip = JSON.parse(serialized) as Record<string, unknown>;

    expect(Object.keys(roundTrip)).toEqual(["__proto__", "constructor", "prototype"]);
    expect(Object.hasOwn(roundTrip, "__proto__")).toBe(true);
    expect(new Set(rawValues.map((raw) => sha256(canonicalJson(JSON.parse(raw))))).size).toBe(4);
  });

  it("rejects own __proto__ keys before Zod can drop them and preserves other keys in hashes", () => {
    expect(
      BehaviorJsonValueSchema.safeParse(JSON.parse('{"nested":{"__proto__":{"value":1}}}')).success,
    ).toBe(false);
    expect(
      BehaviorJsonObjectSchema.safeParse(JSON.parse('{"__proto__":{"value":1}}')).success,
    ).toBe(false);

    const allowedPayloads = [
      '{"constructor":{"value":"base"},"prototype":{"value":"base"}}',
      '{"constructor":{"value":"changed"},"prototype":{"value":"base"}}',
      '{"constructor":{"value":"base"},"prototype":{"value":"changed"}}',
    ];
    const candidateHashes = allowedPayloads.map((raw) => {
      const candidate: BehaviorObservation = {
        ...compatibleCandidate,
        id: "prototype-key-candidate",
        textOutputs: [
          { caseId: "prototype-keys", value: BehaviorJsonValueSchema.parse(JSON.parse(raw)) },
        ],
      };
      return verifyBehaviorContract({ contract, baseline, candidate, registry }).inputHashes
        .candidate;
    });

    expect(new Set(candidateHashes).size).toBe(3);
  });

  it("accepts compatible shape-only output changes and emits a deterministic audit report", () => {
    const first = verifyBehaviorContract({
      contract,
      baseline,
      candidate: compatibleCandidate,
      registry,
    });
    const second = verifyBehaviorContract({
      contract,
      baseline,
      candidate: compatibleCandidate,
      registry,
    });

    expect(first).toMatchObject({
      schemaVersion: REPORT_SCHEMA_VERSION,
      kind: "behavior-verify",
      contractId: contract.id,
      scenarioId: contract.scenarioId,
      observationIds: {
        baseline: baseline.id,
        candidate: compatibleCandidate.id,
      },
      sourceLockHash: registry.sourceLockHash,
      selectedMigrationEdges: [migrationEdge],
      evidenceScope: "offline-fixture",
      liveApiUsed: false,
      changedFiles: ["src/agent.ts"],
      passed: true,
    });
    expect(first.checks.map((check) => check.id)).toEqual(BEHAVIOR_VERIFICATION_CHECKS);
    expect(first.checks.every((check) => check.passed && check.mismatchPaths.length === 0)).toBe(
      true,
    );
    expect(Object.values(first.inputHashes).every((hash) => /^[a-f0-9]{64}$/u.test(hash))).toBe(
      true,
    );
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it("fails every fixed check with precise paths and never includes primitive values", () => {
    const firstConversationItem = compatibleCandidate.conversationItems[0];
    const secondConversationItem = compatibleCandidate.conversationItems[1];
    const completedStreamEvent = compatibleCandidate.streamEvents[1];
    if (!firstConversationItem || !secondConversationItem || !completedStreamEvent) {
      throw new Error("Expected the synthetic compatible observation to be complete.");
    }
    const brokenCandidate: BehaviorObservation = {
      ...compatibleCandidate,
      id: "synthetic-broken-candidate",
      textOutputs: [
        {
          caseId: "answer",
          value: {
            output: [{ type: "message", text: { leaked: "candidate-secret" } }],
            usage: { tokens: 99 },
          },
        },
      ],
      conversationItems: [
        {
          ...firstConversationItem,
          metadata: {
            ...firstConversationItem.metadata,
            trace: "candidate-secret",
          },
        },
        secondConversationItem,
      ],
      streamEvents: [
        {
          sequence: 1,
          type: "response.failed",
          itemKey: "assistant-1",
          payload: { delta: { leaked: "candidate-secret" }, index: 3 },
        },
        completedStreamEvent,
      ],
      toolCalls: [
        {
          sequence: 1,
          name: "get_weather",
          arguments: { city: "Busan", units: "metric" },
        },
      ],
      retryAttempts: [
        {
          sequence: 1,
          operation: "response.create",
          attempt: 1,
          outcome: "success",
          retryable: false,
        },
      ],
      changedFiles: ["src/unexpected.ts"],
    };

    const report = verifyBehaviorContract({
      contract,
      baseline,
      candidate: brokenCandidate,
      registry,
    });
    const checks = Object.fromEntries(report.checks.map((check) => [check.id, check]));

    expect(report.passed).toBe(false);
    expect(report.checks.every((check) => !check.passed)).toBe(true);
    expect(checks.text_output_shape?.mismatchPaths).toContain(
      "$.textOutputs[0].value.output[0].text",
    );
    expect(checks.conversation_state?.mismatchPaths).toEqual([
      "$.conversationItems[0].metadata.trace",
    ]);
    expect(checks.streaming_sequence?.mismatchPaths).toEqual([
      "$.streamEvents[0].type",
      "$.streamEvents[0].payload.delta",
    ]);
    expect(checks.tool_call_sequence_and_arguments?.mismatchPaths).toContain(
      "$.toolCalls[0].arguments.city",
    );
    expect(checks.error_retry_behavior?.mismatchPaths).toContain("$.retryAttempts[0].outcome");
    expect(checks.changed_files_allowlist?.mismatchPaths).toEqual([
      '$.candidate.changedFiles["src/unexpected.ts"]',
      '$.contract.changedFiles.required["src/agent.ts"]',
    ]);

    const serialized = canonicalJson(report);
    expect(serialized).not.toContain("candidate-secret");
    expect(serialized).not.toContain("Busan");
  });

  it("rejects unsafe or inconsistent fixture paths", () => {
    expect(
      BehaviorContractSchema.safeParse({
        ...contract,
        changedFiles: { allowed: ["../outside.ts"], required: [] },
      }).success,
    ).toBe(false);
    expect(
      BehaviorContractSchema.safeParse({
        ...contract,
        changedFiles: { allowed: ["src/agent.ts"], required: ["src/other.ts"] },
      }).success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        changedFiles: ["C:/outside.ts"],
      }).success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        changedFiles: ["src/agent.ts\n- injected markdown"],
      }).success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        changedFiles: ["src/agent\t.ts"],
      }).success,
    ).toBe(false);
  });

  it("requires contiguous one-based sequences and normalized retry outcomes", () => {
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        streamEvents: baseline.streamEvents.map((event, index) => ({
          ...event,
          sequence: index,
        })),
      }).success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        retryAttempts: [{ ...baseline.retryAttempts[0], outcome: "timeout" }],
      }).success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        retryAttempts: baseline.retryAttempts.map((attempt, index) => ({
          ...attempt,
          attempt: index === 0 ? 2 : 4,
        })),
      }).success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        retryAttempts: [
          {
            ...baseline.retryAttempts[0],
            outcome: "success",
            errorCode: undefined,
            retryable: false,
          },
          baseline.retryAttempts[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        retryAttempts: [
          { ...baseline.retryAttempts[0], retryable: false },
          baseline.retryAttempts[1],
        ],
      }).success,
    ).toBe(false);
  });

  it("requires conversation parents to reference unique earlier items", () => {
    const firstItem = baseline.conversationItems[0];
    const secondItem = baseline.conversationItems[1];
    if (!firstItem || !secondItem) {
      throw new Error("Expected synthetic conversation items.");
    }

    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        conversationItems: [{ ...firstItem, parentKey: secondItem.key }, secondItem],
      }).success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        conversationItems: [firstItem, { ...secondItem, key: firstItem.key }],
      }).success,
    ).toBe(false);
  });

  it("rejects typo fields in structural objects without closing JSON metadata", () => {
    expect(
      BehaviorContractSchema.safeParse({ ...contract, scenarioID: contract.scenarioId }).success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        conversationItems: [
          {
            ...baseline.conversationItems[0],
            metdata: { typo: true },
          },
          baseline.conversationItems[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        conversationItems: [
          {
            ...baseline.conversationItems[0],
            metadata: { arbitraryApplicationKey: { remainsOpen: true } },
          },
          baseline.conversationItems[1],
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects report-unsafe identifiers while leaving payload strings unconstrained", () => {
    expect(BehaviorContractSchema.safeParse({ ...contract, id: "bad\ncontract" }).success).toBe(
      false,
    );
    expect(
      BehaviorContractSchema.safeParse({ ...contract, scenarioId: "`markdown`" }).success,
    ).toBe(false);
    expect(
      BehaviorContractSchema.safeParse({ ...contract, migrationEdgeIds: ["edge\ninjected"] })
        .success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({ ...baseline, id: "bad`observation" }).success,
    ).toBe(false);
    expect(
      BehaviorObservationSchema.safeParse({
        ...baseline,
        textOutputs: [{ caseId: "payload", value: "arbitrary\n`payload`" }],
      }).success,
    ).toBe(true);
  });

  it("classifies scenario and edge mismatches as invalid configuration", () => {
    expect(() =>
      verifyBehaviorContract({
        contract,
        baseline: { ...baseline, scenarioId: "different-scenario" },
        candidate: compatibleCandidate,
        registry,
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      verifyBehaviorContract({
        contract: { ...contract, migrationEdgeIds: ["unknown.edge"] },
        baseline,
        candidate: compatibleCandidate,
        registry,
      }),
    ).toThrow(ConfigurationError);
  });

  it("enforces report pass status and fixed check order at the schema boundary", () => {
    const report = verifyBehaviorContract({
      contract,
      baseline,
      candidate: compatibleCandidate,
      registry,
    });

    expect(BehaviorVerifyReportSchema.safeParse({ ...report, passed: false }).success).toBe(false);
    expect(
      BehaviorVerifyReportSchema.safeParse({ ...report, checks: [...report.checks].reverse() })
        .success,
    ).toBe(false);
    expect(
      BehaviorVerifyReportSchema.safeParse({
        ...report,
        observationIds: { ...report.observationIds, candidate: "bad\nreport-id" },
      }).success,
    ).toBe(false);
    expect(
      BehaviorVerifyReportSchema.safeParse({
        ...report,
        changedFiles: ["src/agent.ts", "src/agent.ts"],
      }).success,
    ).toBe(false);
  });
});
