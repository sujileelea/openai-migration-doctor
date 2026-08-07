# Architecture

Migration Doctor implements one deterministic TypeScript and Python model migration, a review-only
TypeScript Assistants API analysis slice, an offline behavioral contract verifier, four report
formats, and a removable Codex remediation adapter boundary.

## Dependency direction

```text
core <- language-typescript
core <- language-python -> LibCST worker
core <- reporters
core + language-typescript <- codex-adapter
core + language-typescript + language-python + reporters <- cli
```

`packages/core` owns schemas, source-lock validation, orchestration ports, patch planning, patch
preview, and verification. It does not import a language adapter, reporter, CLI, or Codex
implementation. `packages/codex-adapter` imports core contracts and the trusted TypeScript analyzer,
while neither core nor the CLI imports the adapter. Removing the package therefore leaves scan and
deterministic plan behavior unchanged. `packages/language-python` is a Node adapter that invokes an
exact-locked Python worker; the Python process does not own graph resolution, planning, report
schemas, or verification policy.

## Pipeline

1. `loadMigrationRegistry` validates every `migration.lock` artifact hash, unique record ID, and
   complete source reference, then brands the returned registry with its canonical integrity hash.
   Codex entry points read each branded registry field once into a schema-validated snapshot and
   reject it unless that snapshot retains the loaded hash. The lock file is a checked-in trust
   anchor, not a signed provenance statement.
2. `resolveMigrationPath` follows same-language unconstrained edges, aggregates agreeing sources, and records conflicts, missing destinations, cycles, or unverified SDK constraints without selecting a speculative target.
3. `scanRepository` invokes the registered TypeScript and Python language adapters and normalizes
   findings and graph issues to relative POSIX paths.
4. `createPatchPlan` independently resolves the locked path, then freezes either exact edits or
   source-backed manual actions containing the terminal target, reason code, and behavior changes.
5. `createPatchPreview` rejects stale or overlapping edits and renders a path-stable diff without writing the source repository. A blocked plan is constrained to zero edits and produces an empty, reportable preview.
6. `verifyPatchPlan` verifies blocked plans without applying anything. For ready plans, it copies
   the repository to a temporary directory, applies frozen edits, re-scans the copy, compares file
   hashes, and confirms the original tree hash is unchanged.
7. Reporters serialize the same normalized result as Markdown, canonical JSON, SARIF 2.1.0, or
   script-free static HTML. The CLI `report` command scans once, stages all four files, claims a new
   bundle directory outside the scanned repository, and removes partial output if publication
   fails.

`verifyBehaviorContract` is a separate, repository-independent path. It validates a versioned
contract plus baseline and candidate observations, selects the referenced edges from the locked
migration registry, and evaluates six fixed checks in stable order. It never runs either
application, synthesizes observations, or calls an external API. The resulting report records
`offline-fixture` evidence and `liveApiUsed: false` so it cannot be confused with runtime proof.

The optional Codex path begins only with a `ready` Tier B plan created by
`createSemanticPatchPlan`. The independent semantic plan freezes the full Git revision, exact
source preimage hashes, required and forbidden paths, instructions, complete selected edge-record
hash, behavior input hashes, built-in verification adapter ID, and rule-specific semantic verifier.
Before manifest creation and again before execution, the adapter exports the exact revision,
re-scans it with the built-in TypeScript adapter, reconstructs the plan, and requires canonical
equality. This rejects handcrafted plans that alter a finding, tier, edge endpoint, or verifier.
Existing Tier A report serialization is unchanged. Current locked rules do not produce a Tier B
plan.

Codex sees a mode-0700 temporary directory containing only the exposed regular UTF-8 files. It is
not a Git repository and contains no `AGENTS.md`, `.codex`, hooks, or other ambient instruction
surface. Because the shell is disabled, the prompt includes the frozen source bodies as canonical
JSON and labels them untrusted data. Actual workspace bytes, not the response narrative, remain the
proposal source.

