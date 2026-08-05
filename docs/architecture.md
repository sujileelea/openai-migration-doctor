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

1. `loadMigrationRegistry` validates every `migration.lock` artifact hash and source reference.
2. `scanRepository` invokes language adapters and normalizes findings to relative POSIX paths.
3. `createPatchPlan` freezes finding IDs, file hashes, exact offsets, expected text, and replacement text.
4. `createPatchPreview` rejects stale or overlapping edits and renders a path-stable diff without writing the source repository.
5. `verifyPatchPlan` copies the repository to a temporary directory, applies the frozen edits, re-scans the copy, compares file hashes, and confirms the original tree hash is unchanged.
6. Reporters serialize the same normalized result as Markdown or canonical JSON.

## Deterministic output

Canonical reports exclude wall-clock time, temporary paths, filesystem timestamps, and random IDs. Object keys are sorted, arrays are explicitly ordered by domain keys, paths are repository-relative, output uses LF, and every JSON document ends with one newline.

Actual duration and cache state are runtime telemetry. The CLI writes them to stderr so machine-readable stdout remains byte-stable.

## Stable edits

Each edit records:

- a stable finding and edit ID;
- repository-relative file path;
- 1-based line and column;
- 0-based UTF-16 offsets used by TypeScript and JavaScript strings;
- original file SHA-256;
- expected and replacement text.

This is sufficient to reject a stale plan and to prove that the verified file bytes equal the planned edit result. It does not prove that model output is behaviorally equivalent.
