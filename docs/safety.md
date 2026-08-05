# Safety

## Current command behavior

- `scan` reads supported source files and never calls a network API.
- `plan` reads findings and locked migration data and never writes the target repository.
- `migrate` emits a preview only. This release has no apply flag.
- `verify` writes only to a temporary repository copy and removes it after the run.

No command invokes Codex, reads an OpenAI API key, pushes Git changes, creates a pull request, deploys, or merges.

## Fail-closed checks

- Missing, malformed, or hash-mismatched source-lock artifacts stop analysis.
- Duplicate source or migration IDs stop analysis.
- Candidate TypeScript files with parser errors stop analysis instead of being silently skipped.
- A uniquely deprecated destination is followed to its terminal graph target; conflicting destinations, cycles, missing destinations, and unverified SDK constraints prevent deterministic patch generation.
- Source conflicts preserve every involved source, require human review, and never choose a replacement.
- A plan with any abstention is atomic: it contains no partial edits and remains reportable as a blocked result.
- File hash or expected-text drift invalidates a frozen plan.
- Overlapping edits are rejected.
- Verification compares the complete resulting file hash, not only the changed-file name.
- Symbolic links and generated dependency/build directories are not scanned or copied.

## Evidence minimization

Reports contain the deprecated model literal, repository-relative location, source links, and hashes needed to audit a finding. They exclude absolute repository paths, temporary paths, source-file contents, environment values, and raw transcripts.

The current model identifier evidence is not secret. Future rules that can encounter sensitive configuration must add explicit redaction tests before release.
