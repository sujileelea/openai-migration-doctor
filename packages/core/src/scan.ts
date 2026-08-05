import { compareStrings } from "./compare.js";
import type { LanguageAdapter } from "./ports.js";
import {
  DEFAULT_EXCLUSIONS,
  normalizeRepositoryRoot,
  readRepositoryRevision,
} from "./repository.js";
import { FindingSchema, SCHEMA_VERSION, type ScanResult, ScanResultSchema } from "./schemas.js";
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

export async function scanRepository(request: ScanRepositoryRequest): Promise<ScanResult> {
  const repositoryRoot = await normalizeRepositoryRoot(request.repositoryRoot);
  const findingGroups = await Promise.all(
    request.adapters.map((adapter) =>
      adapter.scan({ repositoryRoot, migrationEdges: request.registry.edges }),
    ),
  );
  const findings = findingGroups.flat().map((finding) => FindingSchema.parse(finding));
  findings.sort(compareFindings);

  const extensions = [...new Set(request.adapters.flatMap((adapter) => [...adapter.extensions]))];
  extensions.sort(compareStrings);

  return ScanResultSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    kind: "scan",
    repository: { revision: await readRepositoryRevision(repositoryRoot) },
    sourceLockHash: request.registry.sourceLockHash,
    scope: {
      extensions,
      exclusions: [...DEFAULT_EXCLUSIONS].sort(compareStrings),
    },
    migrationEdges: request.registry.edges,
    findings,
    summary: {
      total: findings.length,
      blocking: findings.filter((finding) => finding.severity === "error").length,
    },
  });
}
