import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_VERSION = "1.0.0";
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const PARTICIPANT_PATTERN = /^P[0-9]{2}$/u;
const MAX_SESSIONS = 50;
const MAX_TIME_SECONDS = 86_400;

const TRACKS = ["source-build", "github-action"];
const LANGUAGES = ["javascript", "typescript", "python"];
const OPERATING_SYSTEMS = ["macos", "linux", "windows"];
const OUTCOMES = ["completed", "failed", "stopped"];
const OUTCOME_IMPACT = {
  completed: 1,
  failed: 2,
  stopped: 3,
};
const SETUP_FAILURES = [
  "prerequisite-missing",
  "install-failure",
  "build-failure",
  "command-confusion",
  "action-permission",
  "action-pin",
  "report-not-found",
  "other",
];
const INTERPRETATION_ERRORS = [
  "exit-code",
  "blocking-vs-tool-failure",
  "source-grounding",
  "automation-tier",
  "report-location",
  "next-step",
  "other",
];
const NEXT_ACTIONS = [
  "patch-preview",
  "inspect-plan",
  "review-source",
  "run-tests",
  "seek-help",
  "stop",
  "none",
];

export class UsabilityEvidenceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "UsabilityEvidenceError";
  }
}

function object(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsabilityEvidenceError(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new UsabilityEvidenceError(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

function enumeration(value, values, label) {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new UsabilityEvidenceError(`${label} must be one of: ${values.join(", ")}.`);
  }
  return value;
}

function categoryList(value, values, label) {
  if (!Array.isArray(value) || value.length > values.length) {
    throw new UsabilityEvidenceError(`${label} must be an array with at most ${values.length} items.`);
  }
  const seen = new Set();
  return value.map((candidate, index) => {
    const category = enumeration(candidate, values, `${label}[${index}]`);
    if (seen.has(category)) {
      throw new UsabilityEvidenceError(`${label} must not contain duplicate categories.`);
    }
    seen.add(category);
    return category;
  });
}

function parseSession(value, index) {
  const label = `sessions[${index}]`;
  const session = object(value, label);
  exactKeys(
    session,
    [
      "id",
      "track",
      "language",
      "operatingSystem",
      "outcome",
      "timeToFirstReportSeconds",
      "setupFailures",
      "interpretationErrors",
      "nextAction",
      "privacyIncident",
    ],
    label,
  );
  if (typeof session.id !== "string" || !PARTICIPANT_PATTERN.test(session.id)) {
    throw new UsabilityEvidenceError(`${label}.id must match P00 through P99.`);
  }
  const outcome = enumeration(session.outcome, OUTCOMES, `${label}.outcome`);
  const time = session.timeToFirstReportSeconds;
  if (outcome === "completed") {
    if (!Number.isInteger(time) || time <= 0 || time > MAX_TIME_SECONDS) {
      throw new UsabilityEvidenceError(
        `${label}.timeToFirstReportSeconds must be an integer from 1 to ${MAX_TIME_SECONDS} for a completed session.`,
      );
    }
  } else if (time !== null) {
    throw new UsabilityEvidenceError(
      `${label}.timeToFirstReportSeconds must be null unless the session completed.`,
    );
  }
  if (typeof session.privacyIncident !== "boolean") {
    throw new UsabilityEvidenceError(`${label}.privacyIncident must be a boolean.`);
  }
  if (session.privacyIncident && outcome !== "stopped") {
    throw new UsabilityEvidenceError(`${label} must be stopped when a privacy incident occurs.`);
  }
  return {
    id: session.id,
    track: enumeration(session.track, TRACKS, `${label}.track`),
    language: enumeration(session.language, LANGUAGES, `${label}.language`),
    operatingSystem: enumeration(
      session.operatingSystem,
      OPERATING_SYSTEMS,
      `${label}.operatingSystem`,
    ),
    outcome,
    timeToFirstReportSeconds: time,
    setupFailures: categoryList(session.setupFailures, SETUP_FAILURES, `${label}.setupFailures`),
    interpretationErrors: categoryList(
      session.interpretationErrors,
      INTERPRETATION_ERRORS,
      `${label}.interpretationErrors`,
    ),
    nextAction: enumeration(session.nextAction, NEXT_ACTIONS, `${label}.nextAction`),
    privacyIncident: session.privacyIncident,
  };
}

export function parseFirstUseEvidence(value) {
  const evidence = object(value, "first-use evidence");
  exactKeys(evidence, ["schemaVersion", "toolRevision", "sessions"], "first-use evidence");
  if (evidence.schemaVersion !== SCHEMA_VERSION) {
    throw new UsabilityEvidenceError(`schemaVersion must be ${SCHEMA_VERSION}.`);
  }
  if (typeof evidence.toolRevision !== "string" || !REVISION_PATTERN.test(evidence.toolRevision)) {
    throw new UsabilityEvidenceError("toolRevision must be a lowercase 40-character Git SHA.");
  }
  if (
    !Array.isArray(evidence.sessions) ||
    evidence.sessions.length === 0 ||
    evidence.sessions.length > MAX_SESSIONS
  ) {
    throw new UsabilityEvidenceError(`sessions must contain between 1 and ${MAX_SESSIONS} items.`);
  }
  const sessions = evidence.sessions.map(parseSession);
  const seenIds = new Set();
  for (const session of sessions) {
    if (seenIds.has(session.id)) {
      throw new UsabilityEvidenceError(`Duplicate participant ID: ${session.id}.`);
    }
    seenIds.add(session.id);
  }
  return { schemaVersion: SCHEMA_VERSION, toolRevision: evidence.toolRevision, sessions };
}

function countValues(values, order) {
  const counts = new Map(order.map((value) => [value, 0]));
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return order.map((value) => ({ value, count: counts.get(value) ?? 0 }));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function rankFrictionCandidates(sessions) {
  const candidates = [
    ...SETUP_FAILURES.map((category, order) => ({
      category,
      impactScore: 0,
      key: `setup:${category}`,
      order,
      sessionCount: 0,
    })),
    ...INTERPRETATION_ERRORS.map((category, order) => ({
      category,
      impactScore: 0,
      key: `interpretation:${category}`,
      order: SETUP_FAILURES.length + order,
      sessionCount: 0,
    })),
  ];
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const candidateFor = (key) => {
    const candidate = byKey.get(key);
    if (!candidate) {
      throw new UsabilityEvidenceError(`Unknown friction category: ${key}.`);
    }
    return candidate;
  };

  for (const session of sessions) {
    const impact = OUTCOME_IMPACT[session.outcome];
    for (const category of session.setupFailures) {
      const candidate = candidateFor(`setup:${category}`);
      candidate.sessionCount += 1;
      candidate.impactScore += impact;
    }
    for (const category of session.interpretationErrors) {
      const candidate = candidateFor(`interpretation:${category}`);
      candidate.sessionCount += 1;
      candidate.impactScore += impact;
    }
  }

  return candidates
    .filter((candidate) => candidate.sessionCount > 0)
    .sort(
      (left, right) =>
        right.impactScore - left.impactScore ||
        right.sessionCount - left.sessionCount ||
        left.order - right.order,
    )
    .map(({ order: _order, ...candidate }) => candidate);
}

export function summarizeFirstUseEvidence(evidence) {
  const completedTimes = evidence.sessions
    .filter((session) => session.outcome === "completed")
    .map((session) => session.timeToFirstReportSeconds);
  return {
    toolRevision: evidence.toolRevision,
    sessionCount: evidence.sessions.length,
    tracks: countValues(
      evidence.sessions.map((session) => session.track),
      TRACKS,
    ),
    languages: countValues(
      evidence.sessions.map((session) => session.language),
      LANGUAGES,
    ),
    outcomes: countValues(
      evidence.sessions.map((session) => session.outcome),
      OUTCOMES,
    ),
    completedTime:
      completedTimes.length === 0
        ? null
        : {
            medianSeconds: median(completedTimes),
            minimumSeconds: Math.min(...completedTimes),
            maximumSeconds: Math.max(...completedTimes),
          },
    setupFailures: countValues(
      evidence.sessions.flatMap((session) => session.setupFailures),
      SETUP_FAILURES,
    ),
    interpretationErrors: countValues(
      evidence.sessions.flatMap((session) => session.interpretationErrors),
      INTERPRETATION_ERRORS,
    ),
    frictionCandidates: rankFrictionCandidates(evidence.sessions),
    nextActions: countValues(
      evidence.sessions.map((session) => session.nextAction),
      NEXT_ACTIONS,
    ),
    privacyIncidentCount: evidence.sessions.filter((session) => session.privacyIncident).length,
  };
}

function row(label, entries) {
  const count = entries.find((entry) => entry.value === label)?.count ?? 0;
  return `| ${label} | ${count} |`;
}

function nonzeroRows(entries) {
  const rows = entries.filter((entry) => entry.count > 0);
  if (rows.length === 0) {
    return "None observed.";
  }
  return ["| Category | Count |", "| --- | ---: |", ...rows.map((entry) => row(entry.value, entries))].join(
    "\n",
  );
}

export function renderFirstUseSummary(evidence) {
  const summary = summarizeFirstUseEvidence(evidence);
  const completedTime = summary.completedTime;
  const timeLine = completedTime
    ? `${completedTime.medianSeconds} seconds median (${completedTime.minimumSeconds}–${completedTime.maximumSeconds} seconds).`
    : "No participant completed a first report.";
  const frictionRows =
    summary.frictionCandidates.length === 0
      ? ["None observed."]
      : [
          "| Rank | Category | Sessions | Impact score |",
          "| ---: | --- | ---: | ---: |",
          ...summary.frictionCandidates.map(
            (candidate, index) =>
              `| ${index + 1} | ${candidate.key} | ${candidate.sessionCount} | ${candidate.impactScore} |`,
          ),
        ];
  return [
    "# External first-use study summary",
    "",
    `- Tool revision: \`${summary.toolRevision}\``,
    `- Sessions: ${summary.sessionCount}`,
    `- Time to first completed report: ${timeLine}`,
    `- Privacy incidents: ${summary.privacyIncidentCount}`,
    "- Scope: bounded observations from this sample only; not representative of all OpenAI developers.",
    "",
    "## Outcomes",
    "",
    "| Outcome | Count |",
    "| --- | ---: |",
    ...OUTCOMES.map((outcome) => row(outcome, summary.outcomes)),
    "",
    "## Tracks",
    "",
    "| Track | Count |",
    "| --- | ---: |",
    ...TRACKS.map((track) => row(track, summary.tracks)),
    "",
    "## Languages",
    "",
    "| Language | Count |",
    "| --- | ---: |",
    ...LANGUAGES.map((language) => row(language, summary.languages)),
    "",
    "## Setup failures",
    "",
    nonzeroRows(summary.setupFailures),
    "",
    "## Report-interpretation errors",
    "",
    nonzeroRows(summary.interpretationErrors),
    "",
    "## Friction triage candidates",
    "",
    "The impact score is a within-sample triage aid: each category occurrence scores 1 for a completed session, 2 for a failed session, and 3 for a stopped session. Reproduce a candidate before fixing or filing it; this score is not a usability benchmark.",
    "",
    ...frictionRows,
    "",
    "## Next actions selected",
    "",
    nonzeroRows(summary.nextActions),
    "",
  ].join("\n");
}

function usage() {
  return "Usage: node scripts/summarize-first-use.mjs <anonymized-evidence.json>\n";
}

export async function runCli(argv) {
  if (argv.length !== 1 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(usage());
    return argv.length === 1 ? 0 : 2;
  }
  try {
    const inputPath = path.resolve(argv[0]);
    const raw = await readFile(inputPath, "utf8");
    const evidence = parseFirstUseEvidence(JSON.parse(raw));
    process.stdout.write(renderFirstUseSummary(evidence));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Unable to summarize first-use evidence: ${message}\n`);
    return 2;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}

export { PROJECT_ROOT };
