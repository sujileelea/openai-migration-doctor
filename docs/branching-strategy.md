# Branching strategy

Migration Doctor uses a lightweight GitFlow model. The branch topology separates integration work
from reviewed releases without keeping long-lived environment branches beyond `develop` and
`main`.

## Branch roles

| Branch | Role | Created from | Pull-request target | Merge policy |
| --- | --- | --- | --- | --- |
| `main` | Released, taggable source only | — | `release/*`, `hotfix/*` | Merge commit after release gates |
| `develop` | Default integration branch | — | Working, release-backflow, and hotfix-backflow branches | Squash working branches; merge release boundaries |
| `feat/*`, `fix/*`, `docs/*`, `refactor/*`, `test/*`, `chore/*`, `build/*`, `ci/*`, `perf/*`, `revert/*` | One scoped change | `develop` | `develop` | Squash merge |
| `dependabot/*` | Automated dependency update | `develop` | `develop` | Squash merge |
| `release/v*` | Version and release stabilization | `develop` | `main`, then `develop` | Merge commit |
| `hotfix/v*` | Urgent released-version repair | `main` | `main`, then `develop` | Merge commit |

Branch descriptions use lowercase kebab-case. Keep a branch scoped to one issue or independently
reviewable outcome; do not reuse a merged branch.

## Working-change flow

```bash
git switch develop
git pull --ff-only origin develop
git switch -c feat/short-outcome
```

Commit in small, coherent English units. Open the pull request against `develop`, wait for every
required check, resolve review threads, and squash merge. Delete the remote working branch after
the merge. Never direct-push or force-push to either protected branch.

## Release flow

1. Start `release/vX.Y.Z` from a green, up-to-date `develop` revision.
2. Limit the branch to version metadata, release notes, and stabilization fixes. New features return
   to working branches.
3. Open `release/vX.Y.Z` into `main`. Run the release-specific evidence gates, record their exact
   commit and run URLs, and use a merge commit so the promotion boundary remains visible.
4. Tag the reviewed merge commit on `main`; publication and tagging remain explicit owner actions.
5. Open the same release branch into `develop` to return release-only changes, then delete it after
   both merges complete.

## Hotfix flow

1. Start `hotfix/vX.Y.Z` from the affected `main` release.
2. Add only the minimal repair, regression coverage, and release-note update.
3. Merge it into `main` after the full protected checks, tag the reviewed repair, and merge the same
   branch into `develop` before deletion.

## Protected-branch contract

`develop` is the default branch. Both `develop` and `main` require pull requests, strict required
checks, resolved conversations, administrator enforcement, and disabled force pushes and deletion.
The required checks are:

- `branch-policy`;
- `verify`;
- `Migration audit (ubuntu-latest)`;
- `Migration audit (macos-latest)`.

The branch-policy workflow rejects working branches aimed at `main` and rejects unknown branch
prefixes. Merge commits are reserved for the release and hotfix routes above; ordinary work is
squashed into `develop`.
