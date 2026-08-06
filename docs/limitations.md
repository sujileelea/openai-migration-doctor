# Limitations

Migration Doctor is pre-alpha. It supports one deterministic model-snapshot replacement and
review-only Assistants API analysis for a constrained TypeScript subset.

## Detection

- TypeScript only: `.ts`, `.tsx`, `.mts`, and `.cts`.
- The model-snapshot rule requires a runtime OpenAI import, directly constructed `const` client,
  exact `audio.transcriptions.create` call, inline request, and direct string-literal `model` in the
  same file.
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

These constraints favor precision over recall. The measured 100% precision and recall values apply
only to the checked-in supported synthetic labels; no public benchmark claim is made.

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
- SDK version compatibility is not inferred. Post-patch repository checks will be required before that claim is possible.

## Sources and reports

- The production lock contains five dated source records and two reviewed migration edges: one
  model snapshot replacement and one Assistants-to-Responses-and-Conversations product edge.
  Chained destinations, same-target source aggregation, conflicts, missing destinations, and cycles
  are implemented and covered with clearly synthetic graph fixtures.
- SDK constraint strings are not treated as repository evidence. Until package/version/location proofs are structured and validated, any relevant constrained edge causes an `unverified-constraint` abstention.
- Graph diagnostics are currently emitted only for resource families evaluated by an installed language adapter; there is no repository-wide rule-independent graph audit command yet.
- Source refresh is manual.
- Canonical JSON and Markdown are implemented for pipeline and offline behavior reports; saved
  report files, SARIF, HTML, and GitHub annotations are not.
- Runtime telemetry is written to stderr and is not part of the canonical report.
- Phase 4 structural fields reject unknown keys and report-unsafe identifiers. Arbitrary JSON
  payload keys remain supported except an own `__proto__` key, which is rejected at any depth
  before schema parsing can discard it ambiguously. Own `constructor` and `prototype` keys remain
  supported and are included in canonical input hashes.

## Distribution

- The package is not published.
- License selection is pending.
- Codex remediation, Python, a public benchmark, a skill, and plugin packaging are not implemented.
