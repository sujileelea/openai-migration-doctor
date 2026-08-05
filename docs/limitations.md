# Limitations

Migration Doctor is pre-alpha and supports one narrow rule.

## Detection

- TypeScript only: `.ts`, `.tsx`, `.mts`, and `.cts`.
- The OpenAI import, directly constructed client, and API call must be in the same file.
- Only `audio.transcriptions.create` is recognized.
- The request must be an inline object literal with a direct string-literal `model` property.
- JavaScript, aliases, mutable or reassigned client bindings, wrappers, helper functions, spreads, duplicate or computed properties, template literals, variables, environment configuration, and Realtime calls are not supported.
- Unsupported patterns currently produce no finding rather than a Tier C finding. That abstention surface is planned.

These constraints favor precision over recall. No public precision or recall claim is made from the current synthetic fixtures.

## Transformation and verification

- `migrate` is preview-only and cannot apply a patch to the source repository.
- `verify` uses a temporary directory copy, not a Git worktree.
- Repository build, typecheck, lint, unit tests, and integration tests are not discovered or executed.
- No audio corpus is evaluated, so runtime behavior is always reported as unverified.
- SDK version compatibility is not inferred. Post-patch repository checks will be required before that claim is possible.

## Sources and reports

- The lock contains one migration edge and does not yet implement general graph traversal or multi-source conflict records.
- Source refresh is manual.
- Canonical JSON and Markdown are implemented; saved report files, SARIF, HTML, and GitHub annotations are not.
- Runtime telemetry is written to stderr and is not part of the canonical report.

## Distribution

- The package is not published.
- License selection is pending.
- Codex remediation, Python, benchmarks, a skill, and plugin packaging are not implemented.
