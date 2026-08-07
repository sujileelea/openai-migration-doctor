---
name: migration-audit
description: Audit a repository for supported deprecated OpenAI model and API usage with source-grounded Migration Doctor reports. Use when Codex needs to assess migration readiness, locate supported findings, review abstentions or source conflicts, or produce saved Markdown, JSON, SARIF, and HTML evidence without changing the target repository.
---

# Migration Audit

Use the checked-in Migration Doctor CLI as the only analysis engine. Do not recreate its detection,
migration graph, or verification decisions in prompts or shell scripts.

## Run The Audit

1. Read the target repository's instructions. Check its status, branch, remote, and worktrees before
   running tools.
2. Resolve `TOOL_SOURCE` to the Migration Doctor Git repository containing this skill. This skill
   lives at `.agents/skills/migration-audit`, so the tool source is three directories above it.
3. Create an external parent directory, leaving the report destination itself absent:

   ```bash
   REPORT_PARENT="$(mktemp -d)"
   REPORT_DIR="$REPORT_PARENT/report"
   ```

4. Run the checked-in audit script and preserve its exit code:

   ```bash
   set +e
   MIGRATION_DOCTOR_TOOL_SOURCE="$TOOL_SOURCE" \
     bash "$TOOL_SOURCE/.agents/skills/migration-audit/scripts/run-audit.sh" \
       "$TARGET_REPOSITORY" "$REPORT_DIR"
   STATUS=$?
   set -e
   ```

The script exports committed `HEAD` with `git -C "$TOOL_SOURCE" archive`, installs Node packages
and the exact `uv.lock` into a private temporary tool root, and builds there. It then invokes
`node "$TOOL_ROOT/packages/cli/dist/index.js" report`; neither dependency setup nor analysis writes
to the target repository or the Migration Doctor checkout. Do not replace the archive with a copy
of a dirty worktree, and do not omit `uv sync --project packages/language-python --locked`.

The command writes `migration-report.md`, `migration-report.json`, `migration-report.sarif`, and
`migration-report.html`. The report directory must remain outside the target repository.

## Interpret Results

- `0`: no blocking supported finding.
- `1`: blocking findings were reported successfully. Treat this as an audit result, not a tool
  crash.
- `2` through `5`: configuration, analysis, source-lock, or migration failure. Report the exact
  error and do not claim the audit completed.

Read the saved JSON for structured facts and Markdown or HTML for review. Report exact locations,
official source links, automation tiers, graph issues, and abstention reasons. Preserve these
boundaries:

- detection is local and deterministic;
- a patch preview is not an applied migration;
- offline fixture verification is not repository runtime or live-API parity;
- unsupported usage is outside declared coverage, not proof that migration is unnecessary;
- no production rule or CLI command invokes the optional Codex remediation adapter.

Conclude with the report directory, exit code, blocking count, source-lock hash, and any incomplete
analysis. Do not edit, apply patches, push, open a pull request, or deploy unless the user separately
requests that work.
