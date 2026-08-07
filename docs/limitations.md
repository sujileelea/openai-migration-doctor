# Limitations

Migration Doctor is pre-alpha. It supports one deterministic model-snapshot replacement for
constrained TypeScript and Python subsets and review-only Assistants API analysis for a constrained
TypeScript subset. It also contains a programmatic Codex remediation boundary, but no production
rule or CLI command can invoke it.

## Detection

- TypeScript model and Assistants analysis covers `.ts`, `.tsx`, `.mts`, and `.cts`.
- The TypeScript model-snapshot rule requires a runtime OpenAI import, directly constructed `const`
  client, exact `audio.transcriptions.create` call, inline request, and direct string-literal
  `model` in the same file.
- Assistants analysis recognizes the reviewed method and feature matrix documented in
  [Assistants API TypeScript rule matrix](assistants-rule-matrix.md). It supports renamed imports
  and statically traceable same-file `const` client, namespace, and resource aliases.
- High-signal typed wrappers, detached method aliases, computed or optional access, indirect
  invocation, and dynamic request facets produce Tier C abstentions with stable reason codes.
- Cross-file clients, factories, CommonJS construction, mutable or destructured aliases, untyped
  wrappers, constructor-injected or class-field receivers, namespace imports, dynamic namespace
  selection, JavaScript, and Realtime calls remain silent because OpenAI provenance or the
  deprecated surface cannot be established safely.
- Feature extraction is intentionally literal. Configuration assembled through variables, helper
  calls, spreads, computed keys, or conditionals is not treated as confirmed tool or streaming use.
- Python model analysis covers strict UTF-8 `.py` and `.pyi` files. Invalid UTF-8 and candidate
  parser errors fail closed.
- Python requires an imported `OpenAI` or `AsyncOpenAI` constructor, a direct module- or
  function-scope client assignment with one binding, a later exact
  `client.audio.transcriptions.create` call, and one exact string-literal `model=` keyword.
- Python local `openai.py` and `openai/__init__.py` shadows are skipped conservatively. Reassigned or
  conditional clients, wrappers, indirect clients, dynamic models, starred arguments, and
  non-literal spellings are not detected.
- The Python adapter reads all `.py` and `.pyi` files concurrently before filtering candidates and
  serializes complete candidate sources into one worker request. There is no per-file, aggregate
  byte, file-count, or request-input cap. A very large repository can therefore exhaust parent
  process memory before the worker timeout or 64 MiB output caps apply.
- Python Assistants analysis and JavaScript are not implemented.

These constraints favor precision over recall. In the authored Phase 6 TypeScript corpus, 75
supported and 20 abstention labels had no false positive or false negative. Those exact results
apply only to 120 synthetic instances derived from 42 authored templates; they are not a quality
claim for arbitrary repositories. See the
[immutable ledger](../benchmarks/results/typescript-macos-arm64-6411e60.json).

## Transformation and verification

- `migrate` is preview-only and cannot apply a patch to the source repository.
- Every Assistants finding is Tier C and produces no source edit. The plan records source-backed
  manual actions targeting Responses and, conditionally, Conversations.
- `verify` uses a temporary directory copy, not a Git worktree.
- A blocked analysis-only verification proves that no automatic transformation occurred and the
  original repository stayed unchanged; it deliberately fails `manual_migration_resolved`.
- `verify-behavior` compares supplied JSON observations only. It does not run the source or target
  integration, discover tests, capture SDK events, or establish that a repository emitted the
  observations.
- Offline text and stream payload checks compare JSON shape rather than semantic value equality.
  Conversation identity, linkage, order, and normalized metadata, tool arguments, retry metadata,
  and exact changed paths are compared deterministically.
- Changed-file behavioral contracts accept exact relative POSIX paths only; glob patterns and
  rename inference are not implemented.
- A behavior observation represents one logical retry invocation per operation name. Representing
  repeated independent invocations of the same operation requires separate observations; an
  invocation ID is not yet modeled.
- Repository build, typecheck, lint, unit tests, and integration tests are not discovered or executed.
- No audio or live application corpus is executed, so repository runtime behavior remains
  unverified even when an offline fixture contract passes.
- SDK version compatibility is not inferred. Post-patch repository checks will be required before
  that claim is possible.
- The TypeScript content-hash cache is process-local. It is not a persistent cross-run or
  distributed cache.
- The published 1,000,000-line performance sample is synthetic and machine-specific. Its 0 observed
  Node.js HTTP requests cover only instrumented Node HTTP clients and do not prove total egress.
- Python performance evidence uses a separate `adapter-smoke` ledger; it does not establish a
  cross-language benchmark or arbitrary-repository throughput.

## Codex adapter

- Current locked rules remain unchanged: the model rule is Tier A and all Assistants findings are
  Tier C, so no CLI flow produces `requiresCodex: true`. Core now provides
  `createSemanticPatchPlan` for revision-backed, supported Tier B scans, but no current rule or CLI
  route calls it.
- The adapter requires a top-level Git repository whose index equals HEAD, existing tracked UTF-8
  files, exact Codex CLI `0.146.0`, an operator-pinned launcher SHA-256, and an explicit single-run
  `CODEX_API_KEY`. Unstaged and untracked worktree changes are allowed but ignored because every
  input is read from the frozen commit; the audit proves revision and index stability, not full
  worktree stability. Fresh OS and Codex homes are created for every run; saved authentication is
  neither read nor supported.
- File creation, deletion, rename, symlinks, non-regular files, binaries, files larger than 2 MiB,
  total exposed content larger than 10 MiB, sensitive path classes, and high-confidence credential
  formats are rejected. The initial schema supports at most 64 exposed files, 4,096 filesystem
  entries, 32 path segments, and portable path names.
