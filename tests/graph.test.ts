import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type MigrationLanguage, resolveMigrationPath } from "../packages/core/src/graph.js";
import {
  type MigrationEdge,
  MigrationEdgeSchema,
  REPORT_SCHEMA_VERSION,
  type ResourceRef,
  ResourceRefSchema,
} from "../packages/core/src/schemas.js";
import { PROJECT_ROOT } from "./helpers.js";

type GraphFixture = {
  language: MigrationLanguage;
  from: ResourceRef;
  edges: MigrationEdge[];
};

async function loadGraphFixture(name: string): Promise<GraphFixture> {
  const raw = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "fixtures", "graph", `${name}.json`), "utf8"),
  ) as {
    synthetic?: unknown;
    description?: unknown;
    language?: unknown;
    from?: unknown;
    edges?: unknown;
  };

  expect(raw.synthetic).toBe(true);
  expect(raw.description).toMatch(/^Synthetic/u);
  const language = raw.language;
  if (language !== "typescript" && language !== "python") {
    throw new Error(`Invalid graph fixture language: ${String(language)}`);
  }

  return {
    language,
    from: ResourceRefSchema.parse(raw.from),
    edges: MigrationEdgeSchema.array().parse(raw.edges),
  };
}

describe("migration graph resolution", () => {
  it("continues through a destination that is itself deprecated", async () => {
    const fixture = await loadGraphFixture("destination-deprecated");
    const result = resolveMigrationPath(fixture.edges, fixture.from, fixture.language);

    expect(result).toMatchObject({
      status: "resolved",
      to: { kind: "model", id: "synthetic-gamma-v1" },
      edgeIds: [
        "synthetic.alpha.to.beta.deprecations",
        "synthetic.alpha.to.beta.model-page",
        "synthetic.beta.to.gamma",
      ],
      automationTier: "B",
      reviewRequired: true,
      issue: null,
    });
    expect(result.sources.map((source) => source.url)).toEqual([
      "https://source-a.example.invalid/deprecations",
      "https://source-b.example.invalid/model-beta",
      "https://source-c.example.invalid/deprecations",
    ]);
  });

  it("blocks conflicting destinations and preserves both sources", async () => {
    const fixture = await loadGraphFixture("source-conflict");
    const result = resolveMigrationPath(fixture.edges, fixture.from, fixture.language);

    expect(result).toMatchObject({
      status: "blocked",
      to: null,
      automationTier: "C",
      reviewRequired: true,
      issue: {
        kind: "source-conflict",
        resource: { kind: "api", id: "synthetic-api-v1" },
        edgeIds: ["synthetic.api.to.replacement-a", "synthetic.api.to.replacement-b"],
        reviewRequired: true,
      },
    });
    expect(result.issue?.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.issue?.sources.map((source) => source.url)).toEqual([
      "https://conflict-a.example.invalid/migration",
      "https://conflict-b.example.invalid/migration",
    ]);
  });

  it("treats null and non-null recommendations as a source conflict", async () => {
    const fixture = await loadGraphFixture("source-conflict");
    const edges = fixture.edges.map((edge, index) => (index === 1 ? { ...edge, to: null } : edge));
    const result = resolveMigrationPath(edges, fixture.from, fixture.language);

    expect(result.status).toBe("blocked");
    expect(result.issue?.kind).toBe("source-conflict");
    expect(result.issue?.sources).toHaveLength(2);
  });

  it("blocks a graph cycle with every edge in the cycle", async () => {
    const fixture = await loadGraphFixture("cycle");
    const result = resolveMigrationPath(fixture.edges, fixture.from, fixture.language);

    expect(result).toMatchObject({
      status: "blocked",
      automationTier: "C",
      issue: {
        kind: "cycle",
        resource: { kind: "sdk-symbol", id: "synthetic.symbol.alpha" },
        edgeIds: ["synthetic.symbol.alpha.to.beta", "synthetic.symbol.beta.to.alpha"],
      },
    });
  });

  it("blocks guidance that has no destination", async () => {
    const fixture = await loadGraphFixture("missing-destination");
    const result = resolveMigrationPath(fixture.edges, fixture.from, fixture.language);

    expect(result).toMatchObject({
      status: "blocked",
      to: null,
      automationTier: "C",
      issue: {
        kind: "missing-destination",
        resource: { kind: "product", id: "synthetic-product-v1" },
        edgeIds: ["synthetic.product.destination-missing"],
      },
    });
  });

  it("blocks SDK-constrained guidance without structured repository evidence", async () => {
    const fixture = await loadGraphFixture("unverified-sdk-constraint");
    const result = resolveMigrationPath(fixture.edges, fixture.from, fixture.language);

    expect(result).toMatchObject({
      status: "blocked",
      automationTier: "C",
      issue: {
        kind: "unverified-constraint",
        resource: { kind: "sdk-symbol", id: "synthetic.sdk.alpha" },
        edgeIds: ["synthetic.sdk.alpha.to.beta"],
      },
    });
    expect(result.issue?.message).toContain("synthetic-sdk >= 2.0.0");
  });

  it("blocks a conditional destination that can diverge from an unconstrained path", async () => {
    const fixture = await loadGraphFixture("unverified-sdk-constraint");
    const constrained = fixture.edges[0];
    if (!constrained) {
      throw new Error("Expected the SDK-constraint fixture to contain an edge.");
    }
    const unconstrained: MigrationEdge = {
      ...constrained,
      id: "synthetic.sdk.alpha.to.gamma",
      to: { kind: "sdk-symbol", id: "synthetic.sdk.gamma" },
      sdkConstraints: undefined,
    };
    const result = resolveMigrationPath(
      [unconstrained, ...fixture.edges],
      fixture.from,
      fixture.language,
    );

    expect(result.status).toBe("blocked");
    expect(result.issue?.kind).toBe("unverified-constraint");
    expect(result.edgeIds).toEqual(["synthetic.sdk.alpha.to.beta", "synthetic.sdk.alpha.to.gamma"]);
  });

  it("blocks an unverified stricter edge even when its destination agrees", async () => {
    const fixture = await loadGraphFixture("unverified-sdk-constraint");
    const constrained = fixture.edges[0];
    if (!constrained) {
      throw new Error("Expected the SDK-constraint fixture to contain an edge.");
    }
    const unconstrained: MigrationEdge = {
      ...constrained,
      id: "synthetic.sdk.alpha.to.beta.unconstrained",
      sdkConstraints: undefined,
      automationTier: "A",
      reviewRequired: false,
    };
    const stricter: MigrationEdge = {
      ...constrained,
      automationTier: "C",
      reviewRequired: true,
    };

    const result = resolveMigrationPath([unconstrained, stricter], fixture.from, fixture.language);

    expect(result.status).toBe("blocked");
    expect(result.issue?.kind).toBe("unverified-constraint");
  });

  it("reports a guaranteed unconstrained conflict before unknown constraints", async () => {
    const fixture = await loadGraphFixture("unverified-sdk-constraint");
    const constrained = fixture.edges[0];
    if (!constrained) {
      throw new Error("Expected the SDK-constraint fixture to contain an edge.");
    }
    const replacementA: MigrationEdge = {
      ...constrained,
      id: "synthetic.sdk.alpha.to.replacement-a",
      to: { kind: "sdk-symbol", id: "synthetic.sdk.replacement-a" },
      sdkConstraints: undefined,
    };
    const replacementB: MigrationEdge = {
      ...constrained,
      id: "synthetic.sdk.alpha.to.replacement-b",
      to: { kind: "sdk-symbol", id: "synthetic.sdk.replacement-b" },
      sdkConstraints: undefined,
    };

    const result = resolveMigrationPath(
      [constrained, replacementB, replacementA],
      fixture.from,
      fixture.language,
    );

    expect(result.status).toBe("blocked");
    expect(result.issue?.kind).toBe("source-conflict");
    expect(result.issue?.edgeIds).toEqual([
      "synthetic.sdk.alpha.to.replacement-a",
      "synthetic.sdk.alpha.to.replacement-b",
    ]);
  });

  it("treats same-target sources as agreement independent of edge order", async () => {
    const fixture = await loadGraphFixture("destination-deprecated");
    const forward = resolveMigrationPath(fixture.edges, fixture.from, fixture.language);
    const reversed = resolveMigrationPath(
      [...fixture.edges].reverse(),
      fixture.from,
      fixture.language,
    );

    expect(forward.status).toBe("resolved");
    expect(reversed).toEqual(forward);
    expect(forward.edgeIds).toContain("synthetic.alpha.to.beta.deprecations");
    expect(forward.edgeIds).toContain("synthetic.alpha.to.beta.model-page");
    expect(forward.automationTier).toBe("B");
    expect(forward.reviewRequired).toBe(true);
  });

  it("returns unmapped when the language has no outgoing migration", async () => {
    const fixture = await loadGraphFixture("destination-deprecated");
    const result = resolveMigrationPath(fixture.edges, fixture.from, "python");
    const terminal = resolveMigrationPath(
      fixture.edges,
      ResourceRefSchema.parse({ kind: "model", id: "synthetic-unmapped" }),
      "typescript",
    );

    expect(result).toMatchObject({
      status: "resolved",
      to: { kind: "model", id: "synthetic-beta-v1" },
      edgeIds: ["synthetic.alpha.to.beta.model-page"],
    });
    expect(terminal).toEqual({
      schemaVersion: REPORT_SCHEMA_VERSION,
      status: "unmapped",
      language: "typescript",
      from: { kind: "model", id: "synthetic-unmapped" },
      to: null,
      edgeIds: [],
      sources: [],
      automationTier: null,
      reviewRequired: false,
      issue: null,
    });
  });
});