The runner wraps [`codex exec`](https://learn.chatgpt.com/docs/non-interactive-mode) directly and
accepts exactly Codex CLI `0.146.0`. It resolves one absolute executable, requires its SHA-256 to
match an operator-pinned value before version preflight, rechecks it around execution, and rejects
prerelease suffixes. Its prototype dispatch is frozen and the adapter accepts only the exact
reviewed runner instance. Every run creates fresh OS and Codex homes, accepts only a single-run
`CODEX_API_KEY`, rejects known system, managed, MDM, and administrator skill layers, and fixes
`--strict-config`, `--ephemeral`,
`--ignore-user-config`, and `--ignore-rules`. A named permission profile denies the host root,
permits only minimal runtime reads and workspace writes, denies temporary roots and model tool
network, and uses approval `never`. The OpenAI controller connection remains required. Shell,
unified execution, code mode, JavaScript execution, apps, plugins, browser and computer use, MCP,
hooks, reviewed bundled skills, project instructions, user configuration, web search, and shell
environment inheritance are disabled or rejected. Unexpected item types fail closed.

The adapter treats workspace bytes, not the model's description, as the proposal. It rejects new,
deleted, forbidden, stale, symlinked, special, binary, oversized, or likely credential-bearing
content. A strict structured response must name the exact changed files and frozen plan hash.
Any event outside reasoning, file change, and final message fails the tool-policy check. Accepted
bytes are applied to a standalone snapshot exported from the exact frozen Git revision; it has no
linked `.git` metadata. The adapter re-scans with its internal analyzer and also requires the
rule-specific verifier to prove that candidate bytes equal the exact expected source-to-target
model rewrite. It executes no repository code and accepts no caller repository verdict. The offline
candidate observation remains caller-supplied fixture evidence and never sets runtime behavior
verified. HEAD and the Git index must remain bound to the frozen revision; unstaged worktree bytes
are ignored. The corresponding contract is named `original_repository_revision_unchanged`; it is
not a claim about ignored worktree bytes. Malformed JSONL and incomplete structured responses return
a redacted failed-attempt audit instead of discarding the ledger.

## Python worker boundary

The Python adapter enumerates `.py` and `.pyi` through the same repository file boundary as the
TypeScript adapter, decodes bytes as strict UTF-8, and prefilters only files containing the exact
source model. Invalid UTF-8 and candidate parse failures stop analysis. A local `openai.py` or
`openai/__init__.py` on a candidate's import path causes a conservative skip because external SDK
identity cannot be established safely. Enumeration retains at most 4,096 matching paths, files are
read sequentially with a 2 MiB per-file limit, and source-model candidates are bounded to 256 files
and 16 MiB before shadow exclusions.

Candidate source is sent as a JSON request to LibCST 1.9.0 in
`packages/language-python/.venv`. The Node bridge requires absolute interpreter and worker paths,
starts Python with `-I -X utf8`, supplies no ambient environment on macOS or Linux, preserves only
the Windows system-root variables required to start the interpreter, caps stdout and stderr, and
enforces a timeout. Direct scan and rewrite calls apply the same content limits and preflight the
exact serialized request against a 64 MiB input cap before JSON construction. Both responses must
report the exact LibCST version and match the requested file set and order.

LibCST's qualified-name and scope metadata confirms an imported `OpenAI` or `AsyncOpenAI`
constructor, a direct module- or function-scope client assignment, and a later exact
`client.audio.transcriptions.create(model="...")` keyword literal. Reassignments, conditional
construction, shadowed imports, dynamic models, and indirect clients remain outside the supported
boundary. Rewrites replace only the matched literal while LibCST preserves syntax, formatting,
comments, BOM state, and terminal newline style. LibCST code-point positions are converted to the
core contract's UTF-16 offsets, including lines containing astral code points.

## Developer surfaces

The CLI, composite GitHub Action, and checked-in `migration-audit` skill call the same core scan and
report pipeline; none reimplements detection in prompts or workflow shell. The action and skill
build a committed tool snapshot in a private temporary directory, install the frozen pnpm and uv
dependency sets there, and leave the target repository read-only. Their saved report destination is
also outside the target. Optional plugin packaging is not implemented because it currently adds no
distinct packaging value beyond those two surfaces.

## Deterministic output

Canonical reports exclude wall-clock time, temporary paths, filesystem timestamps, and random IDs. Object keys are sorted, arrays are explicitly ordered by domain keys, paths are repository-relative, output uses LF, and every JSON document ends with one newline.

Actual duration and cache state are runtime telemetry. The CLI writes them to stderr so
machine-readable stdout remains byte-stable. The TypeScript content-hash cache is process-local and
is not encoded into a canonical report. Python adapter-smoke performance ledgers are a separate,
non-canonical evidence type.

Codex audits use canonical structure, canonical proposal hashes, opaque before/after workspace
commitments, stable reason codes, and redacted evidence. They intentionally include observed token
counts, requested model, requested executable hash, and observed executable identity, so two
independent runs are not claimed to be byte-identical. The requested sandbox policy is a request
record, not proof that a failed run enforced every field.

Graph paths preserve deterministic traversal order. Evidence sources and parallel edges at each hop use code-unit ordering rather than the host locale. This keeps issue IDs and canonical reports stable across machines.

Reviewed registry artifacts and `migration.lock` use source schema `1.0.0`. Command reports and
their nested findings, graph issues, deterministic plans, and manual actions use report schema
`3.0.0`. Semantic plans use semantic schema `1.0.0`; Codex manifests, structured proposals, and
redacted audits use adapter schema `1.0.0`. Their lifecycles are intentionally separate.

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
- 0-based UTF-16 offsets used by the shared Node.js core contract;
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