- The model workspace contains only frozen exposed files and no Git metadata. Verification exports
  all regular blobs from the exact commit into a separate standalone snapshot. Repositories with a
  tracked symbolic link are rejected by this conservative exporter.
- Repository verification is static only. The adapter supports its built-in TypeScript analyzer and
  one trusted transcription-model exact-rewrite verifier; it accepts no caller-selected adapter or
  repository verdict. It executes no build, typecheck, test, package script, repository binary, or
  generated candidate code.
- The behavior proof remains `offline-fixture` evidence with `liveApiUsed: false`. A successful
  adapter audit compares a caller-supplied candidate observation and does not establish that the
  candidate repository produced it. Runtime and live-API parity remain unverified.
- Model tool network is disabled, but the Codex controller requires network access to send the
  exposed source and prompt to the OpenAI API. The subprocess contains the single-run API key.
  Current automated tests use fake executable fixtures rather than a live authenticated request.
- The runner rejects the documented system, managed, MDM, and administrator skill layers before a
  run. A privileged local actor can race that preflight, and an unmodeled future configuration layer
  requires a new exact-version review. The audit field is named `requestedSandboxPolicy` because a
  failed run does not prove that every requested control took effect.
- The Codex CLI launcher, its interpreter and dependent resources, OS sandbox implementation, Git,
  Node.js, core planner, and built-in TypeScript analyzer are trusted. The audit hashes the resolved
  launcher file and requires it to match the caller's independent pin, but it does not hash the
  interpreter or dependency closure, authenticate that pin against an OpenAI release manifest, or
  attest the serving model. `requestedModel` records only the CLI request.
- The adapter accepts only the branded registry object returned by `loadMigrationRegistry`, reads
  each field once into a schema-validated snapshot, and rejects post-load mutation by canonical
  integrity hash. The loader verifies schemas and artifact hashes, but the checked-in
  `migration.lock` is unsigned and remains a repository trust anchor.
- Path handling rejects symlink ancestors and uses `O_NOFOLLOW` for leaf access, but Node does not
  expose an `openat`-style API for a single race-free component walk. The source repository and
  temporary workspaces must not be modified concurrently by an adversarial local process.
- The exact-revision exporter caps each Git subprocess at 64 MiB and rejects non-UTF-8 Git paths,
  tracked symlinks, submodules, and non-regular Git modes. Fixed Git options suppress local
  fsmonitor, hooks, replacement objects, global/system configuration, lazy fetch, and attributes;
  unusual Git implementations outside the tested command contract are not supported.
- An unexpected workspace path is omitted from the audit for privacy. Complete snapshots bind it
  inside an opaque before/after workspace hash; an incomplete oversized snapshot records no after
  commitment and always fails.
- Audit objects are available through the package API only. They do not yet have a CLI command,
  saved-file workflow, Markdown reporter, cost estimate, or public rule fixture.

## Sources and reports

- The production lock contains five dated source records and two reviewed migration edges: one
  model snapshot replacement and one Assistants-to-Responses-and-Conversations product edge.
  Chained destinations, same-target source aggregation, conflicts, missing destinations, and cycles
  are implemented and covered with clearly synthetic graph fixtures.
- SDK constraint strings are not treated as repository evidence. Until package/version/location proofs are structured and validated, any relevant constrained edge causes an `unverified-constraint` abstention.
- Graph diagnostics are currently emitted only for resource families evaluated by an installed language adapter; there is no repository-wide rule-independent graph audit command yet.
- Source refresh is manual.
- Markdown, canonical JSON, SARIF 2.1.0, and script-free static HTML are implemented for pipeline
  reports. `report` saves all four only to a new directory outside the scanned repository.
- SARIF contains source locations and official source links for supported findings, but code-host
  presentation depends on the host's SARIF subset and upload permissions. HTML is a local static
  view, not an interactive dashboard.
- SARIF shape and determinism have focused tests, and GitHub CodeQL accepted the upload in the
  [first hosted workflow run](https://github.com/sujileelea/openai-migration-doctor/actions/runs/31159576201).
  A separate official SARIF schema-validator suite is not installed.
- Report publication resolves the target and output parent before its containment and no-replace
  checks. A malicious same-user process can replace a path component between those operations; Node
  does not provide the directory-descriptor `openat` primitives needed to close that TOCTOU window.
  Normal concurrent publishers are tested and only one can claim the destination.
- The composite GitHub Action supports GitHub-hosted Linux and macOS with Bash, Node.js, Python, uv,
  and Corepack setup. It deliberately surfaces finding exit `1` as an output before a calling
  workflow chooses whether to fail; errors `2` through `5` fail the action.
- The action shell runner, including its no-`.git` packaged-entry fallback, is tested locally. The
  composite wrapper, runtime setup, SARIF upload, and artifact upload also passed on GitHub-hosted
  Ubuntu at commit `321bf81810a7ac9fd849513fe94e7eb6ca4c0e6a`; a hosted macOS run remains
  untested.
- Runtime telemetry is written to stderr and is not part of the canonical report.
- Phase 4 structural fields reject unknown keys and report-unsafe identifiers. Arbitrary JSON
  payload keys remain supported except an own `__proto__` key, which is rejected at any depth
  before schema parsing can discard it ambiguously. Own `constructor` and `prototype` keys remain
  supported and are included in canonical input hashes.

## Distribution

- The package is not published.
- License selection is pending.
- The composite GitHub Action and checked-in `migration-audit` Codex skill build from committed
  source in temporary directories; they are not a package-registry distribution.
- Optional plugin packaging is not implemented because the current skill and action cover the
  validated workflows without a distinct plugin packaging benefit.
- Production Codex-assisted rules and CLI orchestration remain unimplemented.
