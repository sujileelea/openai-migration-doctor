# Python language adapter

This package implements Migration Doctor's shared `LanguageAdapter` contract for UTF-8 Python
source. LibCST performs Python-specific parsing, binding confirmation, source positioning, and
format-preserving rendering within that supported encoding. Invalid UTF-8 fails closed. Migration
graph resolution, finding validation, patch planning, preview, and verification remain in
`@migration-doctor/core`.

The adapter implements two independent analyses:

- the deterministic model-snapshot match and format-preserving rewrite; and
- review-only Assistants API inventory for direct calls on a same-file, unconditionally imported
  `OpenAI` or `AsyncOpenAI` assignment proven by LibCST scope and qualified-name metadata.

Assistants findings use the locked Assistants-to-Responses-and-Conversations migration edge, are
always Tier C, and never produce a transformation. The reviewed Python allowlist covers Assistant,
Thread, Message, Run, and Run Step methods. Streaming and tool facets are reported only for static
helper methods or explicit literal keyword arguments. Explicit dynamic `stream`, `tools`, or
`tool_resources` values abstain; factory-created clients, client/resource aliases, detached methods,
dynamic member access, cross-file clients, shadowed bindings, and reassigned clients remain silent.

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
the locked source-model spelling or the conservative Assistants lexical markers are limited to
`PYTHON_MAX_CANDIDATE_FILES` (256 files) and `PYTHON_MAX_CANDIDATE_SOURCE_BYTES` (16 MiB total),
including files later excluded by conservative local-module shadow handling. `LibCstBridge.scan` and
`LibCstBridge.rewrite` enforce the same content limits on direct callers and preflight the exact JSON
size against `PYTHON_MAX_WORKER_INPUT_BYTES` (64 MiB) before serializing a complete worker request.
These exported limits accommodate ordinary handwritten and moderately generated sources while
deterministically bounding retained Python paths, source content, and complete worker inputs;
exceeding one is an analysis error, never a clean scan or silent skip.

The internal worker protocol is `1.1.0`. A scan result carries model `matches` and structured
`assistants` call records separately for every candidate file. TypeScript validates every response
field and known enum value before creating public findings. The worker remains pinned to exactly
LibCST 1.9.0 and runs through the same isolated interpreter, sanitized environment, bounded output,
and timeout used by the original model rule.

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
