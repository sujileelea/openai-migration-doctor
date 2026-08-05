import { canonicalJson } from "./canonical-json.js";
import { compareStrings } from "./compare.js";
import { AnalysisError } from "./errors.js";
import type { LanguageAdapter } from "./ports.js";
import {
  DEFAULT_EXCLUSIONS,
  normalizeRepositoryRoot,
  readRepositoryRevision,
} from "./repository.js";
import {
  FindingSchema,
  type MigrationGraphIssue,
  MigrationGraphIssueSchema,
  REPORT_SCHEMA_VERSION,
  type ScanResult,
  ScanResultSchema,
} from "./schemas.js";
import type { MigrationRegistry } from "./source-lock.js";

export type ScanRepositoryRequest = {
  repositoryRoot: string;
  registry: MigrationRegistry;
  adapters: LanguageAdapter[];
};

function compareFindings(
  left: ReturnType<typeof FindingSchema.parse>,
  right: ReturnType<typeof FindingSchema.parse>,
): number {
  return (
    compareStrings(left.location.file, right.location.file) ||
    left.location.line - right.location.line ||
    left.location.column - right.location.column ||
    compareStrings(left.ruleId, right.ruleId) ||
    compareStrings(left.id, right.id)
  );
}

function compareGraphIssues(left: MigrationGraphIssue, right: MigrationGraphIssue): number {
  return (
    compareStrings(left.kind, right.kind) ||
    compareStrings(left.resource.kind, right.resource.kind) ||
    compareStrings(left.resource.id, right.resource.id) ||
    compareStrings(left.language, right.language) ||
    compareStrings(left.id, right.id)
  );
}

export async function scanRepository(request: ScanRepositoryRequest): Promise<ScanResult> {
  const repositoryRoot = await normalizeRepositoryRoot(request.repositoryRoot);
  const findingGroups = await Promise.all(
    request.adapters.map((adapter) =>
      adapter.scan({ repositoryRoot, migrationEdges: request.registry.edges }),
    ),
  );
  const findings = findingGroups
    .flatMap((group) => group.findings)
    .map((finding) => FindingSchema.parse(finding));
  findings.sort(compareFindings);

  const issueById = new Map<string, MigrationGraphIssue>();
  for (const issue of findingGroups.flatMap((group) => group.graphIssues)) {
    const parsed = MigrationGraphIssueSchema.parse(issue);
    const existing = issueById.get(parsed.id);
    if (existing && canonicalJson(existing) !== canonicalJson(parsed)) {
      throw new AnalysisError(`Graph issue ${parsed.id} has conflicting analyzer records.`);
    }
    issueById.set(parsed.id, parsed);
  }
  for (const finding of findings) {
    for (const issueId of finding.graphIssueIds) {
      if (!issueById.has(issueId)) {
        throw new AnalysisError(`Finding ${finding.id} references unknown graph issue ${issueId}.`);
      }
    }
  }
  const graphIssues = [...issueById.values()].sort(compareGraphIssues);

  const extensions = [...new Set(request.adapters.flatMap((adapter) => [...adapter.extensions]))];
  extensions.sort(compareStrings);

  return ScanResultSchema.parse({
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "scan",
    repository: { revision: await readRepositoryRevision(repositoryRoot) },
    sourceLockHash: request.registry.sourceLockHash,
    scope: {
      extensions,
      exclusions: [...DEFAULT_EXCLUSIONS].sort(compareStrings),
    },
    migrationEdges: request.registry.edges,
    graphIssues,
    findings,
    summary: {
      total: findings.length,
      blocking: findings.filter((finding) => finding.severity === "error").length,
      graphIssues: graphIssues.length,
    },
  });
}
