import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrationRegistry } from "@migration-doctor/core";
import {
  measurePythonAdapter,
  PythonLanguageAdapter,
} from "../dist/index.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

const repositoryRoot = path.resolve(
  readOption("--repository", path.join(projectRoot, "fixtures", "python", "direct-model-literal")),
);
const outputPath = path.resolve(
  readOption("--output", path.join(packageRoot, "performance-results", "python-latest.json")),
);
const iterations = Number.parseInt(readOption("--iterations", "3"), 10);
const requireCleanTool = process.argv.includes("--require-clean");
const registry = await loadMigrationRegistry(projectRoot);
const adapter = new PythonLanguageAdapter();
const ledger = await measurePythonAdapter({
  adapter,
  scan: { repositoryRoot, migrationEdges: registry.edges },
  iterations,
  requireCleanTool,
});

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
process.stdout.write(`${outputPath}\n`);
