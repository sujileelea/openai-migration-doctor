import { canonicalJson, sha256 } from "@migration-doctor/core";

export const TYPESCRIPT_BENCHMARK_CORPUS_ID = "typescript-phase6-synthetic-v1";

export type BenchmarkFindingLabel = {
  family: "model-snapshot" | "assistants-api";
  feature:
    | "model-snapshot"
    | "assistants"
    | "threads"
    | "runs"
    | "streaming"
    | "tools"
    | "file-search"
    | "code-interpreter";
  pattern:
    | "direct"
    | "commonjs"
    | "import-alias"
    | "property-alias"
    | "client-alias"
    | "wrapper"
    | "method-alias"
    | "dynamic-member"
    | "dynamic-request"
    | "indirect-invocation";
  disposition: "supported" | "abstained";
  evidence: string;
  reasonCode?: string;
};

export type BenchmarkFixtureClass =
  | "alias"
  | "comment"
  | "dead-code"
  | "documentation"
  | "dynamic-configuration"
  | "indirect-invocation"
  | "negative-control"
  | "positive-control"
  | "test-code"
  | "unsupported-wrapper";

export type TypeScriptBenchmarkFixture = {
  id: string;
  relativeFile: string;
  classes: BenchmarkFixtureClass[];
  source: string;
  expectedFindings: BenchmarkFindingLabel[];
};

const SOURCE_MODEL = "gpt-4o-mini-transcribe-2025-03-20";

const modelFinding = (): BenchmarkFindingLabel => ({
  family: "model-snapshot",
  feature: "model-snapshot",
  pattern: "direct",
  disposition: "supported",
  evidence: SOURCE_MODEL,
});

const assistantsFinding = (
  feature: BenchmarkFindingLabel["feature"],
  pattern: BenchmarkFindingLabel["pattern"] = "direct",
): BenchmarkFindingLabel => ({
  family: "assistants-api",
  feature,
  pattern,
  disposition: "supported",
  evidence: "",
  reasonCode: "manual-migration-required",
});

const abstention = (
  feature: BenchmarkFindingLabel["feature"],
  pattern: BenchmarkFindingLabel["pattern"],
  reasonCode: string,
): BenchmarkFindingLabel => ({
  family: "assistants-api",
  feature,
  pattern,
  disposition: "abstained",
  evidence: "",
  reasonCode,
});

function sourceFile(id: string, index: number, testCode = false): string {
  const extensions = [".ts", ".mts", ".cts", ".tsx"] as const;
  const extension = testCode ? ".test.ts" : extensions[index % extensions.length];
  return `src/${id}${extension}`;
}

const modelPositiveTemplates: Array<(index: number) => string> = [
  (index) => `import OpenAI from "openai";
const client${index} = new OpenAI();
await client${index}.audio.transcriptions.create({ model: "${SOURCE_MODEL}", file: input });
`,
  (index) => `import Client${index} from "openai";
const client = new Client${index}();
await client.audio.transcriptions.create({ file: input, model: "${SOURCE_MODEL}" });
`,
  (index) => `import { OpenAI } from "openai";
const client${index} = new OpenAI();
await client${index}.audio.transcriptions.create({ "model": "${SOURCE_MODEL}", file: input });
`,
  (index) => `import { OpenAI as Client${index} } from "openai";
const client = new Client${index}();
await client.audio.transcriptions.create({
  file: input,
  model: "${SOURCE_MODEL}",
  language: "en",
});
`,
  (index) => `import OpenAI from "openai";
const client${index} = new OpenAI();
export async function transcribe${index}(input: unknown) {
  return client${index}.audio.transcriptions.create({ model: "${SOURCE_MODEL}", file: input });
}
`,
  (index) => `import OpenAI from "openai";
const client${index} = new OpenAI();
if (false) {
  void client${index}.audio.transcriptions.create({ model: "${SOURCE_MODEL}", file: input });
}
`,
  (index) => `import OpenAI from "openai";
const client${index} = new OpenAI();
describe("synthetic ${index}", () => {
  void client${index}.audio.transcriptions.create({ model: "${SOURCE_MODEL}", file: input });
});
`,
  (index) => `import OpenAI from "openai";
const client${index} = new OpenAI();
const result${index} = client${index}.audio.transcriptions.create({
  prompt: "synthetic",
  model: "${SOURCE_MODEL}",
  file: input,
});
void result${index};
`,
  (index) => `import OpenAI from "openai";
const client${index} = new OpenAI();
async function nested${index}() {
  if (enabled) {
    await client${index}.audio.transcriptions.create({ file: input, model: "${SOURCE_MODEL}" });
  }
}
void nested${index};
`,
  (index) => `import { OpenAI as AudioClient${index} } from "openai";
const audio = new AudioClient${index}();
void audio.audio.transcriptions.create({ model: "${SOURCE_MODEL}", file: input, temperature: 0 });
`,
  (index) => `import OpenAI from "openai";
const sdk${index} = new OpenAI();
const promise${index} = sdk${index}.audio.transcriptions.create({
  model: "${SOURCE_MODEL}",
  file: input,
  response_format: "json",
});
void promise${index};
`,
  (index) => `import OpenAI from "openai";
const sdk${index} = new OpenAI();
export const run${index} = () => sdk${index}.audio.transcriptions.create({
  file: input,
  model: "${SOURCE_MODEL}",
});
`,
];

