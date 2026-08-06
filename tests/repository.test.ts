import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  changedRepositoryFiles,
  compareStrings,
  listRepositoryFiles,
} from "@migration-doctor/core";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("repository determinism", () => {
  it("detects additions, modifications, and deletions in stable order", () => {
    const before = new Map([
      ["deleted.ts", "before-deleted"],
      ["modified.ts", "before-modified"],
      ["unchanged.ts", "same"],
    ]);
    const after = new Map([
      ["added.ts", "after-added"],
      ["modified.ts", "after-modified"],
      ["unchanged.ts", "same"],
    ]);

    expect(changedRepositoryFiles(before, after)).toEqual([
      "added.ts",
      "deleted.ts",
      "modified.ts",
    ]);
  });

  it("sorts paths by code units instead of the host locale", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "migration-doctor-order-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "z.ts"), "export {};\n");
    await writeFile(path.join(root, "ä.ts"), "export {};\n");

    expect(await listRepositoryFiles(root)).toEqual(["z.ts", "ä.ts"]);
    expect(["ä", "z"].sort(compareStrings)).toEqual(["z", "ä"]);
  });
});
