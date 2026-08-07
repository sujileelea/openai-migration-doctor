# Methodology

## Source provenance

The first rule was reviewed on 2026-08-05 against two official OpenAI pages:

- [API deprecations](https://developers.openai.com/api/docs/deprecations)
- [GPT-4o mini Transcribe](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)

Each source record stores the SHA-256 of the exact bytes returned by the official
`.md` endpoint, along with its retrieval timestamp and reviewed claims.
`migration.lock` separately pins the checked-in source-record and migration-edge
files. A changed or missing local artifact fails before repository analysis.

Raw documentation bodies are not committed. The project license covers project-authored material,
not upstream documentation bodies; the [provenance policy](provenance.md) keeps source evidence to
reviewed claims, canonical URLs, retrieval times, and content hashes. While upstream content is
unchanged, reviewers can reproduce the recorded raw hashes with:

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

For JavaScript and TypeScript, Tier A applies only when the compiler API proves all of the following:

1. `OpenAI` was imported from `openai` or constructed through a reviewed CommonJS
   `require("openai")` form in the same file.
2. A local client was directly constructed with that import.
3. The call path is exactly `client.audio.transcriptions.create(...)`.
4. The first argument is an object literal.
5. `model` is a direct property whose value is the exact deprecated string literal.

The edit replaces only the characters inside that literal. It preserves quote style, comments, whitespace, and every unrelated occurrence.

For Python, Tier A applies only to strict UTF-8 `.py` and `.pyi` files when LibCST proves all of the
following:

1. `OpenAI` or `AsyncOpenAI` resolves to an import from `openai`.
2. A client name is assigned directly from that constructor at module or function scope.
3. The client has one binding, is not reassigned, and is constructed before the call.
4. The call path is exactly `client.audio.transcriptions.create(...)`.
5. The call has one explicit `model=` keyword whose value is the exact deprecated string literal.

A candidate beneath a local `openai.py` or `openai/__init__.py` is skipped conservatively because
the external SDK import cannot be proved. Conditional clients, wrappers, aliases, dynamic model
values, and starred arguments are unsupported. LibCST rewrites only the matched literal and tests
require formatting, comments, BOM state, newline style, and UTF-16 source offsets to remain
correct. The same worker inventories reviewed direct Python Assistants calls as Tier C without
transforming them.

## Assistants analysis boundary

The JavaScript and TypeScript analyzers require an exact `openai` import or reviewed CommonJS
constructor and either a same-file directly constructed `const` client or an explicitly typed
wrapper parameter. They match only reviewed
Assistants, Threads, Messages, Runs, and Run Steps methods. Direct and statically traceable `const`
client or resource aliases are supported; typed wrappers, detached methods, computed or optional
members, and indirect invocation abstain. Request-derived facets require literal inline evidence.
The Python analyzer requires an imported direct client assignment; it abstains on proven dynamic
facets and unsupported methods while leaving unproven aliases and cross-file receivers silent.

Every confirmed or abstained Assistants result is Tier C with no remediation. Evidence is the
callee expression only. Planning resolves the locked product target and repeats its behavior
changes in a manual action; migration preview remains empty. Blocked verification proves only that
no automatic transformation occurred and that the original repository is unchanged.

The declared synthetic Phase 3 threshold is at least 99% precision and 95% recall on the supported
subset, with exact routing for labeled high-signal abstentions. The current authored corpus measures
19 true positives, 0 false positives, and 0 false negatives, for 100% precision and 100% recall. All
13 labeled abstentions route exactly. A separate 34-call allowlist fixture produces 58 expected
atomic feature findings. These are historical Phase 3 fixture measurements; the broader authored
Phase 6 benchmark and its claims boundary are recorded below.

## Current fixtures

- direct positive API usage with a nearby duplicate string;
- comment-only occurrence;
- unrelated object with the same `model` value;
- a fake client that shadows the real OpenAI client identifier;
- mutable or reassigned client bindings and use before construction;
- spread, duplicate, and computed request properties;
- already-migrated API usage;
- direct Assistants, Threads, Messages, Runs, Run Steps, streaming, tools, file search, and code
  interpreter usage;
- runtime import, client, namespace, and resource aliases;
- typed wrappers, wrapper-derived aliases, detached methods, computed and optional access, indirect
  invocation, and dynamic streaming or tool configuration;
- Assistants negative controls covering comments, strings, lookalike clients, type-only
  construction, Responses tools, standalone tool configuration, and `purpose: "assistants"`;
- Python direct, aliased-import, module-import, async-client, formatting, BOM, and astral-offset
  positives, plus reassigned, conditional, shadowed, dynamic-model, unrelated-property, local
  module-shadow, and already-migrated controls.

The automated suite also covers locked-artifact tampering, parser failure, stale plans, absolute-root independence, Markdown and JSON agreement, original-tree immutability, and CLI exit codes.

Five `example.invalid` graph fixtures exercise a deprecated intermediate destination, conflicting destinations, a cycle, missing guidance, and an SDK constraint without structured repository evidence. They are explicitly synthetic and make no claim about an OpenAI product. Conflict integration tests require a Tier C finding, preserve both source records, and prove that no patch is planned.

## Phase 6 benchmark

The Phase 6 corpus is generated from 42 independently authored TypeScript templates into 120
synthetic fixture instances. Labels cover the complete declared finding contract, including
location, evidence, rule and resource identities, graph edges, tier, disposition, reason code, and
remediation. Of 95 expected findings, supported cases measured 75 true positives, 0 false
positives, and 0 false negatives; abstentions measured 20 true positives, 0 false positives, and 0
false negatives. These figures apply only to the checked-in authored corpus and do not predict
quality on arbitrary public repositories.

The performance corpus is generated separately as 1,000 TypeScript files containing exactly
1,000,000 lines. Twenty files contain analyzer candidates. A cold scan populates the process-local
content-hash cache; the warm incremental scan changes one file and expects 999 cache hits. On Apple
M3 Max, Darwin arm64, and Node.js 22.18.0, clean commit
[`6411e60d987fedf8988dc0ace5f20c6c8ab27482`](https://github.com/sujileelea/openai-migration-doctor/commit/6411e60d987fedf8988dc0ace5f20c6c8ab27482)
measured 197.68 ms cold and 81.44 ms warm, with peak RSS of 405,536,768 and 498,466,816 bytes.
The immutable [ledger](../benchmarks/results/typescript-macos-arm64-6411e60.json) binds the corpus,
source lock, environment, clean revision, metrics, and budget outcomes.

Both scans observed 0 requests on the instrumented Node.js `undici:request:create` and
`http.client.request.start` diagnostics channels. A deliberate local HTTP test validates that the
observer counts Node requests. This evidence is narrower than a total egress proof: it does not
observe other processes, native libraries, alternate network stacks, or host traffic.

Python uses a separate `adapter-smoke` measurement ledger. Clean commit
[`757ceaa04c8ca2b2965f341e39e3bffbbc5e96e0`](https://github.com/sujileelea/openai-migration-doctor/commit/757ceaa04c8ca2b2965f341e39e3bffbbc5e96e0)
measured one 259-byte candidate file in three isolated worker processes: 192.364 ms, 107.067 ms,
and 105.420 ms, with worker peak RSS of 36,012,032, 35,700,736, and 35,749,888 bytes. The
environment was Apple M3 Max, Darwin arm64, Node.js 22.18.0, Python 3.13.11, and LibCST 1.9.0. The
[ledger](../packages/language-python/performance-results/python-macos-arm64-757ceaa.json) also binds
the corpus hash, migration-edge hash, tool revision, and clean-worktree state. It is not scored as
the TypeScript authored corpus and is not a public cross-language quality benchmark.

## Report derivation

Markdown, canonical JSON, SARIF 2.1.0, and static HTML are derived from the same normalized report
object. The CLI `report` command scans once, claims a new external mode-0700 destination, and renders
each format sequentially into a mode-0600 file opened with `O_EXCL`. File-descriptor identity, size,
and SHA-256 checks bind successful publication to the bytes that were written. A pre-existing
destination, a location inside the target, or an incomplete write fails without reporting the
bundle as complete. Failure performs no pathname deletion and can leave partial artifacts because
non-destructive cleanup cannot be guaranteed against path replacement. The GitHub Action and
checked-in audit skill invoke this command through isolated temporary builds; they do not add
detection logic.

## Offline behavioral contracts

Phase 4 uses a checked-in Assistants-to-Responses fixture family rather than a live API. A
versioned contract identifies the locked product migration edge and declares exact allowed and
required changed paths. Baseline and candidate observations share a scenario ID and record six
normalized evidence families:

1. text output JSON shape;
2. exact normalized conversation item identity, linkage, metadata, and order;
3. streaming event type, item linkage, payload shape, and order;
4. tool name, call order, and exact JSON arguments;
5. one logical invocation per operation, with attempt number, outcome, error code, retryability,
   and order;
6. candidate changed paths against the allowlist and required set.

Event types, item keys, and retry operation keys use product-neutral semantic labels. The baseline
therefore represents normalized Assistants behavior rather than pretending that it emitted raw
Responses events.

The compatible candidate changes synthetic primitive output values while preserving their shapes,
which prevents fixture equality from masquerading as a behavioral contract. Six negative
candidates each break one evidence family. Tests require exactly the named check to fail while the
other five pass, and require evidence to identify a structural path or changed path. Reports hash
the canonical contract and both observations, select their migration edges from the validated
source lock, exclude volatile timing, and state `offline-fixture` and `liveApiUsed: false`.

This method proves that the comparator detects declared fixture regressions. It does not prove that
the fixture represents an arbitrary application, that either integration produced the observation,
or that model meaning, latency, token use, or cost was preserved.

## Codex remediation boundary

Phase 5 reviewed the official [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk),
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), and
[sandbox and approval guidance](https://learn.chatgpt.com/docs/agent-approvals-security), including
the [permission profile](https://learn.chatgpt.com/docs/permissions) and configuration precedence
references, on 2026-08-06. These pages constrain adapter execution rather than define an OpenAI API
migration edge, so they are not added to `migration.lock` or represented as product-rule evidence.

The SDK did not expose every reviewed CLI isolation switch, so the adapter invokes `codex exec`
directly. It requires the exact release output `codex-cli 0.146.0`, rejects prerelease or build
suffixes, resolves one absolute executable, and requires its SHA-256 to match an independently
trusted operator pin before version preflight. It rechecks the same bytes after preflight and around
execution. A local preflight with a dummy credential confirmed that the complete override vector
passed `--strict-config` on that release and reached controller connection; no authenticated model
response was used.

A semantic plan is built only from supported, unambiguous Tier B findings. It uses an independent
schema and freezes the full Git revision, canonical source preimage hashes, required and forbidden
paths, the complete selected migration-edge record hash, behavior input hashes, bounded
instructions, the internal adapter ID, and a rule-specific verifier with source and target models.
Before manifest creation and again before execution, the adapter exports the frozen revision,
re-scans it with the built-in TypeScript adapter, recreates the plan through
`createSemanticPatchPlan`, and requires canonical equality. Handcrafted plans that change the rule,
finding IDs, automation tier, review requirement, edge endpoint, or semantic verifier fail before a
model run. Only the branded object returned by `loadMigrationRegistry` is accepted. The adapter
reads it once into a schema-validated snapshot and requires that snapshot to retain the canonical
integrity hash recorded at load time. The loader validates locked artifact hashes, while the
unsigned `migration.lock` remains a repository trust input. Existing Tier A report serialization
remains unchanged.

Every run creates fresh mode-0700 OS and Codex homes. Only an explicit single-run `CODEX_API_KEY`
crosses the authentication boundary; ambient homes, credentials, rules, and environment secrets do
not. The runner rejects known system configuration, managed configuration, managed requirements,
macOS MDM values, and administrator skill directories. It disables project instructions, user
configuration, reviewed bundled skills, persistence, hooks, MCP, apps, plugins, browser and
computer use, shell and JavaScript execution, web search, and shell-environment inheritance. The
permission profile denies host-root reads, temporary roots, and model tool network while allowing
the controller to contact the OpenAI API. Any non-reasoning, non-file-change, non-message item fails
closed.

The proposal workspace contains only tracked regular UTF-8 blobs read from the exact commit. The
Git index must equal HEAD; unstaged worktree changes are permitted but ignored. Fixed Git overrides
disable local fsmonitor execution, hooks, replacement objects, global and system configuration,
lazy fetch, and attribute-based behavior. The model's structured response declares status, plan
hash, and changed paths, but actual workspace bytes are the proposal. Snapshot limits, portable
path rules, credential screening, and no-follow file access reject creation, deletion, rename,
symlink, special, binary, oversized, or unexpected content.

Accepted bytes are copied to a standalone export of the frozen Git tree with no linked metadata.
The internal scanner must remove the findings, and the trusted semantic verifier independently
constructs the only acceptable candidate by replacing the bound transcription model literals in
the original bytes. Source and target model IDs must also satisfy the stable identifier grammar, so
they cannot escape the bound string literal. The candidate must equal those expected bytes exactly,
preventing syntax-valid deletion, property injection, or unrelated edits from becoming the
verification oracle. No repository build, test, script, binary, or generated candidate code is
executed. The separately declared candidate observation is still only caller-supplied offline
fixture evidence and always records repository runtime behavior as unverified.

The redacted audit hashes the manifest, structured proposal, allowed-file patch, repository check,
behavior fixture report, and executed CLI launcher. Complete snapshots also commit to canonical
before and after path/hash/directory state, including rejected unexpected entries, without exposing
their names. Audits record expected paths, stable outcomes, token counts, requested model, CLI
version, requested and observed executable hashes, and requested sandbox policy. The final
repository contract is `original_repository_revision_unchanged`: it binds HEAD and the index, not
ignored unstaged or untracked worktree bytes. Raw JSONL, thread IDs, prompts, responses, commands,
source or candidate bodies, unexpected paths, fixture values, absolute paths, and timestamps are
excluded. A requested policy in a failed audit is not a claim that every requested control was
enforced before failure.

Twenty-six adapter tests use executable fixtures and a real TypeScript Tier B re-scan. They cover
the passing path; provenance replay; forged targets and tiers; revision, edge, preimage, and task
binding; source deletion and destructive valid syntax; scope and snapshot expansion; tool events;
symlinks; portable paths; credentials; exact Git blobs; local fsmonitor and replacement objects;
structured-output failures; redaction commitments; exact CLI arguments and version; executable
pin mismatches and identity changes; immutable runner dispatch; clean abstention; and malformed
JSONL. They prove local orchestration and rejection logic, not
authenticated model quality, serving-model identity, operating-system parity, repository runtime
behavior, or live OpenAI API compatibility.

## Claims boundary

Passing deterministic edit verification means the patch mechanics satisfy the declared contracts.
An Assistants analysis-only verification intentionally does not pass while manual actions remain.
Passing offline behavioral verification means only that the supplied normalized observations
satisfy the checked-in contract. None of these results alone proves transcription quality,
repository runtime behavior, latency, token use, or cost. Those claims require representative
application instrumentation and repository-specific checks.
