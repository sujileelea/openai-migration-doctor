import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertValidatedMigrationRegistry,
  loadMigrationRegistry,
  SourceLockError,
  sha256,
  snapshotValidatedMigrationRegistry,
} from "@migration-doctor/core";
import { afterEach, describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "./helpers.js";

const temporaryDirectories: string[] = [];

type MutableMigrationRecord = {
  edge: {
    id: string;
    to: { id: string; displayName?: string };
    sources: Array<{ title: string }>;
  };
};

async function copyLockedData(): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-lock-"));
  temporaryDirectories.push(temporaryRoot);
  await cp(path.join(PROJECT_ROOT, "migration.lock"), path.join(temporaryRoot, "migration.lock"));
  await cp(path.join(PROJECT_ROOT, "data"), path.join(temporaryRoot, "data"), {
    recursive: true,
  });
  return temporaryRoot;
}

async function firstLockedSourcePath(root: string): Promise<string> {
  const lock = JSON.parse(await readFile(path.join(root, "migration.lock"), "utf8")) as {
    artifacts: Array<{ kind: string; path: string }>;
  };
  const source = lock.artifacts.find((artifact) => artifact.kind === "source");
  if (!source) {
    throw new Error("Test fixture migration.lock must contain a source artifact.");
  }
  return source.path;
}

