# Why I built Migration Doctor

Migration Doctor began as a deliberately role-aligned portfolio project for the
[Developer Experience Engineer role in Seoul](https://openai.com/careers/developer-experience-engineer-seoul-south-korea/).
The goal was not to add another generic AI demo. It was to show, in one public artifact, how I
choose a developer problem, build the underlying tool, explain it, measure it, protect its users,
and turn feedback into product changes.

This document is a project case study, not an OpenAI endorsement. Migration Doctor remains an
unofficial pre-alpha tool.

## Why this problem

My existing work already demonstrated full-stack AI product delivery, accessibility, multimodal
systems, and production operations. The missing public evidence was different:

| Developer Experience capability | Evidence gap | Migration Doctor response |
| --- | --- | --- |
| Inspiring developer tool or sample | No public OpenAI developer tool authored end to end | English CLI, report bundle, composite Action, and Codex audit skill |
| Technical teaching | Most existing public writing was in Korean | English quickstart, architecture, methodology, safety, limitations, and rule-authoring guides |
| Developer empathy | No measured external first-use workflow | Consent-aware protocol and deterministic anonymized evidence summarizer |
| Product feedback | No public feedback-to-roadmap loop | Source-drift review, friction ledger, and explicit evidence gates |
| Responsible AI and safety | Safety experience existed but was scattered across private systems | Local read-only detection, narrow automation tiers, abstention, redaction, and fail-closed verification |
| End-to-end ownership | Strong product evidence, but not in a standalone developer tool | Problem selection, implementation, evaluation, documentation, release, maintenance, and study design in one repository |

OpenAI API migrations are a useful test of Developer Experience judgment because they combine
rapidly changing documentation, static code evidence, stateful application behavior, and pressure
to automate. A tool that merely replaces strings would be easy to demo and unsafe to trust.

## Product thesis

> Static analysis should find evidence. Official sources should constrain the plan. Codex should
> handle semantic edits. Tests should decide whether the migration is acceptable.

That thesis produced five deliberate decisions.

### 1. Detection is deterministic and local

The scanner does not send repositories to a model and does not need an API key. It reports exact
locations and minimized evidence. This keeps the default onboarding path private, reproducible,
and useful in CI.

### 2. Guidance is locked to reviewed official sources

Each migration edge points to dated source records and exact official Markdown hashes. A scheduled
gate detects upstream drift but never changes a rule automatically. On 2026-08-26, the review gate
detected changes in four current OpenAI documents; the claims and both migration edges were reviewed
before new records and hashes replaced the active lock.

### 3. Automation follows evidence, not ambition

- Tier A previews a syntax-local edit and verifies it in a temporary copy.
- Tier B is reserved for semantic, source-backed changes with trusted verification.
- Tier C explains the required work and abstains from changing code.

The current Assistants analysis remains Tier C. That is a product decision, not an unfinished demo
claim: changing conversation state, tool loops, streaming, and persistence without behavioral
evidence would trade developer confidence for feature count.

### 4. Codex is behind an unreachable production boundary

The repository includes an isolated Codex adapter and negative security tests, but no released rule
or CLI command can invoke it. The boundary demonstrates how I would constrain semantic remediation;
it does not pretend that a fake-executable test is live Codex or OpenAI API evidence.

### 5. Reports are teaching surfaces

Markdown, canonical JSON, SARIF, and script-free HTML are generated from the same normalized report.
The terminal serves an individual developer, SARIF serves code review, JSON serves automation, and
HTML serves explanation without creating four different interpretations of the same result.

## Evidence shipped

The reviewed `v0.1.0-alpha.1` release established:

- one constrained transcription-model migration in JavaScript, TypeScript, and Python;
- review-only Assistants inventory in all three languages;
- four deterministic report formats and a SHA-pinned composite GitHub Action;
- 216 tests at the release handoff, plus separately reviewed source-drift and SDK compatibility
  workflows;
- 120 generated synthetic instances from 42 authored templates, reported only within that corpus;
- a pinned public-repository evaluation with manually reviewed labels and explicit recall boundaries;
- source archives and a published checksum, while clearly retaining unsigned-tag limitations.

The exact scope and caveats live in the [README](../README.md),
[methodology](methodology.md), and [limitations](limitations.md).

## The Developer Experience loop

The project is intentionally evaluated as a loop rather than a feature checklist:

```text
build → teach → observe developers → synthesize feedback → improve the product
```

| Stage | Current evidence | Honest status |
| --- | --- | --- |
| Build | Public CLI, Action, reports, analyzers, verification, and pre-release | Complete for the declared pre-alpha scope |
| Teach | English quickstart, sample report, technical docs, 90-second demo runbook, and deterministic recording preflight | Prepared; video recording is pending |
| Observe | Frozen-revision first-use protocol and anonymized summary schema | Instrumented; no external sessions claimed yet |
| Synthesize | Product-feedback ledger separates official-source observations, internal hypotheses, and external evidence | Ready for external results |
| Improve | Source-drift maintenance already produced a tested fix; usability fixes require participant evidence | Partially demonstrated |

The missing external sessions are visible on purpose. A portfolio case study should make the next
evidence-producing action obvious instead of turning a plan into a result.

## What this demonstrates

- I can turn a broad role requirement into a concrete developer problem and bounded product.
- I can build across static analysis, schemas, CLI design, CI, reports, security boundaries, and
  documentation.
- I treat onboarding, error interpretation, privacy, and evidence quality as product surfaces.
- I update quickly when official inputs change without silently accepting new guidance.
- I can explain what a system proves and where it must abstain.

## What it does not demonstrate yet

- representative usability or adoption;
- live OpenAI API parity;
- a production Codex remediation route;
- a completed Assistants transformation;
- package-registry distribution;
- community teaching, event delivery, or repeated external use.

Those are evidence boundaries, not claims to hide. The next high-value step is to complete at least
three external first-use sessions, fix the two largest reproducible friction points, and publish the
bounded aggregate alongside the frozen tool revision.
