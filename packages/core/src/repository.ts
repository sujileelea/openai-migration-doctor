import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { compareStrings } from "./compare.js";
import { ConfigurationError } from "./errors.js";
import { sha256 } from "./hash.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_EXCLUSIONS = [
  ".git",
  ".migration-doctor",
  "build",
  "coverage",
  "dist",
  "node_modules",
] as const;

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export async function normalizeRepositoryRoot(repositoryRoot: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(repositoryRoot);
  } catch (error) {
    throw new ConfigurationError(`Repository path does not exist: ${repositoryRoot}`, {
      cause: error,
    });
  }

  if (!(await stat(resolved)).isDirectory()) {
    throw new ConfigurationError(`Repository path is not a directory: ${repositoryRoot}`);
  }
  return resolved;
}

export function resolveRepositoryFile(repositoryRoot: string, relativePath: string): string {
  const resolved = path.resolve(repositoryRoot, relativePath);
  if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new ConfigurationError(`File path escapes the repository root: ${relativePath}`);
  }
  return resolved;
}

export type ListRepositoryFilesOptions = {
  maxFiles?: number;
};

export class RepositoryFileLimitError extends ConfigurationError {
  readonly maxFiles: number;

  constructor(maxFiles: number) {
    super(`Repository file enumeration exceeded the ${maxFiles}-file limit.`);
    this.maxFiles = maxFiles;
  }
}

export async function listRepositoryFiles(
  repositoryRoot: string,
  extensions?: ReadonlySet<string>,
  options: ListRepositoryFilesOptions = {},
): Promise<string[]> {
  const maxFiles = options.maxFiles;
  if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles < 0)) {
    throw new ConfigurationError("Repository file limit must be a non-negative integer.");
  }
  const root = await normalizeRepositoryRoot(repositoryRoot);
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareStrings(left.name, right.name));

    for (const entry of entries) {
      if (DEFAULT_EXCLUSIONS.includes(entry.name as (typeof DEFAULT_EXCLUSIONS)[number])) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (extensions && !extensions.has(path.extname(entry.name))) {
        continue;
      }
      if (maxFiles !== undefined && files.length >= maxFiles) {
        throw new RepositoryFileLimitError(maxFiles);
      }
      files.push(toPosixPath(path.relative(root, absolutePath)));
    }
  }

  await visit(root);
  return files;
}

export async function hashRepositoryTree(repositoryRoot: string): Promise<string> {
  const root = await normalizeRepositoryRoot(repositoryRoot);
  const files = await listRepositoryFiles(root);
  const records: string[] = [];
  for (const file of files) {
    const content = await readFile(resolveRepositoryFile(root, file));
    records.push(`${file}\u0000${sha256(content)}`);
  }
  return sha256(records.join("\n"));
}

export async function repositoryFileHashes(repositoryRoot: string): Promise<Map<string, string>> {
  const root = await normalizeRepositoryRoot(repositoryRoot);
  const result = new Map<string, string>();
  for (const file of await listRepositoryFiles(root)) {
    result.set(file, sha256(await readFile(resolveRepositoryFile(root, file))));
  }
  return result;
}

export function changedRepositoryFiles(
  beforeHashes: ReadonlyMap<string, string>,
  afterHashes: ReadonlyMap<string, string>,
): string[] {
  return [...new Set([...beforeHashes.keys(), ...afterHashes.keys()])]
    .filter((file) => beforeHashes.get(file) !== afterHashes.get(file))
    .sort(compareStrings);
}

export async function readRepositoryRevision(repositoryRoot: string): Promise<string | null> {
  const root = await normalizeRepositoryRoot(repositoryRoot);
  try {
    const topLevel = (
      await execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      })
    ).stdout.trim();
    if ((await realpath(topLevel)) !== root) {
      return null;
    }
    return (
      await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })
    ).stdout.trim();
  } catch {
    return null;
  }
}