async function addMigrationArtifact(
  root: string,
  fileName: string,
  mutate: (record: MutableMigrationRecord) => void,
): Promise<void> {
  const originalPath = path.join(root, "data/migrations/gpt-4o-mini-transcribe-2025-03-20.json");
  const record = JSON.parse(await readFile(originalPath, "utf8")) as MutableMigrationRecord;
  mutate(record);
  const raw = `${JSON.stringify(record, null, 2)}\n`;
  const relativePath = `data/migrations/${fileName}`;
  await writeFile(path.join(root, relativePath), raw);

  const lockPath = path.join(root, "migration.lock");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.artifacts.push({ kind: "migration", path: relativePath, sha256: sha256(raw) });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("source lock", () => {
  it("loads the reviewed migration edge and official source hashes", async () => {
    const registry = await loadMigrationRegistry(PROJECT_ROOT);

    expect(registry.edges).toHaveLength(2);
    expect(registry.sources).toHaveLength(5);
    expect(registry.edges).toContainEqual(
      expect.objectContaining({
        from: expect.objectContaining({
          kind: "model",
          id: "gpt-4o-mini-transcribe-2025-03-20",
        }),
        to: expect.objectContaining({
          kind: "model",
          id: "gpt-4o-mini-transcribe-2025-12-15",
        }),
        announcedAt: "2026-07-20",
        shutdownAt: "2027-01-20",
        automationTier: "A",
      }),
    );
    expect(registry.edges).toContainEqual(
      expect.objectContaining({
        from: expect.objectContaining({ kind: "product", id: "assistants-api" }),
        to: expect.objectContaining({ kind: "product", id: "responses-and-conversations" }),
        announcedAt: "2025-08-26",
        shutdownAt: "2026-08-26",
        automationTier: "C",
        reviewRequired: true,
      }),
    );
  });

  it("brands registries and detects mutation after validated loading", async () => {
    const registry = await loadMigrationRegistry(PROJECT_ROOT);

    expect(() => assertValidatedMigrationRegistry(registry)).not.toThrow();
    expect(() => assertValidatedMigrationRegistry({ ...registry })).toThrow(
      "directly from loadMigrationRegistry",
    );
    const edge = registry.edges[0];
    expect(edge).toBeDefined();
    if (!edge) {
      return;
    }
    const originalId = edge.id;
    edge.id = "mutated-after-load";
    expect(() => assertValidatedMigrationRegistry(registry)).toThrow(
      "changed after source-lock validation",
    );
    edge.id = originalId;
    expect(() => assertValidatedMigrationRegistry(registry)).not.toThrow();

    const originalEdges = registry.edges;
    const forgedEdges = originalEdges.map((candidate) => ({
      ...candidate,
      id: `forged.${candidate.id}`,
    }));
    let edgeReads = 0;
    Object.defineProperty(registry, "edges", {
      configurable: true,
      get: () => (edgeReads++ === 0 ? originalEdges : forgedEdges),
    });
    const snapshot = snapshotValidatedMigrationRegistry(registry);
    expect(edgeReads).toBe(1);
    expect(snapshot.edges).toEqual(originalEdges);
    Object.defineProperty(registry, "edges", {
      configurable: true,
      value: originalEdges,
      writable: true,
    });
  });

  it("fails closed when a locked artifact changes", async () => {
    const temporaryRoot = await copyLockedData();
    const relativePath = await firstLockedSourcePath(temporaryRoot);
    await appendFile(path.join(temporaryRoot, relativePath), " ");

    await expect(loadMigrationRegistry(temporaryRoot)).rejects.toBeInstanceOf(SourceLockError);
    await expect(loadMigrationRegistry(temporaryRoot)).rejects.toThrow("hash mismatch");
  });

  it("hashes exact artifact bytes and rejects invalid UTF-8", async () => {
    const temporaryRoot = await copyLockedData();
    const relativePath = await firstLockedSourcePath(temporaryRoot);
    const artifactPath = path.join(temporaryRoot, relativePath);
    const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]);
    await writeFile(artifactPath, invalidUtf8);

    const lockPath = path.join(temporaryRoot, "migration.lock");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    const artifact = lock.artifacts.find(
      (candidate: { path: string }) => candidate.path === relativePath,
    );
    artifact.sha256 = sha256(invalidUtf8);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    await expect(loadMigrationRegistry(temporaryRoot)).rejects.toThrow("not valid UTF-8");
  });

  it("fails closed when migration.lock is missing", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-lock-"));
    temporaryDirectories.push(temporaryRoot);

    await expect(loadMigrationRegistry(temporaryRoot)).rejects.toBeInstanceOf(SourceLockError);
  });

  it("rejects a locked artifact symlink that escapes the project root", async () => {
    const temporaryRoot = await copyLockedData();
    const relativePath = await firstLockedSourcePath(temporaryRoot);
    const artifact = path.join(temporaryRoot, relativePath);
    await unlink(artifact);
    await symlink(path.join(PROJECT_ROOT, "README.md"), artifact);

    await expect(loadMigrationRegistry(temporaryRoot)).rejects.toThrow("symlink escapes");
  });

  it("rejects duplicate migration edge IDs across different artifacts", async () => {
    const temporaryRoot = await copyLockedData();
    await addMigrationArtifact(temporaryRoot, "duplicate-edge.json", () => undefined);

    await expect(loadMigrationRegistry(temporaryRoot)).rejects.toThrow(
      "duplicate migration edge ID",
    );
  });

  it("preserves competing destinations for graph-level review", async () => {
    const temporaryRoot = await copyLockedData();
    await addMigrationArtifact(temporaryRoot, "competing-destination.json", (record) => {
      record.edge.id = "synthetic.competing-destination";
      record.edge.to.id = "synthetic-other-destination";
      record.edge.to.displayName = "Synthetic other destination";
    });

    const registry = await loadMigrationRegistry(temporaryRoot);

    expect(registry.edges.map((edge) => edge.to?.id)).toEqual([
      "gpt-4o-mini-transcribe-2025-12-15",
      "responses-and-conversations",
      "synthetic-other-destination",
    ]);
  });

  it("requires an edge source reference to match the locked title", async () => {
    const temporaryRoot = await copyLockedData();
    const migrationPath = path.join(
      temporaryRoot,
      "data/migrations/gpt-4o-mini-transcribe-2025-03-20.json",
    );
    const record = JSON.parse(await readFile(migrationPath, "utf8"));
    record.edge.sources[0].title = "Unreviewed display title";
    const raw = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(migrationPath, raw);

    const lockPath = path.join(temporaryRoot, "migration.lock");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    const artifact = lock.artifacts.find(
      (candidate: { path: string }) =>
        candidate.path === "data/migrations/gpt-4o-mini-transcribe-2025-03-20.json",
    );
    artifact.sha256 = sha256(raw);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    await expect(loadMigrationRegistry(temporaryRoot)).rejects.toThrow("unlocked source");
  });
});
