import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  loadMigrationRegistry,
  scanRepository,
  sha256,
} from "../packages/core/dist/index.js";
import { PythonLanguageAdapter } from "../packages/language-python/dist/index.js";
import {
  JavaScriptLanguageAdapter,
  TypeScriptLanguageAdapter,
} from "../packages/language-typescript/dist/index.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_PATH = path.join(
  PROJECT_ROOT,
  "evaluations",
  "public-repositories",
  "manifest.json",
);
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const SUPPORTED_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".py",
  ".pyi",
  ".ts",
  ".tsx",
]);

function fail(message) {
  throw new Error(message);
}

function validateManifest(value) {
  if (!value || value.schemaVersion !== "1.0.0" || !Array.isArray(value.repositories)) {
    fail("Public-repository manifest must use schema 1.0.0 and list repositories.");
  }
  const ids = new Set();
  for (const repository of value.repositories) {
    if (
      !repository ||
      typeof repository.id !== "string" ||
      ids.has(repository.id) ||
      typeof repository.url !== "string" ||
      !repository.url.startsWith("https://github.com/") ||
      !REVISION.test(repository.revision) ||
      repository.license?.spdx !== "MIT" ||
      typeof repository.license.path !== "string" ||
      !SHA256.test(repository.license.sha256) ||
      typeof repository.groundTruth?.path !== "string" ||
      path.isAbsolute(repository.groundTruth.path) ||
      !SHA256.test(repository.groundTruth.sha256) ||
      !Number.isInteger(repository.expectedGraphIssues) ||
      repository.expectedGraphIssues < 0
    ) {
      fail(`Invalid public-repository manifest entry: ${repository?.id ?? "unknown"}.`);
    }
    for (const field of ["runtimeCallSites", "supportedCallSites", "outOfScopeCallSites"]) {
      if (!Number.isInteger(repository.manualReview?.[field]) || repository.manualReview[field] < 0) {
        fail(`Invalid manual-review ${field} for ${repository.id}.`);
      }
    }
    if (typeof repository.manualReview.note !== "string") {
      fail(`Invalid manual-review note for ${repository.id}.`);
    }
    ids.add(repository.id);
  }
  return value;
}

function killProcessGroup(child) {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the limit check and termination.
    }
  }
}

