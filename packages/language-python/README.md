# Python language adapter

This package implements Migration Doctor's shared `LanguageAdapter` contract for UTF-8 Python
source. LibCST performs Python-specific parsing, binding confirmation, source positioning, and
format-preserving rendering within that supported encoding. Invalid UTF-8 fails closed. Migration
graph resolution, finding validation, patch planning, preview, and verification remain in
`@migration-doctor/core`.

The worker dependency is exact-pinned and local analysis never installs packages or uses the
network. Prepare the package environment explicitly:

```bash
uv sync --project packages/language-python --locked
```

`PythonLanguageAdapter` uses `packages/language-python/.venv` by default. Callers may provide an
explicit `pythonExecutable` for another environment containing the locked LibCST version.

Python performance output is deliberately separate from canonical scan reports and the TypeScript
benchmark ledger:

```bash
corepack pnpm --filter @migration-doctor/language-python build
node packages/language-python/scripts/measure-performance.mjs
```

The hook writes `performance-results/python-latest.json`. It is explicitly an `adapter-smoke`
measurement, not a public benchmark, and is ignored by Git. It records the tool revision and dirty
state, corpus tree hash, migration-edge hash, environment, duration, and worker peak RSS. Use
`--require-clean` with an immutable `--output` path when preparing checked-in measurement evidence;
that mode rejects a dirty tool worktree.
