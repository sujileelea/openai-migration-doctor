import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseFirstUseEvidence,
  renderFirstUseSummary,
  UsabilityEvidenceError,
} from "../scripts/summarize-first-use.mjs";
import { PROJECT_ROOT } from "./helpers.js";

const SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts/summarize-first-use.mjs");
const temporaryDirectories: string[] = [];

function validEvidence() {
  return {
    schemaVersion: "1.0.0",
    toolRevision: "a".repeat(40),
    sessions: [
      {
        id: "P01",
        track: "source-build",
        language: "typescript",
        operatingSystem: "macos",
        outcome: "completed",
        timeToFirstReportSeconds: 300,
        setupFailures: ["command-confusion"],
        interpretationErrors: [],
        nextAction: "patch-preview",
        privacyIncident: false,
      },
      {
        id: "P02",
        track: "github-action",
        language: "python",
        operatingSystem: "linux",
        outcome: "completed",
        timeToFirstReportSeconds: 420,
        setupFailures: [],
        interpretationErrors: ["exit-code"],
        nextAction: "inspect-plan",
        privacyIncident: false,
      },
      {
        id: "P03",
        track: "source-build",
        language: "javascript",
        operatingSystem: "windows",
        outcome: "failed",
        timeToFirstReportSeconds: null,
        setupFailures: ["prerequisite-missing"],
        interpretationErrors: [],
        nextAction: "seek-help",
        privacyIncident: false,
      },
    ],
  };
}

function sessionAt(evidence: ReturnType<typeof validEvidence>, index: number) {
  const session = evidence.sessions[index];
  if (!session) {
    throw new Error(`Expected session at index ${index}.`);
  }
  return session;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("external first-use evidence", () => {
  it("renders deterministic, bounded aggregate evidence", () => {
    const evidence = parseFirstUseEvidence(validEvidence());
    const report = renderFirstUseSummary(evidence);

    expect(report).toContain("- Sessions: 3");
    expect(report).toContain("360 seconds median (300–420 seconds)");
    expect(report).toContain("| completed | 2 |");
    expect(report).toContain("| prerequisite-missing | 1 |");
    expect(report).toContain("| exit-code | 1 |");
    expect(report).toContain("not representative of all OpenAI developers");
    expect(report).not.toContain("P01");
  });

  it("rejects free-form participant notes and duplicate participant IDs", () => {
    const withNotes = validEvidence();
    Object.assign(sessionAt(withNotes, 0), { notes: "personally identifying note" });
    expect(() => parseFirstUseEvidence(withNotes)).toThrow(UsabilityEvidenceError);
    expect(() => parseFirstUseEvidence(withNotes)).toThrow("must contain exactly");

    const duplicates = validEvidence();
    sessionAt(duplicates, 1).id = "P01";
    expect(() => parseFirstUseEvidence(duplicates)).toThrow("Duplicate participant ID");
  });

  it("requires completed timing and fail-closed privacy stops", () => {
    const missingTime = validEvidence();
    sessionAt(missingTime, 0).timeToFirstReportSeconds = null;
    expect(() => parseFirstUseEvidence(missingTime)).toThrow("must be an integer");

    const privacyIncident = validEvidence();
    sessionAt(privacyIncident, 0).privacyIncident = true;
    expect(() => parseFirstUseEvidence(privacyIncident)).toThrow(
      "must be stopped when a privacy incident occurs",
    );
  });

  it("runs as a stdout-only CLI over anonymized JSON", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "migration-doctor-first-use-"));
    temporaryDirectories.push(directory);
    const inputPath = path.join(directory, "evidence.json");
    await writeFile(inputPath, `${JSON.stringify(validEvidence(), null, 2)}\n`);

    const result = spawnSync(process.execPath, [SCRIPT_PATH, inputPath], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# External first-use study summary");
  });
});
