# Changelog

All notable project changes are documented here. This project follows Semantic Versioning for
tagged source releases while it remains pre-alpha.

## [0.1.0-alpha.1] - 2026-08-07

### Added

- Deterministic JavaScript, TypeScript, and Python model-snapshot migration analysis.
- Conservative ESM and CommonJS OpenAI client provenance for JavaScript.
- Review-only Assistants, Threads, Runs, streaming, tools, file-search, and code-interpreter
  analysis across JavaScript, TypeScript, and Python.
- Explicit `verify-repository` command execution after unchanged deterministic verification.
- Scheduled official-source drift, pinned public-repository evaluation, and exact official SDK
  compatibility workflows.
- Four-format saved report bundles, a sanitized sample report, a composite Action, and a Codex
  audit skill.

### Security

- Repository commands use JSON argv, no shell, a minimal non-credential environment, bounded
  output, timeouts, POSIX process-group cleanup, and post-command candidate-tree verification.
- Public evaluation exports exact Git blobs under an isolated Git configuration and never executes
  upstream repository code.

### Known boundaries

- Assistants migration remains Tier C analysis only.
- No CLI command invokes the optional Codex remediation adapter.
- Registry packages are private; supported distribution is a source build or SHA-pinned composite
  Action.

[0.1.0-alpha.1]: https://github.com/sujileelea/openai-migration-doctor/releases/tag/v0.1.0-alpha.1
