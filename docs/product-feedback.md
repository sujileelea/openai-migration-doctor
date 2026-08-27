# Product feedback ledger

This ledger separates observed evidence from hypotheses. It records feedback about Migration Doctor
and source ambiguity relevant to developer tooling; it is not presented as representative feedback
about OpenAI developers or products.

## Evidence classes

- **Official-source observation**: directly reproducible from a reviewed official document.
- **Repository observation**: reproduced in this repository or its CI.
- **External developer observation**: recorded through the first-use protocol and backed by an
  anonymized checked-in aggregate.
- **Hypothesis**: plausible friction that must not be described as user feedback until observed.

## Current ledger

| Evidence class | Observation | Product response | Status |
| --- | --- | --- | --- |
| Official-source observation | The Assistants migration guide conceptually maps Assistants configuration to reusable Prompt objects, while the same guide and deprecations material warn that reusable Prompt objects are also deprecated. | The durable Tier C destination keeps configuration in application code, uses Responses for execution, and makes Conversations conditional. The source graph preserves all three reviewed pages. | Implemented and source-locked |
| Repository observation | Scheduled source-drift checks failed after official pages changed; a 2026-08-26 review found four changed canonical documents and a 2026-08-27 follow-up found another Prompt migration change. | Re-review claims before creating new dated records; never accept upstream hashes automatically. | Implemented and green locally |
| Repository observation | Three source-lock tests depended on an obsolete dated filename after the active records changed. | Resolve the currently locked source artifact from `migration.lock` in tests. | Fixed with regression coverage |
| Hypothesis | First-time users may interpret report exit `1` as a tool failure. | Measure this as the controlled `exit-code` interpretation category and state the contract in the demo. | Awaiting external sessions |
| Hypothesis | The source-build prerequisites may delay time to first report compared with the SHA-pinned Action. | Assign both tracks under one frozen revision and compare only within the observed sample. | Awaiting external sessions |

No external developer observation is claimed yet.

## Feedback for documentation surfaces

The current official materials are individually explicit, but a developer has to reconcile two
separate transitions:

1. Assistants to Responses and, when durable state is needed, Conversations.
2. Reusable Prompt objects to application-owned prompt content.

A durable migration overview could reduce ambiguity by putting both transitions in the first
decision table and distinguishing temporary conceptual mapping from the long-lived application
architecture. This is an inference from the reviewed source set, not a measured developer complaint.

## External feedback workflow

Use the [external first-use protocol](first-use-study.md). When a study round finishes:

1. freeze and record the exact tool revision;
2. generate a deterministic aggregate with `corepack pnpm usability:summarize`;
3. add only the reviewed anonymized summary;
4. use the generated friction-candidate order as the triage queue, reproduce each candidate, and
   preserve the outcome behind any rejected candidate;
5. fix the two highest-impact reproducible items with tests or file scoped follow-up issues;
6. update this ledger and any README or quickstart claim in the same change.

Raw participant notes, quotes, consent records, private repository details, and identifying metadata
remain outside this repository.