const modelNegativeTemplates: Array<{
  classes: BenchmarkFixtureClass[];
  render(index: number): string;
}> = [
  {
    classes: ["negative-control", "comment"],
    render: (index) => `// Synthetic ${index}: model: "${SOURCE_MODEL}"
export const value${index} = true;
`,
  },
  {
    classes: ["negative-control", "documentation"],
    render: (index) => `export const documentation${index} = "Use ${SOURCE_MODEL} in old examples";
`,
  },
  {
    classes: ["negative-control"],
    render: (index) => `const request${index} = { model: "${SOURCE_MODEL}" };
void request${index};
`,
  },
  {
    classes: ["negative-control", "dynamic-configuration"],
    render: (index) => `import OpenAI from "openai";
const client${index} = new OpenAI();
const model${index} = "${SOURCE_MODEL}";
await client${index}.audio.transcriptions.create({ model: model${index}, file: input });
`,
  },
  {
    classes: ["negative-control", "dynamic-configuration"],
    render: (index) => `import OpenAI from "openai";
const client${index} = new OpenAI();
const key${index} = "model";
await client${index}.audio.transcriptions.create({ [key${index}]: "${SOURCE_MODEL}", file: input });
`,
  },
  {
    classes: ["negative-control", "dynamic-configuration"],
    render: (index) => `import OpenAI from "openai";
const client${index} = new OpenAI();
const base${index} = { file: input };
await client${index}.audio.transcriptions.create({ ...base${index}, model: "${SOURCE_MODEL}" });
`,
  },
  {
    classes: ["negative-control"],
    render: (index) => `import OpenAI from "openai";
const client${index} = new OpenAI();
await client${index}.audio.transcriptions.create({ model: "gpt-4o-mini-transcribe-2025-12-15", file: input });
`,
  },
  {
    classes: ["negative-control"],
    render: (index) => `class OpenAI${index} {}
const literal${index} = "${SOURCE_MODEL}";
void new OpenAI${index}();
void literal${index};
`,
  },
  {
    classes: ["negative-control"],
    render: (index) => `import type OpenAI from "openai";
const client${index} = new OpenAI();
await client${index}.audio.transcriptions.create({ model: "${SOURCE_MODEL}", file: input });
`,
  },
  {
    classes: ["negative-control", "unsupported-wrapper"],
    render: (index) => `import type OpenAI from "openai";
export function wrapped${index}(client: OpenAI) {
  return client.audio.transcriptions.create({ model: "${SOURCE_MODEL}", file: input });
}
`,
  },
  {
    classes: ["negative-control", "alias"],
    render: (index) => `import OpenAI from "openai";
const client${index} = new OpenAI();
const alias${index} = client${index};
await alias${index}.audio.transcriptions.create({ model: "${SOURCE_MODEL}", file: input });
`,
  },
  {
    classes: ["negative-control"],
    render: (index) => `import OpenAI from "openai";
await client${index}.audio.transcriptions.create({ model: "${SOURCE_MODEL}", file: input });
const client${index} = new OpenAI();
`,
  },
];

