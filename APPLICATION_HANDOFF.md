# Developer Experience application handoff

Updated on 2026-08-27 (Asia/Seoul). This is the active handoff for the work that prepares Migration
Doctor as evidence for the
[Developer Experience Engineer role in Seoul](https://openai.com/careers/developer-experience-engineer-seoul-south-korea/).
`NEXT_SESSION_HANDOFF.md` remains the detailed product ledger; this document explains the
application objective, the two work lines, and the safe order for continuing them.

## Mission

The owner wants to make a specific, supportable claim:

> I identified a real OpenAI developer-experience problem, deliberately planned and implemented a
> public tool for it, taught developers how to use it, measured the experience, and improved the
> product from evidence.

Migration Doctor must therefore be presented as more than a static-analysis implementation. The
portfolio thesis is the complete Developer Experience loop:

```text
build → teach → observe developers → synthesize feedback → improve → release
```

The current tool already provides strong build, safety, documentation, and evaluation evidence.
The application work adds the missing role-aligned narrative, first-use measurement loop, demo,
and professional repository governance. Keep every claim bounded by checked-in evidence. This is
an unofficial pre-alpha project and not an OpenAI product or endorsement.

## Repository and authority

- Local repository: this checkout; do not publish workstation-specific paths in application media
- Remote: `https://github.com/sujileelea/openai-migration-doctor.git`
- Workspace rules: read the enclosing Workspace `AGENTS.md`, then this repository's `AGENTS.md`
  before acting.
- Never push, create or merge a pull request, change repository settings, tag, publish, contact
  participants, or disclose credentials/private source without the applicable owner approval.
- `main` is release-only. Routine work starts from and targets `develop` after the remote transition
  is complete.

## Git and GitHub state at handoff

The worktree was clean when this handoff was updated. Stable content anchors use full commit
IDs; resolve the self-referential handoff commit itself with `git rev-parse HEAD`.

| Ref | Commit | State and purpose |
| --- | --- | --- |
| `origin/main`, `main` | `479d6cca8f13bd00646838927803a5773be1a594` | Released-code branch; unchanged by application work |
| `origin/develop` | `639e4648d5e0577dfc2e2cfcacdc33b5187140fe` | Governance and Developer Experience evidence after PRs #21 and #22 |
| `origin/chore/branch-governance` | `f0a8ceb3ab22bd99422b59b069bed70d0eb687f2` | Source branch for merged PR #21; retained as a fallback ref |
| merged PR #22 source | `bcb0cee2cf077752ab9ee1755704ca238261916a` | Eight reviewed DX commits; remote source branch was deleted automatically after merge |

GitHub uses `develop` as its default branch. PR #21 was squash-merged as `00d02c3`; PR #22 was
squash-merged as `639e4648`. All thirteen PR checks passed for #22, followed by successful
[deterministic-core](https://github.com/sujileelea/openai-migration-doctor/actions/runs/33065633224)
and [cross-platform migration audit](https://github.com/sujileelea/openai-migration-doctor/actions/runs/33065633200)
target-branch workflows. `main` remains unchanged.

## Work line A — branch governance

Branch: `chore/branch-governance`

Commits:

- `2c366e918e21d1c610f96d59df32c5c4a35af68f` — `chore: establish protected develop workflow`
- `f0a8ceb3ab22bd99422b59b069bed70d0eb687f2` — `docs: add application work handoff`

This line implements a lightweight GitFlow contract:

- `develop` is the default integration branch;
- working branches such as `feat/*`, `fix/*`, `docs/*`, and `chore/*` target `develop` and are
  squash-merged;
- only `release/*` and `hotfix/*` target `main`;
- release and hotfix merge commits preserve visible promotion boundaries and flow back to
  `develop`;
- direct pushes, force pushes, and protected-branch deletion are forbidden;
- `.github/workflows/branch-policy.yml` rejects invalid source/target routes;
- `docs/branching-strategy.md`, contributing guidance, the PR template, CI triggers, and repository
  agent instructions describe the same contract.

Verification recorded at this commit:

- frozen pnpm and uv dependency checks passed;
- build, typecheck, Biome lint/format, and Python bytecode checks passed;
- 18 test files and 230 tests passed;
- generated SARIF validated against the SHA-256-pinned official OASIS schema;
- clean-worktree benchmark passed with 120 fixtures, precision `1.0000`, recall `1.0000`, cold
  `198.36 ms`, and warm `69.92 ms`;
- direct policy checks allow `chore/branch-governance -> develop` and reject it against `main`.

The benchmark timings are local measurements, not release guarantees.

## Work line B — Developer Experience evidence loop

Merged by [PR #22](https://github.com/sujileelea/openai-migration-doctor/pull/22) from
`feat/dx-evidence-loop`; GitHub deleted the remote source branch after the squash merge.

Important files introduced by that branch are:

- `docs/developer-experience-case-study.md` — explains why the project was built for this role,
  maps evidence gaps to concrete project choices, and states honest limitations;
- `docs/demo-90-seconds.md` — exact credential-free demo and recording runbook;
- `docs/first-use-study.md` — consent, privacy, measurements, stop conditions, and completion gate
  for external sessions;
- `docs/product-feedback.md` — separates official-source observations, internal hypotheses, and
  external evidence;
- `scripts/summarize-first-use.mjs` — rejects free-form notes and deterministically aggregates the
  bounded anonymized first-use schema;
- new dated official-source records and an updated `migration.lock` after four upstream documents
  changed.

The eight DX commits are:

1. `cd19ead` — `chore: refresh reviewed OpenAI source records`
2. `1a4a374` — `feat: add external first-use evidence workflow`
3. `d196e10` — `docs: publish Developer Experience case study`
4. `52b2811` — `feat: rank first-use friction candidates`
5. `6642bcc` — `chore: automate demo recording preflight`
6. `e42bfe3` — `fix: accept pnpm script argument separator`
7. `59126d1` — `chore: refresh prompt migration source record`
8. `bcb0cee` — `docs: refresh application handoff after branch push`

Verification recorded at `cbe785270e2929e126a4a88403ed86e0655d608a`:

- install, uv lock/sync, build, typecheck, lint, format, and Python checks passed;
- 20 test files and 239 tests passed;
- SARIF schema validation passed;
- five current reviewed source records across four official documents passed the drift check;
- the demo rehearsal generated Markdown, JSON, SARIF, and HTML and returned expected finding exit
  `1`;
- the clean-worktree benchmark passed with 120 fixtures, precision `1.0000`, recall `1.0000`, cold
  `208.41 ms`, and warm `76.53 ms`.

An 86-second 1080p candidate demo was rendered from the clean public merge commit `639e4648` with
English narration and burned-in captions. It shows the exact finding and four-file report contract,
is stored outside the repository, and passed stream decoding, visual sampling, duration, checksum,
and private-path/string QA. Its SHA-256 is
`c72390791036901b92237cf35738a7f16f9cb74d2ed1c2990c1d299e172cb02a`. No public video URL and no
external participant result are claimed.

## Current remote settings

Read-only verification on 2026-08-27 found:

- default branch: `develop`;
- `develop` exists remotely and requires a pull request, all four up-to-date checks, resolved
  conversations, administrator enforcement, and disabled force push/deletion;
- `main` keeps the same protection set while remaining release-only;
- required checks on both protected branches: `branch-policy`, `verify`,
  `Migration audit (ubuntu-latest)`, and `Migration audit (macos-latest)`;
- squash and merge-commit methods are enabled; rebase merge is disabled;
- automatic source-branch deletion is enabled.

Both branches require pull requests, strict up-to-date checks, resolved conversations, and
administrator enforcement. Linear history, force pushes, and protected-branch deletion are
disabled as required by the checked-in release-boundary contract.

## Safe continuation order

### Phase 1 — merge the reviewed governance PR — complete

PR #21 was squash-merged as `00d02c308f6de09a3a13d339d3c9d7123d131402`. Its target-branch
`verify` and both migration-audit jobs passed.

### Phase 2 — finish remote governance — complete

The target default branch, required checks, administrator enforcement, conversation resolution,
merge methods, and deletion settings were applied and read back through the GitHub API.

### Phase 3 — open and merge the DX evidence PR — complete

PR #22 passed all required, code-scanning, and language/SDK matrix checks and was squash-merged to
`develop` as `639e4648d5e0577dfc2e2cfcacdc33b5187140fe`. Both target-branch workflows then passed and the
remote source branch was deleted automatically. `main` was not changed.

### Phase 4 — produce the missing application evidence

Once the code and documentation are on a reviewed `develop` revision:

1. **Candidate complete:** the 86-second English demo candidate is anchored to public commit
   `639e4648d5e0577dfc2e2cfcacdc33b5187140fe`; publish it only after owner review of the prepared
   title, description, and destination;
2. **Recruitment open:** issue #4 contains the public invitation and privacy boundary at
   [this checkpoint](https://github.com/sujileelea/openai-migration-doctor/issues/4#issuecomment-5438529958).
   Consent and complete at least three real sessions; the current completed-session count is zero;
3. use only the bounded anonymized schema—never commit names, employers, handles, raw notes,
   transcripts, credentials, private repositories, or customer source;
4. generate the deterministic aggregate, fix or file the two largest reproducible friction points,
   and add regression tests for any product fix;
5. update the case study and README with only the evidence actually produced;
6. prepare a `release/vX.Y.Z` branch and reviewed pre-release only if the owner chooses a release
   boundary.

Participant scheduling/consent, video publication, tags, releases, and application submission are
external owner actions. The public invitation is posted; do not infer participants from reactions
or replies without completed consented observation.

## Application-completion definition

The project is ready to serve as this role's deliberate portfolio evidence when:

- the protected `develop`/release-only `main` topology is live and verified;
- both work lines have landed through reviewed PRs with green required checks;
- the case study links an exact public revision and makes the role-aligned product decisions easy
  to scan;
- the English demo is published from the reviewed candidate anchored to that exact revision;
- at least three first-use sessions are summarized without generalization;
- the two highest-impact observed friction points are fixed or filed with evidence;
- README, limitations, methodology, feedback ledger, and release notes agree on supported scope;
- no claim implies representative adoption, live OpenAI API parity, production Codex remediation,
  or official OpenAI affiliation.

## Do not expand scope accidentally

- Do not start the Assistants transformation or production Codex route merely to make the demo look
  broader. Those require separate evidence and issue dependencies.
- Do not move or recreate `v0.1.0-alpha.1`; it is intentionally pinned to its reviewed release
  target.
- Do not auto-accept changed official documentation. Review new source bytes and update dated
  records plus `migration.lock` together.
- Do not turn planned participant sessions or a recording runbook into completed evidence.
- Do not delete the older remote `docs/next-session-handoff` branch without owner approval.

## First commands for the next session

```bash
cd /path/to/openai-migration-doctor
git switch develop
git pull --ff-only origin develop
git status --short --branch
git branch -vv
git log --oneline --decorate --graph --all -12
gh issue view 4
```

Then read `AGENTS.md`, this file, `docs/branching-strategy.md`,
`docs/first-use-study.md`, and `NEXT_SESSION_HANDOFF.md`.

Re-verify volatile GitHub state before proposing any remote action. If the owner has not explicitly
authorized that action in the new session, stop at a report and request the decision.
