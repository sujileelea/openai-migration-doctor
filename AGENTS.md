# Migration Doctor repository guidance

Read `README.md` and `CODEX_HANDOFF.md` before changing product behavior.

## Commands

```bash
corepack pnpm install --frozen-lockfile
uv lock --check --project packages/language-python
uv sync --project packages/language-python --locked
corepack pnpm build
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm python:check
corepack pnpm test
```

## Invariants

- Keep dependencies inward: `core` must not import CLI, reporters, language adapters, or Codex.
- Detection is local, deterministic, read-only, and network-free.
- Keep the Python worker on the exact checked-in `uv.lock`, require LibCST 1.9.0 at runtime, and
  preserve its isolated interpreter flags, sanitized environment, absolute executable and worker
  paths, bounded output, and timeout.
- Every migration rule needs official source records, a locked artifact hash, positive and negative fixtures, an automation tier, and a verification contract.
- After editing a locked artifact, recompute its SHA-256 and update `migration.lock` in the same change.
- Canonical JSON must not contain duration, current time, absolute paths, temporary paths, or random IDs. Runtime telemetry belongs on stderr.
- `migrate` remains preview-only. Deterministic `verify` may write only to a temporary copy.
- Never report runtime behavior as verified without repository-specific behavioral evidence.
- Codex remains opt-in and package-local: require a Tier B plan that freezes the Git revision,
  source preimages, instructions, complete migration edges, behavior inputs, and trusted semantic
  verifier. Reproduce that plan from the exact revision at every public execution boundary.
- Codex runs only in an allowlist workspace under the root-denying permission profile. Keep shell,
  model tool network, apps, plugins, browser, computer-use, MCP, hooks, and environment inheritance
  disabled. Controller network is limited to the OpenAI API and requires a single-run API key.
- Require an independently trusted Codex launcher SHA-256 before version preflight, recheck it around
  execution, and keep the exact runner dispatch immutable.
- Verify candidate bytes in a standalone exact-revision snapshot with built-in static analyzers and
  a rule-specific deterministic postcondition. Do not execute repository code or accept
  caller-supplied adapters or repository pass/fail callbacks.
- Caller-supplied offline behavior observations are declared fixture evidence only; they never set
  `runtimeBehaviorVerified`.
- Do not route a production rule or CLI command to Codex until that rule has source-backed Tier B
  scope and a trusted repository observation harness.
- Saved report bundles must use a new directory outside the scanned target. Markdown, canonical
  JSON, SARIF, and static HTML must remain views of the same normalized report.
- Keep the composite action and checked-in audit skill pinned to frozen dependency inputs and
  isolated temporary tool builds. Do not add plugin packaging without a distinct distribution
  requirement.

## Definition of done

Run lock checks, build, typecheck, lint, Python bytecode checks, and tests. Keep the README and
limitations truthful, validate the checked-in skill after changing it, and report measured results
separately from targets.
