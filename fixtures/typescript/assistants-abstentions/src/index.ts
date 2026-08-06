import RuntimeOpenAI from "openai";
import type { OpenAI as OpenAIType } from "openai";

const openai = new RuntimeOpenAI();
const operation = "create";
const streaming = process.env.STREAM === "1";
const configuredTools = [{ type: "file_search" }];
const assistantConfig = { model: "gpt-4o" };

function wrappedRun(client: OpenAIType) {
  return client.beta.threads.runs.create("thread_123", { assistant_id: "asst_123" });
}

const createAssistant = openai.beta.assistants.create;
await createAssistant({ model: "gpt-4o" });

await openai.beta.threads.runs[operation]("thread_123", { assistant_id: "asst_123" });
await openai.beta.assistants.create(assistantConfig);
await openai.beta.threads.runs.create.call(openai.beta.threads.runs, "thread_123", {
  assistant_id: "asst_123",
});

await openai.beta.threads.runs.create("thread_123", {
  assistant_id: "asst_123",
  stream: streaming,
});

await openai.beta.assistants.create({
  model: "gpt-4o",
  tools: configuredTools,
});

await openai.beta?.threads.runs.create("thread_123", { assistant_id: "asst_123" });

function wrappedAliasRun(client: OpenAIType) {
  const runs = client.beta.threads.runs;
  return runs.create("thread_123", { assistant_id: "asst_123" });
}

void wrappedRun;
void wrappedAliasRun;
