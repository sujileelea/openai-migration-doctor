import path from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES = new Map([
  [
    "develop",
    new Set([
      "build",
      "chore",
      "ci",
      "dependabot",
      "docs",
      "feat",
      "fix",
      "hotfix",
      "perf",
      "refactor",
      "release",
      "revert",
      "test",
    ]),
  ],
  ["main", new Set(["hotfix", "release"])],
]);

const BRANCH_PATTERN = /^[a-z0-9]+\/[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/u;

export class BranchPolicyError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "BranchPolicyError";
  }
}

export function validateBranchRoute(base, head) {
  if (!ROUTES.has(base)) {
    throw new BranchPolicyError(`Unsupported protected base branch: ${base}.`);
  }
  if (!BRANCH_PATTERN.test(head) || head.includes("//") || head.includes("..")) {
    throw new BranchPolicyError(
      `Head branch must use a lowercase <type>/<description> name; received: ${head}.`,
    );
  }

  const separator = head.indexOf("/");
  const type = head.slice(0, separator);
  const allowedTypes = ROUTES.get(base);
  if (!allowedTypes?.has(type)) {
    const allowed = [...(allowedTypes ?? [])].sort().join(", ");
    throw new BranchPolicyError(
      `${head} cannot target ${base}; allowed branch types are: ${allowed}.`,
    );
  }

  return { base, head, type };
}

function usage() {
  return "Usage: node scripts/check-branch-policy.mjs --base <branch> --head <branch>\n";
}

function parseArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if ((key !== "--base" && key !== "--head") || value === undefined || options.has(key)) {
      throw new BranchPolicyError(usage().trim());
    }
    options.set(key, value);
  }
  if (options.size !== 2) {
    throw new BranchPolicyError(usage().trim());
  }
  return { base: options.get("--base"), head: options.get("--head") };
}

export function runCli(argv) {
  try {
    const { base, head } = parseArguments(argv);
    const route = validateBranchRoute(base, head);
    process.stdout.write(`Allowed branch route: ${route.head} -> ${route.base}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
