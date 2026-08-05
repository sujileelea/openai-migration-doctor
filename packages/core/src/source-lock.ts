import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { SourceLockError } from "./errors.js";
import { sha256 } from "./hash.js";
import {
  type MigrationEdge,
  MigrationRecordSchema,
  SourceLockSchema,
  type SourceRecord,
  SourceRecordSchema,
} from "./schemas.js";

export type MigrationRegistry = {
  sourceLockHash: string;
  sources: SourceRecord[];
  edges: MigrationEdge[];
};

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SourceLockError(`${label} is not valid JSON.`, { cause: error });
  }
}

async function resolveArtifact(projectRoot: string, relativePath: string): Promise<string> {
  const root = await realpath(projectRoot);
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new SourceLockError(`Locked artifact escapes the project root: ${relativePath}`);
  }
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    throw new SourceLockError(`Unable to resolve locked artifact ${relativePath}.`, {
      cause: error,
    });
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new SourceLockError(`Locked artifact symlink escapes the project root: ${relativePath}`);
  }
  return resolved;
}

export async function loadMigrationRegistry(projectRoot: string): Promise<MigrationRegistry> {
  const lockPath = path.join(projectRoot, "migration.lock");
  let lockRaw: string;
  try {
    lockRaw = await readFile(lockPath, "utf8");
  } catch (error) {
    throw new SourceLockError(`Unable to read source lock at ${lockPath}.`, { cause: error });
  }

  const parsedLock = SourceLockSchema.safeParse(parseJson(lockRaw, "migration.lock"));
  if (!parsedLock.success) {
    throw new SourceLockError(
      `migration.lock failed schema validation: ${parsedLock.error.message}`,
    );
  }

  const sources: SourceRecord[] = [];
  const edges: MigrationEdge[] = [];
  const seenPaths = new Set<string>();

  for (const artifact of parsedLock.data.artifacts) {
    if (seenPaths.has(artifact.path)) {
      throw new SourceLockError(`migration.lock contains a duplicate path: ${artifact.path}`);
    }
    seenPaths.add(artifact.path);

    const artifactPath = await resolveArtifact(projectRoot, artifact.path);
    let raw: string;
    try {
      raw = await readFile(artifactPath, "utf8");
    } catch (error) {
      throw new SourceLockError(`Unable to read locked artifact ${artifact.path}.`, {
        cause: error,
      });
    }

    const actualHash = sha256(raw);
    if (actualHash !== artifact.sha256) {
      throw new SourceLockError(
        `Locked artifact hash mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actualHash}.`,
      );
    }

    const value = parseJson(raw, artifact.path);
    if (artifact.kind === "source") {
      const parsed = SourceRecordSchema.safeParse(value);
      if (!parsed.success) {
        throw new SourceLockError(
          `${artifact.path} failed schema validation: ${parsed.error.message}`,
        );
      }
      sources.push(parsed.data);
      continue;
    }

    const parsed = MigrationRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw new SourceLockError(
        `${artifact.path} failed schema validation: ${parsed.error.message}`,
      );
    }
    edges.push(parsed.data.edge);
  }

  const sourceKeys = new Set(
    sources.map(
      ({ source }) => `${source.url}\u0000${source.contentHash}\u0000${source.retrievedAt}`,
    ),
  );
  for (const edge of edges) {
    for (const source of edge.sources) {
      const key = `${source.url}\u0000${source.contentHash}\u0000${source.retrievedAt}`;
      if (!sourceKeys.has(key)) {
        throw new SourceLockError(`Migration edge ${edge.id} references an unlocked source.`);
      }
    }
  }

  sources.sort((left, right) => left.id.localeCompare(right.id));
  edges.sort((left, right) => left.id.localeCompare(right.id));

  return {
    sourceLockHash: sha256(lockRaw),
    sources,
    edges,
  };
}
