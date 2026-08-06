import { OpenAI as Client } from "openai";

const openai = new Client();

await openai.beta.assistants.create({
  model: "gpt-4o",
  tools: [{ type: "file_search" }, { type: "code_interpreter" }],
  tool_resources: {
    file_search: { vector_store_ids: ["vs_123"] },
    code_interpreter: { file_ids: ["file_123"] },
  },
});

await openai.beta.threads.create();
await openai.beta.threads.createAndRunStream({ assistant_id: "asst_123" });

const runs = openai.beta.threads.runs;
await runs.create("thread_123", {
  assistant_id: "asst_123",
  stream: true,
  tools: [{ type: "function", function: { name: "weather" } }],
});

const clientAlias = openai;
await clientAlias.beta.threads.messages.create("thread_123", {
  role: "user",
  content: "Hello",
});

await openai.beta.assistants.del("asst_123");

const beta = openai.beta;
await beta.threads.retrieve("thread_123");
