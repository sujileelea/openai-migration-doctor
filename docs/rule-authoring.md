# Migration Rule Authoring

Every released rule must connect an exact code finding to reviewed official guidance without
weakening abstention or verification boundaries. Start from the existing transcription rule in
[`data/migrations/gpt-4o-mini-transcribe-2025-03-20.json`](../data/migrations/gpt-4o-mini-transcribe-2025-03-20.json)
and its TypeScript fixtures; do not start by adding a string search to the CLI.

## 1. Review Official Sources

1. Retrieve the relevant official OpenAI `.md` page to a temporary file.
2. Record the exact upstream byte hash, URL, title, UTC retrieval timestamp, and only the claims
   needed by the rule.
3. Create a new dated record under `data/sources/`. Never overwrite a historical source record.
4. If current official sources disagree, preserve each source, emit a graph conflict through the
   existing core graph, and require human review.

The source record's `source.contentHash` hashes the upstream documentation bytes. The
`migration.lock` artifact hash separately hashes the checked-in JSON file. A changed upstream hash
requires renewed human review; it is not a mechanical lock update.

## 2. Add The Reviewed Migration Edge

Create a record under `data/migrations/` with:

- stable `from` and, when verified, `to` resources;
- announcement and shutdown dates only when supported by the reviewed sources;
- exact source references matching locked source records;
- supported languages and any reviewed SDK constraints;
- explicit behavior changes;
- an automation tier and `reviewRequired` decision.

Choose the narrowest safe tier:

| Tier | Allowed behavior |
| --- | --- |
| A | Deterministic transformation with an exact, rule-specific postcondition. |
| B | Frozen semantic plan and trusted verifier; no production Codex route without a repository observation harness. |
| C | Detection and source-backed manual action only; no automatic transformation. |

Do not infer a destination from naming similarity. Core graph resolution must also check whether a
destination has its own migration edge or conflicting guidance.

## 3. Lock Exact Artifacts

Format the new JSON files first. Hash their exact checked-in bytes and append each path, kind, and
SHA-256 to `migration.lock`:

```bash
shasum -a 256 data/sources/<dated-source>.json
shasum -a 256 data/migrations/<migration-edge>.json
```

Run the source-lock tests immediately. They verify schemas, byte hashes, unique IDs, path
containment, and exact source references. `migration.lock` is an unsigned reviewed trust anchor;
never describe it as an authenticated upstream manifest.

## 4. Extend A Language Adapter

Keep orchestration in `packages/core`. A language adapter implements the shared `LanguageAdapter`
port and returns schema-validated findings and graph issues. It must:

- prove SDK symbol or client identity before reporting usage;
- use syntax or semantic structure rather than comments or raw text matches;
- report repository-relative locations and minimal, non-secret evidence;
- derive the migration outcome from locked edges;
- classify ambiguous high-signal patterns with a stable abstention reason;
- preserve deterministic ordering and remain network-free and read-only.

Do not add rule-specific analysis to the CLI, reporters, GitHub Action, or skill. Those surfaces call
the same scan pipeline.

## 5. Add Evidence Fixtures

Add focused fixtures for every declared boundary:

- direct positive usage;
- relevant import and client aliases;
- comments, strings, lookalike clients, and already-migrated negatives;
- wrappers, dynamic values, computed access, or other ambiguous forms that must abstain;
- destination conflicts and missing destinations when the graph behavior changes;
- deliberately broken verification evidence for each behavioral contract.

Tier A needs byte-exact patch and stale-plan tests. Tier B needs exact revision, preimage, scope,
trusted verifier, and behavior-input binding tests. Tier C needs proof that no edit or automatic
transformation occurs. Synthetic fixture measurements are not a public benchmark claim.

## 6. Verify The Rule

Run the complete repository gate:

```bash
corepack pnpm python:lock:check
corepack pnpm python:sync
corepack pnpm python:check
corepack pnpm build
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
```

Then generate a report bundle from the positive fixture into a new directory outside the
repository and inspect all four outputs:

```bash
REPORT_PARENT="$(mktemp -d)"
corepack pnpm run doctor report fixtures/<language>/<positive-fixture> \
  --output "$REPORT_PARENT/report"
```

Confirm Markdown, JSON, SARIF, and HTML agree on locations, severity, source links, review status,
and abstentions. Update the rule matrix, methodology, limitations, and coverage claims with measured
results only.

## Review Checklist

- Official source bytes and reviewed claims are reproducible.
- Source and migration artifacts are schema-valid and locked by exact hash.
- Positive, negative, ambiguous, stale, and conflict cases are tested as applicable.
- The declared automation tier matches the actual transformation and verification strength.
- Reports contain no absolute paths, source bodies, secrets, or volatile telemetry.
- Unsupported patterns abstain instead of silently broadening coverage.
- The target repository is unchanged after scan, plan, report, migrate preview, and verify.
