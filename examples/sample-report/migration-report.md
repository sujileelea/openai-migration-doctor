# Migration Doctor Scan

Source lock: `3c27c078ca6e5327a89734e2c6e89afdee5d0b6b96cd3114ca19bc7920d3d01e`

Blocking findings: **3** / 4

## Findings

### `openai.transcriptions.model.gpt-4o-mini-transcribe-2025-03-20`

- Location: `src/index.cjs:7:11`
- Evidence: `gpt-4o-mini-transcribe-2025-03-20`
- Confidence: high
- Automation tier: A
- Analysis family: `model-snapshot`
- Feature: `model-snapshot`
- Pattern: `commonjs`
- Disposition: supported
- Human review: required
- Recommended replacement: `gpt-4o-mini-transcribe-2025-12-15`
- Shutdown: 2027-01-20
- Official sources:
  - [Deprecations | OpenAI API](https://developers.openai.com/api/docs/deprecations)
  - [GPT-4o mini Transcribe Model | OpenAI API](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)

### `openai.assistants.api.runs`

- Location: `src/index.cjs:10:6`
- Evidence: `client.beta.threads.runs.create`
- Confidence: high
- Automation tier: C
- Analysis family: `assistants-api`
- Feature: `runs`
- Pattern: `commonjs`
- Disposition: supported
- Reason code: `manual-migration-required`
- Human review: required
- Abstention: Assistants API usage is confirmed, but Migration Doctor does not transform stateful API integrations.
- Shutdown: 2026-08-26
- Official sources:
  - [Deprecations | OpenAI API](https://developers.openai.com/api/docs/deprecations)
  - [Assistants migration guide | OpenAI API](https://developers.openai.com/api/docs/assistants/migration)
  - [Migrate from prompt objects | OpenAI API](https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object)

### `openai.assistants.api.threads`

- Location: `src/index.cjs:10:6`
- Evidence: `client.beta.threads.runs.create`
- Confidence: high
- Automation tier: C
- Analysis family: `assistants-api`
- Feature: `threads`
- Pattern: `commonjs`
- Disposition: supported
- Reason code: `manual-migration-required`
- Human review: required
- Abstention: Assistants API usage is confirmed, but Migration Doctor does not transform stateful API integrations.
- Shutdown: 2026-08-26
- Official sources:
  - [Deprecations | OpenAI API](https://developers.openai.com/api/docs/deprecations)
  - [Assistants migration guide | OpenAI API](https://developers.openai.com/api/docs/assistants/migration)
  - [Migrate from prompt objects | OpenAI API](https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object)

### `openai.assistants.feature.streaming`

- Location: `src/index.cjs:10:6`
- Evidence: `client.beta.threads.runs.create`
- Confidence: high
- Automation tier: C
- Analysis family: `assistants-api`
- Feature: `streaming`
- Pattern: `commonjs`
- Disposition: supported
- Reason code: `manual-migration-required`
- Human review: required
- Abstention: Assistants API usage is confirmed, but Migration Doctor does not transform stateful API integrations.
- Shutdown: 2026-08-26
- Official sources:
  - [Deprecations | OpenAI API](https://developers.openai.com/api/docs/deprecations)
  - [Assistants migration guide | OpenAI API](https://developers.openai.com/api/docs/assistants/migration)
  - [Migrate from prompt objects | OpenAI API](https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object)
