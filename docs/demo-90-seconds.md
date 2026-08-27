# 90-second demo runbook

This runbook produces a concise English demo of Migration Doctor without live credentials, private
source, or claims beyond the reviewed pre-alpha contract.

## Recording contract

- Record from a clean, public commit and show its 40-character SHA at the start.
- Use only `fixtures/typescript/direct-model-literal`.
- Build before recording; dependency-install time is not part of the demo.
- Keep the terminal large enough to read at 1080p and add English captions.
- Do not show environment variables, private paths, notifications, tokens, or unrelated browser tabs.
- State that exit `1` means the report completed with a blocking finding.
- Do not imply live OpenAI API use or a production Codex route.

## Preflight

Run before screen recording:

```bash
git fetch --prune origin
git status --short
git rev-parse HEAD
corepack pnpm build
corepack pnpm demo:prepare
```

The preflight requires a clean worktree, a 40-character revision contained by an `origin` remote
tracking branch, expected finding exit `1`, and an exact non-empty four-file report bundle. Before
the PR is public, rehearse without claiming recording readiness:

```bash
corepack pnpm demo:prepare -- --rehearsal
```

For the recording itself, prepare a fresh path and run the same report command visibly:

```bash
DEMO_PARENT="$(mktemp -d)"
corepack pnpm run doctor report fixtures/typescript/direct-model-literal \
  --output "$DEMO_PARENT/report"
# Exit 1 is expected because the fixture contains a blocking finding.
```

Confirm that the report directory contains:

```text
migration-report.md
migration-report.json
migration-report.sarif
migration-report.html
```

Delete the temporary rehearsal directory outside the recording session when it is no longer needed.

## Shot list and narration

### 0–10 seconds — the problem

Show the README title and one sentence of the product thesis.

> OpenAI APIs evolve quickly, but a production migration is more than replacing a model string.
> Migration Doctor asks what will break, which path official sources support, and what can be changed
> safely.

### 10–25 seconds — evidence before automation

Show `migration.lock`, one dated source record, and the Tier A/Tier C table.

> Every rule is tied to reviewed official-document hashes, fixtures, an automation tier, and a
> verification contract. If a source changes, the scheduled gate fails and requires human review.

### 25–45 seconds — first report

Run the prepared `report` command and show the exact finding.

> This local scan needs no API key and never changes the repository. Exit one means the report
> completed with a blocking finding—not that the tool crashed. Here it identifies the deprecated
> transcription snapshot, exact location, replacement, and review boundary.

### 45–60 seconds — one result, four surfaces

Show the four generated files, then open the static HTML report.

> The same normalized result becomes Markdown for a developer, JSON for automation, SARIF for code
> review, and script-free HTML for explanation.

### 60–76 seconds — safe change and verification

Show `plan`, `migrate --risk safe`, and `verify` in the README or a prepared terminal pane.

> Migration stays preview-only. Tier A verification applies the edit in a temporary copy, checks
> the exact file boundary, re-scans the candidate, and proves the original tree is unchanged.

### 76–90 seconds — the honest boundary

Show the Assistants Tier C row and the external first-use protocol link.

> Stateful Assistants migration remains analysis-only until behavior can be proved. The next product
> loop is external first use: observe developers, publish bounded aggregates, fix the two biggest
> friction points, and repeat.

## Post-recording QA

- Final duration is 85–90 seconds with no sped-up speech.
- Captions match the spoken words and technical identifiers.
- The description links the exact commit, quickstart, sample report, limitations, and first-use
  protocol.
- The video title includes “Unofficial pre-alpha developer tool.”
- Any measured number shown on screen is traceable to a checked-in ledger or release handoff.
- The repository still has no untracked recording output or generated report bundle.
