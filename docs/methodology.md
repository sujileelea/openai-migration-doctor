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

## Assistants source provenance

The Phase 3 product review was retrieved on 2026-08-06 at
`2026-08-06T05:59:25Z` and is recorded in three dated source artifacts:

- [`openai-assistants-deprecations-2026-08-06.json`](../data/sources/openai-assistants-deprecations-2026-08-06.json), reviewing [API deprecations](https://developers.openai.com/api/docs/deprecations);
- [`openai-assistants-migration-2026-08-06.json`](../data/sources/openai-assistants-migration-2026-08-06.json), reviewing the [Assistants migration guide](https://developers.openai.com/api/docs/assistants/migration);
- [`openai-prompt-object-migration-2026-08-06.json`](../data/sources/openai-prompt-object-migration-2026-08-06.json), reviewing [Migrate from prompt objects](https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object).

The records hash the exact bytes returned by the corresponding official `.md`
endpoints. Reviewers can reproduce the upstream hashes with:

```bash
curl -fsSL https://developers.openai.com/api/docs/deprecations.md | shasum -a 256
curl -fsSL https://developers.openai.com/api/docs/assistants/migration.md | shasum -a 256
curl -fsSL https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object.md | shasum -a 256
```

Expected hashes for the 2026-08-06 review, in command order, are:

```text
fb7c700f0de0a5354a14d54eb3ae83b6ed3e7df31ed446da9e795163d66a9962
6620f25e6ee958973bc4eaad789ff3f9dc88641c0b69d1166819db5d37ed24e5
3de9c5fe52bbd457a3b2f187aad7c7319a173a6acff35330bcfea77c566b7971
```

The deprecation record states that developers were notified on 2025-08-26 and
that the Assistants API is scheduled to shut down on 2026-08-26. The approved
product mapping is intentionally review-only:

```text
assistants-api
  -> responses-and-conversations
```

The destination label reflects the official recommendation of the Responses
API and Conversations API. Responses is the execution surface. Conversations is
conditional: use it when the application requires durable server-side
conversation state, because the migration guide also states that Responses can
run without a Conversation. OpenAI does not provide an automatic Thread to
Conversation backfill, so existing Thread state requires deliberate migration.

Reusable Prompt objects are excluded from the durable destination. Although the
Assistants migration table presents Prompts as the conceptual replacement for
Assistant configuration, that same guide warns that reusable Prompt objects are
deprecated. The deprecation record dates that change to 2026-06-03 and schedules
`v1/prompts` to shut down on 2026-11-30. The current Prompt migration guide says
to move prompt content into application code and pass generated messages through
Responses input. The locked Tier C plan therefore keeps model selection,
instructions, and tool declarations in application-owned configuration and
requires semantic review of conversation state, streaming, and tool behavior.

## Model automation boundary

Tier A applies only when the TypeScript AST proves all of the following:

1. `OpenAI` was imported from `openai` in the same file.
2. A local client was directly constructed with that import.
3. The call path is exactly `client.audio.transcriptions.create(...)`.
4. The first argument is an object literal.
5. `model` is a direct property whose value is the exact deprecated string literal.

The edit replaces only the characters inside that literal. It preserves quote style, comments, whitespace, and every unrelated occurrence.

## Assistants analysis boundary

The TypeScript analyzer requires an exact `openai` import and either a same-file directly
constructed `const` client or an explicitly typed wrapper parameter. It matches only reviewed
Assistants, Threads, Messages, Runs, and Run Steps methods. Direct and statically traceable `const`
client or resource aliases are supported; typed wrappers, detached methods, computed or optional
members, and indirect invocation abstain. Request-derived facets require literal inline evidence.

Every confirmed or abstained Assistants result is Tier C with no remediation. Evidence is the
callee expression only. Planning resolves the locked product target and repeats its behavior
changes in a manual action; migration preview remains empty. Blocked verification proves only that
no automatic transformation occurred and that the original repository is unchanged.

The declared synthetic Phase 3 threshold is at least 99% precision and 95% recall on the supported
subset, with exact routing for labeled high-signal abstentions. The current authored corpus measures
19 true positives, 0 false positives, and 0 false negatives, for 100% precision and 100% recall. All
13 labeled abstentions route exactly. A separate 34-call allowlist fixture produces 58 expected
atomic feature findings. These measurements are fixture evidence, not the Phase 6 public benchmark.

## Current fixtures

- direct positive API usage with a nearby duplicate string;
- comment-only occurrence;
- unrelated object with the same `model` value;
- a fake client that shadows the real OpenAI client identifier;
- mutable or reassigned client bindings and use before construction;
- spread, duplicate, and computed request properties;
- already-migrated API usage.
- direct Assistants, Threads, Messages, Runs, Run Steps, streaming, tools, file search, and code
  interpreter usage;
- runtime import, client, namespace, and resource aliases;
- typed wrappers, wrapper-derived aliases, detached methods, computed and optional access, indirect
  invocation, and dynamic streaming or tool configuration;
- Assistants negative controls covering comments, strings, lookalike clients, type-only
  construction, Responses tools, standalone tool configuration, and `purpose: "assistants"`.

The automated suite also covers locked-artifact tampering, parser failure, stale plans, absolute-root independence, Markdown and JSON agreement, original-tree immutability, and CLI exit codes.

Five `example.invalid` graph fixtures exercise a deprecated intermediate destination, conflicting destinations, a cycle, missing guidance, and an SDK constraint without structured repository evidence. They are explicitly synthetic and make no claim about an OpenAI product. Conflict integration tests require a Tier C finding, preserve both source records, and prove that no patch is planned.

## Claims boundary

Passing deterministic edit verification means the patch mechanics satisfy the declared contracts.
An Assistants analysis-only verification intentionally does not pass while manual actions remain.
Neither result means transcription quality, conversation state, streaming order, tool behavior,
latency, token use, cost, or application behavior has been preserved. Those claims require
representative behavioral fixtures and repository-specific checks.
