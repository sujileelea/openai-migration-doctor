import type OpenAI from "openai";
import RuntimeOpenAI from "openai";

const invalidRuntimeClient = new OpenAI();
const realClient = new RuntimeOpenAI();
const fakeClient = {
  beta: {
    assistants: {
      create: (request: unknown) => request,
    },
  },
};

// realClient.beta.assistants.create({ model: "gpt-4o" });
const documentation = "realClient.beta.threads.runs.create()";

fakeClient.beta.assistants.create({ model: "gpt-4o" });
await realClient.responses.create({ model: "gpt-4o", input: "Hello" });
await realClient.responses.create({
  model: "gpt-4o",
  input: "Search",
  tools: [{ type: "file_search", vector_store_ids: ["vs_123"] }],
});
await realClient.files.create({ file: {} as File, purpose: "assistants" });

const unrelatedConfiguration = {
  stream: true,
  tools: [{ type: "code_interpreter" }],
};

void invalidRuntimeClient;
void documentation;
void unrelatedConfiguration;
