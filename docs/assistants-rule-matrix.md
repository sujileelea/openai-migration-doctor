# Assistants API rule matrix

Migration Doctor inventories deprecated Assistants API usage in JavaScript, TypeScript, and Python without
transforming it. Every positive or high-signal unsupported finding is Tier C, requires human review,
and points to the locked product edge:

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

### JavaScript and TypeScript

| Surface | Exact methods |
| --- | --- |
| `beta.assistants` | `create`, `retrieve`, `update`, `list`, `delete`, `del` |
| `beta.threads` | `create`, `retrieve`, `update`, `delete`, `del`, `createAndRun`, `createAndRunPoll`, `createAndRunStream` |
| `beta.threads.messages` | `create`, `retrieve`, `update`, `list`, `delete`, `del` |
| `beta.threads.runs` | `create`, `retrieve`, `update`, `list`, `cancel`, `createAndPoll`, `createAndStream`, `poll`, `stream`, `submitToolOutputs`, `submitToolOutputsAndPoll`, `submitToolOutputsStream` |
| `beta.threads.runs.steps` | `retrieve`, `list` |

Both current `delete` spellings and legacy OpenAI Node `del` aliases are inventoried. A call rooted
in a proven OpenAI client but outside this allowlist abstains with `unsupported-method`.

### Python

| Surface | Exact methods |
| --- | --- |
| `beta.assistants` | `create`, `retrieve`, `update`, `list`, `delete` |
| `beta.threads` | `create`, `retrieve`, `update`, `delete`, `create_and_run`, `create_and_run_poll`, `create_and_run_stream` |
| `beta.threads.messages` | `create`, `retrieve`, `update`, `list`, `delete` |
| `beta.threads.runs` | `create`, `retrieve`, `update`, `list`, `cancel`, `create_and_poll`, `create_and_stream`, `poll`, `stream`, `submit_tool_outputs`, `submit_tool_outputs_and_poll`, `submit_tool_outputs_stream` |
| `beta.threads.runs.steps` | `retrieve`, `list` |

Python uses the same feature mapping as TypeScript with the SDK's snake_case method names. A direct
call rooted in a proven Python client but outside this allowlist abstains with `unsupported-method`.

## JavaScript and TypeScript pattern boundary

| Pattern | Classification |
| --- | --- |
| Runtime default or named `OpenAI` import plus same-file `const` construction | Supported |
| Renamed runtime import | Supported as `import-alias` |
| Reviewed `require("openai")`, `.default`, `.OpenAI`, or `{ OpenAI }` constructor plus same-file `const` construction | Supported as `commonjs` |
| Same-file `const` client alias | Supported as `client-alias` |
| Same-file `const` `beta`, resource, or nested resource alias | Supported as `property-alias` |
| Parameter typed by an exact `openai` `OpenAI` import | Abstain with `wrapper-parameter` |
| Detached method alias | Abstain with `method-alias` |
| Bracket or optional member access | Abstain with `computed-member-access` or `optional-member-access` |
| `.call`, `.apply`, or `.bind` invocation | Abstain with `indirect-invocation` |
| Non-inline request object | Keep proven primary API features; do not infer request-derived facets |
| Spread, computed, duplicate, or dynamic inline facet | Keep proven primary features and abstain on the affected streaming or tool facet |

Comments, documentation strings, lookalike clients, a locally bound `require`, type-only constructor use, Responses API tools,
standalone tool configuration, and `purpose: "assistants"` file uploads are negative controls. The
last case remains valid in current file-search workflows and is not evidence of deprecated API use.

## Python pattern boundary

| Pattern | Classification |
| --- | --- |
| Unconditional exact or renamed `OpenAI` / `AsyncOpenAI` import plus one lexically preceding visible direct assignment, including a closure binding | Supported as `direct` or `import-alias` |
| Unconditional exact or renamed `openai` module import plus direct constructor assignment | Supported as `direct` or `import-alias` |
| Reviewed direct Assistant, Thread, Message, Run, or Run Step method | Supported |
| Reviewed stream helper or explicit `stream=True` | Supported streaming facet |
| Static non-empty inline `tools=[...]` with literal tool types | Supported tools and known specialized facets |
| Static inline `tool_resources={...}` with known resource keys | Supported tools and known specialized facets |
| Static direct or nested message `attachments=[...]` with literal tool types | Supported tools and known specialized facets |
| Explicit non-literal `stream`, `tools`, or `tool_resources` value | Abstain on the affected facet |
| Direct static method outside the reviewed allowlist | Abstain with `unsupported-method` |
| Reassigned or shadowed constructor or client | Silent |
| Factory, inline constructor, forward client binding, client/resource alias, detached method, dynamic member, or cross-file receiver | Silent |

The analyzers intentionally emit no finding when OpenAI provenance cannot be established. Their
silent boundaries are recall limits, not proof that a repository is migrated.

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

The checked-in Python fixture suite separately asserts 21 atomic findings on representative direct
calls, all 31 reviewed method calls and their 55 feature findings, five explicit dynamic-facet or
unsupported-method abstentions, aliased and asynchronous clients, and zero findings for lookalike,
shadowed, and reassigned clients. These exact authored-fixture checks are not a public Python
precision or recall benchmark.
