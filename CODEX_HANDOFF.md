# Codex Handoff — Migration Doctor for OpenAI APIs

> This is the historical bootstrap plan. For the current release state, open issues, dependency
> order, verification commands, and next-session procedure, read
> [`NEXT_SESSION_HANDOFF.md`](NEXT_SESSION_HANDOFF.md).

## 1. Mission

Build a production-grade, unofficial developer tool that helps teams migrate OpenAI API integrations safely.

The system must combine:

1. deterministic repository analysis;
2. a versioned migration graph grounded in official OpenAI sources;
3. risk-tiered deterministic or Codex-assisted transformations;
4. behavioral verification;
5. public accuracy and performance benchmarks.

The user has explicitly removed schedule pressure. Optimize for **correctness, reproducibility, developer experience, and scan performance**, not feature count or demo speed.

## 2. Handoff baseline (historical)

This section records the repository state when this handoff was written. For the
current implementation status, use `README.md`, `docs/limitations.md`, and the
Git history.

- The product concept and target quality bar are locked.
- No implementation existed at handoff time.
- `README.md` is the public product contract and must remain truthful.
- Commands, performance numbers, and coverage in the README are targets until measured.
- Do not describe a planned feature as implemented.
- There was no repository-level `AGENTS.md` at handoff time. The current file
  contains only verified commands, durable constraints, and the definition of done.

## 3. Read before changing code

Read these in order:

