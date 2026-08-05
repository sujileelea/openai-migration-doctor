import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  type MigrationEdge,
  SOURCE_SCHEMA_VERSION,
  type SourceRef,
  sha256,
} from "@migration-doctor/core";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

export function fixturePath(name: string): string {
  return path.join(PROJECT_ROOT, "fixtures", "typescript", name);
}

export function syntheticSource(label: string, hashCharacter: string): SourceRef {
  return {
    url: `https://${label}.example.invalid/migration`,
    title: `Synthetic ${label} source`,
    retrievedAt: "2026-08-05T00:00:00.000Z",
    contentHash: hashCharacter.repeat(64),
  };
}

export function syntheticTranscriptionConflict(): {
  sources: SourceRef[];
  edges: MigrationEdge[];
} {
  const sourceA = syntheticSource("conflict-a", "a");
  const sourceB = syntheticSource("conflict-b", "b");
  const from = {
    kind: "model" as const,
    id: "gpt-4o-mini-transcribe-2025-03-20",
    displayName: "Synthetic deprecated transcription snapshot",
  };
  return {
    sources: [sourceA, sourceB],
    edges: [
      {
        id: "synthetic.transcribe.to.replacement-a",
        from,
        to: { kind: "model", id: "synthetic-transcribe-replacement-a" },
        sources: [sourceA],
        languages: ["typescript"],
        behaviorChanges: [],
        automationTier: "A",
        reviewRequired: false,
      },
      {
        id: "synthetic.transcribe.to.replacement-b",
        from,
        to: { kind: "model", id: "synthetic-transcribe-replacement-b" },
        sources: [sourceB],
        languages: ["typescript"],
        behaviorChanges: [],
        automationTier: "C",
        reviewRequired: true,
      },
    ],
  };
}

export async function writeLockedRegistry(
  root: string,
  sources: SourceRef[],
  edges: MigrationEdge[],
): Promise<void> {
  const sourceDirectory = path.join(root, "data", "sources");
  const migrationDirectory = path.join(root, "data", "migrations");
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(migrationDirectory, { recursive: true });

  const artifacts: Array<{ kind: "source" | "migration"; path: string; sha256: string }> = [];
  for (const [index, source] of sources.entries()) {
    const relativePath = `data/sources/synthetic-${index + 1}.json`;
    const raw = canonicalJson({
      schemaVersion: SOURCE_SCHEMA_VERSION,
      id: `synthetic.source.${index + 1}`,
      source,
      claims: ["Synthetic test evidence only; no upstream product claim."],
    });
    await writeFile(path.join(root, relativePath), raw);
    artifacts.push({ kind: "source", path: relativePath, sha256: sha256(raw) });
  }

  for (const [index, edge] of edges.entries()) {
    const relativePath = `data/migrations/synthetic-${index + 1}.json`;
    const raw = canonicalJson({ schemaVersion: SOURCE_SCHEMA_VERSION, edge });
    await writeFile(path.join(root, relativePath), raw);
    artifacts.push({ kind: "migration", path: relativePath, sha256: sha256(raw) });
  }

  await writeFile(
    path.join(root, "migration.lock"),
    canonicalJson({
      schemaVersion: SOURCE_SCHEMA_VERSION,
      createdAt: "2026-08-05T00:00:00.000Z",
      artifacts,
    }),
  );
}
