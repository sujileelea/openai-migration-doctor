import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_VERSION = "1.0.0";
const OFFICIAL_ORIGIN = "https://developers.openai.com";
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

class SourceDriftError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SourceDriftError";
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function object(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceDriftError(label + " must be an object.");
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SourceDriftError(label + " must contain exactly: " + expected.join(", ") + ".");
  }
}

function parseJson(bytes, label) {
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SourceDriftError(label + " is not valid UTF-8.", { cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SourceDriftError(label + " is not valid JSON.", { cause: error });
  }
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new SourceDriftError(label + " must be a lowercase SHA-256 digest.");
  }
  return value;
}

function timestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new SourceDriftError(label + " must be an ISO 8601 timestamp with an offset.");
  }
  return value;
}

function relativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new SourceDriftError(label + " must be a safe relative POSIX path.");
  }
  return value;
}

function parseLock(value) {
  const lock = object(value, "migration.lock");
  exactKeys(lock, ["schemaVersion", "createdAt", "artifacts"], "migration.lock");
  if (lock.schemaVersion !== SCHEMA_VERSION) {
    throw new SourceDriftError("migration.lock schemaVersion must be " + SCHEMA_VERSION + ".");
  }
  timestamp(lock.createdAt, "migration.lock createdAt");
  if (!Array.isArray(lock.artifacts) || lock.artifacts.length === 0) {
    throw new SourceDriftError("migration.lock artifacts must be a non-empty array.");
  }

  const seenPaths = new Set();
  return lock.artifacts.map((candidate, index) => {
    const label = "migration.lock artifacts[" + index + "]";
    const artifact = object(candidate, label);
    exactKeys(artifact, ["kind", "path", "sha256"], label);
    if (artifact.kind !== "source" && artifact.kind !== "migration") {
      throw new SourceDriftError(label + " kind must be source or migration.");
    }
    const artifactPath = relativePath(artifact.path, label + " path");
    if (seenPaths.has(artifactPath)) {
      throw new SourceDriftError("migration.lock contains a duplicate path: " + artifactPath + ".");
    }
    seenPaths.add(artifactPath);
    return {
      kind: artifact.kind,
      path: artifactPath,
      sha256: digest(artifact.sha256, label + " sha256"),
    };
  });
}

function markdownUrl(sourceUrl, label) {
  if (typeof sourceUrl !== "string") {
    throw new SourceDriftError(label + " must be a URL.");
  }
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch (error) {
    throw new SourceDriftError(label + " must be a URL.", { cause: error });
  }
  if (
    parsed.origin !== OFFICIAL_ORIGIN ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.pathname.startsWith("/api/docs/") ||
    parsed.pathname.endsWith("/") ||
    /%2f|%5c/iu.test(parsed.pathname)
  ) {
    throw new SourceDriftError(
      label +
        " must be a canonical " +
        OFFICIAL_ORIGIN +
        "/api/docs/... URL without query or fragment.",
    );
  }
  const pathname = parsed.pathname.endsWith(".md") ? parsed.pathname : parsed.pathname + ".md";
  return OFFICIAL_ORIGIN + pathname;
}

function parseSourceRecord(value, artifactPath) {
  const record = object(value, artifactPath);
  exactKeys(record, ["schemaVersion", "id", "source", "claims"], artifactPath);
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new SourceDriftError(artifactPath + " schemaVersion must be " + SCHEMA_VERSION + ".");
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new SourceDriftError(artifactPath + " id must be a non-empty string.");
  }
  if (
    !Array.isArray(record.claims) ||
    record.claims.length === 0 ||
    record.claims.some((claim) => typeof claim !== "string" || claim.length === 0)
  ) {
    throw new SourceDriftError(artifactPath + " claims must be a non-empty string array.");
  }
  const source = object(record.source, artifactPath + " source");
  exactKeys(source, ["url", "title", "retrievedAt", "contentHash"], artifactPath + " source");
  if (typeof source.title !== "string" || source.title.length === 0) {
    throw new SourceDriftError(artifactPath + " source title must be a non-empty string.");
  }
  timestamp(source.retrievedAt, artifactPath + " source retrievedAt");
  return {
    id: record.id,
    path: artifactPath,
    url: markdownUrl(source.url, artifactPath + " source url"),
    expectedSha256: digest(source.contentHash, artifactPath + " source contentHash"),
  };
}

async function containedFile(root, relative, label) {
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new SourceDriftError(label + " escapes its root.");
  }
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    throw new SourceDriftError("Unable to resolve " + label + ".", { cause: error });
  }
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new SourceDriftError(label + " resolves outside its root.");
  }
  return resolved;
}

