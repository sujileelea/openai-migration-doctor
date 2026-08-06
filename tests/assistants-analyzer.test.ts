import { type Finding, loadMigrationRegistry, scanRepository } from "@migration-doctor/core";
import { TypeScriptLanguageAdapter } from "@migration-doctor/language-typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { fixturePath, PROJECT_ROOT } from "./helpers.js";

const adapter = new TypeScriptLanguageAdapter();
let registry: Awaited<ReturnType<typeof loadMigrationRegistry>>;

beforeAll(async () => {
  registry = await loadMigrationRegistry(PROJECT_ROOT);
});

async function scanFixture(name: string) {
  return scanRepository({
    repositoryRoot: fixturePath(name),
    registry,
    adapters: [adapter],
  });
}

function label(fixture: string, finding: Finding): string {
  const analysis = finding.analysis;
  return [
    fixture,
    finding.location.file,
    finding.location.line,
    finding.location.column,
    analysis.feature,
    analysis.pattern,
    analysis.disposition,
    analysis.reasonCode ?? "",
  ].join(":");
}

function expectedLabel(
  fixture: string,
  line: number,
  column: number,
  feature: Finding["analysis"]["feature"],
  pattern: Finding["analysis"]["pattern"],
  disposition: Finding["analysis"]["disposition"],
  reasonCode: string,
): string {
  return [fixture, "src/index.ts", line, column, feature, pattern, disposition, reasonCode].join(
    ":",
  );
}

function metrics(expected: Set<string>, actual: Set<string>) {
  const truePositives = [...actual].filter((item) => expected.has(item)).length;
  const falsePositives = [...actual].filter((item) => !expected.has(item)).length;
  const falseNegatives = [...expected].filter((item) => !actual.has(item)).length;
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision: truePositives / (truePositives + falsePositives),
    recall: truePositives / (truePositives + falseNegatives),
  };
}

const supported = (
  fixture: string,
  line: number,
  feature: Finding["analysis"]["feature"],
  pattern: Finding["analysis"]["pattern"],
  column = 7,
) =>
  expectedLabel(fixture, line, column, feature, pattern, "supported", "manual-migration-required");

const abstained = (
  line: number,
  column: number,
  feature: Finding["analysis"]["feature"],
  pattern: Finding["analysis"]["pattern"],
  reasonCode: string,
) =>
  expectedLabel("assistants-abstentions", line, column, feature, pattern, "abstained", reasonCode);

const EXPECTED_SUPPORTED = new Set([
  supported("assistants-direct", 5, "assistants", "import-alias"),
  supported("assistants-direct", 5, "tools", "import-alias"),
  supported("assistants-direct", 5, "file-search", "import-alias"),
  supported("assistants-direct", 5, "code-interpreter", "import-alias"),
  supported("assistants-direct", 14, "threads", "import-alias"),
  supported("assistants-direct", 15, "threads", "import-alias"),
  supported("assistants-direct", 15, "runs", "import-alias"),
  supported("assistants-direct", 15, "streaming", "import-alias"),
  supported("assistants-direct", 18, "threads", "property-alias"),
  supported("assistants-direct", 18, "runs", "property-alias"),
  supported("assistants-direct", 18, "streaming", "property-alias"),
  supported("assistants-direct", 18, "tools", "property-alias"),
  supported("assistants-direct", 25, "threads", "client-alias"),
  supported("assistants-direct", 30, "assistants", "import-alias"),
  supported("assistants-direct", 33, "threads", "property-alias"),
  supported("assistants-abstentions", 23, "threads", "import-alias"),
  supported("assistants-abstentions", 23, "runs", "import-alias"),
  supported("assistants-abstentions", 28, "assistants", "import-alias"),
  supported("assistants-abstentions", 18, "assistants", "import-alias"),
]);

const EXPECTED_ABSTENTIONS = new Set([
  abstained(11, 10, "threads", "wrapper", "wrapper-parameter"),
  abstained(11, 10, "runs", "wrapper", "wrapper-parameter"),
  abstained(15, 7, "assistants", "method-alias", "method-alias"),
  abstained(17, 7, "threads", "dynamic-member", "computed-member-access"),
  abstained(17, 7, "runs", "dynamic-member", "computed-member-access"),
  abstained(19, 7, "threads", "indirect-invocation", "indirect-invocation"),
  abstained(19, 7, "runs", "indirect-invocation", "indirect-invocation"),
  abstained(23, 7, "streaming", "dynamic-request", "dynamic-stream"),
  abstained(28, 7, "tools", "dynamic-request", "dynamic-tools"),
  abstained(33, 7, "threads", "dynamic-member", "optional-member-access"),
  abstained(33, 7, "runs", "dynamic-member", "optional-member-access"),
  abstained(37, 10, "threads", "wrapper", "wrapper-parameter"),
  abstained(37, 10, "runs", "wrapper", "wrapper-parameter"),
]);

