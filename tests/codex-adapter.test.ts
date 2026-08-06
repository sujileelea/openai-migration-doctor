import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildCodexExecArgs,
  CODEX_AUDIT_CHECKS,
  CodexExecRunner,
  CodexRemediationAuditSchema,
  CodexRemediationManifestSchema,
  createCodexRemediationManifest,
  runCodexRemediation,
  sanitizeCodexEnvironment,
} from "@migration-doctor/codex-adapter";
import {
  BEHAVIOR_FIXTURE_SCHEMA_VERSION,
  type BehaviorContract,
  type BehaviorObservation,
  canonicalJson,
  createSemanticPatchPlan,
  loadMigrationRegistry,
  type MigrationRegistry,
  scanRepository,
  sha256,
} from "@migration-doctor/core";
import { TypeScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyWorkspaceChanges,
  createVerificationWorktree,
  readGitRevisionFile,
  readSafeCodexFile,
  readStableGitRepositoryRevision,
  snapshotWorkspace,
} from "../packages/codex-adapter/src/workspace.js";
import { fixturePath, PROJECT_ROOT } from "./helpers.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const MODEL_EDGE_ID = "openai.model.gpt-4o-mini-transcribe-2025-03-20.to.2025-12-15";
const SOURCE_MODEL = "gpt-4o-mini-transcribe-2025-03-20";
const TARGET_MODEL = "gpt-4o-mini-transcribe-2025-12-15";
const SOURCE_FILE = "src/transcribe.ts";

let semanticRegistry: MigrationRegistry;
let lockedRegistry: MigrationRegistry;
let semanticRegistryRoot: string;

async function createTierBRegistryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "migration-doctor-tier-b-registry-"));
  await cp(path.join(PROJECT_ROOT, "data"), path.join(root, "data"), { recursive: true });
  await cp(path.join(PROJECT_ROOT, "migration.lock"), path.join(root, "migration.lock"));

  const migrationPath = path.join(root, "data/migrations/gpt-4o-mini-transcribe-2025-03-20.json");
  const migration = JSON.parse(await readFile(migrationPath, "utf8")) as {
    edge: { automationTier: string; reviewRequired: boolean };
  };
  migration.edge.automationTier = "B";
  migration.edge.reviewRequired = true;
  await writeFile(migrationPath, `${JSON.stringify(migration, null, 2)}\n`);

  const lockPath = path.join(root, "migration.lock");
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
    artifacts: Array<{ path: string; sha256: string }>;
  };
  const artifact = lock.artifacts.find(
    (entry) => entry.path === "data/migrations/gpt-4o-mini-transcribe-2025-03-20.json",
  );
  if (!artifact) {
    throw new Error("Expected the model migration artifact in the synthetic source lock.");
  }
  artifact.sha256 = sha256(await readFile(migrationPath));
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return root;
}

beforeAll(async () => {
  lockedRegistry = await loadMigrationRegistry(PROJECT_ROOT);
  semanticRegistryRoot = await createTierBRegistryRoot();
  semanticRegistry = await loadMigrationRegistry(semanticRegistryRoot);
});

afterAll(async () => {
  await rm(semanticRegistryRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runGit(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.stdout;
}

async function createCommittedRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "migration-doctor-codex-test-"));
  temporaryDirectories.push(root);
  await cp(fixturePath("direct-model-literal"), root, { recursive: true });
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.name", "Migration Doctor Test"]);
  await runGit(root, ["config", "user.email", "migration-doctor-test@invalid.example"]);
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "--quiet", "-m", "fixture"]);
  return root;
}

function observation(id: string, changedFiles: string[]): BehaviorObservation {
  return {
    schemaVersion: BEHAVIOR_FIXTURE_SCHEMA_VERSION,
    id,
    scenarioId: "semantic-model-migration",
    textOutputs: [{ caseId: "transcript", value: { type: "text", text: "private" } }],
    conversationItems: [],
    streamEvents: [],
    toolCalls: [],
    retryAttempts: [],
    changedFiles,
  };
}

type Prepared = Awaited<ReturnType<typeof prepare>>;

