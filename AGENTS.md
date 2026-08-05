# Migration Doctor repository guidance

Read `README.md` and `CODEX_HANDOFF.md` before changing product behavior.

## Commands

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
```

## Invariants

- Keep dependencies inward: `core` must not import CLI, reporters, or language adapters.
- Detection is local, deterministic, read-only, and network-free.
- Every migration rule needs official source records, a locked artifact hash, positive and negative fixtures, an automation tier, and a verification contract.
- After editing a locked artifact, recompute its SHA-256 and update `migration.lock` in the same change.
- Canonical JSON must not contain duration, current time, absolute paths, temporary paths, or random IDs. Runtime telemetry belongs on stderr.
- `migrate` remains preview-only in Phase 1. `verify` may write only to a temporary copy.
- Never report runtime behavior as verified without repository-specific behavioral evidence.
- Do not add Codex, Python, Assistants transformation, SARIF, HTML, caching, or plugin packaging before the current phase gate is satisfied.

## Definition of done

Run build, typecheck, lint, and tests. Keep the README and limitations truthful, and report measured results separately from targets.
