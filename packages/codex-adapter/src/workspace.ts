import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, opendir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify, TextDecoder } from "node:util";
import {
  ConfigurationError,
  changedRepositoryFiles,
  compareStrings,
  normalizeRepositoryRoot,
  resolveRepositoryFile,
  sha256,
} from "@migration-doctor/core";
import { CodexRelativePathSchema, type CodexRemediationManifest } from "./schemas.js";

const execFileAsync = promisify(execFile);
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export const MAX_CODEX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_CODEX_WORKSPACE_BYTES = 10 * 1024 * 1024;
export const MAX_CODEX_WORKSPACE_FILES = 64;
export const MAX_CODEX_WORKSPACE_ENTRIES = 4_096;

const GIT_ENVIRONMENT = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
} as const;

const SAFE_GIT_ARGUMENTS = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.preloadIndex=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "submodule.recurse=false",
  "-c",
  "status.submoduleSummary=false",
] as const;

const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/u,
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
] as const;

export type WorkspaceSnapshot = {
  hashes: Map<string, string>;
  contents: Map<string, Buffer>;
  directories: string[];
};

export type ProposalWorkspace = {
  root: string;
  cleanup(): Promise<void>;
};

export type VerificationWorktree = {
  root: string;
  revision: string;
  cleanup(): Promise<void>;
};

async function runGit(
  args: string[],
  options: { cwd?: string; maxBuffer?: number } = {},
): Promise<string> {
  const result = await execFileAsync("git", [...SAFE_GIT_ARGUMENTS, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: GIT_ENVIRONMENT,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  return result.stdout;
}

async function runGitBuffer(
  args: string[],
  options: { cwd?: string; maxBuffer?: number } = {},
): Promise<Buffer> {
  const result = (await execFileAsync("git", [...SAFE_GIT_ARGUMENTS, ...args], {
    cwd: options.cwd,
    encoding: null,
    env: GIT_ENVIRONMENT,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  })) as unknown as { stdout: Buffer };
  return result.stdout;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function assertPathHasNoSymlink(
  root: string,
  relativePath: string,
  options: { leafMustExist: boolean },
): Promise<string> {
  const target = resolveRepositoryFile(root, relativePath);
  if (target === root) {
    throw new ConfigurationError(`Codex scope requires a file path: ${relativePath}`);
  }

  const components = path.relative(root, target).split(path.sep);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    let metadata: Stats;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isMissingPathError(error) && !options.leafMustExist && index === components.length - 1) {
        return target;
      }
      throw new ConfigurationError(`Codex scope path does not exist: ${relativePath}`, {
        cause: error,
      });
    }
    if (metadata.isSymbolicLink()) {
      throw new ConfigurationError(`Codex scope path contains a symbolic link: ${relativePath}`);
    }
    if (index < components.length - 1 && !metadata.isDirectory()) {
      throw new ConfigurationError(
        `Codex scope path has a non-directory component: ${relativePath}`,
      );
    }
  }
  return target;
}

async function ensureSafeParentDirectories(root: string, relativePath: string): Promise<void> {
  const target = resolveRepositoryFile(root, relativePath);
  const parentPath = path.relative(root, path.dirname(target));
  if (parentPath.length === 0) {
    return;
  }

  let current = root;
  for (const component of parentPath.split(path.sep)) {
    current = path.join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ConfigurationError(
        `Codex scope path has an unsafe directory component: ${relativePath}`,
      );
    }
  }
}