export async function loadSourceChecks(projectRoot) {
  let root;
  try {
    root = await realpath(projectRoot);
  } catch (error) {
    throw new SourceDriftError("Unable to resolve the project root.", { cause: error });
  }
  const lockPath = await containedFile(root, "migration.lock", "migration.lock");
  let lockBytes;
  try {
    lockBytes = await readFile(lockPath);
  } catch (error) {
    throw new SourceDriftError("Unable to read migration.lock.", { cause: error });
  }

  const artifacts = parseLock(parseJson(lockBytes, "migration.lock"));
  const records = [];
  const seenIds = new Set();
  for (const artifact of artifacts) {
    const artifactFile = await containedFile(root, artifact.path, artifact.path);
    let bytes;
    try {
      bytes = await readFile(artifactFile);
    } catch (error) {
      throw new SourceDriftError("Unable to read locked artifact " + artifact.path + ".", {
        cause: error,
      });
    }
    const observedArtifactHash = sha256(bytes);
    if (observedArtifactHash !== artifact.sha256) {
      throw new SourceDriftError(
        "Locked artifact hash mismatch for " +
          artifact.path +
          ": expected " +
          artifact.sha256 +
          ", observed " +
          observedArtifactHash +
          ".",
      );
    }
    if (artifact.kind === "source") {
      const record = parseSourceRecord(parseJson(bytes, artifact.path), artifact.path);
      if (seenIds.has(record.id)) {
        throw new SourceDriftError("migration.lock contains duplicate source ID " + record.id + ".");
      }
      seenIds.add(record.id);
      records.push(record);
    }
  }
  if (records.length === 0) {
    throw new SourceDriftError("migration.lock does not contain a source artifact.");
  }

  const byUrl = new Map();
  for (const record of records) {
    const existing = byUrl.get(record.url);
    if (existing === undefined) {
      byUrl.set(record.url, {
        url: record.url,
        expectedSha256: record.expectedSha256,
        records: [{ id: record.id, path: record.path }],
      });
    } else {
      if (existing.expectedSha256 !== record.expectedSha256) {
        throw new SourceDriftError(
          "Locked source records disagree on the reviewed hash for " +
            record.url +
            ": " +
            existing.expectedSha256 +
            " and " +
            record.expectedSha256 +
            ".",
        );
      }
      existing.records.push({ id: record.id, path: record.path });
    }
  }
  return {
    sourceRecordCount: records.length,
    checks: [...byUrl.values()]
      .map((check) => ({
        ...check,
        records: check.records.sort((left, right) => compareStrings(left.path, right.path)),
      }))
      .sort((left, right) => compareStrings(left.url, right.url)),
  };
}

function sourceBytes(bytes, label) {
  if (!(bytes instanceof Uint8Array)) {
    throw new SourceDriftError(label + " did not return bytes.");
  }
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new SourceDriftError(label + " exceeds the " + MAX_SOURCE_BYTES + "-byte limit.");
  }
  return bytes;
}

export async function fetchOfficialMarkdown(url, fetchImplementation = globalThis.fetch) {
  if (typeof fetchImplementation !== "function") {
    throw new SourceDriftError("This Node.js runtime does not provide fetch.");
  }
  let response;
  try {
    response = await fetchImplementation(url, {
      cache: "no-store",
      headers: {
        accept: "text/markdown, text/plain;q=0.9",
        "accept-encoding": "identity",
        "user-agent": "openai-migration-doctor-source-drift/0.1",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new SourceDriftError("Unable to fetch " + url + ".", { cause: error });
  }
  if (!response.ok || response.body === null) {
    throw new SourceDriftError("Unable to fetch " + url + ": HTTP " + response.status + ".");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
    throw new SourceDriftError(url + " exceeds the " + MAX_SOURCE_BYTES + "-byte limit.");
  }

  const chunks = [];
  let totalBytes = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SOURCE_BYTES) {
        throw new SourceDriftError(url + " exceeds the " + MAX_SOURCE_BYTES + "-byte limit.");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof SourceDriftError) {
      throw error;
    }
    throw new SourceDriftError("Unable to read " + url + ".", { cause: error });
  }
  return Buffer.concat(chunks, totalBytes);
}

function parseFixtureManifest(value) {
  const manifest = object(value, "fixture manifest");
  exactKeys(manifest, ["schemaVersion", "documents"], "fixture manifest");
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new SourceDriftError("fixture manifest schemaVersion must be " + SCHEMA_VERSION + ".");
  }
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new SourceDriftError("fixture manifest documents must be a non-empty array.");
  }
  const seenUrls = new Set();
  return manifest.documents.map((candidate, index) => {
    const label = "fixture manifest documents[" + index + "]";
    const entry = object(candidate, label);
    exactKeys(entry, ["url", "path"], label);
    let parsed;
    try {
      parsed = new URL(entry.url);
    } catch (error) {
      throw new SourceDriftError(label + " url must be a URL.", { cause: error });
    }
    if (
      parsed.origin !== OFFICIAL_ORIGIN ||
      !parsed.pathname.startsWith("/api/docs/") ||
      !parsed.pathname.endsWith(".md") ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.href !== entry.url
    ) {
      throw new SourceDriftError(label + " url must be a canonical official .md URL.");
    }
    if (seenUrls.has(entry.url)) {
      throw new SourceDriftError("fixture manifest contains duplicate URL " + entry.url + ".");
    }
    seenUrls.add(entry.url);
    return { url: entry.url, path: relativePath(entry.path, label + " path") };
  });
}