async function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? PROJECT_ROOT,
      env: {
        HOME: options.home ?? tmpdir(),
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        ...options.env,
      },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      killProcessGroup(child);
      finish(() => reject(new Error(`${executable} exceeded the ${timeoutMs} ms timeout.`)));
    }, timeoutMs);
    timeout.unref();
    const collect = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        killProcessGroup(child);
        finish(() => reject(new Error(`${executable} exceeded its output limit.`)));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        finish(() =>
          reject(
            new Error(
              `${executable} failed with ${signal ?? `exit ${code}`}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
            ),
          ),
        );
        return;
      }
      finish(() => {
        const output = Buffer.concat(stdout);
        resolve(options.encoding === "buffer" ? output : output.toString("utf8").trim());
      });
    });
  });
}

function isolatedGitEnvironment(home) {
  return {
    GIT_CONFIG_GLOBAL: path.join(home, "global.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function decodeGitPath(bytes, repositoryId) {
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(`${repositoryId} contains a non-UTF-8 path: ${error.message}`);
  }
  if (
    value.length === 0 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split("/").includes("..")
  ) {
    fail(`${repositoryId} contains a non-portable source path.`);
  }
  return value;
}

async function exportReviewedBlobs(repository, gitDirectory, destination, gitOptions) {
  const tree = await run(
    "git",
    ["--git-dir", gitDirectory, "ls-tree", "-rz", "--full-tree", repository.revision],
    { ...gitOptions, encoding: "buffer", maxOutputBytes: 16 * 1024 * 1024 },
  );
  let licenseExported = false;
  for (const record of tree.subarray(0, -1).toString("binary").split("\0")) {
    const separator = record.indexOf("\t");
    if (separator < 0) {
      fail(`Unable to parse the Git tree for ${repository.id}.`);
    }
    const metadata = record.slice(0, separator);
    const rawPath = Buffer.from(record.slice(separator + 1), "binary");
    const match = /^(100644|100755) blob ([a-f0-9]{40})$/u.exec(metadata);
    if (!match) {
      continue;
    }
    const file = decodeGitPath(rawPath, repository.id);
    if (file !== repository.license.path && !SUPPORTED_EXTENSIONS.has(path.posix.extname(file))) {
      continue;
    }
    const bytes = await run("git", ["--git-dir", gitDirectory, "cat-file", "blob", match[2]], {
      ...gitOptions,
      encoding: "buffer",
    });
    const target = path.join(destination, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    licenseExported ||= file === repository.license.path;
  }
  if (!licenseExported) {
    fail(`The pinned tree for ${repository.id} does not contain its declared license file.`);
  }
}

async function clonePinned(repository, destination, gitHome) {
  const gitDirectory = path.join(destination, "objects.git");
  const sourceRoot = path.join(destination, "source");
  const gitOptions = {
    home: gitHome,
    env: isolatedGitEnvironment(gitHome),
  };
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await run("git", ["init", "--bare", "--quiet", "--template=", gitDirectory], gitOptions);
  await run("git", ["--git-dir", gitDirectory, "remote", "add", "origin", repository.url], gitOptions);
  await run(
    "git",
    ["--git-dir", gitDirectory, "fetch", "--quiet", "--depth", "1", "origin", repository.revision],
    gitOptions,
  );
  const revision = await run("git", ["--git-dir", gitDirectory, "rev-parse", "FETCH_HEAD"], gitOptions);
  if (revision !== repository.revision) {
    fail(`Fetched revision mismatch for ${repository.id}.`);
  }
  await mkdir(sourceRoot, { mode: 0o700 });
  await exportReviewedBlobs(repository, gitDirectory, sourceRoot, gitOptions);
  return sourceRoot;
}

function summarizeFindings(findings) {
  const labels = findings.map((finding) => ({
    file: finding.location.file,
    line: finding.location.line,
    column: finding.location.column,
    language: finding.language,
    severity: finding.severity,
    ruleId: finding.ruleId,
    feature: finding.analysis.feature,
    pattern: finding.analysis.pattern,
    disposition: finding.analysis.disposition,
    reasonCode: finding.analysis.reasonCode ?? null,
  }));
  const supported = findings.filter(
    (finding) => finding.analysis.disposition === "supported",
  ).length;
  return {
    labels,
    supported,
    abstained: findings.length - supported,
    findingLabelHash: sha256(canonicalJson(labels)),
  };
}

function validateGroundTruth(repository, value) {
  if (
    !value ||
    value.schemaVersion !== "1.0.0" ||
    value.repositoryRevision !== repository.revision ||
    !Array.isArray(value.labels)
  ) {
    fail(`Invalid ground-truth header for ${repository.id}.`);
  }
  const keys = new Set();
  for (const label of value.labels) {
    const key = canonicalJson(label);
    if (
      !label ||
      typeof label.file !== "string" ||
      !Number.isInteger(label.line) ||
      label.line < 1 ||
      !Number.isInteger(label.column) ||
      label.column < 1 ||
      !["javascript", "typescript", "python"].includes(label.language) ||
      !["error", "warning", "info"].includes(label.severity) ||
      typeof label.ruleId !== "string" ||
      typeof label.feature !== "string" ||
      typeof label.pattern !== "string" ||
      !["supported", "abstained"].includes(label.disposition) ||
      !(typeof label.reasonCode === "string" || label.reasonCode === null) ||
      keys.has(key)
    ) {
      fail(`Invalid or duplicate ground-truth label for ${repository.id}.`);
    }
    keys.add(key);
  }
  return value.labels;
}

async function loadGroundTruth(repository) {
  const root = path.join(PROJECT_ROOT, "evaluations", "public-repositories");
  const labelsPath = path.resolve(root, repository.groundTruth.path);
  if (!labelsPath.startsWith(`${root}${path.sep}`)) {
    fail(`Ground-truth path escapes the evaluation directory for ${repository.id}.`);
  }
  const bytes = await readFile(labelsPath);
  const observedHash = createHash("sha256").update(bytes).digest("hex");
  if (observedHash !== repository.groundTruth.sha256) {
    fail(`Ground-truth hash changed for ${repository.id}.`);
  }
  return validateGroundTruth(repository, JSON.parse(bytes.toString("utf8")));
}

function compareLabels(expectedLabels, actualLabels) {
  const expected = new Map(expectedLabels.map((label) => [canonicalJson(label), label]));
  const actual = new Map(actualLabels.map((label) => [canonicalJson(label), label]));
  const falsePositives = [...actual.keys()].filter((key) => !expected.has(key));
  const falseNegatives = [...expected.keys()].filter((key) => !actual.has(key));
  const truePositives = actual.size - falsePositives.length;
  return {
    expectedAtomicFindings: expected.size,
    truePositives,
    falsePositives: falsePositives.length,
    falseNegatives: falseNegatives.length,
    precision: ratio(truePositives, actual.size),
    recall: ratio(truePositives, expected.size),
    expectedLabelHash: sha256(canonicalJson(expectedLabels)),
    actualLabelHash: sha256(canonicalJson(actualLabels)),
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

async function evaluate(manifest) {
  const gitStatus = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (gitStatus !== "") {
    fail("Public-repository evaluation requires a clean Migration Doctor worktree.");
  }
  const toolRevision = await run("git", ["rev-parse", "HEAD"]);
  const registry = await loadMigrationRegistry(PROJECT_ROOT);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-public-eval-"));
  const gitHome = path.join(temporaryRoot, "git-home");
  await mkdir(gitHome, { mode: 0o700 });
  const repositories = [];
  try {
    for (const repository of manifest.repositories) {
      const checkout = path.join(temporaryRoot, repository.id);
      const sourceRoot = await clonePinned(repository, checkout, gitHome);
      const licenseBytes = await readFile(path.join(sourceRoot, repository.license.path));
      const licenseHash = createHash("sha256").update(licenseBytes).digest("hex");
      if (licenseHash !== repository.license.sha256) {
        fail(`License hash changed for ${repository.id}.`);
      }
      const scan = await scanRepository({
        repositoryRoot: sourceRoot,
        registry,
        adapters: [
          new JavaScriptLanguageAdapter(),
          new TypeScriptLanguageAdapter(),
          new PythonLanguageAdapter(),
        ],
      });
      const findings = summarizeFindings(scan.findings);
      const expectedLabels = await loadGroundTruth(repository);
      const comparison = compareLabels(expectedLabels, findings.labels);
      const actual = {
        total: scan.summary.total,
        blocking: scan.summary.blocking,
        graphIssues: scan.summary.graphIssues,
        supported: findings.supported,
        abstained: findings.abstained,
        findingLabelHash: findings.findingLabelHash,
      };
      const expectedBlocking = expectedLabels.filter((label) => label.severity === "error").length;
      if (actual.total !== expectedLabels.length || actual.blocking !== expectedBlocking) {
        fail(`${repository.id} summary does not match its checked-in ground truth.`);
      }
      if (actual.graphIssues !== repository.expectedGraphIssues) {
        fail(
          `${repository.id} graphIssues changed: expected ${repository.expectedGraphIssues}, received ${actual.graphIssues}.`,
        );
      }
      if (comparison.falsePositives > 0 || comparison.falseNegatives > 0) {
        fail(
          `${repository.id} differs from checked-in ground truth: ${comparison.falsePositives} false positives and ${comparison.falseNegatives} false negatives.`,
        );
      }
      repositories.push({
        id: repository.id,
        url: repository.url,
        revision: repository.revision,
        license: repository.license,
        groundTruth: repository.groundTruth,
        actual,
        comparison,
        manualReview: repository.manualReview,
      });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const expected = repositories.reduce(
    (sum, repository) => sum + repository.comparison.expectedAtomicFindings,
    0,
  );
  const falsePositives = repositories.reduce(
    (sum, repository) => sum + repository.comparison.falsePositives,
    0,
  );
  const falseNegatives = repositories.reduce(
    (sum, repository) => sum + repository.comparison.falseNegatives,
    0,
  );
  const truePositives = expected - falseNegatives;
  return {
    schemaVersion: "1.0.0",
    corpus: "pinned-public-repositories-v1",
    reviewedAt: manifest.reviewedAt,
    toolRevision,
    sourceLockHash: registry.sourceLockHash,
    repositories,
    aggregate: {
      repositories: repositories.length,
      runtimeCallSites: repositories.reduce(
        (sum, repository) => sum + repository.manualReview.runtimeCallSites,
        0,
      ),
      supportedCallSites: repositories.reduce(
        (sum, repository) => sum + repository.manualReview.supportedCallSites,
        0,
      ),
      outOfScopeCallSites: repositories.reduce(
        (sum, repository) => sum + repository.manualReview.outOfScopeCallSites,
        0,
      ),
      expectedAtomicFindings: expected,
      truePositives,
      falsePositives,
      falseNegatives,
      precision: ratio(truePositives, truePositives + falsePositives),
      recall: ratio(truePositives, truePositives + falseNegatives),
    },
    claimsBoundary:
      "These measurements apply only to three pinned public revisions and the manually reviewed declared subset; they do not predict arbitrary-repository quality.",
  };
}

const args = process.argv.slice(2);
const manifest = validateManifest(JSON.parse(await readFile(MANIFEST_PATH, "utf8")));
if (args.includes("--validate-manifest")) {
  await Promise.all(manifest.repositories.map((repository) => loadGroundTruth(repository)));
  process.stdout.write("Public-repository manifest is valid.\n");
} else {
  const outputIndex = args.indexOf("--output");
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !output) {
    fail("--output requires a new ledger path.");
  }
  const ledger = canonicalJson(await evaluate(manifest));
  if (output) {
    const outputPath = path.resolve(output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, ledger, { flag: "wx", mode: 0o600 });
  } else {
    process.stdout.write(ledger);
  }
}
