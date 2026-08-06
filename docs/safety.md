# Safety

## Current command behavior

- `scan` reads supported source files and never calls a network API.
- `plan` reads findings and locked migration data and never writes the target repository.
- `migrate` emits a preview only. This release has no apply flag.
- `verify` writes only to a temporary repository copy and removes it after the run.
- `verify-behavior` reads local JSON observations only. It does not execute a repository or make a
  network or live API call.

No command invokes Codex, reads an OpenAI API key, pushes Git changes, creates a pull request, deploys, or merges.

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
