# Safety

## Current command behavior

- `scan` reads supported source files and never calls a network API.
- `plan` reads findings and locked migration data and never writes the target repository.
- `migrate` emits a preview only. This release has no apply flag.
- `verify` writes only to a temporary repository copy and removes it after the run.

No command invokes Codex, reads an OpenAI API key, pushes Git changes, creates a pull request, deploys, or merges.

## Fail-closed checks

- Missing, malformed, or hash-mismatched source-lock artifacts stop analysis.
- Candidate TypeScript files with parser errors stop analysis instead of being silently skipped.
- A destination that is also deprecated in the loaded lock blocks patch planning.
- File hash or expected-text drift invalidates a frozen plan.
- Overlapping edits are rejected.
- Verification compares the complete resulting file hash, not only the changed-file name.
- Symbolic links and generated dependency/build directories are not scanned or copied.

## Evidence minimization

Reports contain the deprecated model literal, repository-relative location, source links, and hashes needed to audit a finding. They exclude absolute repository paths, temporary paths, source-file contents, environment values, and raw transcripts.

The current model identifier evidence is not secret. Future rules that can encounter sensitive configuration must add explicit redaction tests before release.
