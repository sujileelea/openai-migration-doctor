import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const LOCK_PATH = fileURLToPath(new URL("../config/sarif-schema-lock.json", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));
const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/typescript/direct-model-literal", import.meta.url),
);

function parseSchemaLock(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("SARIF schema lock must be an object.");
  }
  const expectedKeys = ["maximumBytes", "sarifVersion", "schemaVersion", "sha256", "url"];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(`SARIF schema lock must contain exactly: ${expectedKeys.join(", ")}.`);
  }
  if (
    value.schemaVersion !== "1.0.0" ||
    value.sarifVersion !== "2.1.0" ||
    typeof value.url !== "string" ||
    !value.url.startsWith("https://docs.oasis-open.org/") ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.maximumBytes) ||
    value.maximumBytes < 1
  ) {
    throw new TypeError("SARIF schema lock contains an invalid field.");
  }
  return value;
}

async function fetchPinnedSchema(lock) {
  const response = await fetch(lock.url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Unable to fetch the OASIS SARIF schema: HTTP ${response.status}.`);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > lock.maximumBytes) {
      throw new Error(`OASIS SARIF schema exceeds the ${lock.maximumBytes}-byte limit.`);
    }
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  const observedHash = createHash("sha256").update(bytes).digest("hex");
  if (observedHash !== lock.sha256) {
    throw new Error(
      `OASIS SARIF schema SHA-256 mismatch: expected ${lock.sha256}, observed ${observedHash}.`,
    );
  }
  return JSON.parse(bytes.toString("utf8"));
}

function generateSarif() {
  const result = spawnSync(
    process.execPath,
    [CLI_PATH, "scan", FIXTURE_PATH, "--format", "sarif"],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: { ...process.env, MIGRATION_DOCTOR_HOME: PROJECT_ROOT },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (result.error) {
    throw new Error("Unable to run Migration Doctor for SARIF validation.", {
      cause: result.error,
    });
  }
  if (result.status !== 1) {
    throw new Error(
      `Expected the labeled SARIF fixture to exit 1, received ${result.status ?? "no status"}: ${result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const lock = parseSchemaLock(JSON.parse(await readFile(LOCK_PATH, "utf8")));
  const schema = await fetchPinnedSchema(lock);
  const report = generateSarif();
  if (report.$schema !== lock.url || report.version !== lock.sarifVersion) {
    throw new Error("Generated SARIF does not identify the pinned OASIS schema and version.");
  }

  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    strictRequired: false,
    unicodeRegExp: false,
  });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(report)) {
    throw new Error(
      `Generated SARIF failed OASIS schema validation: ${ajv.errorsText(validate.errors)}`,
    );
  }
  process.stdout.write(
    `Validated generated SARIF ${lock.sarifVersion} against ${lock.url} (sha256:${lock.sha256}).\n`,
  );
}

await main();
