# Contributing

Start with the [rule-authoring guide](docs/rule-authoring.md) and preserve the invariants in
[AGENTS.md](AGENTS.md). A migration rule is incomplete without official source records, locked
artifact hashes, positive and negative fixtures, an automation tier, and a verification contract.

Before opening a pull request, run:

```bash
corepack pnpm install --frozen-lockfile
uv lock --check --project packages/language-python
uv sync --project packages/language-python --locked
corepack pnpm build
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm python:check
corepack pnpm test
corepack pnpm validate:sarif
corepack pnpm benchmark
```

Keep commits scoped and written in English. Do not update reviewed source claims automatically when
the source-drift gate changes; create new dated source records after human review. Never include
customer source, credentials, transcripts, or raw model traffic in fixtures or issue reports.
