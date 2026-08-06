# Architecture

Migration Doctor currently implements one deterministic TypeScript model migration, a review-only
Assistants API analysis slice, and an offline behavioral contract verifier.

## Dependency direction

```text
core <- language-typescript
core <- reporters
core + language-typescript + reporters <- cli
```

`packages/core` owns schemas, source-lock validation, orchestration ports, patch planning, patch preview, and verification. It does not import a language adapter, reporter, or CLI implementation. The CLI injects the TypeScript adapter into the core pipeline.

## Pipeline

1. `loadMigrationRegistry` validates every `migration.lock` artifact hash, unique record ID, and complete source reference.
2. `resolveMigrationPath` follows same-language unconstrained edges, aggregates agreeing sources, and records conflicts, missing destinations, cycles, or unverified SDK constraints without selecting a speculative target.
3. `scanRepository` invokes language adapters and normalizes findings and graph issues to relative POSIX paths.
4. `createPatchPlan` independently resolves the locked path, then freezes either exact edits or
   source-backed manual actions containing the terminal target, reason code, and behavior changes.
5. `createPatchPreview` rejects stale or overlapping edits and renders a path-stable diff without writing the source repository. A blocked plan is constrained to zero edits and produces an empty, reportable preview.
6. `verifyPatchPlan` verifies blocked plans without applying anything. For ready plans, it copies
   the repository to a temporary directory, applies frozen edits, re-scans the copy, compares file
   hashes, and confirms the original tree hash is unchanged.
7. Reporters serialize the same normalized result as Markdown or canonical JSON.

`verifyBehaviorContract` is a separate, repository-independent path. It validates a versioned
contract plus baseline and candidate observations, selects the referenced edges from the locked
migration registry, and evaluates six fixed checks in stable order. It never runs either
application, synthesizes observations, or calls an external API. The resulting report records
`offline-fixture` evidence and `liveApiUsed: false` so it cannot be confused with runtime proof.

## Deterministic output

Canonical reports exclude wall-clock time, temporary paths, filesystem timestamps, and random IDs. Object keys are sorted, arrays are explicitly ordered by domain keys, paths are repository-relative, output uses LF, and every JSON document ends with one newline.

Actual duration and cache state are runtime telemetry. The CLI writes them to stderr so machine-readable stdout remains byte-stable.

Graph paths preserve deterministic traversal order. Evidence sources and parallel edges at each hop use code-unit ordering rather than the host locale. This keeps issue IDs and canonical reports stable across machines.

Reviewed registry artifacts and `migration.lock` use source schema `1.0.0`. Command reports and
their nested findings, graph issues, plans, and manual actions use report schema `3.0.0`; their
version lifecycles are intentionally separate.

## Analysis-only plans

Every finding records an analysis family, atomic feature, syntax pattern, support disposition, and
optional stable reason code. Assistants findings are always Tier C with `remediation: none` and
`requiresCodex: false`.

A blocked plan is atomic: `edits` and `allowedFiles` are empty, while `manualActions` preserve the
locked graph destination and every declared behavior change. Its verification contracts are
`manual_migration_resolved`, `no_automatic_transformation`, and
`original_repository_unchanged`. The first remains false until a future user-reviewed migration is
supplied, so a detection-only result cannot be mistaken for a completed migration.

## Stable edits

Each edit records:

- a stable finding and edit ID;
- repository-relative file path;
- 1-based line and column;
- 0-based UTF-16 offsets used by TypeScript and JavaScript strings;
- original file SHA-256;
- expected and replacement text.

This is sufficient to reject a stale plan and to prove that the verified file bytes equal the planned edit result. It does not prove that model output is behaviorally equivalent.

## Offline behavioral observations

Behavior observations normalize only the evidence needed for a contract: JSON output shapes,
conversation items, stream events, tool calls, retry attempts, and changed paths. Text values and
stream payload values are compared by JSON shape. Conversation identity, linkage, order, and
normalized metadata, tool arguments, and retry attempts are compared exactly because they are part
of application control flow. Failure evidence names the mismatched structural path or file path
without reproducing application payload values.

The contract format uses exact relative paths rather than glob expansion. Required paths must also
be allowed. Ordered evidence uses contiguous sequence numbers, making reordering and omission
unambiguous and keeping canonical reports independent of host locale and clock time. Conversation
parents must reference an earlier item. Retry attempts are normalized per operation, begin at one,
increment by one, and stop after success or an explicitly non-retryable error.