export async function createFixtureReader(manifestPath) {
  let manifestFile;
  try {
    manifestFile = await realpath(manifestPath);
  } catch (error) {
    throw new SourceDriftError("Unable to resolve the fixture manifest.", { cause: error });
  }
  const fixtureRoot = path.dirname(manifestFile);
  const entries = parseFixtureManifest(parseJson(await readFile(manifestFile), "fixture manifest"));
  const pathsByUrl = new Map();
  for (const entry of entries) {
    pathsByUrl.set(entry.url, await containedFile(fixtureRoot, entry.path, "fixture " + entry.path));
  }
  return async (url) => {
    const fixturePath = pathsByUrl.get(url);
    if (fixturePath === undefined) {
      throw new SourceDriftError("Fixture manifest has no document for " + url + ".");
    }
    return sourceBytes(await readFile(fixturePath), "Fixture for " + url);
  };
}

export async function checkSourceDrift({ projectRoot, readDocument }) {
  const sourceChecks = await loadSourceChecks(projectRoot);
  const results = [];
  for (const check of sourceChecks.checks) {
    const bytes = sourceBytes(await readDocument(check.url), check.url);
    const observedSha256 = sha256(bytes);
    results.push({
      ...check,
      observedSha256,
      status: observedSha256 === check.expectedSha256 ? "current" : "drift",
    });
  }
  return {
    sourceRecordCount: sourceChecks.sourceRecordCount,
    documentCount: results.length,
    results,
  };
}

function plural(count, singular) {
  return count === 1 ? singular : singular + "s";
}

function formatSuccess(result) {
  return (
    "Official source hashes are current: " +
    result.sourceRecordCount +
    " reviewed " +
    plural(result.sourceRecordCount, "source record") +
    " across " +
    result.documentCount +
    " canonical Markdown " +
    plural(result.documentCount, "document") +
    ".\n"
  );
}

function formatDrift(result) {
  const drifted = result.results.filter((candidate) => candidate.status === "drift");
  const lines = [
    "Official source drift detected in " +
      drifted.length +
      " " +
      plural(drifted.length, "document") +
      ":",
  ];
  for (const candidate of drifted) {
    lines.push("- " + candidate.url);
    lines.push("  expected SHA-256: " + candidate.expectedSha256);
    lines.push("  observed SHA-256: " + candidate.observedSha256);
    lines.push("  affected locked source records:");
    for (const record of candidate.records) {
      lines.push("    - " + record.path + " (" + record.id + ")");
    }
  }
  lines.push(
    "Review required:",
    "1. Download each changed .md response to a temporary location.",
    "2. Review every affected claim and migration edge against the changed official source.",
    "3. Create new dated source records; do not overwrite historical reviewed records.",
    "4. Update affected migration edges and migration.lock only after human review.",
    "No project files were modified.",
  );
  return lines.join("\n") + "\n";
}

function usage() {
  return [
    "Usage:",
    "  node scripts/check-source-drift.mjs --network [--root <project-root>]",
    "  node scripts/check-source-drift.mjs --fixture-manifest <path> [--root <project-root>]",
    "",
    "Exactly one access mode is required. --network is the explicit live-network gate.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { fixtureManifest: undefined, help: false, network: false, root: PROJECT_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--network") {
      options.network = true;
    } else if (argument === "--root" || argument === "--fixture-manifest") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SourceDriftError(argument + " requires a value.");
      }
      if (argument === "--root") {
        options.root = path.resolve(value);
      } else {
        options.fixtureManifest = path.resolve(value);
      }
      index += 1;
    } else {
      throw new SourceDriftError("Unknown argument: " + argument + ".");
    }
  }
  return options;
}

export async function runCli(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(error.message + "\n\n" + usage() + "\n");
    return 2;
  }
  if (options.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  if (options.network === (options.fixtureManifest !== undefined)) {
    process.stderr.write(
      "Choose exactly one of --network or --fixture-manifest.\n\n" + usage() + "\n",
    );
    return 2;
  }

  try {
    const readDocument = options.network
      ? (url) => fetchOfficialMarkdown(url)
      : await createFixtureReader(options.fixtureManifest);
    const result = await checkSourceDrift({ projectRoot: options.root, readDocument });
    if (result.results.some((candidate) => candidate.status === "drift")) {
      process.stderr.write(formatDrift(result));
      return 1;
    }
    process.stdout.write(formatSuccess(result));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown source drift failure.";
    process.stderr.write(
      "Official source drift check failed: " +
        message +
        "\nNo project files were modified.\n",
    );
    return 2;
  }
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