describe("Assistants API TypeScript analysis", () => {
  it("covers the reviewed OpenAI Node method allowlist and legacy del aliases", async () => {
    const scan = await scanFixture("assistants-method-matrix");
    const expected = new Map<string, Set<Finding["analysis"]["feature"]>>();
    const add = (methods: string[], features: Array<Finding["analysis"]["feature"]>) => {
      for (const method of methods) {
        expected.set(method, new Set(features));
      }
    };

    add(
      ["create", "retrieve", "update", "list", "delete", "del"].map(
        (method) => `client.beta.assistants.${method}`,
      ),
      ["assistants"],
    );
    add(
      ["create", "retrieve", "update", "delete", "del"].map(
        (method) => `client.beta.threads.${method}`,
      ),
      ["threads"],
    );
    add(
      ["createAndRun", "createAndRunPoll"].map((method) => `client.beta.threads.${method}`),
      ["threads", "runs"],
    );
    add(["client.beta.threads.createAndRunStream"], ["threads", "runs", "streaming"]);
    add(
      ["create", "retrieve", "update", "list", "delete", "del"].map(
        (method) => `client.beta.threads.messages.${method}`,
      ),
      ["threads"],
    );
    add(
      ["create", "retrieve", "update", "list", "cancel", "createAndPoll", "poll"].map(
        (method) => `client.beta.threads.runs.${method}`,
      ),
      ["threads", "runs"],
    );
    add(
      ["createAndStream", "stream"].map((method) => `client.beta.threads.runs.${method}`),
      ["threads", "runs", "streaming"],
    );
    add(
      ["submitToolOutputs", "submitToolOutputsAndPoll"].map(
        (method) => `client.beta.threads.runs.${method}`,
      ),
      ["threads", "runs", "tools"],
    );
    add(
      ["client.beta.threads.runs.submitToolOutputsStream"],
      ["threads", "runs", "streaming", "tools"],
    );
    add(
      ["retrieve", "list"].map((method) => `client.beta.threads.runs.steps.${method}`),
      ["threads", "runs"],
    );

    const actual = new Map<string, Set<Finding["analysis"]["feature"]>>();
    for (const finding of scan.findings) {
      const features = actual.get(finding.evidence) ?? new Set();
      features.add(finding.analysis.feature);
      actual.set(finding.evidence, features);
    }

    expect(scan.summary).toEqual({ total: 58, blocking: 51, graphIssues: 0 });
    expect(actual).toEqual(expected);
  });

  it("classifies direct API surfaces and feature facets as Tier C analysis only", async () => {
    const scan = await scanFixture("assistants-direct");

    expect(scan.summary).toEqual({ total: 15, blocking: 9, graphIssues: 0 });
    expect(scan.findings).toHaveLength(15);
    expect(
      scan.findings.every(
        (finding) =>
          finding.kind === "analysis-only" &&
          finding.automationTier === "C" &&
          finding.reviewRequired &&
          finding.remediation.kind === "none" &&
          finding.analysis.family === "assistants-api",
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
    expect(
      scan.findings.map((finding) => finding.evidence).every((value) => !value.includes("(")),
    ).toBe(true);
  });

  it("routes high-signal unsupported patterns to stable abstentions", async () => {
    const scan = await scanFixture("assistants-abstentions");
    const unsupported = scan.findings.filter(
      (finding) => finding.analysis.disposition === "abstained",
    );

    expect(unsupported).toHaveLength(13);
    expect(
      unsupported.every(
        (finding) =>
          finding.kind === "unsupported-pattern" &&
          finding.analysis.reasonCode !== undefined &&
          finding.abstentionReason !== undefined &&
          finding.remediation.kind === "none",
      ),
    ).toBe(true);
    expect(new Set(unsupported.map((finding) => finding.analysis.reasonCode))).toEqual(
      new Set([
        "wrapper-parameter",
        "method-alias",
        "computed-member-access",
        "optional-member-access",
        "indirect-invocation",
        "dynamic-stream",
        "dynamic-tools",
      ]),
    );

    const dynamicStream = scan.findings.filter((finding) => finding.location.line === 23);
    expect(dynamicStream.map((finding) => finding.analysis)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: "threads", disposition: "supported" }),
        expect.objectContaining({ feature: "runs", disposition: "supported" }),
        expect.objectContaining({
          feature: "streaming",
          disposition: "abstained",
          reasonCode: "dynamic-stream",
        }),
      ]),
    );
  });

  it("does not report comments, strings, fake clients, type-only construction, or Responses", async () => {
    const scan = await scanFixture("assistants-negative");
    expect(scan.findings).toEqual([]);
    expect(scan.summary).toEqual({ total: 0, blocking: 0, graphIssues: 0 });
  });

  it("does not require an Assistants edge for text candidates without proven usage", async () => {
    const result = await adapter.scan({
      repositoryRoot: fixturePath("assistants-negative"),
      migrationEdges: registry.edges.filter((edge) => edge.from.id !== "assistants-api"),
    });

    expect(result).toEqual({ findings: [], graphIssues: [] });
  });

  it("measures 100% supported precision and recall with complete abstention routing", async () => {
    const scans = await Promise.all([
      scanFixture("assistants-direct"),
      scanFixture("assistants-abstentions"),
      scanFixture("assistants-negative"),
    ]);
    const fixtures = ["assistants-direct", "assistants-abstentions", "assistants-negative"];
    const labeled = scans.flatMap((scan, index) =>
      scan.findings.map((finding) => ({ fixture: fixtures[index] as string, finding })),
    );
    const actualSupported = new Set(
      labeled
        .filter(({ finding }) => finding.analysis.disposition === "supported")
        .map(({ fixture, finding }) => label(fixture, finding)),
    );
    const actualAbstentions = new Set(
      labeled
        .filter(({ finding }) => finding.analysis.disposition === "abstained")
        .map(({ fixture, finding }) => label(fixture, finding)),
    );

    expect(metrics(EXPECTED_SUPPORTED, actualSupported)).toEqual({
      truePositives: 19,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
    });
    expect(metrics(EXPECTED_ABSTENTIONS, actualAbstentions)).toEqual({
      truePositives: 13,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
    });
  });
});