1. `README.md`
2. this file
3. [OpenAI API deprecations](https://developers.openai.com/api/docs/deprecations)
4. [Assistants migration guide](https://developers.openai.com/api/docs/assistants/migration)
5. [Agent Builder migration guide](https://developers.openai.com/api/docs/guides/agent-builder/migrate-from-agent-builder)
6. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
7. [AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
8. [Build skills](https://learn.chatgpt.com/docs/build-skills)

Before encoding any migration rule, fetch or verify the current official source. Documentation changes are input data, not assumptions.

If current official sources disagree:

- preserve both sources;
- record retrieval timestamps;
- emit a source-conflict finding;
- require human review;
- do not invent a resolution.

## 4. Locked product decisions

Do not reopen these decisions without concrete evidence:

- The public name is **Migration Doctor for OpenAI APIs**.
- The README must state that the tool is unofficial and not endorsed by OpenAI.
- Detection is deterministic and local; no LLM is used for repository scanning.
- Codex remediation is opt-in and occurs only after a source-backed plan exists.
- The same repository plus the same `migration.lock` must produce deterministic findings.
- Every rule has a source, positive fixture, negative fixture, automation tier, and verification contract.
- Unsupported migrations abstain rather than guessing.
- No automatic push, pull request, merge, deployment, or full-access execution.
- TypeScript is the first vertical slice. Python enters only through the shared language-adapter contract after the core is proven.
- Markdown and JSON reporters precede SARIF, HTML, GitHub Action, and plugin packaging.
- A skill is created after the underlying workflow is stable; a plugin is packaging, not the implementation core.

## 5. Product invariants

Every implementation decision must preserve these invariants:

### Evidence

- A finding points to an exact repository location.
- Migration guidance points to official source URLs.
- Dates and recommendations are versioned data, not constants scattered through code.
- A recommended destination is checked against the graph for its own deprecation status.

### Safety

- Scan never mutates the target repository.
- Plan never mutates the target repository.
- Migrate defaults to patch preview.
- Verify runs in an isolated worktree or temporary repository.
- Codex receives the smallest sufficient file and instruction scope.
- Verification failure cannot be reported as migration success.

### Truthfulness

- Target metrics are labeled as targets.
- Measured metrics include hardware, OS, corpus, cache state, and tool version.
- A feature is listed as supported only when its rule matrix and tests are public.
- LLM judgment alone is never used as the pass/fail oracle.

### Performance

- No network or API dependency in detection.
- Unchanged files are skipped through content hashes.
- Candidate-file prefiltering happens before expensive parsing.
- Independent analysis is parallelizable.
- Performance regressions are tested, not narrated away.

## 6. Initial technical stack

Use these defaults unless a measured spike demonstrates a better choice:

- Node.js 20 or newer
- pnpm workspace
- TypeScript with `strict: true`
- ESM packages
- Vitest
- Zod for data validation and stable serialized schemas
- a small CLI framework such as Commander
- TypeScript Compiler API for semantic confirmation and transforms
- a cheap text/token prefilter before AST construction
- SHA-256 content hashes for incremental cache keys
- worker threads only after a single-process baseline is correct and benchmarked
- Markdown and JSON as the first reporters
- Python adapter later, using LibCST for formatting-preserving transforms
- Codex behind an adapter interface; core packages must not depend directly on Codex

Do not introduce Rust, a database, a web framework, or hosted infrastructure before benchmark evidence shows they are necessary.

## 7. Target package boundaries

```text
packages/core
  Domain schemas, migration graph, rule engine, orchestration.

packages/cli
  Commands, config resolution, exit codes, terminal UX.

packages/language-typescript
  Candidate discovery, AST confirmation, findings, codemods.

packages/language-python
  Python adapter added after the shared contract stabilizes.

packages/codex-adapter
  Opt-in Codex planning and patch proposal behind a narrow interface.

packages/reporters
  Markdown and JSON first; SARIF and HTML later.

data/sources
  Retrieved source metadata and immutable raw-source references.

data/migrations
  Reviewed migration graph entries; no unreviewed generated data in releases.

fixtures
  Positive, negative, ambiguous, and behavior-verification repositories.

benchmarks
  Accuracy and performance corpus, runner, and result ledger.
```

Core cannot import CLI, reporters, language adapters, or Codex. Dependency direction must stay inward.

## 8. Core schemas

Start with versioned Zod schemas and inferred TypeScript types. The names may evolve, but the information contract may not be weakened.

```ts
type SourceRef = {
  url: string;
  title: string;
  retrievedAt: string;
  contentHash: string;
};

type MigrationEdge = {
  id: string;
  from: ResourceRef;
  to: ResourceRef | null;
  announcedAt?: string;
  shutdownAt?: string;
  sources: SourceRef[];
  languages: Array<"typescript" | "python">;
  sdkConstraints?: string[];
  behaviorChanges: string[];
  automationTier: "A" | "B" | "C";
  reviewRequired: boolean;
};

type Finding = {
  schemaVersion: string;
  ruleId: string;
  severity: "info" | "warning" | "error";
  location: {
    file: string;
    line: number;
    column: number;
  };
  evidence: string;
  migrationEdgeIds: string[];
  confidence: "low" | "medium" | "high";
  automationTier: "A" | "B" | "C";
  abstentionReason?: string;
};

type PatchPlan = {
  findingIds: string[];
  allowedFiles: string[];
  forbiddenFiles: string[];
  sourceLockHash: string;
  verificationContracts: string[];
  requiresCodex: boolean;
};

type VerificationResult = {
  passed: boolean;
  checks: Array<{
    id: string;
    passed: boolean;
    evidence: string[];
  }>;
  changedFiles: string[];
  durationMs: number;
  tokenUsage?: number;
  estimatedCost?: number;
};
```

Define `ResourceRef` during schema work. It must distinguish a model ID, API surface, SDK symbol, and product without relying on display strings.

Every serialized root object requires `schemaVersion`.

## 9. Implementation sequence and gates

This is a dependency order, not a schedule.

### Phase 0 — Repository bootstrap

Deliver:

- pnpm workspace;
- strict TypeScript config;
- core, CLI, TypeScript adapter, and reporters packages;
- Vitest and lint/format/typecheck commands;
- CI for the deterministic core only;
- short `AGENTS.md` containing actual commands and invariants.

Gate:

- clean install works from a fresh clone;
- build, test, lint, and typecheck pass;
- no OpenAI API key is needed.

### Phase 1 — One end-to-end deterministic vertical slice

Implement exactly one rule first:

- a deprecated model identifier with an official replacement;
- one positive TypeScript fixture;
- at least two negative controls;
- a source entry and `migration.lock`;
- exact file and line finding;
- Markdown and JSON output;
- a deterministic Tier A patch preview;
- a verification test proving only the intended literal changed.

Gate:

- `scan -> plan -> patch preview -> verify` works end to end;
- same inputs produce byte-stable JSON;
- negative fixtures produce zero findings;
- README still accurately describes the implementation state.

Do not implement Assistants migration before this slice passes.

### Phase 2 — Migration graph and source-conflict behavior

Deliver:

- graph traversal;
- destination-deprecation checks;
- source retrieval metadata;
- conflict records;
- a fixture whose destination is also deprecated;
- explicit Tier C abstention when sources require human interpretation.

Gate:

- no conflicting source is silently preferred;
- reports show both sources and the review requirement;
- graph cycles and missing destinations are tested.

### Phase 3 — Assistants analysis without transformation

Detect and classify:

- Assistants;
- Threads;
- Runs;
- streaming;
- tools;
- file search;
- code interpreter;
- wrapper and alias patterns.

Gate:

- publish a feature-level rule matrix;
- achieve the declared precision/recall threshold on the supported subset;
- unsupported patterns abstain with a useful reason;
- no Codex integration yet.

### Phase 4 — Behavioral contracts

Create before/after fixture contracts for:

- text output shape;
- conversation state;
- streaming sequence;
- tool call sequence and arguments;
- error and retry behavior;
- changed-file allowlists.

Gate:

- contracts can fail against intentionally broken migrations;
- verification evidence identifies the failing behavior;
- no live API is required for the default test suite.

If live API smoke tests are later added, keep them opt-in and record model, SDK, date, token usage, and cost.

### Phase 5 — Codex adapter

Only now add Codex-assisted remediation.

Requirements:

- receive a frozen `PatchPlan`;
- expose only allowed files;
- forbid push, deployment, migration execution, and secret access;
- request structured output where supported;
- preserve a redacted audit ledger;
- run in an isolated worktree;
- pass the same verification contracts as deterministic transforms.

Gate:

- removing the Codex adapter does not affect scan or plan;
- malformed or incomplete Codex output fails closed;
- a deliberately unsafe proposal is rejected by the verifier;
- Codex cannot expand the allowed file set.

### Phase 6 — Accuracy and performance benchmark

Deliver:

- at least 100 labeled TypeScript fixtures before claiming benchmark quality;
- positive and negative controls;
- aliases, wrappers, dynamic configuration, comments, and dead code;
- cold and warm scan modes;
- peak memory and duration collection;
- a machine-readable result ledger;
- regression budgets in CI.

Targets:

- precision >= 99%;
- recall >= 95% on declared supported patterns;
- one million LOC cold scan <= 30 seconds;
- warm incremental scan <= 3 seconds;
- zero API calls for detection.

Gate:

- publish results with hardware, OS, corpus, cache state, commit SHA, and tool version;
- if a target is missed, report the measured result rather than weakening the methodology.

### Phase 7 — Python adapter

Implement the same language-adapter contract with LibCST. Do not duplicate core migration logic inside Python-specific code.

Gate:

- Python findings serialize to the same schema;
- formatting and comments are preserved;
- language-parity fixtures are added where semantics match;
- Python performance is measured separately.

### Phase 8 — Developer surfaces

After the core is stable:

- SARIF;
- static HTML report;
- GitHub Action;
- checked-in `.agents/skills/migration-audit/SKILL.md`;
- optional plugin packaging;
- contributor rule-authoring guide.

Gate:

- each surface calls the same core APIs;
- no surface reimplements migration logic;
- a new developer can produce a first report from the README alone.

## 10. Required fixture classes

Every rule family needs:

- direct positive usage;
- aliased import;
- wrapped SDK client;
- same string in a comment;
- same string in documentation;
- dead or test code classification;
- dynamic configuration;
- supported migration;
- unsupported variant;
- destination already deprecated;
- missing or conflicting official guidance.

Do not optimize only for the happy-path fixture shown in a demo.

## 11. CLI exit-code contract

Define and test stable exit codes early. Recommended starting contract:

- `0`: completed; no blocking findings;
- `1`: completed; blocking migration findings exist;
- `2`: invalid configuration or invocation;
- `3`: analysis incomplete because of parser or repository errors;
- `4`: source lock missing, stale beyond policy, or conflicted;
- `5`: migration or verification failed.

The CLI must distinguish “findings exist” from “the tool failed.”

## 12. Report requirements

Every report must contain:

- tool and schema version;
- repository revision when available;
- source lock hash;
- scan scope and exclusions;
- finding count by severity and automation tier;
- exact evidence locations;
- shutdown dates and source links;
- unsupported and abstained cases;
- analysis duration and cache state;
- redaction notice;
- verification results when a patch exists.

Markdown and JSON must agree. Add a contract test that renders both from the same normalized result object.

## 13. Testing strategy

Use layered tests:

1. schema tests;
2. migration-graph unit tests;
3. analyzer unit tests;
4. fixture integration tests;
5. codemod snapshot and semantic tests;
6. verifier negative tests;
7. CLI end-to-end tests;
8. benchmark regression tests;
9. optional live API smoke tests.

Avoid snapshots for unordered or unstable data. Normalize paths, timestamps, durations, and platform-specific output before comparisons.

## 14. Documentation requirements

Keep these documents honest and current:

- `README.md`: public product contract and measured results;
- `docs/architecture.md`: dependency boundaries and data flow;
- `docs/methodology.md`: corpus construction and metrics;
- `docs/safety.md`: permissions, redaction, and threat model;
- `docs/limitations.md`: unsupported patterns and known failure classes;
- `docs/product-feedback.md`: developer friction, source ambiguity, and feedback for product teams;
- `AGENTS.md`: only real commands, repo conventions, constraints, and definition of done.

When Codex makes the same mistake twice, write a short retrospective and update tests first. Add an `AGENTS.md` rule only when the mistake represents a durable repository convention.

## 15. Definition of done for the project

The project is not complete because a demo runs. It is complete when:

- supported coverage is published at feature level;
- accuracy and performance are independently reproducible;
- every rule is source-backed and fixture-tested;
- supported transforms preserve declared behavior;
- unsupported cases reliably abstain;
- local scanning requires no API key;
- Codex remediation is isolated, scoped, and auditable;
- a developer can use the tool from the README without the author present;
- feedback from Korean and global developers has produced documented product changes;
- portfolio claims use only measured results.

## 16. First Codex session prompt

Use this prompt in the new implementation session:

> Read `README.md` and `CODEX_HANDOFF.md` completely. Inspect the repository before editing. Start only with Phase 0 and Phase 1: bootstrap the strict TypeScript pnpm workspace and implement one deterministic, official-source-backed TypeScript migration rule end to end. Do not add Codex integration, Assistants transformation, Python, SARIF, HTML, GitHub Actions that require secrets, or plugin packaging yet. First write the schemas, positive and negative fixtures, migration source entry, and verification contract; then implement the smallest code that makes `scan -> plan -> patch preview -> verify` pass. Keep the README truthful, create a concise `AGENTS.md` only after real commands exist, run every relevant check, and report measured behavior and remaining limitations.

## 17. Handoff completion checklist

Before ending any Codex session:

- record the exact phase and gate status;
- list changed files;
- run and report build, typecheck, lint, and tests;
- report any benchmark executed and its environment;
- distinguish measured results from targets;
- update limitations for newly discovered unsupported cases;
- leave the worktree in a reviewable state;
- write the next smallest evidence-producing task.
