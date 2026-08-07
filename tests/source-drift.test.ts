import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchOfficialMarkdown } from "../scripts/check-source-drift.mjs";
import { PROJECT_ROOT } from "./helpers.js";

const SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts/check-source-drift.mjs");
const SOURCE_URL = "https://developers.openai.com/api/docs/deprecations";
const MARKDOWN_URL = `${SOURCE_URL}.md`;
const temporaryDirectories: string[] = [];

type FixtureProject = {
  manifestPath: string;
  root: string;
  sourcePaths: string[];
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixtureProject({
  duplicateSource = false,
  expectedHash,
  upstream = "reviewed official source bytes\n",
}: {
  duplicateSource?: boolean;
  expectedHash?: string;
  upstream?: string;
} = {}): Promise<FixtureProject> {
  const root = await mkdtemp(path.join(tmpdir(), "migration-doctor-source-drift-"));
  temporaryDirectories.push(root);
  const sourcePaths = ["source-one.json", ...(duplicateSource ? ["source-two.json"] : [])];
  const artifacts: Array<{ kind: "source"; path: string; sha256: string }> = [];
  const reviewedHash = expectedHash ?? sha256(upstream);

  for (const [index, fileName] of sourcePaths.entries()) {
    const record = {
      schemaVersion: "1.0.0",
      id: `synthetic.source.${index + 1}`,
      source: {
        url: SOURCE_URL,
        title: "Synthetic official source fixture",
        retrievedAt: "2026-08-07T00:00:00Z",
        contentHash: reviewedHash,
      },
      claims: ["Synthetic reviewed claim."],
    };
    const raw = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(path.join(root, fileName), raw);
    artifacts.push({ kind: "source", path: fileName, sha256: sha256(raw) });
  }

  await writeFile(
    path.join(root, "migration.lock"),
    `${JSON.stringify(
      {
        schemaVersion: "1.0.0",
        createdAt: "2026-08-07T00:00:00Z",
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(root, "upstream.md"), upstream);
  const manifestPath = path.join(root, "fixture-manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: "1.0.0",
        documents: [{ url: MARKDOWN_URL, path: "upstream.md" }],
      },
      null,
      2,
    )}\n`,
  );
  return { manifestPath, root, sourcePaths };
}

function runChecker(project: FixtureProject) {
  return spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--root", project.root, "--fixture-manifest", project.manifestPath],
    { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 10_000 },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("official source drift gate", () => {
  it("deduplicates canonical documents and passes against injected offline bytes", async () => {
    const project = await createFixtureProject({ duplicateSource: true });

    const result = runChecker(project);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "Official source hashes are current: 2 reviewed source records across 1 canonical Markdown document.\n",
    );
  });

  it("fails with review instructions and never changes locked project files", async () => {
    const project = await createFixtureProject({ expectedHash: sha256("previous bytes\n") });
    const trackedPaths = ["migration.lock", ...project.sourcePaths];
    const before = await Promise.all(
      trackedPaths.map((file) => readFile(path.join(project.root, file), "utf8")),
    );

    const result = runChecker(project);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Official source drift detected in 1 document:");
    expect(result.stderr).toContain(MARKDOWN_URL);
    expect(result.stderr).toContain("Create new dated source records");
    expect(result.stderr).toContain("No project files were modified.");
    await expect(
      Promise.all(trackedPaths.map((file) => readFile(path.join(project.root, file), "utf8"))),
    ).resolves.toEqual(before);
  });

  it("rejects a changed source artifact before comparing upstream bytes", async () => {
    const project = await createFixtureProject();
    const firstSource = project.sourcePaths[0];
    if (firstSource === undefined) {
      throw new Error("Expected a source fixture.");
    }
    await writeFile(path.join(project.root, firstSource), "{}\n");

    const result = runChecker(project);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Locked artifact hash mismatch");
    expect(result.stderr).toContain("No project files were modified.");
  });

  it("rejects conflicting reviewed hashes for one canonical document", async () => {
    const project = await createFixtureProject({ duplicateSource: true });
    const secondSource = project.sourcePaths[1];
    if (secondSource === undefined) {
      throw new Error("Expected a second source fixture.");
    }
    const secondPath = path.join(project.root, secondSource);
    const secondRecord = JSON.parse(await readFile(secondPath, "utf8"));
    secondRecord.source.contentHash = sha256("different reviewed bytes\n");
    const secondRaw = `${JSON.stringify(secondRecord, null, 2)}\n`;
    await writeFile(secondPath, secondRaw);
    const lockPath = path.join(project.root, "migration.lock");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.artifacts[1].sha256 = sha256(secondRaw);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const result = runChecker(project);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Locked source records disagree on the reviewed hash");
  });

  it("requires an explicit network or fixture access mode", async () => {
    const project = await createFixtureProject();

    const result = spawnSync(process.execPath, [SCRIPT_PATH, "--root", project.root], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Choose exactly one of --network or --fixture-manifest.");
  });

  it("fetches official Markdown with redirect rejection and bounded identity encoding", async () => {
    const bytes = await fetchOfficialMarkdown(MARKDOWN_URL, async (input, init) => {
      expect(input).toBe(MARKDOWN_URL);
      expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
      expect(new Headers(init?.headers).get("accept-encoding")).toBe("identity");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("reviewed bytes\n", { status: 200 });
    });

    expect(Buffer.from(bytes).toString("utf8")).toBe("reviewed bytes\n");
  });

  it("rejects non-success source responses and declared oversized bodies", async () => {
    await expect(
      fetchOfficialMarkdown(MARKDOWN_URL, async () => new Response("redirect", { status: 302 })),
    ).rejects.toThrow("HTTP 302");
    await expect(
      fetchOfficialMarkdown(
        MARKDOWN_URL,
        async () =>
          new Response("small", {
            status: 200,
            headers: { "content-length": String(4 * 1024 * 1024 + 1) },
          }),
      ),
    ).rejects.toThrow("exceeds the 4194304-byte limit");
  });

  it("rejects streamed source bodies over the limit and body-read failures", async () => {
    await expect(
      fetchOfficialMarkdown(
        MARKDOWN_URL,
        async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { status: 200 }),
      ),
    ).rejects.toThrow("exceeds the 4194304-byte limit");

    await expect(
      fetchOfficialMarkdown(
        MARKDOWN_URL,
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            body: {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    throw new Error("synthetic read failure");
                  },
                };
              },
            },
          }) as unknown as Response,
      ),
    ).rejects.toThrow(`Unable to read ${MARKDOWN_URL}`);
  });
});
