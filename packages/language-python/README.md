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

Python source ingestion uses fixed fail-closed budgets. Every `.py` and `.pyi` file is checked
before and after a sequential read against `PYTHON_MAX_SOURCE_FILE_BYTES` (2 MiB). Enumeration stops
before retaining more than `PYTHON_MAX_SOURCE_FILES` (4,096) matching source paths. Files containing
the locked source-model spelling are limited to `PYTHON_MAX_CANDIDATE_FILES` (256 files) and
`PYTHON_MAX_CANDIDATE_SOURCE_BYTES` (16 MiB total), including files later excluded by conservative
local-module shadow handling. `LibCstBridge.scan` and `LibCstBridge.rewrite` enforce the same content
limits on direct callers and preflight the exact JSON size against `PYTHON_MAX_WORKER_INPUT_BYTES`
(64 MiB) before serializing a complete worker request. These exported limits accommodate ordinary
handwritten and moderately generated sources while deterministically bounding retained Python paths,
source content, and complete worker inputs; exceeding one is an analysis error, never a clean scan
or silent skip.

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