async function readRegularFile(root: string, relativePath: string): Promise<Buffer> {
  const file = await assertPathHasNoSymlink(root, relativePath, { leafMustExist: true });
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ConfigurationError(`Codex scope requires a regular file: ${relativePath}`);
    }
    if (metadata.size > MAX_CODEX_FILE_BYTES) {
      throw new ConfigurationError(
        `Codex scope file exceeds ${MAX_CODEX_FILE_BYTES} bytes: ${relativePath}`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeNewRegularFile(
  root: string,
  relativePath: string,
  content: Buffer,
  mode: number,
): Promise<void> {
  await ensureSafeParentDirectories(root, relativePath);
  const target = await assertPathHasNoSymlink(root, relativePath, { leafMustExist: false });
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ConfigurationError(`Codex scope requires a regular file: ${relativePath}`);
    }
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

async function replaceRegularFile(
  root: string,
  relativePath: string,
  content: Buffer,
): Promise<void> {
  const target = await assertPathHasNoSymlink(root, relativePath, { leafMustExist: true });
  const handle = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ConfigurationError(`Codex scope requires a regular file: ${relativePath}`);
    }
    await handle.truncate(0);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

function assertSafeTextContent(content: Buffer, displayPath: string): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new ConfigurationError(`Codex scope requires UTF-8 text: ${displayPath}`, {
      cause: error,
    });
  }
  if (text.includes("\0")) {
    throw new ConfigurationError(`Codex scope cannot contain null bytes: ${displayPath}`);
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new ConfigurationError(`Codex scope contains a likely credential: ${displayPath}`);
  }
}

export async function readSafeCodexFile(
  repositoryRoot: string,
  relativePath: string,
): Promise<Buffer> {
  const root = await normalizeRepositoryRoot(repositoryRoot);
  const content = await readRegularFile(root, relativePath);
  assertSafeTextContent(content, relativePath);
  return content;
}

export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const normalizedRoot = await normalizeRepositoryRoot(root);
  const hashes = new Map<string, string>();
  const contents = new Map<string, Buffer>();
  const directories: string[] = [];
  let totalBytes = 0;
  let entryCount = 0;

  async function visit(directory: string): Promise<void> {
    const entries = [];
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entryCount += 1;
      if (entryCount > MAX_CODEX_WORKSPACE_ENTRIES) {
        throw new ConfigurationError(
          `Codex workspace exceeds ${MAX_CODEX_WORKSPACE_ENTRIES} filesystem entries.`,
        );
      }
      entries.push(entry);
    }
    entries.sort((left, right) => compareStrings(left.name, right.name));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(normalizedRoot, absolutePath).split(path.sep).join("/");
      if (relativePath.length > 4096 || relativePath.split("/").length > 32) {
        throw new ConfigurationError("Codex workspace contains an overlong path.");
      }
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new ConfigurationError(
          `Codex workspace contains a non-regular entry: ${relativePath}`,
        );
      }
      if (metadata.isDirectory()) {
        directories.push(relativePath);
        await visit(absolutePath);
        continue;
      }

      const content = await readRegularFile(normalizedRoot, relativePath);
      if (hashes.size >= MAX_CODEX_WORKSPACE_FILES) {
        throw new ConfigurationError(
          `Codex workspace exceeds ${MAX_CODEX_WORKSPACE_FILES} regular files.`,
        );
      }
      if (content.byteLength > MAX_CODEX_FILE_BYTES) {
        throw new ConfigurationError(
          `Codex workspace file exceeds ${MAX_CODEX_FILE_BYTES} bytes: ${relativePath}`,
        );
      }
      assertSafeTextContent(content, relativePath);
      totalBytes += content.byteLength;
      if (totalBytes > MAX_CODEX_WORKSPACE_BYTES) {
        throw new ConfigurationError(
          `Codex workspace exceeds ${MAX_CODEX_WORKSPACE_BYTES} total bytes.`,
        );
      }
      hashes.set(relativePath, sha256(content));
      contents.set(relativePath, content);
    }
  }

  await visit(normalizedRoot);
  directories.sort(compareStrings);
  return { hashes, contents, directories };
}

export function changedWorkspaceFiles(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): string[] {
  return changedRepositoryFiles(before.hashes, after.hashes);
}

