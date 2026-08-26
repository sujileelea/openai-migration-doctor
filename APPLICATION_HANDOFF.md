# Developer Experience application handoff

Updated on 2026-08-27 (Asia/Seoul). This is the active handoff for the work that prepares Migration
Doctor as evidence for the
[Developer Experience Engineer role in Seoul](https://openai.com/careers/developer-experience-engineer-seoul-south-korea/).
`NEXT_SESSION_HANDOFF.md` remains the detailed product ledger; this document explains the
application objective, the two local work lines, and the safe order for continuing them.

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

- Local repository: `/Users/sujilee/Desktop/Workspace/Career/opencareer/migration-doctor`
- Remote: `https://github.com/sujileelea/openai-migration-doctor.git`
- Workspace rules: read `/Users/sujilee/Desktop/Workspace/AGENTS.md`, then this repository's
  `AGENTS.md` before acting.
- Never push, create or merge a pull request, change repository settings, tag, publish, contact
  participants, or disclose credentials/private source without the applicable owner approval.
- `main` is release-only. Routine work starts from and targets `develop` after the remote transition
  is complete.

## Git state at handoff

The worktree was clean when this handoff was written. Stable content anchors use full local commit
IDs; resolve the self-referential handoff commit itself with `git rev-parse HEAD`.

| Ref | Commit | State and purpose |
| --- | --- | --- |
| `origin/main`, `main` | `479d6cca8f13bd00646838927803a5773be1a594` | Current public default and released-code branch |
| `develop` | `479d6cca8f13bd00646838927803a5773be1a594` | Local integration baseline; not on the remote |
| `chore/branch-governance` | `HEAD` (implementation anchor `2c366e918e21d1c610f96d59df32c5c4a35af68f`) | Two commits ahead of `develop`; current branch; local only |
| `feat/dx-evidence-loop` | `bb16ae41fd1d2bda2f9b8fc93a3e5a8346d06c4f` | Three commits ahead of `develop`; local only |

The remote currently has only `main` and the older `docs/next-session-handoff` branch. There are no
open pull requests. As verified on 2026-08-27, GitHub still uses `main` as its default branch and no
remote `develop` branch exists.

Do not combine the two active local lines into one undifferentiated push. Governance must land on
`develop` first; the Developer Experience evidence branch follows it.

## Work line A — branch governance

Branch: `chore/branch-governance`

Commits:

- `2c366e918e21d1c610f96d59df32c5c4a35af68f` — `chore: establish protected develop workflow`
- `HEAD` — `docs: add application work handoff` (this document; resolve its hash locally)

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

Branch: `feat/dx-evidence-loop`

Commits, in order:

1. `2ddfb90376b91325dfc0fb780e42c4f8577326dc` — `chore: refresh reviewed OpenAI source records`
2. `532749fcb965641da40e1ad4419518de141bbcbc` — `feat: add external first-use evidence workflow`
3. `bb16ae41fd1d2bda2f9b8fc93a3e5a8346d06c4f` — `docs: publish Developer Experience case study`

Important files exist on that branch, not on the current governance branch:

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

Verification recorded at `bb16ae41fd1d2bda2f9b8fc93a3e5a8346d06c4f`:

- install, uv lock/sync, build, typecheck, lint, format, and Python checks passed;
- 18 test files and 220 tests passed;
- SARIF schema validation passed;
- five current reviewed source records across four official documents passed the drift check;
- the demo smoke test generated Markdown, JSON, SARIF, and HTML and returned expected finding exit
  `1`.

No demo video or external participant results have been claimed. Those remain pending evidence.

## Current remote settings

Read-only verification on 2026-08-27 found:

- default branch: `main`;
- `main` requires a pull request, administrator enforcement, resolved strict status checks, linear
  history, and disallows force pushes and deletion;
- current required checks: `verify`, `Migration audit (ubuntu-latest)`, and
  `Migration audit (macos-latest)`;
- squash, merge-commit, and rebase merge methods are all enabled;
- automatic source-branch deletion is disabled.

These are current facts, not the target state. The target policy needs release-boundary merge
commits, so the current `main` linear-history requirement must eventually be removed. Do not change
it before the governance workflow is live and the owner approves the exact remote transition.

## Safe continuation order

### Phase 1 — bootstrap `develop` and open the governance PR

Obtain explicit owner approval, then:

1. recheck the worktree, local refs, remote heads, open PRs, and required workflow status;
2. publish local `develop` at the exact current `origin/main` commit;
3. apply temporary `develop` protection with the three existing strict required checks,
   administrator enforcement, resolved conversations, and disabled force push/deletion; do not
   require `branch-policy` before that workflow exists on the base branch;
4. push `chore/branch-governance` and open a PR to `develop`;
5. wait for every check that starts and run the policy script locally; if GitHub also starts the new
   `branch-policy` job from the pull request, require it to pass;
6. do not merge until the owner explicitly approves the reviewed PR.

This bootstrap is the only planned direct creation of remote `develop`; it must not become a
general direct-push exception.

### Phase 2 — finish remote governance

After the governance PR is approved and merged into `develop`:

1. make `develop` the GitHub default branch;
2. require `branch-policy`, `verify`, and both migration-audit jobs on both protected branches;
3. keep administrator enforcement, resolved conversations, and disabled force push/deletion;
4. remove required linear history so only the documented release/hotfix routes can retain merge
   commits;
5. keep squash and merge-commit methods, disable rebase merge, and enable automatic head-branch
   deletion;
6. verify all settings through read-only GitHub API calls and record the result.

Repository settings and the default-branch change are owner decisions. Apply only the subset the
owner explicitly authorizes.

### Phase 3 — integrate the DX evidence branch

After governance is live:

1. update local `develop` from `origin/develop`;
2. rebase the still-local `feat/dx-evidence-loop` onto `develop`;
3. expect overlaps in `NEXT_SESSION_HANDOFF.md`, `README.md`, and `package.json`; retain both the
   new branch contract and the newer evidence-loop facts;
4. rerun every repository Definition-of-Done gate, source drift, demo smoke, SARIF validation, and
   clean-worktree benchmark;
5. push only after owner approval and open the PR against `develop`;
6. wait for required checks and obtain a separate merge decision.

Do not target this feature branch at `main` and do not bypass the governance PR by merging the two
local branches first.

### Phase 4 — produce the missing application evidence

Once the code and documentation are on a reviewed `develop` revision:

1. record the 85–90 second English demo from one clean, public, 40-character commit using
   `docs/demo-90-seconds.md`;
2. have the owner recruit and consent at least three developers under `docs/first-use-study.md`;
3. use only the bounded anonymized schema—never commit names, employers, handles, raw notes,
   transcripts, credentials, private repositories, or customer source;
4. generate the deterministic aggregate, fix or file the two largest reproducible friction points,
   and add regression tests for any product fix;
5. update the case study and README with only the evidence actually produced;
6. prepare a `release/vX.Y.Z` branch and reviewed pre-release only if the owner chooses a release
   boundary.

Participant recruitment/contact, video publication, tags, releases, and application submission are
external owner actions.

## Application-completion definition

The project is ready to serve as this role's deliberate portfolio evidence when:

- the protected `develop`/release-only `main` topology is live and verified;
- both local work lines have landed through reviewed PRs with green required checks;
- the case study links an exact public revision and makes the role-aligned product decisions easy
  to scan;
- the English demo is recorded from that exact revision and contains no private information;
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
cd /Users/sujilee/Desktop/Workspace/Career/opencareer/migration-doctor
git status --short --branch
git branch -vv
git log --oneline --decorate --graph --all -12
git rev-list --left-right --count develop...chore/branch-governance
git rev-list --left-right --count develop...feat/dx-evidence-loop
```

Then read `AGENTS.md`, this file, `docs/branching-strategy.md`, and
`NEXT_SESSION_HANDOFF.md`. If the session is working on the evidence branch, inspect its case study
without changing branches first:

```bash
git show feat/dx-evidence-loop:docs/developer-experience-case-study.md
```

Re-verify volatile GitHub state before proposing any remote action. If the owner has not explicitly
authorized that action in the new session, stop at a report and request the decision.
