import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { compareStrings } from "./compare.js";
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

function sourceKey(source: SourceRecord["source"]): string {
  return [source.url, source.title, source.contentHash, source.retrievedAt].join("\u0000");
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SourceLockError(`${label} is not valid JSON.`, { cause: error });
  }
}

function decodeUtf8(raw: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    throw new SourceLockError(`${label} is not valid UTF-8.`, { cause: error });
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
  let lockBytes: Uint8Array;
  try {
    lockBytes = await readFile(lockPath);
  } catch (error) {
    throw new SourceLockError(`Unable to read source lock at ${lockPath}.`, { cause: error });
  }
  const lockRaw = decodeUtf8(lockBytes, "migration.lock");

  const parsedLock = SourceLockSchema.safeParse(parseJson(lockRaw, "migration.lock"));
  if (!parsedLock.success) {
    throw new SourceLockError(
      `migration.lock failed schema validation: ${parsedLock.error.message}`,
    );
  }

  const sources: SourceRecord[] = [];
  const edges: MigrationEdge[] = [];
  const seenPaths = new Set<string>();
  const seenSourceIds = new Set<string>();
  const seenEdgeIds = new Set<string>();

  for (const artifact of parsedLock.data.artifacts) {
    if (seenPaths.has(artifact.path)) {
      throw new SourceLockError(`migration.lock contains a duplicate path: ${artifact.path}`);
    }
    seenPaths.add(artifact.path);

    const artifactPath = await resolveArtifact(projectRoot, artifact.path);
    let rawBytes: Uint8Array;
    try {
      rawBytes = await readFile(artifactPath);
    } catch (error) {
      throw new SourceLockError(`Unable to read locked artifact ${artifact.path}.`, {
        cause: error,
      });
    }

    const actualHash = sha256(rawBytes);
    if (actualHash !== artifact.sha256) {
      throw new SourceLockError(
        `Locked artifact hash mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actualHash}.`,
      );
    }

    const raw = decodeUtf8(rawBytes, artifact.path);
    const value = parseJson(raw, artifact.path);
    if (artifact.kind === "source") {
      const parsed = SourceRecordSchema.safeParse(value);
      if (!parsed.success) {
        throw new SourceLockError(
          `${artifact.path} failed schema validation: ${parsed.error.message}`,
        );
      }
      if (seenSourceIds.has(parsed.data.id)) {
        throw new SourceLockError(`Source lock contains a duplicate source ID: ${parsed.data.id}`);
      }
      seenSourceIds.add(parsed.data.id);
      sources.push(parsed.data);
      continue;
    }

    const parsed = MigrationRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw new SourceLockError(
        `${artifact.path} failed schema validation: ${parsed.error.message}`,
      );
    }
    if (seenEdgeIds.has(parsed.data.edge.id)) {
      throw new SourceLockError(
        `Source lock contains a duplicate migration edge ID: ${parsed.data.edge.id}`,
      );
    }
    seenEdgeIds.add(parsed.data.edge.id);
    edges.push(parsed.data.edge);
  }

  const sourceKeys = new Set(sources.map(({ source }) => sourceKey(source)));
  for (const edge of edges) {
    for (const source of edge.sources) {
      if (!sourceKeys.has(sourceKey(source))) {
        throw new SourceLockError(`Migration edge ${edge.id} references an unlocked source.`);
      }
    }
  }

  sources.sort((left, right) => compareStrings(left.id, right.id));
  edges.sort((left, right) => compareStrings(left.id, right.id));

  return {
    sourceLockHash: sha256(lockBytes),
    sources,
    edges,
  };
}