export async function createProposalWorkspace(
  repositoryRoot: string,
  manifest: CodexRemediationManifest,
): Promise<ProposalWorkspace> {
  const sourceRoot = await normalizeRepositoryRoot(repositoryRoot);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "migration-doctor-codex-proposal-"));

  try {
    await chmod(temporaryRoot, 0o700);
    for (const exposed of manifest.exposedFiles) {
      const content = await readGitRevisionFile(
        sourceRoot,
        manifest.repositoryRevision,
        exposed.path,
      );
      if (sha256(content) !== exposed.beforeHash) {
        throw new ConfigurationError(`Codex scope is stale for file: ${exposed.path}`);
      }
      await writeNewRegularFile(temporaryRoot, exposed.path, content, 0o600);
    }

    return {
      root: temporaryRoot,
      cleanup: async () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function readStableGitRepositoryRevision(repositoryRoot: string): Promise<string> {
  const root = await normalizeRepositoryRoot(repositoryRoot);
  let topLevel: string;
  try {
    topLevel = (await runGit(["-C", root, "rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    throw new ConfigurationError("Codex remediation requires a Git repository.", { cause: error });
  }
  if ((await realpath(topLevel)) !== root) {
    throw new ConfigurationError("Codex remediation must target the Git repository root.");
  }
  const revision = (await runGit(["-C", root, "rev-parse", "HEAD"])).trim();
  if (!GIT_OBJECT_ID.test(revision)) {
    throw new ConfigurationError("Codex remediation could not resolve a full Git revision.");
  }
  try {
    await runGit(["-C", root, "diff-index", "--cached", "--quiet", revision, "--"]);
  } catch (error) {
    throw new ConfigurationError(
      "Codex remediation requires the Git index to match the frozen HEAD revision.",
      { cause: error },
    );
  }
  const revisionAfterCheck = (await runGit(["-C", root, "rev-parse", "HEAD"])).trim();
  if (revisionAfterCheck !== revision) {
    throw new ConfigurationError("Codex remediation repository revision changed during preflight.");
  }
  return revision;
}

export async function readGitRevisionFile(
  repositoryRoot: string,
  revision: string,
  relativePath: string,
): Promise<Buffer> {
  const root = await normalizeRepositoryRoot(repositoryRoot);
  if (!GIT_OBJECT_ID.test(revision)) {
    throw new ConfigurationError("Codex scope requires a full Git object ID.");
  }
  CodexRelativePathSchema.parse(relativePath);
  const rawEntry = await runGitBuffer([
    "--literal-pathspecs",
    "-C",
    root,
    "ls-tree",
    "-z",
    "--full-tree",
    revision,
    "--",
    relativePath,
  ]);
  let entry: string;
  try {
    entry = new TextDecoder("utf-8", { fatal: true }).decode(rawEntry);
  } catch (error) {
    throw new ConfigurationError(`Codex scope requires a UTF-8 Git path: ${relativePath}`, {
      cause: error,
    });
  }
  const records = entry.split("\0").filter((record) => record.length > 0);
  if (records.length !== 1) {
    throw new ConfigurationError(
      `Codex scope file is not a tracked regular blob at the frozen revision: ${relativePath}`,
    );
  }
  const separator = records[0]?.indexOf("\t") ?? -1;
  const header = separator < 0 ? [] : records[0]?.slice(0, separator).split(" ");
  const recordedPath = separator < 0 ? "" : records[0]?.slice(separator + 1);
  const [mode, objectType, objectId] = header ?? [];
  if (
    recordedPath !== relativePath ||
    objectType !== "blob" ||
    !objectId ||
    (mode !== "100644" && mode !== "100755")
  ) {
    throw new ConfigurationError(
      `Codex scope file is not a tracked regular blob at the frozen revision: ${relativePath}`,
    );
  }
  const content = await runGitBuffer(["-C", root, "cat-file", "blob", objectId]);
  if (content.byteLength > MAX_CODEX_FILE_BYTES) {
    throw new ConfigurationError(
      `Codex scope file exceeds ${MAX_CODEX_FILE_BYTES} bytes: ${relativePath}`,
    );
  }
  assertSafeTextContent(content, relativePath);
  return content;
}

async function exportRevision(
  sourceRoot: string,
  targetRoot: string,
  revision: string,
): Promise<void> {
  const rawTree = await runGitBuffer([
    "-C",
    sourceRoot,
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    revision,
  ]);
  let tree: string;
  try {
    tree = new TextDecoder("utf-8", { fatal: true }).decode(rawTree);
  } catch (error) {
    throw new ConfigurationError("Codex verification requires UTF-8 Git paths.", { cause: error });
  }

  for (const record of tree.split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const separator = record.indexOf("\t");
    if (separator < 0) {
      throw new ConfigurationError("Git returned an invalid tree entry for Codex verification.");
    }
    const [mode, objectType, objectId] = record.slice(0, separator).split(" ");
    const file = record.slice(separator + 1);
    if (!mode || objectType !== "blob" || !objectId) {
      throw new ConfigurationError(`Codex verification cannot stage Git entry: ${file}`);
    }
    if (mode === "120000") {
      throw new ConfigurationError(
        `Codex verification does not allow tracked symbolic links: ${file}`,
      );
    }
    if (mode !== "100644" && mode !== "100755") {
      throw new ConfigurationError(`Codex verification cannot stage Git mode ${mode}: ${file}`);
    }
    const content = await runGitBuffer(["-C", sourceRoot, "cat-file", "blob", objectId]);
    await writeNewRegularFile(targetRoot, file, content, mode === "100755" ? 0o700 : 0o600);
  }
}

export async function createVerificationWorktree(
  repositoryRoot: string,
  expectedRevision?: string,
): Promise<VerificationWorktree> {
  const sourceRoot = await normalizeRepositoryRoot(repositoryRoot);
  const revision = await readStableGitRepositoryRevision(sourceRoot);
  if (expectedRevision !== undefined && revision !== expectedRevision) {
    throw new ConfigurationError(
      `Codex remediation repository revision changed: expected ${expectedRevision}, received ${revision}.`,
    );
  }
  const temporaryParent = await mkdtemp(path.join(tmpdir(), "migration-doctor-codex-verify-"));
  const worktreeRoot = path.join(temporaryParent, "snapshot");

  try {
    await chmod(temporaryParent, 0o700);
    await mkdir(worktreeRoot, { mode: 0o700 });
    await exportRevision(sourceRoot, worktreeRoot, revision);
    const revisionAfterExport = await readStableGitRepositoryRevision(sourceRoot);
    if (revisionAfterExport !== revision) {
      throw new ConfigurationError("Codex remediation repository revision changed during staging.");
    }

    return {
      root: worktreeRoot,
      revision,
      cleanup: async () => rm(temporaryParent, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryParent, { recursive: true, force: true });
    throw error;
  }
}

export async function applyWorkspaceChanges(
  verificationRoot: string,
  after: WorkspaceSnapshot,
  changedFiles: readonly string[],
  expectedBeforeHashes?: ReadonlyMap<string, string>,
): Promise<void> {
  const root = await normalizeRepositoryRoot(verificationRoot);
  for (const file of changedFiles) {
    const content = after.contents.get(file);
    if (!content) {
      throw new ConfigurationError(`Codex remediation does not allow file deletion: ${file}`);
    }
    if (expectedBeforeHashes) {
      const expectedBeforeHash = expectedBeforeHashes.get(file);
      if (!expectedBeforeHash) {
        throw new ConfigurationError(`Codex remediation has no frozen preimage for file: ${file}`);
      }
      const actualBeforeHash = sha256(await readRegularFile(root, file));
      if (actualBeforeHash !== expectedBeforeHash) {
        throw new ConfigurationError(`Codex verification preimage is stale for file: ${file}`);
      }
    }
    await replaceRegularFile(root, file, content);
  }
}
