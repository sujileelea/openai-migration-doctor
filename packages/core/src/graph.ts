import { compareStrings } from "./compare.js";
import { sha256 } from "./hash.js";
import {
  type MigrationEdge,
  type MigrationGraphIssue,
  type MigrationLanguage,
  REPORT_SCHEMA_VERSION,
  type ResourceRef,
  type SourceRef,
} from "./schemas.js";

export type { MigrationGraphIssue, MigrationLanguage } from "./schemas.js";

type ResolutionEvidence = {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  language: MigrationLanguage;
  from: ResourceRef;
  edgeIds: string[];
  sources: SourceRef[];
};

export type MigrationResolution =
  | (ResolutionEvidence & {
      status: "unmapped";
      to: null;
      automationTier: null;
      reviewRequired: false;
      issue: null;
    })
  | (ResolutionEvidence & {
      status: "resolved";
      to: ResourceRef;
      automationTier: MigrationEdge["automationTier"];
      reviewRequired: boolean;
      issue: null;
    })
  | (ResolutionEvidence & {
      status: "blocked";
      to: null;
      automationTier: "C";
      reviewRequired: true;
      issue: MigrationGraphIssue;
    });

type DestinationGroup = {
  resource: ResourceRef | null;
  edges: MigrationEdge[];
};

const tierRank: Record<MigrationEdge["automationTier"], number> = {
  A: 0,
  B: 1,
  C: 2,
};

function resourceKey(resource: ResourceRef): string {
  return `${resource.kind}:${resource.id}`;
}

function resourcePresentationKey(resource: ResourceRef): string {
  return `${resourceKey(resource)}\u0000${resource.displayName ?? ""}`;
}

function sourceKey(source: SourceRef): string {
  return [source.url, source.title, source.contentHash, source.retrievedAt].join("\u0000");
}

function edgeSortKey(edge: MigrationEdge): string {
  return [
    edge.id,
    resourceKey(edge.from),
    edge.to ? resourcePresentationKey(edge.to) : "<missing>",
    edge.automationTier,
    edge.reviewRequired ? "1" : "0",
    ...[...(edge.sdkConstraints ?? [])].sort(compareStrings),
    ...edge.sources.map(sourceKey).sort(compareStrings),
  ].join("\u0000");
}

function sortEdges(edges: readonly MigrationEdge[]): MigrationEdge[] {
  return [...edges].sort((left, right) => compareStrings(edgeSortKey(left), edgeSortKey(right)));
}

function collectEdgeIds(edges: readonly MigrationEdge[]): string[] {
  return [...new Set(edges.map((edge) => edge.id))];
}

function collectSources(edges: readonly MigrationEdge[]): SourceRef[] {
  const sources = new Map<string, SourceRef>();
  for (const edge of edges) {
    for (const source of edge.sources) {
      sources.set(sourceKey(source), source);
    }
  }
  return [...sources.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, source]) => source);
}

function collectSdkConstraints(edges: readonly MigrationEdge[]): string[] {
  return [...new Set(edges.flatMap((edge) => edge.sdkConstraints ?? []))].sort(compareStrings);
}

function createIssue(
  kind: MigrationGraphIssue["kind"],
  language: MigrationLanguage,
  resource: ResourceRef,
  edges: readonly MigrationEdge[],
  message: string,
): MigrationGraphIssue {
  const edgeIds = collectEdgeIds(edges);
  const sources = collectSources(edges);
  const id = sha256(
    [
      "migration-graph-issue",
      REPORT_SCHEMA_VERSION,
      kind,
      language,
      resourceKey(resource),
      ...edgeIds,
      ...sources.map(sourceKey),
    ].join("\u0000"),
  );

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    id,
    kind,
    language,
    resource,
    edgeIds,
    sources,
    message,
    reviewRequired: true,
  };
}

function createBlockedResolution(
  from: ResourceRef,
  language: MigrationLanguage,
  traversedEdges: readonly MigrationEdge[],
  issue: MigrationGraphIssue,
): MigrationResolution {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "blocked",
    language,
    from,
    to: null,
    edgeIds: collectEdgeIds(traversedEdges),
    sources: collectSources(traversedEdges),
    automationTier: "C",
    reviewRequired: true,
    issue,
  };
}