async function prepare() {
  const root = await createCommittedRepository();
  const adapter = new TypeScriptLanguageAdapter();
  const scan = await scanRepository({
    repositoryRoot: root,
    registry: semanticRegistry,
    adapters: [adapter],
  });
  const finding = scan.findings[0];
  if (!finding) {
    throw new Error("Expected the Tier B fixture to contain one finding.");
  }
  const baselineObservation = observation("semantic-baseline", []);
  const candidateObservation = observation("semantic-candidate", [SOURCE_FILE]);
  const behaviorContract: BehaviorContract = {
    schemaVersion: BEHAVIOR_FIXTURE_SCHEMA_VERSION,
    id: "semantic-model-contract",
    scenarioId: baselineObservation.scenarioId,
    migrationEdgeIds: [MODEL_EDGE_ID],
    changedFiles: { allowed: [SOURCE_FILE], required: [SOURCE_FILE] },
  };
  const plan = createSemanticPatchPlan(scan, {
    sourceFiles: [{ path: SOURCE_FILE, beforeHash: finding.fileHash }],
    forbiddenFiles: [".env"],
    requiredFiles: [SOURCE_FILE],
    instructions: [
      `Replace only the transcription request model ${SOURCE_MODEL} with ${TARGET_MODEL}.`,
    ],
    behaviorContractHash: sha256(canonicalJson(behaviorContract)),
    baselineObservationHash: sha256(canonicalJson(baselineObservation)),
  });
  const manifest = await createCodexRemediationManifest({
    repositoryRoot: root,
    plan,
    registry: semanticRegistry,
    behaviorContract,
    baselineObservation,
  });
  const source = await readFile(path.join(root, SOURCE_FILE), "utf8");
  const candidateSource = source.replace(`model: "${SOURCE_MODEL}"`, `model: "${TARGET_MODEL}"`);
  return {
    root,
    plan,
    manifest,
    behaviorContract,
    baselineObservation,
    candidateObservation,
    candidateSource,
  };
}

type FakeCodexOptions = {
  finalResponse: string;
  expectedExecutableHash?: string;
  versionOutput?: string;
  mutateOnVersion?: boolean;
  operations?: Array<
    | { kind: "write"; path: string; content: string }
    | { kind: "delete"; path: string }
    | { kind: "symlink"; path: string; target: string }
  >;
  itemTypes?: string[];
  rawOutput?: string;
};

async function fakeCodexRunner(options: FakeCodexOptions): Promise<CodexExecRunner> {
  const root = await mkdtemp(path.join(tmpdir(), "migration-doctor-fake-codex-"));
  temporaryDirectories.push(root);
  const executable = path.join(root, "codex-fixture.mjs");
  const fixture = JSON.stringify(options);
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      'import path from "node:path";',
      `const fixture = ${fixture};`,
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { if (fixture.mutateOnVersion) fs.appendFileSync(new URL(import.meta.url), "\\n// mutated"); process.stdout.write(fixture.versionOutput ?? "codex-cli 0.146.0\\n"); process.exit(0); }',
      'const cwdIndex = args.indexOf("-C");',
      'const workspace = cwdIndex >= 0 ? args[cwdIndex + 1] : "";',
      "for (const operation of fixture.operations ?? []) {",
      "  const target = path.join(workspace, operation.path);",
      '  if (operation.kind === "write") { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, operation.content); }',
      '  if (operation.kind === "delete") fs.rmSync(target, { force: true, recursive: true });',
      '  if (operation.kind === "symlink") { fs.rmSync(target, { force: true, recursive: true }); fs.symlinkSync(operation.target, target); }',
      "}",
      "if (fixture.rawOutput !== undefined) { process.stdout.write(fixture.rawOutput); process.exit(0); }",
      "const events = [",
      '  { type: "thread.started", thread_id: "volatile-thread" },',
      '  { type: "turn.started" },',
      '  ...(fixture.itemTypes ?? []).map((type, index) => ({ type: "item.completed", item: { id: "tool-" + index, type, ...(type === "command_execution" ? { command: "opaque" } : {}) } })),',
      '  { type: "item.completed", item: { id: "message", type: "agent_message", text: fixture.finalResponse } },',
      '  { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },',
      "];",
      'process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");',
    ].join("\n"),
  );
  await chmod(executable, 0o700);
  const executableHash = sha256(await readFile(executable));
  return new CodexExecRunner({
    executable,
    expectedExecutableHash: options.expectedExecutableHash ?? executableHash,
    environment: { CODEX_API_KEY: "fixture-only-key", PATH: process.env.PATH },
  });
}

function completedProposal(planHash: string, changedFiles = [SOURCE_FILE]): string {
  return JSON.stringify({
    schemaVersion: "1.0.0",
    status: "completed",
    planHash,
    changedFiles,
  });
}

function abstainedProposal(planHash: string): string {
  return JSON.stringify({
    schemaVersion: "1.0.0",
    status: "abstained",
    planHash,
    changedFiles: [],
    reasonCode: "manual-review-required",
  });
}

async function passingRunner(prepared: Prepared): Promise<CodexExecRunner> {
  return fakeCodexRunner({
    finalResponse: completedProposal(prepared.manifest.planHash),
    operations: [{ kind: "write", path: SOURCE_FILE, content: prepared.candidateSource }],
    itemTypes: ["file_change"],
  });
}

function remediationRequest(prepared: Prepared, runner: CodexExecRunner) {
  return {
    repositoryRoot: prepared.root,
    plan: prepared.plan,
    manifest: prepared.manifest,
    registry: semanticRegistry,
    behaviorContract: prepared.behaviorContract,
    baselineObservation: prepared.baselineObservation,
    candidateObservation: prepared.candidateObservation,
    runner,
    model: "gpt-5.6-terra",
  };
}

