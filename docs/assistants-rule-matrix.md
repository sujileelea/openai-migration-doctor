# Assistants API TypeScript rule matrix

Phase 3 inventories deprecated Assistants API usage without transforming it. Every positive or
high-signal unsupported finding is Tier C, requires human review, and points to the locked product
edge:

```text
Assistants API -> Responses API + Conversations API
```

Responses is the execution destination. Conversations is conditional on durable server-side state.
Assistant model selection, instructions, and tool declarations move to application-owned
configuration; reusable Prompt objects are not a durable destination.

## Feature rules

| Feature | Rule ID | Confirmed evidence | Result |
| --- | --- | --- | --- |
| Assistants | `openai.assistants.api.assistants` | Reviewed `client.beta.assistants.*(...)` method | Tier C analysis only |
| Threads | `openai.assistants.api.threads` | Reviewed Thread, Message, composite Thread/Run, or nested Run method | Tier C analysis only |
| Runs | `openai.assistants.api.runs` | Reviewed `createAndRun*`, `threads.runs.*`, or Run Step method | Tier C analysis only |
| Streaming | `openai.assistants.feature.streaming` | Reviewed stream helper or unique inline `stream: true` | Tier C analysis only |
| Tools | `openai.assistants.feature.tools` | Static non-empty inline tool array, direct tool resources, or tool-output helper | Tier C analysis only |
| File search | `openai.assistants.feature.file-search` | Inline `type: "file_search"` or direct `tool_resources.file_search` | Tier C analysis only |
| Code interpreter | `openai.assistants.feature.code-interpreter` | Inline `type: "code_interpreter"` or direct `tool_resources.code_interpreter` | Tier C analysis only |

Assistants, Threads, and Runs findings have `error` severity. Behavioral facets have `warning`
severity. A nested Runs call emits both Threads and Runs findings because a Run executes against a
Thread. Evidence contains only the callee expression, not request arguments, instructions, message
content, tool arguments, or other customer data.

## Reviewed methods

| Surface | Exact methods |
| --- | --- |
| `beta.assistants` | `create`, `retrieve`, `update`, `list`, `delete`, `del` |
| `beta.threads` | `create`, `retrieve`, `update`, `delete`, `del`, `createAndRun`, `createAndRunPoll`, `createAndRunStream` |
| `beta.threads.messages` | `create`, `retrieve`, `update`, `list`, `delete`, `del` |
| `beta.threads.runs` | `create`, `retrieve`, `update`, `list`, `cancel`, `createAndPoll`, `createAndStream`, `poll`, `stream`, `submitToolOutputs`, `submitToolOutputsAndPoll`, `submitToolOutputsStream` |
| `beta.threads.runs.steps` | `retrieve`, `list` |

Both current `delete` spellings and legacy OpenAI Node `del` aliases are inventoried. A call rooted
in a proven OpenAI client but outside this allowlist abstains with `unsupported-method`.

## Pattern boundary

| Pattern | Classification |
| --- | --- |
| Runtime default or named `OpenAI` import plus same-file `const` construction | Supported |
| Renamed runtime import | Supported as `import-alias` |
| Same-file `const` client alias | Supported as `client-alias` |
| Same-file `const` `beta`, resource, or nested resource alias | Supported as `property-alias` |
| Parameter typed by an exact `openai` `OpenAI` import | Abstain with `wrapper-parameter` |
| Detached method alias | Abstain with `method-alias` |
| Bracket or optional member access | Abstain with `computed-member-access` or `optional-member-access` |
| `.call`, `.apply`, or `.bind` invocation | Abstain with `indirect-invocation` |
| Non-inline request object | Keep proven primary API features; do not infer request-derived facets |
| Spread, computed, duplicate, or dynamic inline facet | Keep proven primary features and abstain on the affected streaming or tool facet |

Comments, documentation strings, lookalike clients, type-only constructor use, Responses API tools,
standalone tool configuration, and `purpose: "assistants"` file uploads are negative controls. The
last case remains valid in current file-search workflows and is not evidence of deprecated API use.

The analyzer intentionally emits no finding when OpenAI provenance cannot be established. Current
silent boundaries include cross-file clients, factory-created clients, CommonJS construction,
mutable or destructured aliases, untyped wrapper parameters, constructor-injected or class-field
receivers, namespace imports, and dynamic namespace selection. These are recall limits, not proof
that a repository is migrated.

## Measured synthetic gate

The declared Phase 3 gate is at least 99% precision and 95% recall on the supported subset, plus
exact routing for every labeled high-signal abstention.

The checked-in TypeScript corpus currently measures:

| Measure | Result |
| --- | ---: |
| Supported atomic labels | 19 |
| Supported true positives / false positives / false negatives | 19 / 0 / 0 |
| Supported precision / recall | 100% / 100% |
| Labeled abstention routes matched | 13 / 13 |
| Reviewed method calls | 34 |
| Atomic findings in the method matrix | 58 |

These are deterministic results on authored fixtures, not a public benchmark or a claim about
arbitrary repositories. The Phase 6 public benchmark remains separate and requires at least 100
labeled TypeScript fixtures before benchmark-quality claims are made.
