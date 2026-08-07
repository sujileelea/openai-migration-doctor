import { access, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyTextEdits,
  createPatchPreview,
  createPlanReport,
  FindingSchema,
  loadMigrationRegistry,
  PatchPlanSchema,
  scanRepository,
  verifyPatchPlan,
} from "@migration-doctor/core";
import { TypeScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LIBCST_PROTOCOL_VERSION,
  LibCstBridge,
  measurePythonAdapter,
  PYTHON_MAX_CANDIDATE_FILES,
  PYTHON_MAX_CANDIDATE_SOURCE_BYTES,
  PYTHON_MAX_SOURCE_FILE_BYTES,
  PYTHON_MAX_SOURCE_FILES,
  PYTHON_MAX_WORKER_INPUT_BYTES,
  PYTHON_PERFORMANCE_SCHEMA_VERSION,
  PYTHON_SOURCE_MODEL,
  PythonLanguageAdapter,
  parseLibCstScanResponse,
  pythonPositionToUtf16Offset,
} from "../packages/language-python/src/index.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PYTHON_PACKAGE_ROOT = path.join(PROJECT_ROOT, "packages", "language-python");
const PYTHON_EXECUTABLE =
  process.env.MIGRATION_DOCTOR_PYTHON ??
  path.join(
    PYTHON_PACKAGE_ROOT,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
const TARGET_MODEL = "gpt-4o-mini-transcribe-2025-12-15";

function pythonFixture(name: string): string {
  return path.join(PROJECT_ROOT, "fixtures", "python", name);
}

describe("LibCST Python language adapter", () => {
  const adapter = new PythonLanguageAdapter({ pythonExecutable: PYTHON_EXECUTABLE });
  const typescriptAdapter = new TypeScriptLanguageAdapter();
  const temporaryRepositories: string[] = [];
  let registry: Awaited<ReturnType<typeof loadMigrationRegistry>>;

  beforeAll(async () => {
    await access(PYTHON_EXECUTABLE);
    registry = await loadMigrationRegistry(PROJECT_ROOT);
  });

  afterAll(async () => {
    await Promise.all(
      temporaryRepositories.map(async (repositoryRoot) => {
        await rm(repositoryRoot, { recursive: true, force: true });
      }),
    );
  });

  async function temporaryPythonRepository(): Promise<string> {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-python-limits-"));
    temporaryRepositories.push(repositoryRoot);
    return repositoryRoot;
  }

  async function scanPython(name: string) {
    return await scanRepository({
      repositoryRoot: pythonFixture(name),
      registry,
      adapters: [adapter],
    });
  }

  it("validates Assistants classifications at the LibCST protocol boundary", () => {
    const response = {
      schemaVersion: LIBCST_PROTOCOL_VERSION,
      kind: "scan-result",
      files: [
        {
          path: "src/assistants.py",
          matches: [],
          assistants: [
            {
              start: { line: 1, column: 0 },
              end: { line: 1, column: 29 },
              features: [
                {
                  feature: "assistants",
                  disposition: "supported",
                  pattern: "direct",
                  reasonCode: "manual-migration-required",
                },
              ],
            },
          ],
        },
      ],
      worker: { pythonVersion: "3.13.0", libcstVersion: "1.9.0", peakRssBytes: 0 },
    };

    expect(parseLibCstScanResponse(response)).toEqual(response);
    const invalid = structuredClone(response);
    const classification = invalid.files[0]?.assistants[0]?.features[0];
    expect(classification).toBeDefined();
    if (!classification) {
      return;
    }
    classification.disposition = "abstained";
    classification.reasonCode = "unsupported-method";
    expect(() => parseLibCstScanResponse(invalid)).toThrow(
      "has an inconsistent abstained classification",
    );
  });

  it("serializes Python findings and plans through the shared core schemas", async () => {
    const scan = await scanPython("direct-model-literal");
    expect(scan.scope.extensions).toEqual([".py", ".pyi"]);
    expect(scan.summary).toEqual({ total: 1, blocking: 1, graphIssues: 0 });
    const finding = scan.findings[0];
    expect(finding).toBeDefined();
    if (!finding) {
      return;
    }
    expect(FindingSchema.parse(finding)).toEqual(finding);
    expect(finding).toMatchObject({
      schemaVersion: "4.0.0",
      language: "python",
      ruleId: "openai.transcriptions.model.gpt-4o-mini-transcribe-2025-03-20",
      evidence: PYTHON_SOURCE_MODEL,
      confidence: "high",
      automationTier: "A",
      remediation: { kind: "replace-string-literal", replacement: TARGET_MODEL },
      analysis: {
        family: "model-snapshot",
        feature: "model-snapshot",
        pattern: "direct",
        disposition: "supported",
      },
    });

    const plan = createPlanReport(scan).plan;
    expect(PatchPlanSchema.parse(plan)).toEqual(plan);
    expect(plan).toMatchObject({
      schemaVersion: "4.0.0",
      status: "ready",
      requiresCodex: false,
      allowedFiles: ["src/transcribe.py"],
    });
  });

  it("keeps parity with the TypeScript model-snapshot rule where semantics match", async () => {
    const [pythonScan, typescriptScan] = await Promise.all([
      scanPython("direct-model-literal"),
      scanRepository({
        repositoryRoot: path.join(PROJECT_ROOT, "fixtures", "typescript", "direct-model-literal"),
        registry,
        adapters: [typescriptAdapter],
      }),
    ]);
    const pythonFinding = pythonScan.findings[0];
    const typescriptFinding = typescriptScan.findings[0];
    expect(pythonFinding).toBeDefined();
    expect(typescriptFinding).toBeDefined();
    if (!pythonFinding || !typescriptFinding) {
      return;
    }
    expect({
      ruleId: pythonFinding.ruleId,
      resource: pythonFinding.resource,
      severity: pythonFinding.severity,
      evidence: pythonFinding.evidence,
      migrationEdgeIds: pythonFinding.migrationEdgeIds,
      confidence: pythonFinding.confidence,
      automationTier: pythonFinding.automationTier,
      reviewRequired: pythonFinding.reviewRequired,
      analysis: pythonFinding.analysis,
      remediation: pythonFinding.remediation,
    }).toEqual({
      ruleId: typescriptFinding.ruleId,
      resource: typescriptFinding.resource,
      severity: typescriptFinding.severity,
      evidence: typescriptFinding.evidence,
      migrationEdgeIds: typescriptFinding.migrationEdgeIds,
      confidence: typescriptFinding.confidence,
      automationTier: typescriptFinding.automationTier,
      reviewRequired: typescriptFinding.reviewRequired,
      analysis: typescriptFinding.analysis,
      remediation: typescriptFinding.remediation,
    });
  });

  it("delegates conflicting migration paths to the shared core graph resolver", async () => {
    const modelEdge = registry.edges.find((edge) => edge.from.id === PYTHON_SOURCE_MODEL);
    expect(modelEdge).toBeDefined();
    if (!modelEdge) {
      return;
    }
    const conflictEdge = {
      ...modelEdge,
      id: "synthetic.python.transcription.conflict",
      to: { kind: "model" as const, id: "synthetic-conflicting-target" },
      automationTier: "C" as const,
      reviewRequired: true,
    };
    const result = await adapter.scan({
      repositoryRoot: pythonFixture("direct-model-literal"),
      migrationEdges: [modelEdge, conflictEdge],
    });

    expect(result.graphIssues).toHaveLength(1);
    expect(result.graphIssues[0]).toMatchObject({
      kind: "source-conflict",
      language: "python",
      edgeIds: [modelEdge.id, conflictEdge.id].sort(),
    });
    expect(result.findings[0]).toMatchObject({
      kind: "source-conflict",
      language: "python",
      automationTier: "C",
      remediation: { kind: "none" },
    });
    expect(FindingSchema.parse(result.findings[0])).toEqual(result.findings[0]);
  });

  it.each(["aliased-import", "module-alias", "async-client", "unrelated-openai-shadow"])(
    "recognizes the %s OpenAI constructor binding",
    async (name) => {
      const scan = await scanPython(name);
      expect(scan.findings).toHaveLength(1);
      expect(scan.findings[0]?.language).toBe("python");
    },
  );

  it.each([
    "already-migrated",
    "async-reassigned-client",
    "comment-only",
    "conditional-client",
    "dynamic-model",
    "local-openai-shadow",
    "reassigned-client",
    "shadowed-client",
    "unrelated-model-property",
  ])("does not report the %s negative fixture", async (name) => {
    const scan = await scanPython(name);
    expect(scan.findings).toEqual([]);
    expect(scan.summary).toEqual({ total: 0, blocking: 0, graphIssues: 0 });
  });

  it("inventories direct Python Assistants calls and static behavior facets as Tier C", async () => {
    const scan = await scanPython("assistants-direct");

    expect(scan.summary).toEqual({ total: 21, blocking: 11, graphIssues: 0 });
    expect(
      scan.findings.every(
        (finding) =>
          finding.kind === "analysis-only" &&
          finding.language === "python" &&
          finding.automationTier === "C" &&
          finding.reviewRequired &&
          finding.remediation.kind === "none" &&
          finding.analysis.family === "assistants-api" &&
          finding.analysis.pattern === "direct" &&
          finding.analysis.disposition === "supported" &&
          finding.analysis.reasonCode === "manual-migration-required",
      ),
    ).toBe(true);
    expect(new Set(scan.findings.map((finding) => finding.analysis.feature))).toEqual(
      new Set([
        "assistants",
        "threads",
        "runs",
        "streaming",
        "tools",
        "file-search",
        "code-interpreter",
      ]),
    );
    expect(scan.findings.every((finding) => !finding.evidence.includes("("))).toBe(true);
    expect(scan.findings.every((finding) => FindingSchema.safeParse(finding).success)).toBe(true);

    const plan = createPlanReport(scan).plan;
    expect(plan).toMatchObject({ status: "blocked", requiresCodex: false, edits: [] });
    expect(plan.manualActions).toHaveLength(21);
    const preview = await createPatchPreview(pythonFixture("assistants-direct"), scan, plan);
    expect(preview.files).toEqual([]);

    const featuresFor = (evidence: string) =>
      scan.findings
        .filter((finding) => finding.evidence === evidence)
        .map((finding) => finding.analysis.feature);
    expect(featuresFor("client.beta.threads.messages.create")).toEqual(
      expect.arrayContaining(["threads", "tools", "file-search"]),
    );
    expect(featuresFor("client.beta.threads.runs.submit_tool_outputs")).toEqual(
      expect.arrayContaining(["threads", "runs", "streaming", "tools"]),
    );
  });

  it("fails closed when a proven Python Assistants call has no locked migration edge", async () => {
    await expect(
      adapter.scan({
        repositoryRoot: pythonFixture("assistants-direct"),
        migrationEdges: registry.edges.filter((edge) => edge.from.id !== "assistants-api"),
      }),
    ).rejects.toThrow("No locked Python migration edge exists for the Assistants API.");
  });

  it("covers the reviewed Python Assistants method allowlist", async () => {
    const scan = await scanPython("assistants-method-matrix");
    const expected = new Map<string, Set<string>>();
    const add = (methods: string[], features: string[]) => {
      for (const method of methods) {
        expected.set(method, new Set(features));
      }
    };

    add(
      ["create", "retrieve", "update", "list", "delete"].map(
        (method) => `client.beta.assistants.${method}`,
      ),
      ["assistants"],
    );
    add(
      ["create", "retrieve", "update", "delete"].map((method) => `client.beta.threads.${method}`),
      ["threads"],
    );
    add(
      ["create_and_run", "create_and_run_poll"].map((method) => `client.beta.threads.${method}`),
      ["threads", "runs"],
    );
    add(["client.beta.threads.create_and_run_stream"], ["threads", "runs", "streaming"]);
    add(
      ["create", "retrieve", "update", "list", "delete"].map(
        (method) => `client.beta.threads.messages.${method}`,
      ),
      ["threads"],
    );
    add(
      ["create", "retrieve", "update", "list", "cancel", "create_and_poll", "poll"].map(
        (method) => `client.beta.threads.runs.${method}`,
      ),
      ["threads", "runs"],
    );
    add(
      ["create_and_stream", "stream"].map((method) => `client.beta.threads.runs.${method}`),
      ["threads", "runs", "streaming"],
    );
    add(
      ["submit_tool_outputs", "submit_tool_outputs_and_poll"].map(
        (method) => `client.beta.threads.runs.${method}`,
      ),
      ["threads", "runs", "tools"],
    );
    add(
      ["client.beta.threads.runs.submit_tool_outputs_stream"],
      ["threads", "runs", "streaming", "tools"],
    );
    add(
      ["retrieve", "list"].map((method) => `client.beta.threads.runs.steps.${method}`),
      ["threads", "runs"],
    );

    const actual = new Map<string, Set<string>>();
    for (const finding of scan.findings) {
      const features = actual.get(finding.evidence) ?? new Set<string>();
      features.add(finding.analysis.feature);
      actual.set(finding.evidence, features);
    }
    expect(scan.summary).toEqual({ total: 55, blocking: 48, graphIssues: 0 });
    expect(actual).toEqual(expected);
  });

  it("proves renamed imports, module aliases, and AsyncOpenAI clients", async () => {
    const [aliases, asynchronous] = await Promise.all([
      scanPython("assistants-alias"),
      scanPython("assistants-async"),
    ]);

    expect(aliases.summary).toEqual({ total: 3, blocking: 3, graphIssues: 0 });
    expect(aliases.findings.every((finding) => finding.analysis.pattern === "import-alias")).toBe(
      true,
    );
    expect(asynchronous.summary).toEqual({ total: 4, blocking: 3, graphIssues: 0 });
    expect(asynchronous.findings.every((finding) => finding.analysis.pattern === "direct")).toBe(
      true,
    );
    expect(asynchronous.findings.map((finding) => finding.analysis.feature)).toEqual(
      expect.arrayContaining(["threads", "runs", "streaming"]),
    );
  });

  it("supports a lexically preceding visible closure binding and skips a forward binding", async () => {
    const [closure, forward] = await Promise.all([
      scanPython("assistants-closure"),
      scanPython("assistants-forward-binding"),
    ]);

    expect(closure.summary).toEqual({ total: 1, blocking: 1, graphIssues: 0 });
    expect(closure.findings[0]?.evidence).toBe("client.beta.threads.create");
    expect(forward.findings).toEqual([]);
  });

  it("keeps proven APIs while routing explicit dynamic facets and methods to abstentions", async () => {
    const scan = await scanPython("assistants-dynamic");
    const supported = scan.findings.filter(
      (finding) => finding.analysis.disposition === "supported",
    );
    const abstained = scan.findings.filter(
      (finding) => finding.analysis.disposition === "abstained",
    );

    expect(scan.summary).toEqual({ total: 10, blocking: 7, graphIssues: 0 });
    expect(supported).toHaveLength(5);
    expect(abstained).toHaveLength(5);
    expect(new Set(abstained.map((finding) => finding.analysis.reasonCode))).toEqual(
      new Set(["dynamic-stream", "dynamic-tools", "dynamic-tool-resources", "unsupported-method"]),
    );
    expect(
      abstained.every(
        (finding) =>
          finding.kind === "unsupported-pattern" &&
          finding.confidence === "medium" &&
          finding.abstentionReason !== undefined,
      ),
    ).toBe(true);
  });

  it.each(["assistants-negative", "assistants-shadowed", "assistants-reassigned"])(
    "does not infer Assistants provenance for the %s fixture",
    async (name) => {
      const scan = await scanPython(name);
      expect(scan.findings).toEqual([]);
      expect(scan.summary).toEqual({ total: 0, blocking: 0, graphIssues: 0 });
    },
  );

  it("preserves comments, spacing, quote style, and all non-model bytes", async () => {
    const root = pythonFixture("formatting-comments");
    const relativeFile = "src/transcribe.py";
    const before = await readFile(path.join(root, relativeFile), "utf8");
    const scan = await scanPython("formatting-comments");
    const plan = createPlanReport(scan).plan;
    const preview = await createPatchPreview(root, scan, plan);
    const previewFile = preview.files[0];
    expect(previewFile).toBeDefined();
    if (!previewFile) {
      return;
    }
    const patched = applyTextEdits(before, previewFile.edits);
    const rewritten = await adapter.rewriteSource({
      relativeFile,
      content: before,
      targetModel: TARGET_MODEL,
    });

    expect(rewritten.worker.libcstVersion).toBe("1.9.0");
    expect(rewritten.changedCount).toBe(1);
    expect(rewritten.content).toBe(patched);
    expect(patched).toBe(before.replace(PYTHON_SOURCE_MODEL, TARGET_MODEL));
    expect(patched).toContain("# keep the import explanation");
    expect(patched).toContain("# Keep this comment and the intentionally unusual spacing.");
    expect(patched).toContain("model = 'gpt-4o-mini-transcribe-2025-12-15'");
    expect(patched).toContain("# keep the trailing comment");
  });

  it("normalizes LibCST code-point columns to UTF-16 offsets after an astral character", async () => {
    const root = pythonFixture("astral-offset");
    const source = await readFile(path.join(root, "src", "transcribe.py"), "utf8");
    const scan = await scanPython("astral-offset");
    const finding = scan.findings[0];
    expect(finding).toBeDefined();
    if (!finding) {
      return;
    }
    const expectedStart = source.indexOf(PYTHON_SOURCE_MODEL);
    const lineStart = source.lastIndexOf("\n", expectedStart) + 1;
    expect(finding.location.startOffset).toBe(expectedStart);
    expect(finding.location.endOffset).toBe(expectedStart + PYTHON_SOURCE_MODEL.length);
    expect(finding.location.column).toBe(expectedStart - lineStart + 1);
    expect(source.slice(finding.location.startOffset, finding.location.endOffset)).toBe(
      PYTHON_SOURCE_MODEL,
    );
  });

  it("preserves CRLF bytes while rewriting after an astral character", async () => {
    const relativeFile = "src/transcribe.py";
    const before = [
      "from openai import OpenAI",
      "client = OpenAI()",
      `result = client.audio.transcriptions.create(prompt="🚀", model='${PYTHON_SOURCE_MODEL}')`,
      "",
    ].join("\r\n");
    const scanned = await adapter.bridge.scan(
      [{ path: relativeFile, content: before }],
      PYTHON_SOURCE_MODEL,
    );
    const match = scanned.files[0]?.matches[0];
    expect(match).toBeDefined();
    if (!match) {
      return;
    }
    const startOffset = pythonPositionToUtf16Offset(before, match.start);
    const endOffset = pythonPositionToUtf16Offset(before, match.end);
    expect(before.slice(startOffset, endOffset)).toBe(PYTHON_SOURCE_MODEL);

    const rewritten = await adapter.rewriteSource({
      relativeFile,
      content: before,
      targetModel: TARGET_MODEL,
    });
    expect(rewritten.content).toBe(before.replace(PYTHON_SOURCE_MODEL, TARGET_MODEL));
    expect(rewritten.content.split("\r\n")).toHaveLength(before.split("\r\n").length);
    expect(rewritten.content.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("preserves lone-CR bytes and offsets while rewriting", async () => {
    const relativeFile = "src/transcribe.py";
    const before = [
      "from openai import OpenAI",
      "client = OpenAI()",
      `result = client.audio.transcriptions.create(file=b"audio", model="${PYTHON_SOURCE_MODEL}")`,
      "",
    ].join("\r");
    const scanned = await adapter.bridge.scan(
      [{ path: relativeFile, content: before }],
      PYTHON_SOURCE_MODEL,
    );
    const match = scanned.files[0]?.matches[0];
    expect(match).toBeDefined();
    if (!match) {
      return;
    }
    const startOffset = pythonPositionToUtf16Offset(before, match.start);
    const endOffset = pythonPositionToUtf16Offset(before, match.end);
    expect(before.slice(startOffset, endOffset)).toBe(PYTHON_SOURCE_MODEL);

    const rewritten = await adapter.rewriteSource({
      relativeFile,
      content: before,
      targetModel: TARGET_MODEL,
    });
    expect(rewritten.content).toBe(before.replace(PYTHON_SOURCE_MODEL, TARGET_MODEL));
    expect(rewritten.content).not.toContain("\n");
  });

  it("preserves a UTF-8 BOM through scan, preview, and LibCST rewrite", async () => {
    const root = pythonFixture("utf8-bom");
    const relativeFile = "src/transcribe.py";
    const before = await readFile(path.join(root, relativeFile), "utf8");
    expect(before.startsWith("\uFEFF")).toBe(true);

    const scan = await scanPython("utf8-bom");
    const finding = scan.findings[0];
    expect(finding).toBeDefined();
    if (!finding) {
      return;
    }
    const expectedStart = before.indexOf(PYTHON_SOURCE_MODEL);
    expect(finding.location.startOffset).toBe(expectedStart);
    expect(finding.location.endOffset).toBe(expectedStart + PYTHON_SOURCE_MODEL.length);
    expect(finding.location.column).toBe(expectedStart + 1);

    const plan = createPlanReport(scan).plan;
    const preview = await createPatchPreview(root, scan, plan);
    const previewFile = preview.files[0];
    expect(previewFile).toBeDefined();
    if (!previewFile) {
      return;
    }
    const patched = applyTextEdits(before, previewFile.edits);
    expect(patched).toBe(before.replace(PYTHON_SOURCE_MODEL, TARGET_MODEL));
    expect(patched.startsWith("\uFEFF")).toBe(true);

    const rewritten = await adapter.rewriteSource({
      relativeFile,
      content: before,
      targetModel: TARGET_MODEL,
    });
    expect(rewritten.content).toBe(patched);
  });

  it("uses the shared preview and temporary-tree verifier without mutating Python source", async () => {
    const root = pythonFixture("direct-model-literal");
    const sourcePath = path.join(root, "src", "transcribe.py");
    const before = await readFile(sourcePath, "utf8");
    const scan = await scanPython("direct-model-literal");
    const plan = createPlanReport(scan).plan;
    const preview = await createPatchPreview(root, scan, plan);
    const report = await verifyPatchPlan({
      repositoryRoot: root,
      scan,
      plan,
      preview,
      registry,
      adapters: [adapter],
    });

    expect(report.verification.passed).toBe(true);
    expect(report.verification.runtimeBehaviorVerified).toBe(false);
    expect(report.verification.changedFiles).toEqual(["src/transcribe.py"]);
    expect(await readFile(sourcePath, "utf8")).toBe(before);
  });

  it("records Python performance separately from canonical reports and TypeScript ledgers", async () => {
    const ledger = await measurePythonAdapter({
      adapter,
      scan: {
        repositoryRoot: pythonFixture("direct-model-literal"),
        migrationEdges: registry.edges,
      },
      iterations: 1,
    });

    expect(ledger).toMatchObject({
      schemaVersion: PYTHON_PERFORMANCE_SCHEMA_VERSION,
      kind: "python-language-adapter-performance",
      measurementScope: "adapter-smoke",
      adapter: "python-libcst",
      environment: { libcstVersion: "1.9.0" },
      measurements: [
        {
          iteration: 1,
          mode: "isolated-process",
          candidateFiles: 1,
          findings: 1,
          graphIssues: 0,
        },
      ],
    });
    expect(ledger.toolRevision).toMatch(/^[a-f0-9]{40}$/u);
    expect(ledger.migrationEdgesHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(ledger.corpus.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(ledger).not.toHaveProperty("kind", "benchmark-ledger");
  });

  it("rejects an oversized noncandidate before reading its source", async () => {
    const repositoryRoot = await temporaryPythonRepository();
    const sourcePath = path.join(repositoryRoot, "generated.py");
    await writeFile(sourcePath, "pass\n", "utf8");
    await truncate(sourcePath, PYTHON_MAX_SOURCE_FILE_BYTES + 1);

    await expect(adapter.scan({ repositoryRoot, migrationEdges: registry.edges })).rejects.toThrow(
      `Python source file generated.py is ${PYTHON_MAX_SOURCE_FILE_BYTES + 1} bytes before read; the per-file source limit is ${PYTHON_MAX_SOURCE_FILE_BYTES} bytes.`,
    );
  });

  it("rejects noncandidate Python source counts during bounded enumeration", async () => {
    const repositoryRoot = await temporaryPythonRepository();
    const batchSize = 128;
    for (let start = 0; start <= PYTHON_MAX_SOURCE_FILES; start += batchSize) {
      const count = Math.min(batchSize, PYTHON_MAX_SOURCE_FILES + 1 - start);
      await Promise.all(
        Array.from({ length: count }, async (_, offset) => {
          await writeFile(path.join(repositoryRoot, `source-${start + offset}.py`), "", "utf8");
        }),
      );
    }

    await expect(adapter.scan({ repositoryRoot, migrationEdges: registry.edges })).rejects.toThrow(
      `the source file limit is ${PYTHON_MAX_SOURCE_FILES}`,
    );
  });

  it("rejects repositories above the production candidate-file limit", async () => {
    const repositoryRoot = await temporaryPythonRepository();
    const candidate = `# ${PYTHON_SOURCE_MODEL}\n`;
    for (let index = 0; index <= PYTHON_MAX_CANDIDATE_FILES; index += 1) {
      await writeFile(path.join(repositoryRoot, `candidate-${index}.py`), candidate, "utf8");
    }

    await expect(adapter.scan({ repositoryRoot, migrationEdges: registry.edges })).rejects.toThrow(
      `the candidate file limit is ${PYTHON_MAX_CANDIDATE_FILES}`,
    );
  });

  it("rejects repositories above the production aggregate candidate-source limit", async () => {
    const repositoryRoot = await temporaryPythonRepository();
    const fileCount = Math.floor(PYTHON_MAX_CANDIDATE_SOURCE_BYTES / PYTHON_MAX_SOURCE_FILE_BYTES);
    for (let index = 0; index <= fileCount; index += 1) {
      const sourcePath = path.join(repositoryRoot, `candidate-${index}.py`);
      await writeFile(sourcePath, `# ${PYTHON_SOURCE_MODEL}\n`, "utf8");
      await truncate(sourcePath, PYTHON_MAX_SOURCE_FILE_BYTES);
    }

    await expect(adapter.scan({ repositoryRoot, migrationEdges: registry.edges })).rejects.toThrow(
      `the aggregate source limit is ${PYTHON_MAX_CANDIDATE_SOURCE_BYTES} bytes`,
    );
  });

  it("enforces production source budgets on direct bridge scan and rewrite calls", async () => {
    const oversizedContent = "x".repeat(PYTHON_MAX_SOURCE_FILE_BYTES + 1);
    await expect(
      adapter.bridge.scan(
        [{ path: "oversized.py", content: oversizedContent }],
        PYTHON_SOURCE_MODEL,
      ),
    ).rejects.toThrow(`the per-file source limit is ${PYTHON_MAX_SOURCE_FILE_BYTES} bytes`);
    await expect(
      adapter.bridge.rewrite(
        [{ path: "oversized.py", content: oversizedContent }],
        PYTHON_SOURCE_MODEL,
        TARGET_MODEL,
      ),
    ).rejects.toThrow(`the per-file source limit is ${PYTHON_MAX_SOURCE_FILE_BYTES} bytes`);

    const tooManyFiles = Array.from({ length: PYTHON_MAX_CANDIDATE_FILES + 1 }, (_, index) => ({
      path: `candidate-${index}.py`,
      content: "pass\n",
    }));
    await expect(adapter.bridge.scan(tooManyFiles, PYTHON_SOURCE_MODEL)).rejects.toThrow(
      `the limit is ${PYTHON_MAX_CANDIDATE_FILES}`,
    );

    const contentAtFileLimit = "x".repeat(PYTHON_MAX_SOURCE_FILE_BYTES);
    const aggregateFiles = Array.from(
      {
        length: Math.floor(PYTHON_MAX_CANDIDATE_SOURCE_BYTES / PYTHON_MAX_SOURCE_FILE_BYTES) + 1,
      },
      (_, index) => ({ path: `aggregate-${index}.py`, content: contentAtFileLimit }),
    );
    await expect(adapter.bridge.scan(aggregateFiles, PYTHON_SOURCE_MODEL)).rejects.toThrow(
      `the aggregate source limit is ${PYTHON_MAX_CANDIDATE_SOURCE_BYTES} bytes`,
    );

    const controlCharacterContent = "\0".repeat(PYTHON_MAX_SOURCE_FILE_BYTES);
    const escapedInputFiles = Array.from(
      {
        length: PYTHON_MAX_CANDIDATE_SOURCE_BYTES / PYTHON_MAX_SOURCE_FILE_BYTES,
      },
      (_, index) => ({ path: `escaped-${index}.py`, content: controlCharacterContent }),
    );
    await expect(adapter.bridge.scan(escapedInputFiles, PYTHON_SOURCE_MODEL)).rejects.toThrow(
      `the worker input limit is ${PYTHON_MAX_WORKER_INPUT_BYTES} bytes`,
    );
  });

  it("rejects scan and rewrite workers whose LibCST version drifted", async () => {
    const bridge = new LibCstBridge({
      pythonExecutable: PYTHON_EXECUTABLE,
      workerPath: path.join(PROJECT_ROOT, "tests", "fixtures", "libcst-version-drift.py"),
    });

    const files = [{ path: "source.py", content: "pass\n" }];
    await expect(bridge.scan(files, PYTHON_SOURCE_MODEL)).rejects.toThrow(
      "requires LibCST 1.9.0; worker reported 1.8.6",
    );
    await expect(bridge.rewrite(files, PYTHON_SOURCE_MODEL, TARGET_MODEL)).rejects.toThrow(
      "requires LibCST 1.9.0; worker reported 1.8.6",
    );
  });

  it("does not inherit ambient secret variables into the LibCST subprocess", async () => {
    const bridge = new LibCstBridge({
      pythonExecutable: PYTHON_EXECUTABLE,
      workerPath: path.join(PROJECT_ROOT, "tests", "fixtures", "libcst-environment.py"),
    });
    process.env.MIGRATION_DOCTOR_PHASE7_SECRET = "must-not-cross-process-boundary";
    try {
      await expect(
        bridge.scan([{ path: "source.py", content: "pass\n" }], PYTHON_SOURCE_MODEL),
      ).resolves.toMatchObject({ worker: { libcstVersion: "1.9.0" } });
    } finally {
      delete process.env.MIGRATION_DOCTOR_PHASE7_SECRET;
    }
  });
});