describe("Codex remediation adapter", () => {
  it("binds a real Tier B plan and verifies candidate bytes with the static scanner", async () => {
    const prepared = await prepare();
    const audit = await runCodexRemediation(
      remediationRequest(prepared, await passingRunner(prepared)),
    );

    expect(audit.passed).toBe(true);
    expect(audit.checks.map((entry) => entry.id)).toEqual(CODEX_AUDIT_CHECKS);
    expect(audit.repositoryProof).toMatchObject({
      status: "completed",
      passed: true,
      verificationAdapterIds: ["typescript"],
      semanticVerifierId: "typescript-transcription-model-exact-rewrite-v1",
      repositoryCodeExecuted: false,
    });
    expect(audit.behaviorProof).toMatchObject({
      status: "completed",
      passed: true,
      provenance: "caller-supplied-offline-fixture",
      repositoryRuntimeVerified: false,
    });
    expect(audit.runtimeBehaviorVerified).toBe(false);
    expect(audit.semanticVerifier).toEqual(prepared.manifest.semanticVerifier);
    expect(audit.adapter.executableHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(audit.adapter.requestedExecutableHash).toBe(audit.adapter.executableHash);
    expect(audit.repositoryRevision).toBe(prepared.plan.semanticRemediation?.repositoryRevision);
    expect(
      CodexRemediationAuditSchema.safeParse({
        ...audit,
        repositoryRevision: "0".repeat(40),
      }).success,
    ).toBe(false);
    expect(
      CodexRemediationAuditSchema.safeParse({
        ...audit,
        adapter: { ...audit.adapter, requestedExecutableHash: "0".repeat(64) },
      }).success,
    ).toBe(false);
    expect(CodexRemediationAuditSchema.safeParse({ ...audit, changes: [] }).success).toBe(false);
    expect(
      CodexRemediationAuditSchema.safeParse({
        ...audit,
        repositoryProof: { ...audit.repositoryProof, candidatePatchHash: "0".repeat(64) },
      }).success,
    ).toBe(false);
    expect(await readFile(path.join(prepared.root, SOURCE_FILE), "utf8")).toContain(SOURCE_MODEL);
    expect(canonicalJson(audit)).not.toContain(prepared.candidateSource);
    expect(canonicalJson(audit)).not.toContain(prepared.root);
  });

  it("records a clean model abstention without treating it as verified", async () => {
    const prepared = await prepare();
    const runner = await fakeCodexRunner({
      finalResponse: abstainedProposal(prepared.manifest.planHash),
    });

    const audit = await runCodexRemediation(remediationRequest(prepared, runner));

    expect(audit).toMatchObject({
      status: "abstained",
      proposalStatus: "abstained",
      changes: [],
      passed: false,
    });
    for (const id of [
      "plan_binding",
      "repository_revision_binding",
      "workspace_isolation",
      "structured_output",
      "external_action_policy",
      "changed_files_allowlist",
      "original_repository_revision_unchanged",
    ] as const) {
      expect(audit.checks.find((entry) => entry.id === id)?.passed).toBe(true);
    }
    for (const id of [
      "proposal_hashes_match",
      "repository_contracts",
      "declared_behavior_fixture",
    ] as const) {
      expect(audit.checks.find((entry) => entry.id === id)?.passed).toBe(false);
    }
    expect(audit.repositoryProof).toMatchObject({ status: "not-run", passed: false });
    expect(audit.behaviorProof).toMatchObject({ status: "not-run", passed: false });
  });

  it("rejects any manifest task, edge, or file-scope rebinding before execution", async () => {
    const prepared = await prepare();
    const runner = await passingRunner(prepared);
    for (const manifest of [
      { ...prepared.manifest, instructions: ["Perform an unrelated edit."] },
      { ...prepared.manifest, migrationEdgeIds: ["unrelated.edge"] },
      {
        ...prepared.manifest,
        semanticVerifier: {
          ...prepared.manifest.semanticVerifier,
          targetModel: "unrelated-model",
        },
      },
      {
        ...prepared.manifest,
        exposedFiles: [
          ...prepared.manifest.exposedFiles,
          { path: "src/extra.ts", beforeHash: "a".repeat(64) },
        ],
      },
    ]) {
      await expect(
        runCodexRemediation({ ...remediationRequest(prepared, runner), manifest }),
      ).rejects.toThrow(/frozen|exactly match/u);
    }
    expect(
      CodexRemediationManifestSchema.safeParse({
        ...prepared.manifest,
        verificationAdapterIds: ["unrelated-adapter"],
      }).success,
    ).toBe(false);
  });

  it("rejects unvalidated or differently locked registries before execution", async () => {
    const prepared = await prepare();
    const tamperedRegistry = {
      ...semanticRegistry,
      edges: semanticRegistry.edges.map((edge) =>
        edge.id === MODEL_EDGE_ID
          ? { ...edge, to: { kind: "model" as const, id: "untrusted-target-model" } }
          : edge,
      ),
    };

    await expect(
      runCodexRemediation({
        ...remediationRequest(prepared, await passingRunner(prepared)),
        registry: tamperedRegistry,
      }),
    ).rejects.toThrow("directly from loadMigrationRegistry");
    await expect(
      runCodexRemediation({
        ...remediationRequest(prepared, await passingRunner(prepared)),
        registry: lockedRegistry,
      }),
    ).rejects.toThrow(/source-lock|provenance/u);
  });

  it("reproduces trusted plan provenance at every public boundary", async () => {
    const prepared = await prepare();
    const forgedVerifier = {
      ...prepared.plan.semanticRemediation.semanticVerifier,
      targetModel: "totally-wrong-model",
    };
    const forgedPlan = {
      ...prepared.plan,
      semanticRemediation: {
        ...prepared.plan.semanticRemediation,
        semanticVerifier: forgedVerifier,
      },
    };

    await expect(
      createCodexRemediationManifest({
        repositoryRoot: prepared.root,
        plan: forgedPlan,
        registry: semanticRegistry,
        behaviorContract: prepared.behaviorContract,
        baselineObservation: prepared.baselineObservation,
      }),
    ).rejects.toThrow(/trusted analysis|provenance/u);

    const forgedManifest = {
      ...prepared.manifest,
      planHash: sha256(canonicalJson(forgedPlan)),
      semanticVerifier: forgedVerifier,
    };
    const forgedCandidate = (await readFile(path.join(prepared.root, SOURCE_FILE), "utf8")).replace(
      SOURCE_MODEL,
      forgedVerifier.targetModel,
    );
    const runner = await fakeCodexRunner({
      finalResponse: completedProposal(forgedManifest.planHash),
      operations: [{ kind: "write", path: SOURCE_FILE, content: forgedCandidate }],
      itemTypes: ["file_change"],
    });
    await expect(
      runCodexRemediation({
        ...remediationRequest(prepared, runner),
        plan: forgedPlan,
        manifest: forgedManifest,
      }),
    ).rejects.toThrow(/trusted analysis|provenance/u);

    const selectedTierAEdges = lockedRegistry.edges
      .filter((edge) => prepared.plan.semanticRemediation.migrationEdgeIds.includes(edge.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const tierAPlan = {
      ...prepared.plan,
      semanticRemediation: {
        ...prepared.plan.semanticRemediation,
        migrationEdgesHash: sha256(canonicalJson(selectedTierAEdges)),
      },
    };
    await expect(
      createCodexRemediationManifest({
        repositoryRoot: prepared.root,
        plan: tierAPlan,
        registry: lockedRegistry,
        behaviorContract: prepared.behaviorContract,
        baselineObservation: prepared.baselineObservation,
      }),
    ).rejects.toThrow(/eligible|provenance/u);
  });

  it("rejects unreviewed Codex runner implementations", async () => {
    const prepared = await prepare();
    class UnreviewedRunner extends CodexExecRunner {}
    const runner = new UnreviewedRunner({
      executable: "/does/not/run",
      expectedExecutableHash: "0".repeat(64),
      environment: { CODEX_API_KEY: "fixture-only-key", PATH: process.env.PATH },
    });
    await expect(runCodexRemediation(remediationRequest(prepared, runner))).rejects.toThrow(
      "exact reviewed Codex runner",
    );
  });

  it("rejects expanded files and forbidden tool events without running verification", async () => {
    const expanded = await prepare();
    const expandedRunner = await fakeCodexRunner({
      finalResponse: completedProposal(expanded.manifest.planHash, [".env", SOURCE_FILE]),
      operations: [
        { kind: "write", path: SOURCE_FILE, content: expanded.candidateSource },
        { kind: "write", path: ".env", content: "FIXTURE_ONLY=1\n" },
      ],
      itemTypes: ["file_change"],
    });
    const expandedAudit = await runCodexRemediation(remediationRequest(expanded, expandedRunner));
    expect(expandedAudit.passed).toBe(false);
    expect(expandedAudit.repositoryProof.status).toBe("not-run");
    expect(expandedAudit.checks.find((entry) => entry.id === "workspace_isolation")).toMatchObject({
      passed: false,
      reasonCodes: ["workspace-scope-violated"],
    });

    const toolAttempt = await prepare();
    const toolRunner = await fakeCodexRunner({
      finalResponse: completedProposal(toolAttempt.manifest.planHash),
      operations: [{ kind: "write", path: SOURCE_FILE, content: toolAttempt.candidateSource }],
      itemTypes: ["command_execution", "file_change"],
    });
    const toolAudit = await runCodexRemediation(remediationRequest(toolAttempt, toolRunner));
    expect(toolAudit.passed).toBe(false);
    expect(toolAudit.checks.find((entry) => entry.id === "external_action_policy")).toMatchObject({
      passed: false,
      reasonCodes: ["command-tool-attempted"],
    });
  });

  it("commits to rejected workspace state without disclosing unexpected paths", async () => {
    const prepared = await prepare();
    const runAttempt = async (unexpectedPath: string) => {
      const runner = await fakeCodexRunner({
        finalResponse: completedProposal(prepared.manifest.planHash, [SOURCE_FILE, unexpectedPath]),
        operations: [
          { kind: "write" as const, path: SOURCE_FILE, content: prepared.candidateSource },
          { kind: "write" as const, path: unexpectedPath, content: "private candidate bytes\n" },
        ],
        itemTypes: ["file_change"],
      });
      return await runCodexRemediation(remediationRequest(prepared, runner));
    };

    const first = await runAttempt("src/private-candidate-a.ts");
    const second = await runAttempt("src/private-candidate-b.ts");
    expect(first.workspaceEvidence).toMatchObject({
      snapshotComplete: true,
      unexpectedEntryCount: 1,
    });
    expect(first.workspaceEvidence.afterWorkspaceHash).not.toBe(
      second.workspaceEvidence.afterWorkspaceHash,
    );
    expect(canonicalJson(first)).not.toContain("private-candidate-a");
    expect(canonicalJson(first)).not.toContain("private candidate bytes");
  });

  it("records incomplete oversized snapshots without leaking rejected entries", async () => {
    const prepared = await prepare();
    const overflowOperations = Array.from({ length: 64 }, (_, index) => ({
      kind: "write" as const,
      path: `overflow/private-${index.toString().padStart(2, "0")}.ts`,
      content: "export {};\n",
    }));
    const runner = await fakeCodexRunner({
      finalResponse: completedProposal(prepared.manifest.planHash),
      operations: [
        { kind: "write", path: SOURCE_FILE, content: prepared.candidateSource },
        ...overflowOperations,
      ],
      itemTypes: ["file_change"],
    });

    const audit = await runCodexRemediation(remediationRequest(prepared, runner));
    expect(audit).toMatchObject({ status: "failed", passed: false });
    expect(audit.workspaceEvidence).toMatchObject({
      snapshotComplete: false,
      unexpectedEntryCount: null,
      afterWorkspaceHash: null,
    });
    expect(canonicalJson(audit)).not.toContain("overflow/private-");
  });

  it("fails closed on malformed and incomplete structured output", async () => {
    const prepared = await prepare();
    const malformed = await fakeCodexRunner({ finalResponse: "not-json" });
    const incomplete = await fakeCodexRunner({ finalResponse: "{}" });

    const malformedAudit = await runCodexRemediation(remediationRequest(prepared, malformed));
    const incompleteAudit = await runCodexRemediation(remediationRequest(prepared, incomplete));
    expect(malformedAudit).toMatchObject({
      status: "failed",
      proposalStatus: "unavailable",
      proposalHash: null,
      passed: false,
    });
    expect(malformedAudit.checks.find((entry) => entry.id === "structured_output")).toMatchObject({
      passed: false,
      reasonCodes: ["codex-malformed-output"],
    });
    expect(incompleteAudit.checks.find((entry) => entry.id === "structured_output")).toMatchObject({
      passed: false,
      reasonCodes: ["invalid-structured-output"],
    });
    expect(canonicalJson(malformedAudit)).not.toContain("not-json");
  });

  it("rejects declared-file mismatches and unsafe candidate syntax", async () => {
    const mismatch = await prepare();
    const mismatchRunner = await fakeCodexRunner({
      finalResponse: completedProposal(mismatch.manifest.planHash, ["src/other.ts"]),
      operations: [{ kind: "write", path: SOURCE_FILE, content: mismatch.candidateSource }],
      itemTypes: ["file_change"],
    });
    const mismatchAudit = await runCodexRemediation(remediationRequest(mismatch, mismatchRunner));
    expect(
      mismatchAudit.checks.find((entry) => entry.id === "proposal_hashes_match"),
    ).toMatchObject({
      passed: false,
      reasonCodes: ["declared-files-mismatch"],
    });

    const unsafe = await prepare();
    const unsafeRunner = await fakeCodexRunner({
      finalResponse: completedProposal(unsafe.manifest.planHash),
      operations: [{ kind: "write", path: SOURCE_FILE, content: "import {\n" }],
      itemTypes: ["file_change"],
    });
    const unsafeAudit = await runCodexRemediation(remediationRequest(unsafe, unsafeRunner));
    expect(unsafeAudit.passed).toBe(false);
    expect(unsafeAudit.checks.find((entry) => entry.id === "repository_contracts")).toMatchObject({
      passed: false,
      reasonCodes: ["verification-staging-failed"],
    });
  });

  it("rejects a syntax-valid destructive candidate that only removes the finding", async () => {
    const prepared = await prepare();
    const runner = await fakeCodexRunner({
      finalResponse: completedProposal(prepared.manifest.planHash),
      operations: [{ kind: "write", path: SOURCE_FILE, content: "export {};\n" }],
      itemTypes: ["file_change"],
    });

    const audit = await runCodexRemediation(remediationRequest(prepared, runner));
    expect(audit.passed).toBe(false);
    expect(audit.repositoryProof).toMatchObject({
      status: "completed",
      passed: false,
      semanticVerifierId: "typescript-transcription-model-exact-rewrite-v1",
    });
    expect(audit.checks.find((entry) => entry.id === "repository_contracts")).toMatchObject({
      passed: false,
      reasonCodes: ["repository-contract-failed"],
    });
  });

  it("rejects deletion, symlink replacement, and source revision drift", async () => {
    const deletion = await prepare();
    const deletionRunner = await fakeCodexRunner({
      finalResponse: completedProposal(deletion.manifest.planHash),
      operations: [{ kind: "delete", path: SOURCE_FILE }],
      itemTypes: ["file_change"],
    });
    const deletionAudit = await runCodexRemediation(remediationRequest(deletion, deletionRunner));
    expect(
      deletionAudit.checks.find((entry) => entry.id === "changed_files_allowlist"),
    ).toMatchObject({ passed: false, reasonCodes: ["file-deletion-forbidden"] });

    const symlinkAttempt = await prepare();
    const symlinkRunner = await fakeCodexRunner({
      finalResponse: completedProposal(symlinkAttempt.manifest.planHash),
      operations: [{ kind: "symlink", path: SOURCE_FILE, target: "/etc/passwd" }],
      itemTypes: ["file_change"],
    });
    const symlinkAudit = await runCodexRemediation(
      remediationRequest(symlinkAttempt, symlinkRunner),
    );
    expect(symlinkAudit.passed).toBe(false);
    expect(symlinkAudit.checks.find((entry) => entry.id === "workspace_isolation")).toMatchObject({
      passed: false,
      reasonCodes: ["invalid-workspace-state", "workspace-scope-violated"],
    });

    const stale = await prepare();
    await writeFile(path.join(stale.root, SOURCE_FILE), "// changed after manifest\n");
    await runGit(stale.root, ["add", "--all"]);
    await runGit(stale.root, ["commit", "--quiet", "-m", "drift"]);
    await expect(
      runCodexRemediation(remediationRequest(stale, await passingRunner(stale))),
    ).rejects.toThrow("repository revision changed");
  });

  it("rejects sensitive and portable-colliding manifest paths and likely credentials", async () => {
    const prepared = await prepare();
    const exposed = prepared.manifest.exposedFiles[0];
    expect(exposed).toBeDefined();
    if (!exposed) return;

    for (const sensitivePath of [
      ".env",
      "AGENTS.md",
      "AGENTS.override.md",
      ".codex/config.toml",
      "keys/id_rsa",
    ]) {
      expect(
        CodexRemediationManifestSchema.safeParse({
          ...prepared.manifest,
          exposedFiles: [{ ...exposed, path: sensitivePath }],
          requiredFiles: [sensitivePath],
          forbiddenFiles: [],
        }).success,
      ).toBe(false);
    }
    expect(
      CodexRemediationManifestSchema.safeParse({
        ...prepared.manifest,
        forbiddenFiles: [SOURCE_FILE.toUpperCase()],
      }).success,
    ).toBe(false);
    for (const invalidPath of [
      "CON.ts",
      "src/trailing-dot.",
      "src/alternate:data.ts",
      `${Array.from({ length: 33 }, () => "deep").join("/")}.ts`,
    ]) {
      expect(
        CodexRemediationManifestSchema.safeParse({
          ...prepared.manifest,
          exposedFiles: [{ ...exposed, path: invalidPath }],
          requiredFiles: [invalidPath],
          forbiddenFiles: [],
        }).success,
      ).toBe(false);
    }

    await writeFile(
      path.join(prepared.root, SOURCE_FILE),
      `export const key = "sk-proj-${"a".repeat(32)}";\n`,
    );
    await expect(readSafeCodexFile(prepared.root, SOURCE_FILE)).rejects.toThrow(
      "likely credential",
    );
  });

  it("rejects symbolic-link ancestors for scoped reads and candidate writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "migration-doctor-link-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "migration-doctor-link-outside-"));
    temporaryDirectories.push(root, outside);
    await writeFile(path.join(outside, "secret.ts"), "outside\n");
    await symlink(outside, path.join(root, "link"));
    await expect(readSafeCodexFile(root, "link/secret.ts")).rejects.toThrow("symbolic link");

    const verificationRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-link-write-"));
    temporaryDirectories.push(verificationRoot);
    await symlink(outside, path.join(verificationRoot, "link"));
    await expect(
      applyWorkspaceChanges(
        verificationRoot,
        {
          hashes: new Map([["link/secret.ts", sha256("changed\n")]]),
          contents: new Map([["link/secret.ts", Buffer.from("changed\n")]]),
          directories: ["link"],
        },
        ["link/secret.ts"],
      ),
    ).rejects.toThrow("symbolic link");
    expect(await readFile(path.join(outside, "secret.ts"), "utf8")).toBe("outside\n");
  });

  it("stages the exact revision without linked Git metadata and enforces preimages", async () => {
    const root = await createCommittedRepository();
    const revision = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    const verification = await createVerificationWorktree(root, revision);
    try {
      await expect(lstat(path.join(verification.root, ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const before = await readFile(path.join(verification.root, SOURCE_FILE));
      const after = await snapshotWorkspace(verification.root);
      after.contents.set(SOURCE_FILE, Buffer.from("changed\n"));
      after.hashes.set(SOURCE_FILE, sha256("changed\n"));
      await expect(
        applyWorkspaceChanges(
          verification.root,
          after,
          [SOURCE_FILE],
          new Map([[SOURCE_FILE, "0".repeat(64)]]),
        ),
      ).rejects.toThrow("preimage is stale");
      expect(await readFile(path.join(verification.root, SOURCE_FILE))).toEqual(before);
      await applyWorkspaceChanges(
        verification.root,
        after,
        [SOURCE_FILE],
        new Map([[SOURCE_FILE, sha256(before)]]),
      );
      expect(await readFile(path.join(verification.root, SOURCE_FILE), "utf8")).toBe("changed\n");
    } finally {
      await verification.cleanup();
    }

    await runGit(root, ["commit", "--allow-empty", "--quiet", "-m", "new revision"]);
    await expect(createVerificationWorktree(root, revision)).rejects.toThrow(
      "repository revision changed",
    );
  });

  it("reads only regular blobs from the frozen revision", async () => {
    const prepared = await prepare();
    const originalManifest = prepared.manifest;
    await writeFile(path.join(prepared.root, SOURCE_FILE), "// uncommitted worktree bytes\n");
    const recreatedManifest = await createCodexRemediationManifest({
      repositoryRoot: prepared.root,
      plan: prepared.plan,
      registry: semanticRegistry,
      behaviorContract: prepared.behaviorContract,
      baselineObservation: prepared.baselineObservation,
    });
    expect(recreatedManifest).toEqual(originalManifest);

    await writeFile(path.join(prepared.root, "untracked.ts"), "export {};\n");
    await expect(
      readGitRevisionFile(
        prepared.root,
        await readStableGitRepositoryRevision(prepared.root),
        "untracked.ts",
      ),
    ).rejects.toThrow("tracked regular blob");
    await expect(readGitRevisionFile(prepared.root, "--help", SOURCE_FILE)).rejects.toThrow(
      "full Git object ID",
    );
  });

  it("disables repository-local Git execution and replacement objects", async () => {
    const root = await createCommittedRepository();
    const originalRevision = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    const sentinel = path.join(root, "fsmonitor-ran");
    const fsmonitor = path.join(root, "fsmonitor.sh");
    await writeFile(fsmonitor, `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\n`);
    await chmod(fsmonitor, 0o700);
    await runGit(root, ["config", "core.fsmonitor", fsmonitor]);
    expect(await readStableGitRepositoryRevision(root)).toBe(originalRevision);
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(path.join(root, SOURCE_FILE), "export const replacementTree = true;\n");
    await runGit(root, ["add", "--all"]);
    await runGit(root, ["commit", "--quiet", "-m", "replacement tree"]);
    const replacementRevision = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    await runGit(root, ["switch", "--quiet", "--detach", originalRevision]);
    await runGit(root, ["replace", originalRevision, replacementRevision]);

    const staged = await createVerificationWorktree(root, originalRevision);
    try {
      expect(await readFile(path.join(staged.root, SOURCE_FILE), "utf8")).toContain(SOURCE_MODEL);
      expect(await readFile(path.join(staged.root, SOURCE_FILE), "utf8")).not.toContain(
        "replacementTree",
      );
    } finally {
      await staged.cleanup();
    }
  });
});

describe("hardened codex exec runner", () => {
  it("builds a root-denying, no-shell policy and strips ambient secrets", () => {
    const args = buildCodexExecArgs(
      { workingDirectory: "/isolated", model: "gpt-5.6-terra" },
      "/schema.json",
      "/runtime-home",
    );
    expect(args).toContain('default_permissions="migration_doctor"');
    expect(args).toContain(
      'permissions.migration_doctor.filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"}',
    );
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain("features.apps=false");
    expect(args).toContain("features.plugins=false");
    expect(args).toContain("tools.web_search=false");
    expect(args).toContain("project_root_markers=[]");
    expect(args).toContain("mcp_servers={}");
    expect(args).toContain("--strict-config");
    expect(args).toContain('shell_environment_policy.inherit="none"');
    expect(args).toContain("permissions.migration_doctor.network.enabled=false");
    expect(args).not.toContain("--sandbox");
    expect(
      sanitizeCodexEnvironment({
        HOME: "/ambient-home",
        TMPDIR: "/ambient-tmp",
        CODEX_API_KEY: "codex-secret",
        OPENAI_API_KEY: "openai-secret",
        CODEX_HOME: "/controlled",
        PATH: "/bin",
      }),
    ).toEqual({
      CODEX_API_KEY: "codex-secret",
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: "/bin",
      TERM: "dumb",
    });
  });

  it("fails closed on malformed JSONL", async () => {
    const runner = await fakeCodexRunner({ finalResponse: "{}", rawOutput: "not-json\n" });
    const workspace = await mkdtemp(path.join(tmpdir(), "migration-doctor-runner-workspace-"));
    temporaryDirectories.push(workspace);
    await expect(
      runner.run({
        workingDirectory: workspace,
        prompt: "Return structured output.",
        outputSchema: { type: "object" },
      }),
    ).rejects.toMatchObject({ code: "CODEX_MALFORMED_OUTPUT" });
  });

  it("rejects prerelease variants of the exact reviewed CLI version", async () => {
    const runner = await fakeCodexRunner({
      finalResponse: "{}",
      versionOutput: "codex-cli 0.146.0-beta\n",
    });
    const workspace = await mkdtemp(path.join(tmpdir(), "migration-doctor-version-workspace-"));
    temporaryDirectories.push(workspace);
    await expect(
      runner.run({
        workingDirectory: workspace,
        prompt: "Return structured output.",
        outputSchema: { type: "object" },
      }),
    ).rejects.toMatchObject({ code: "CODEX_UNSUPPORTED_VERSION" });
  });

  it("rejects a Codex executable that changes during identity preflight", async () => {
    const runner = await fakeCodexRunner({ finalResponse: "{}", mutateOnVersion: true });
    const workspace = await mkdtemp(path.join(tmpdir(), "migration-doctor-identity-workspace-"));
    temporaryDirectories.push(workspace);
    await expect(
      runner.run({
        workingDirectory: workspace,
        prompt: "Return structured output.",
        outputSchema: { type: "object" },
      }),
    ).rejects.toMatchObject({ code: "CODEX_EXECUTABLE_CHANGED" });
  });

  it("rejects an executable outside the operator-pinned hash before preflight", async () => {
    const runner = await fakeCodexRunner({
      finalResponse: "{}",
      expectedExecutableHash: "0".repeat(64),
      mutateOnVersion: true,
    });
    const workspace = await mkdtemp(path.join(tmpdir(), "migration-doctor-pin-workspace-"));
    temporaryDirectories.push(workspace);
    const beforeHash = sha256(await readFile(runner.executable));

    await expect(
      runner.run({
        workingDirectory: workspace,
        prompt: "Return structured output.",
        outputSchema: { type: "object" },
      }),
    ).rejects.toMatchObject({ code: "CODEX_UNTRUSTED_EXECUTABLE" });
    expect(sha256(await readFile(runner.executable))).toBe(beforeHash);
  });

  it("freezes the reviewed runner dispatch against prototype monkeypatches", () => {
    const reviewedRun = CodexExecRunner.prototype.run;

    expect(Object.isFrozen(CodexExecRunner.prototype)).toBe(true);
    expect(Reflect.set(CodexExecRunner.prototype, "run", async () => undefined)).toBe(false);
    expect(CodexExecRunner.prototype.run).toBe(reviewedRun);
  });

  it("classifies every disabled tool without retaining raw event data", async () => {
    const runner = await fakeCodexRunner({
      finalResponse: JSON.stringify({ schemaVersion: "1.0.0" }),
      itemTypes: ["command_execution", "image_view", "mcp_tool_call", "web_search", "dynamic_tool"],
    });
    const workspace = await mkdtemp(path.join(tmpdir(), "migration-doctor-policy-workspace-"));
    temporaryDirectories.push(workspace);
    const result = await runner.run({
      workingDirectory: workspace,
      prompt: "Return structured output.",
      outputSchema: { type: "object" },
    });

    expect(result.policyViolationCodes).toEqual([
      "command-tool-attempted",
      "mcp-tool-attempted",
      "unsupported-tool-attempted",
      "web-search-attempted",
    ]);
    expect(canonicalJson(result)).not.toContain("volatile-thread");
    expect(canonicalJson(result)).not.toContain("opaque");
  });

  it("requires a single-run Codex API key", () => {
    expect(
      () =>
        new CodexExecRunner({
          executable: "/does/not/matter",
          expectedExecutableHash: "0".repeat(64),
          environment: { PATH: process.env.PATH },
        }),
    ).toThrow("single-run CODEX_API_KEY");
  });
});