function modelFixtures(): TypeScriptBenchmarkFixture[] {
  const fixtures: TypeScriptBenchmarkFixture[] = [];
  for (let index = 0; index < 48; index += 1) {
    const templateIndex = index % modelPositiveTemplates.length;
    const id = `model-positive-${String(index + 1).padStart(3, "0")}`;
    const testCode = templateIndex === 6;
    const classes: BenchmarkFixtureClass[] = ["positive-control"];
    if ([1, 3, 9].includes(templateIndex)) classes.push("alias");
    if (templateIndex === 5) classes.push("dead-code");
    if (testCode) classes.push("test-code");
    fixtures.push({
      id,
      relativeFile: sourceFile(id, index, testCode),
      classes,
      source: (modelPositiveTemplates[templateIndex] as (value: number) => string)(index),
      expectedFindings: [modelFinding()],
    });
  }

  for (let index = 0; index < 48; index += 1) {
    const template = modelNegativeTemplates[index % modelNegativeTemplates.length];
    if (!template) throw new Error("Synthetic model benchmark template is missing.");
    const id = `model-negative-${String(index + 1).padStart(3, "0")}`;
    fixtures.push({
      id,
      relativeFile: sourceFile(id, index),
      classes: [...template.classes],
      source: template.render(index),
      expectedFindings: [],
    });
  }
  return fixtures;
}

type AssistantsTemplate = {
  classes: BenchmarkFixtureClass[];
  evidence: string;
  source: string;
  expectedFindings: BenchmarkFindingLabel[];
};

const assistantsSupportedTemplates: AssistantsTemplate[] = [
  {
    classes: ["positive-control"],
    evidence: "client.beta.assistants.retrieve",
    source: 'await client.beta.assistants.retrieve("asst_123");',
    expectedFindings: [assistantsFinding("assistants")],
  },
  {
    classes: ["positive-control"],
    evidence: "client.beta.threads.retrieve",
    source: 'await client.beta.threads.retrieve("thread_123");',
    expectedFindings: [assistantsFinding("threads")],
  },
  {
    classes: ["positive-control"],
    evidence: "client.beta.threads.runs.retrieve",
    source: 'await client.beta.threads.runs.retrieve("thread_123", "run_123");',
    expectedFindings: [assistantsFinding("threads"), assistantsFinding("runs")],
  },
  {
    classes: ["positive-control"],
    evidence: "client.beta.threads.createAndRunStream",
    source: 'await client.beta.threads.createAndRunStream({ assistant_id: "asst_123" });',
    expectedFindings: [
      assistantsFinding("threads"),
      assistantsFinding("runs"),
      assistantsFinding("streaming"),
    ],
  },
  {
    classes: ["positive-control"],
    evidence: "client.beta.assistants.create",
    source:
      'await client.beta.assistants.create({ model: "gpt-4o", tools: [{ type: "file_search" }] });',
    expectedFindings: [
      assistantsFinding("assistants"),
      assistantsFinding("tools"),
      assistantsFinding("file-search"),
    ],
  },
  {
    classes: ["positive-control"],
    evidence: "client.beta.assistants.create",
    source:
      'await client.beta.assistants.create({ model: "gpt-4o", tools: [{ type: "code_interpreter" }] });',
    expectedFindings: [
      assistantsFinding("assistants"),
      assistantsFinding("tools"),
      assistantsFinding("code-interpreter"),
    ],
  },
  {
    classes: ["positive-control"],
    evidence: "client.beta.threads.runs.create",
    source:
      'await client.beta.threads.runs.create("thread_123", { assistant_id: "asst_123", stream: true, tools: [{ type: "function" }] });',
    expectedFindings: [
      assistantsFinding("threads"),
      assistantsFinding("runs"),
      assistantsFinding("streaming"),
      assistantsFinding("tools"),
    ],
  },
  {
    classes: ["positive-control", "alias"],
    evidence: "runs.create",
    source:
      'const runs = client.beta.threads.runs; await runs.create("thread_123", { assistant_id: "asst_123" });',
    expectedFindings: [
      assistantsFinding("threads", "property-alias"),
      assistantsFinding("runs", "property-alias"),
    ],
  },
  {
    classes: ["positive-control", "alias"],
    evidence: "alias.beta.threads.create",
    source: "const alias = client; await alias.beta.threads.create();",
    expectedFindings: [assistantsFinding("threads", "client-alias")],
  },
  {
    classes: ["positive-control", "alias"],
    evidence: "client.beta.assistants.delete",
    source: 'await client.beta.assistants.delete("asst_123");',
    expectedFindings: [assistantsFinding("assistants", "import-alias")],
  },
  {
    classes: ["positive-control", "alias"],
    evidence: "beta.threads.retrieve",
    source: 'const beta = client.beta; await beta.threads.retrieve("thread_123");',
    expectedFindings: [assistantsFinding("threads", "property-alias")],
  },
  {
    classes: ["positive-control"],
    evidence: "client.beta.threads.messages.create",
    source:
      'await client.beta.threads.messages.create("thread_123", { role: "user", content: "hi" });',
    expectedFindings: [assistantsFinding("threads")],
  },
];

