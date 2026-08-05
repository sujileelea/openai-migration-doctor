# Architecture

Migration Doctor currently implements one deterministic TypeScript migration vertical slice.

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
4. `createPatchPlan` independently resolves the locked path, then freezes finding IDs, file hashes, exact offsets, expected text, and the terminal replacement.
5. `createPatchPreview` rejects stale or overlapping edits and renders a path-stable diff without writing the source repository. A blocked plan is constrained to zero edits and produces an empty, reportable preview.
6. `verifyPatchPlan` copies the repository to a temporary directory, applies the frozen edits, re-scans the copy, compares file hashes, and confirms the original tree hash is unchanged.
7. Reporters serialize the same normalized result as Markdown or canonical JSON.

## Deterministic output

Canonical reports exclude wall-clock time, temporary paths, filesystem timestamps, and random IDs. Object keys are sorted, arrays are explicitly ordered by domain keys, paths are repository-relative, output uses LF, and every JSON document ends with one newline.

Actual duration and cache state are runtime telemetry. The CLI writes them to stderr so machine-readable stdout remains byte-stable.

Graph paths preserve deterministic traversal order. Evidence sources and parallel edges at each hop use code-unit ordering rather than the host locale. This keeps issue IDs and canonical reports stable across machines.

Reviewed registry artifacts and `migration.lock` use source schema `1.0.0`. Command reports and their nested findings, graph issues, and plans use report schema `2.0.0`; their version lifecycles are intentionally separate.

## Stable edits

Each edit records:

- a stable finding and edit ID;
- repository-relative file path;
- 1-based line and column;
- 0-based UTF-16 offsets used by TypeScript and JavaScript strings;
- original file SHA-256;
- expected and replacement text.

This is sufficient to reject a stale plan and to prove that the verified file bytes equal the planned edit result. It does not prove that model output is behaviorally equivalent.
