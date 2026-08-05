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
import { loadMigrationRegistry, SourceLockError, sha256 } from "@migration-doctor/core";
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

    expect(registry.edges).toHaveLength(1);
    expect(registry.sources).toHaveLength(2);
    expect(registry.edges[0]).toMatchObject({
      from: { kind: "model", id: "gpt-4o-mini-transcribe-2025-03-20" },
      to: { kind: "model", id: "gpt-4o-mini-transcribe-2025-12-15" },
      announcedAt: "2026-07-20",
      shutdownAt: "2027-01-20",
      automationTier: "A",
    });
  });

  it("fails closed when a locked artifact changes", async () => {
    const temporaryRoot = await copyLockedData();
    await appendFile(
      path.join(temporaryRoot, "data/sources/openai-deprecations-2026-08-05.json"),
      " ",
    );

    await expect(loadMigrationRegistry(temporaryRoot)).rejects.toBeInstanceOf(SourceLockError);
    await expect(loadMigrationRegistry(temporaryRoot)).rejects.toThrow("hash mismatch");
  });

  it("fails closed when migration.lock is missing", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-lock-"));
    temporaryDirectories.push(temporaryRoot);

    await expect(loadMigrationRegistry(temporaryRoot)).rejects.toBeInstanceOf(SourceLockError);
  });

  it("rejects a locked artifact symlink that escapes the project root", async () => {
    const temporaryRoot = await copyLockedData();
    const artifact = path.join(temporaryRoot, "data/sources/openai-deprecations-2026-08-05.json");
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

  it("fails closed when sources recommend competing destinations", async () => {
    const temporaryRoot = await copyLockedData();
    await addMigrationArtifact(temporaryRoot, "competing-destination.json", (record) => {
      record.edge.id = "synthetic.competing-destination";
      record.edge.to.id = "synthetic-other-destination";
      record.edge.to.displayName = "Synthetic other destination";
    });

    await expect(loadMigrationRegistry(temporaryRoot)).rejects.toThrow(
      "conflicting migration destinations",
    );
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
