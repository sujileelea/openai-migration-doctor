# Methodology

## Source provenance

The first rule was reviewed on 2026-08-05 against two official OpenAI pages:

- [API deprecations](https://developers.openai.com/api/docs/deprecations)
- [GPT-4o mini Transcribe](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)

Each source record stores the SHA-256 of the exact bytes returned by the official
`.md` endpoint, along with its retrieval timestamp and reviewed claims.
`migration.lock` separately pins the checked-in source-record and migration-edge
files. A changed or missing local artifact fails before repository analysis.

Raw documentation bodies are not committed while the project's license and
provenance policy remain pending. While upstream content is unchanged, reviewers
can reproduce the recorded raw hashes with:

```bash
curl -fsSL https://developers.openai.com/api/docs/deprecations.md | shasum -a 256
curl -fsSL https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe.md | shasum -a 256
```

Expected hashes for this review are:

```text
fb7c700f0de0a5354a14d54eb3ae83b6ed3e7df31ed446da9e795163d66a9962
da0d59ea4a9c17f571f28a3a721ed7e45df6bc7bad283f27378905a7f07cab44
```

A mismatch means the upstream page changed. Reviewers must fetch the new content
to a temporary file, inspect the relevant claims, create a new dated source
record, and update `migration.lock`; they must not overwrite historical records
or accept the new hash without reviewing the mapping.

The locked mapping is:

```text
gpt-4o-mini-transcribe-2025-03-20
  -> gpt-4o-mini-transcribe-2025-12-15
```

The deprecation was announced on 2026-07-20 and the deprecated model snapshot is scheduled to shut down on 2027-01-20.

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
- mutable or reassigned client bindings and use before construction;
- spread, duplicate, and computed request properties;
- already-migrated API usage.

The automated suite also covers locked-artifact tampering, parser failure, stale plans, absolute-root independence, Markdown and JSON agreement, original-tree immutability, and CLI exit codes.

Five `example.invalid` graph fixtures exercise a deprecated intermediate destination, conflicting destinations, a cycle, missing guidance, and an SDK constraint without structured repository evidence. They are explicitly synthetic and make no claim about an OpenAI product. Conflict integration tests require a Tier C finding, preserve both source records, and prove that no patch is planned.

## Claims boundary

Passing verification means the patch mechanics satisfy the declared deterministic contracts. It does not mean transcription quality, latency, token use, cost, or application behavior has been preserved. Those claims require a representative audio corpus and repository-specific checks.
