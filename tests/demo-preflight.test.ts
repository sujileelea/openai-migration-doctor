import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DemoPreflightError,
  EXPECTED_REPORT_FILES,
  parseRemoteRefs,
  validateReportBundle,
} from "../scripts/prepare-demo.mjs";

const temporaryDirectories: string[] = [];

async function createReportBundle() {
  const directory = await mkdtemp(path.join(tmpdir(), "migration-doctor-demo-test-"));
  temporaryDirectories.push(directory);
  for (const fileName of EXPECTED_REPORT_FILES) {
    const body =
      fileName === "migration-report.json"
        ? `${JSON.stringify({ findings: [{ id: "finding" }] })}\n`
        : "report\n";
    await writeFile(path.join(directory, fileName), body);
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("demo preflight", () => {
  it("accepts exactly four non-empty report files with at least one finding", async () => {
    const directory = await createReportBundle();
    await expect(validateReportBundle(directory)).resolves.toBeUndefined();
  });

  it("rejects extra paths, empty files, and finding-free JSON", async () => {
    const withExtraPath = await createReportBundle();
    await mkdir(path.join(withExtraPath, "extra"));
    await expect(validateReportBundle(withExtraPath)).rejects.toThrow(DemoPreflightError);

    const withEmptyFile = await createReportBundle();
    await writeFile(path.join(withEmptyFile, "migration-report.md"), "");
    await expect(validateReportBundle(withEmptyFile)).rejects.toThrow("must not be empty");

    const withoutFinding = await createReportBundle();
    await writeFile(
      path.join(withoutFinding, "migration-report.json"),
      `${JSON.stringify({ findings: [] })}\n`,
    );
    await expect(validateReportBundle(withoutFinding)).rejects.toThrow(
      "must contain at least one finding",
    );
  });

  it("normalizes remote refs and excludes the symbolic origin head", () => {
    expect(parseRemoteRefs("origin/HEAD\norigin/develop\norigin/release/v0.2.0\n")).toEqual([
      "origin/develop",
      "origin/release/v0.2.0",
    ]);
  });
});
