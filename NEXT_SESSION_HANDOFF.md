# Next Session Handoff

Prepared on 2026-08-08 (Asia/Seoul) for the session following the first reviewed
Migration Doctor pre-release.

## Read first

1. This file.
2. [`README.md`](README.md) for the public contract and measured evidence.
3. [`docs/limitations.md`](docs/limitations.md) for unsupported patterns and trust boundaries.
4. [`docs/safety.md`](docs/safety.md), [`docs/methodology.md`](docs/methodology.md), and
   [`docs/rule-authoring.md`](docs/rule-authoring.md) before changing a rule or verifier.
5. [GitHub issue #18](https://github.com/sujileelea/openai-migration-doctor/issues/18) for the
   live next-phase tracker.

`CODEX_HANDOFF.md` is the historical bootstrap plan. It explains why the architecture exists, but
it is not the current work ledger.

## Shipped baseline

| Item | Reviewed state |
| --- | --- |
| Release | [`v0.1.0-alpha.1`](https://github.com/sujileelea/openai-migration-doctor/releases/tag/v0.1.0-alpha.1), public pre-release |
| Release target | `5f728026a2736d829cb3959e06c63e1ce705db31` |
| Composite Action pin | `f872e95b4485de765766708d7c11a7117707e1b1` |
| Source archive SHA-256 | `16e4db9fc91c13f4d5e92e9f448e34033fb3be5268d1eeda6cfab15cf1942e4b` |
| Distribution | Source build and SHA-pinned composite Action; no npm or PyPI package |
| License | Apache-2.0 for project-authored material; dependency and provenance boundaries remain separate |
| Handoff baseline | `main` was `446dd688f9e1ccd078e59525f52ab1f7d9bc6fbf` before this handoff change |

The release tag intentionally remains on the reviewed release target. The branch that adds this
handoff follows the Vitest 3.2.6 maintenance update, the published-release link, and the
benchmark-authorship clarification. Never move or recreate the existing tag to include post-release
work.

Implemented and verified at this baseline:

- one constrained direct transcription-model migration rule in JavaScript, TypeScript, and Python;
- review-only Tier C Assistants inventory in all three languages, with no Assistants rewrite;
- deterministic Markdown, JSON, SARIF 2.1.0, and script-free HTML reports;
- source drift, hash-bound public-repository evaluation, exact SDK loopback, and synthetic benchmark
  evidence;
- 17 test files and 216 tests in the deterministic suite;
- an isolated Codex adapter boundary that no production rule or CLI command can reach;
- strict `main` protection and repository security features described below.

The release evidence workflows passed at the release target:

- [official source drift](https://github.com/sujileelea/openai-migration-doctor/actions/runs/31182697527);
- [public repository evaluation](https://github.com/sujileelea/openai-migration-doctor/actions/runs/31182707076);
- [SDK compatibility matrix](https://github.com/sujileelea/openai-migration-doctor/actions/runs/31182716113).

## Open work

The [next-phase tracker](https://github.com/sujileelea/openai-migration-doctor/issues/18) is the
canonical open-work index. Each child issue states scope, non-goals, dependencies, risks, and
acceptance criteria.

| Priority | Issue | Intended outcome |
| --- | --- | --- |
| P0 | [#4 External first-use workflow](https://github.com/sujileelea/openai-migration-doctor/issues/4) | Produce bounded external usability evidence; owner coordinates participants. |
| P0 | [#5 One reviewed cross-file binding](https://github.com/sujileelea/openai-migration-doctor/issues/5) | Narrow one observed recall boundary without generic data-flow claims. |
| P1 | [#7 Rule-independent graph audit](https://github.com/sujileelea/openai-migration-doctor/issues/7) | Audit the complete locked graph without scanning a repository. |
| P1 | [#8 Cross-language public evidence](https://github.com/sujileelea/openai-migration-doctor/issues/8) | Add independently reviewed language coverage and bounded performance evidence. |
| P1 | [#9 Signed release provenance](https://github.com/sujileelea/openai-migration-doctor/issues/9) | Select and verify a release trust model; owner selects signing identity. |
| P2 | [#6 Structured SDK package evidence](https://github.com/sujileelea/openai-migration-doctor/issues/6) | Evaluate constraints from one exact manifest/lock format when a reviewed rule needs it. |
| P2 | [#10 Behavior contract v2](https://github.com/sujileelea/openai-migration-doctor/issues/10) | Model repeated invocations and exact file moves deterministically. |
| P2 | [#11 Opt-in live API evidence](https://github.com/sujileelea/openai-migration-doctor/issues/11) | Test only the locked rule under an owner-approved credential and budget. |
| P2 | [#19 Trusted semantic observation harness](https://github.com/sujileelea/openai-migration-doctor/issues/19) | Produce provenance-bound observations from an approved fixture candidate. |
| P2 | [#12 One Assistants transformation slice](https://github.com/sujileelea/openai-migration-doctor/issues/12) | Close one source-backed Tier B feature contract; all other findings stay Tier C. |
| P3 | [#13 Opt-in Codex CLI route](https://github.com/sujileelea/openai-migration-doctor/issues/13) | Route only the first production-quality Tier B rule and save redacted audits. |
| P3 | [#14 Persistent scan cache](https://github.com/sujileelea/openai-migration-doctor/issues/14) | Add correctness-bound cross-run caching after a threat model. |
| P3 | [#15 Verification profiles](https://github.com/sujileelea/openai-migration-doctor/issues/15) | Add one proved isolation backend; command execution remains opt-in. |
| P3 | [#16 Reusable prompt inventory](https://github.com/sujileelea/openai-migration-doctor/issues/16) | Add one source-backed Tier C inventory rule without creating Prompt objects. |
| P3 | [#17 Registry distribution contract](https://github.com/sujileelea/openai-migration-doctor/issues/17) | Prove packed artifacts or record why publication stays deferred. |

### Dependency order

- The first repository-local implementation should be #5. It is tied to a known public-corpus
  boundary and requires no external credential or irreversible action.
- #4 can proceed in parallel only when the owner has recruited participants and approved the
  privacy boundary.
- Do not start #12 until the owner approves its exact feature and its sources, observation contract,
  per-feature Tier B planner/verifier contract, and relevant #6/#10/#19 dependencies are resolved.
  #11 is independent transcription-rule evidence, not an Assistants prerequisite.
- #13 is blocked until #12 supplies a production-quality Tier B rule and #19 proves its observation
  provenance.
- #17 may prepare artifacts, but registry publication is a separate irreversible owner action.

Do not open implementation work for plugin packaging, a hosted repository-upload service,
automatic apply/commit/PR/merge/deploy, or general agent-framework rewrites without new evidence and
a separately reviewed product contract.

## Next session start

Run these commands before editing:

```bash
git switch main
git pull --ff-only
git status --short --branch
git rev-parse HEAD
gh issue view 18
gh issue view 5
```

Confirm that the worktree is clean, `main` equals `origin/main`, the tracker is open, no earlier PR
is still active, and no required workflow is queued. Then create one scoped branch:

```bash
git switch -c feat/reviewed-cross-file-binding
```

For #5, write the supported import/export contract, neighboring abstentions, and fixtures before
changing the analyzer. Update the public ground truth only after an independent manual review; do
not relabel output merely to match the implementation.

## Local verification

Install exactly from the checked-in locks when the environment is not already prepared:

```bash
corepack pnpm install --frozen-lockfile
uv lock --check --project packages/language-python
uv sync --project packages/language-python --locked
```

Run the deterministic local gates for every implementation PR:

```bash
corepack pnpm build
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm python:check
corepack pnpm test
corepack pnpm validate:sarif
git diff --check
git status --short
```

`validate:sarif` downloads the hash-pinned official schema. Review and commit the candidate, then
run the benchmark from the resulting clean worktree:

```bash
git status --short
corepack pnpm benchmark --output /private/tmp/migration-doctor-benchmark.json
```

The first command must print nothing. The benchmark intentionally rejects a dirty worktree and its
output must stay outside the repository unless intentionally preparing a reviewed ledger. Do not
commit generated `benchmarks/results/latest.json`.

When a change affects source records, public labels, SDK compatibility, performance claims, or a
release boundary, run or dispatch the corresponding evidence workflow and keep the run URL and
exact commit SHA in the PR. Public evaluation requires a clean worktree and never runs upstream
repository code.

## Protected merge procedure

`main` requires a pull request and enforces the same rules for administrators:

- strict, up-to-date required checks: `verify`, `Migration audit (ubuntu-latest)`, and
  `Migration audit (macos-latest)`;
- linear history and resolved conversations;
- force pushes and branch deletion disabled.

Use a short branch, scoped English commits, and the PR template. Push the branch, open a PR, wait
for every required check, resolve review threads, and squash merge. Never direct-push to `main`.
After merge, pull `main`, confirm `HEAD == origin/main`, and wait for any new `main` workflow runs
before reporting completion.

Private vulnerability reporting, Dependabot alerts/security updates, secret scanning, and push
protection were enabled at handoff. Recheck them before a security or release claim. Signed commits,
signed tags, and immutable releases are not currently enforced; issue #9 owns that work.

## Claim boundaries

Keep these statements exact until linked evidence changes them:

- This is an unofficial developer tool, not an OpenAI product or endorsement.
- It is pre-alpha, not production-ready, and does not provide full migration coverage.
- Assistants usage is analysis-only Tier C in JavaScript, TypeScript, and Python; no Assistants
  transformation exists.
- No production rule or CLI command invokes Codex. Automated adapter tests use fake executables.
- No live OpenAI API parity or application runtime behavior has been verified. The SDK matrix is an
  exact local loopback request-byte test and contacts no OpenAI endpoint.
- The synthetic result covers 120 generated instances from 42 independently authored templates,
  not 120 independently authored fixtures.
- The public evaluation covers one positive TypeScript application with 25 runtime call sites and
  41 atomic labels, one separate seven-call-site cross-file application outside the current
  same-file boundary, and one zero-label negative control. The supported set has 41 TP, 0 FP, and
  0 FN. Do not generalize beyond those pinned revisions and labels.
- Detection is network-free. Dependency installation, source drift, SARIF validation, public
  evaluation acquisition, SDK installation, and Codex control traffic are separate networked
  operations.
- npm/PyPI packages, automatic source apply, automatic PR/push/merge/deploy, Windows repository
  verification, and an untrusted-command sandbox are not supported.
- The current release has checksums, but its tag and `migration.lock` are unsigned and the release
  is not immutable.

## Owner-input boundaries

Use an owner decision interaction only when a task reaches one of these external boundaries:

- recruiting or scheduling external participants (#4);
- selecting a signing identity, rotation policy, or account-level release setting (#9);
- supplying credentials, approving a cost ceiling, or authorizing live OpenAI/Codex traffic
  (#11 and #13);
- selecting the exact Assistants feature that may enter the supported transformation contract
  (#12);
- authorizing the exact repository and file scope disclosed to Codex (#13);
- publishing a package name or registry artifact (#17);
- changing the supported product outcome or making an irreversible external action.

Repository-local schemas, fixtures, analyzers, reporters, and reversible design choices do not need
owner approval when they stay inside the accepted issue contract.

## End-of-session checklist

- Update the issue checklist and add the exact PR, run, corpus, and ledger links.
- Keep `README.md`, rule matrices, methodology, safety, and limitations consistent with measured
  behavior.
- Add a new limitation when a newly observed unsupported boundary remains unresolved.
- Confirm no secrets, raw participant data, transcripts, external source bodies, or unreviewed
  third-party material were committed.
- Leave the worktree clean, no required run pending, and no undocumented local-only change.
- Update this handoff when priority, dependencies, release state, or trust boundaries materially
  change.
