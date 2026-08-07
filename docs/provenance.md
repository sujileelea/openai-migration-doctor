# Provenance policy

Migration Doctor accepts only material whose origin, license, and review path are explicit. This
policy applies to source code, fixtures, documentation, schemas, generated artifacts, and other
content proposed for the repository.

## First-party work

Project code, authored fixtures, tests, reports, and documentation are licensed under Apache-2.0.
Contributors must have the right to submit their work. Unless explicitly stated otherwise, an
intentional contribution accepted into this repository is submitted under Apache-2.0 as described
by Section 5 of the license.

Fixtures must be synthetic or contributed with documented permission. They must not contain
customer code, secrets, personal data, proprietary prompts, or copied examples whose reuse terms
are unknown.

## Third-party material

Do not copy third-party code, fixtures, documentation bodies, schemas, generated examples, or media
into the repository without recording all of the following in the same change:

1. the upstream owner and canonical source URL;
2. the exact version, release, or commit;
3. the upstream license and compatibility review;
4. which files were copied and what was changed;
5. every attribution, notice, or redistribution file the upstream terms require.

Unknown origin, ambiguous permission, incompatible terms, or a missing required notice blocks the
change. A URL or public availability alone is not permission to copy.

Package-manager dependencies are not vendored. Their exact versions and integrity data remain in
`pnpm-lock.yaml` or `packages/language-python/uv.lock`, and each dependency remains under its own
license. Lock metadata does not relicense dependency source under the project license.

## Official migration sources

Official OpenAI documentation is evidence for reviewed migration claims, not repository content.
Source records retain the canonical URL, retrieval time, content hash, and a narrowly paraphrased
claim. Raw page bodies stay outside the repository. A source change requires a new dated record,
human review, and a regenerated `migration.lock`; historical records are not overwritten.

External validation schemas follow the same boundary. The SARIF gate downloads the official OASIS
schema only during validation, enforces a response-size limit and pinned SHA-256, and does not
commit the schema body.

## Generated artifacts

Generated files may be committed only when their first-party inputs and generating command are
documented and reproducible. Generated output must not embed unreviewed third-party source. Measured
benchmark ledgers must identify the tool revision, corpus hash, environment, and clean-worktree
state rather than presenting generated data as an external standard.

## Review checklist

Every change that introduces external material must answer these questions before merge:

- Can a reviewer trace every copied byte to a stable upstream revision?
- Does the recorded license allow this repository's use and distribution?
- Are required notices present and project claims clearly separated from upstream claims?
- Is the smallest necessary excerpt used, with raw bodies kept external when a hash and source URL
  are sufficient?
- Do tests or lock checks fail when the reviewed input drifts?

The current repository contains no copied external source fixtures, raw OpenAI documentation pages,
or vendored SARIF schema. Installed dependencies are acquired separately and remain under the
licenses declared by their upstream distributions.