const assistantsAbstentionTemplates: AssistantsTemplate[] = [
  {
    classes: ["unsupported-wrapper"],
    evidence: "client.beta.threads.runs.create",
    source: `function wrapped(client: OpenAIType) {
  return client.beta.threads.runs.create("thread_123", { assistant_id: "asst_123" });
}`,
    expectedFindings: [
      abstention("threads", "wrapper", "wrapper-parameter"),
      abstention("runs", "wrapper", "wrapper-parameter"),
    ],
  },
  {
    classes: ["alias"],
    evidence: "createAssistant",
    source: `const createAssistant = client.beta.assistants.create;
await createAssistant({ model: "gpt-4o" });`,
    expectedFindings: [abstention("assistants", "method-alias", "method-alias")],
  },
  {
    classes: ["dynamic-configuration"],
    evidence: "client.beta.threads.runs[operation]",
    source: `const operation = "create";
await client.beta.threads.runs[operation]("thread_123", { assistant_id: "asst_123" });`,
    expectedFindings: [
      abstention("threads", "dynamic-member", "computed-member-access"),
      abstention("runs", "dynamic-member", "computed-member-access"),
    ],
  },
  {
    classes: ["indirect-invocation"],
    evidence: "client.beta.threads.runs.create.call",
    source:
      'await client.beta.threads.runs.create.call(client.beta.threads.runs, "thread_123", { assistant_id: "asst_123" });',
    expectedFindings: [
      abstention("threads", "indirect-invocation", "indirect-invocation"),
      abstention("runs", "indirect-invocation", "indirect-invocation"),
    ],
  },
  {
    classes: ["dynamic-configuration"],
    evidence: "client.beta?.threads.runs.create",
    source: 'await client.beta?.threads.runs.create("thread_123", { assistant_id: "asst_123" });',
    expectedFindings: [
      abstention("threads", "dynamic-member", "optional-member-access"),
      abstention("runs", "dynamic-member", "optional-member-access"),
    ],
  },
  {
    classes: ["dynamic-configuration"],
    evidence: "client.beta.threads.runs.create",
    source: `const streaming = process.env.STREAM === "1";
await client.beta.threads.runs.create("thread_123", { assistant_id: "asst_123", stream: streaming });`,
    expectedFindings: [
      assistantsFinding("threads"),
      assistantsFinding("runs"),
      abstention("streaming", "dynamic-request", "dynamic-stream"),
    ],
  },
];

function assistantsFixtures(): TypeScriptBenchmarkFixture[] {
  const fixtures = assistantsSupportedTemplates.map((template, index) => {
    const id = `assistants-positive-${String(index + 1).padStart(3, "0")}`;
    const importAlias = index === 9;
    const importStatement = importAlias
      ? 'import Client from "openai";\nimport type { OpenAI as OpenAIType } from "openai";\nconst client = new Client();'
      : 'import OpenAI from "openai";\nimport type { OpenAI as OpenAIType } from "openai";\nconst client = new OpenAI();';
    return {
      id,
      relativeFile: sourceFile(id, index),
      classes: [...template.classes],
      source: `${importStatement}\n${template.source}\n`,
      expectedFindings: template.expectedFindings.map((finding) => ({
        ...finding,
        evidence: template.evidence,
      })),
    };
  });

  for (let index = 0; index < 12; index += 1) {
    const template = assistantsAbstentionTemplates[index % assistantsAbstentionTemplates.length];
    if (!template) throw new Error("Synthetic Assistants benchmark template is missing.");
    const id = `assistants-abstention-${String(index + 1).padStart(3, "0")}`;
    fixtures.push({
      id,
      relativeFile: sourceFile(id, index),
      classes: [...template.classes],
      source: `import OpenAI from "openai";
import type { OpenAI as OpenAIType } from "openai";
const client = new OpenAI();
${template.source}
`,
      expectedFindings: template.expectedFindings.map((finding) => ({
        ...finding,
        evidence: template.evidence,
      })),
    });
  }
  return fixtures;
}

export const TYPESCRIPT_BENCHMARK_AUTHORED_TEMPLATE_COUNT =
  modelPositiveTemplates.length +
  modelNegativeTemplates.length +
  assistantsSupportedTemplates.length +
  assistantsAbstentionTemplates.length;

export function createTypeScriptBenchmarkCorpus(): TypeScriptBenchmarkFixture[] {
  return [...modelFixtures(), ...assistantsFixtures()];
}

export function benchmarkCorpusHash(fixtures: readonly TypeScriptBenchmarkFixture[]): string {
  return sha256(canonicalJson(fixtures));
}