function groupDestinations(edges: readonly MigrationEdge[]): DestinationGroup[] {
  const groups = new Map<string, DestinationGroup>();
  for (const edge of edges) {
    const key = edge.to ? resourceKey(edge.to) : "<missing>";
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { resource: edge.to, edges: [edge] });
      continue;
    }

    existing.edges.push(edge);
    if (
      existing.resource &&
      edge.to &&
      compareStrings(resourcePresentationKey(edge.to), resourcePresentationKey(existing.resource)) <
        0
    ) {
      existing.resource = edge.to;
    }
  }

  return [...groups.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, group]) => ({ ...group, edges: sortEdges(group.edges) }));
}

function mostRestrictiveTier(
  current: MigrationEdge["automationTier"],
  edges: readonly MigrationEdge[],
): MigrationEdge["automationTier"] {
  let result = current;
  for (const edge of edges) {
    if (tierRank[edge.automationTier] > tierRank[result]) {
      result = edge.automationTier;
    }
  }
  return result;
}

export function resolveMigrationPath(
  edges: readonly MigrationEdge[],
  from: ResourceRef,
  language: MigrationLanguage,
): MigrationResolution {
  const outgoingByResource = new Map<string, MigrationEdge[]>();
  for (const edge of edges) {
    if (!edge.languages.includes(language)) {
      continue;
    }
    const key = resourceKey(edge.from);
    const outgoing = outgoingByResource.get(key) ?? [];
    outgoing.push(edge);
    outgoingByResource.set(key, outgoing);
  }
  for (const outgoing of outgoingByResource.values()) {
    outgoing.sort((left, right) => compareStrings(edgeSortKey(left), edgeSortKey(right)));
  }

  if (!outgoingByResource.has(resourceKey(from))) {
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      status: "unmapped",
      language,
      from,
      to: null,
      edgeIds: [],
      sources: [],
      automationTier: null,
      reviewRequired: false,
      issue: null,
    };
  }

  const visited = new Set([resourceKey(from)]);
  const traversedEdges: MigrationEdge[] = [];
  let current = from;
  let automationTier: MigrationEdge["automationTier"] = "A";
  let reviewRequired = false;

  while (true) {
    const outgoing = outgoingByResource.get(resourceKey(current));
    if (!outgoing || outgoing.length === 0) {
      return {
        schemaVersion: REPORT_SCHEMA_VERSION,
        status: "resolved",
        language,
        from,
        to: current,
        edgeIds: collectEdgeIds(traversedEdges),
        sources: collectSources(traversedEdges),
        automationTier,
        reviewRequired,
        issue: null,
      };
    }

    const unconstrained = outgoing.filter((edge) => (edge.sdkConstraints?.length ?? 0) === 0);
    const destinations = groupDestinations(unconstrained);
    if (destinations.length > 1) {
      const labels = destinations
        .map(({ resource }) => (resource ? resourceKey(resource) : "<missing>"))
        .sort(compareStrings);
      const issue = createIssue(
        "source-conflict",
        language,
        current,
        unconstrained,
        `Conflicting migration destinations for ${resourceKey(current)}: ${labels.join(", ")}.`,
      );
      return createBlockedResolution(from, language, [...traversedEdges, ...unconstrained], issue);
    }

    const constrained = outgoing.filter((edge) => (edge.sdkConstraints?.length ?? 0) > 0);
    if (constrained.length > 0) {
      const issue = createIssue(
        "unverified-constraint",
        language,
        current,
        outgoing,
        `Migration guidance for ${resourceKey(current)} contains SDK constraints without structured repository evidence: ${collectSdkConstraints(constrained).join(", ")}.`,
      );
      return createBlockedResolution(from, language, [...traversedEdges, ...outgoing], issue);
    }

    const destination = destinations[0];
    if (!destination || destination.resource === null) {
      const issueEdges = destination?.edges ?? unconstrained;
      const issue = createIssue(
        "missing-destination",
        language,
        current,
        issueEdges,
        `Migration guidance for ${resourceKey(current)} does not name a destination.`,
      );
      return createBlockedResolution(from, language, [...traversedEdges, ...issueEdges], issue);
    }

    traversedEdges.push(...destination.edges);
    automationTier = mostRestrictiveTier(automationTier, destination.edges);
    reviewRequired ||= destination.edges.some((edge) => edge.reviewRequired);

    const next = destination.resource;
    const nextKey = resourceKey(next);
    if (visited.has(nextKey)) {
      const issue = createIssue(
        "cycle",
        language,
        next,
        traversedEdges,
        `Migration graph cycle revisits ${nextKey}.`,
      );
      return createBlockedResolution(from, language, traversedEdges, issue);
    }

    visited.add(nextKey);
    current = next;
  }
}
