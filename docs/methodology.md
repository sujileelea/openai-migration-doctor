# Methodology

## Source provenance

The first rule was reviewed on 2026-08-05 against two official OpenAI pages:

- [API deprecations](https://developers.openai.com/api/docs/deprecations)
- [GPT-4o mini Transcribe](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)

The raw Markdown SHA-256 values, retrieval timestamp, claims, migration mapping, and local artifact hashes are pinned by `migration.lock`. A changed or missing artifact fails before repository analysis.

The locked mapping is:

```text
gpt-4o-mini-transcribe-2025-03-20
  -> gpt-4o-mini-transcribe-2025-12-15
```

The deprecation was announced on 2026-07-20 and the source snapshot is scheduled to shut down on 2027-01-20.

## Automation boundary

Tier A applies only when the TypeScript AST proves all of the following:

1. `OpenAI` was imported from `openai` in the same file.
2. A local client was directly constructed with that import.
3. The call path is exactly `client.audio.transcriptions.create(...)`.
4. The first argument is an object literal.
5. `model` is a direct property whose value is the exact deprecated string literal.

The edit replaces only the characters inside that literal. It preserves quote style, comments, whitespace, and every unrelated occurrence.

## Current fixtures

- direct positive API usage with a nearby duplicate string;
- comment-only occurrence;
- unrelated object with the same `model` value;
- a fake client that shadows the real OpenAI client identifier;
- already-migrated API usage.

The automated suite also covers locked-artifact tampering, parser failure, stale plans, absolute-root independence, Markdown and JSON agreement, original-tree immutability, and CLI exit codes.

## Claims boundary

Passing verification means the patch mechanics satisfy the declared deterministic contracts. It does not mean transcription quality, latency, token use, cost, or application behavior has been preserved. Those claims require a representative audio corpus and repository-specific checks.
