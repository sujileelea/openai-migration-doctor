# Safety

## Current command behavior

- `scan` reads supported source files and never calls a network API.
- `plan` reads findings and locked migration data and never writes the target repository.
- `migrate` emits a preview only. This release has no apply flag.
- `verify` writes only to a temporary repository copy and removes it after the run.
- `verify-behavior` reads local JSON observations only. It does not execute a repository or make a
  network or live API call.

No current command invokes Codex, reads an OpenAI API key, pushes Git changes, creates a pull
request, deploys, or merges. The separately imported `codex-adapter` is an opt-in library surface;
the shipped analyzer and CLI do not route plans into it.

## Fail-closed checks

- Missing, malformed, or hash-mismatched source-lock artifacts stop analysis.
- Duplicate source or migration IDs stop analysis.
- Candidate TypeScript files with parser errors stop analysis instead of being silently skipped.
- A uniquely deprecated destination is followed to its terminal graph target; conflicting destinations, cycles, missing destinations, and unverified SDK constraints prevent deterministic patch generation.
- Source conflicts preserve every involved source, require human review, and never choose a replacement.
- A plan with any abstention is atomic: it contains no partial edits and remains reportable as a blocked result.
- Every Assistants API result is Tier C. It creates a source-backed manual action and never creates
  a text edit, invokes Codex, or claims the migration is resolved.
- Behavioral contract input must pass strict versioned schemas, reference edges present in the
  validated source lock, use the same scenario ID, and contain deterministic ordered evidence.
- A behavioral report passes only when all six fixed checks pass. A failed contract exits with the
  verification failure code and cannot be reported as a successful migration.
- Behavioral reports explicitly distinguish offline fixture evidence from live API evidence.
- Blocked verification uses analysis-only contracts. It records the unresolved manual work,
  verifies that no automatic transformation was previewed, and verifies that the original tree is
  unchanged; it never reports `literal_replacement_only` as a passing Assistants check.
- File hash or expected-text drift invalidates a frozen plan.
- Overlapping edits are rejected.
- Verification compares the complete resulting file hash, not only the changed-file name.
- Symbolic links and generated dependency/build directories are not scanned or copied.
- A Codex semantic plan freezes the full Git revision, exact source preimage hashes, instructions,
  required and forbidden paths, behavior inputs, complete selected edge records, the internal
  adapter ID, and a rule-specific semantic verifier. Manifest creation and execution each reproduce
  that plan from a trusted scan of the exact revision before any model run.
- Codex sees only existing allowlisted UTF-8 files in a standalone temporary directory with no Git
  metadata. Secret paths, ambient `AGENTS.md`, high-confidence credential values, binary input,
  symlinks, special files, and scope or size expansion are rejected.
- The Codex subprocess receives a sanitized environment containing an explicit single-run
  `CODEX_API_KEY` but no ambient authentication or secret variables. Fresh OS and Codex homes are
  created per run. Known system, managed, MDM, and administrator skill layers are rejected; user
  config, project instructions, rules, reviewed bundled skills, plugins, and session persistence are
  disabled or absent.
- The resolved Codex launcher must match an independently trusted SHA-256 before version preflight.
  Its bytes are checked again after preflight and around execution, and runner dispatch is frozen.
- The Codex permission profile denies host-root reads and model tool network and writes only to the
  proposal workspace. The OpenAI controller connection remains enabled so the exposed source can
  be sent to the requested model. Shell, unified execution, code and JavaScript execution, apps,
  plugins, browser and computer use, hooks, MCP, web search, and shell-environment inheritance are
  disabled. Any unexpected tool item still fails the audit.
- Model output is parsed with a strict schema, but the proposal is derived from actual workspace
  bytes. Declared and actual paths must match exactly, and file creation or deletion is rejected.
- Codex never sees the full verification tree. Accepted bytes are copied into a standalone export
  of the exact frozen Git revision with no linked repository metadata. The adapter re-runs its
  internal static analyzer and requires exact equality with the rule-specific expected rewrite.
  Semantic model IDs use a non-escaping stable identifier grammar, preventing quote or property
  injection into that rewrite. The adapter never executes candidate repository code.
- Offline candidate observations are caller-supplied declared fixtures. Their comparison can pass
  `declared_behavior_fixture`, but the audit always records `repositoryRuntimeVerified: false` and
  `runtimeBehaviorVerified: false`.
- Malformed JSONL, runner failure, and incomplete structured output return a redacted failed audit
  after the run starts. Configuration or source-binding failures reject before model execution.

## Evidence minimization

Reports contain the deprecated model literal or Assistants callee expression, repository-relative
location, source links, and hashes needed to audit a finding. Assistants evidence stops before call
arguments, so instructions, messages, tool arguments, and request configuration are not copied into
the report. Reports exclude absolute repository paths, temporary paths, source-file contents,
environment values, and raw transcripts.

The current model identifier and SDK callee evidence are not secret. Future rules that need request
content must add explicit redaction tests before release.

Offline behavior failure evidence contains field paths and changed-file paths. It does not
reproduce primitive text-output or stream-payload values. Fixture authors remain responsible for
keeping tool arguments synthetic because exact tool arguments are part of the declared comparison
contract.

Codex audits contain only schema versions, stable status and reason codes, expected relative paths,
hashes and opaque workspace commitments, contract outcomes, requested sandbox policy and model,
requested and observed CLI executable hashes, CLI identity, and token counts. Unexpected workspace
paths are committed inside a hash, not listed. Audits exclude prompts, responses, command strings
and output, source and patch bodies, observation values, absolute or temporary paths, wall-clock
data, and thread IDs. Tests inject source, candidate, command, unexpected-path, and thread sentinels
and require them to be absent from canonical audit output.
