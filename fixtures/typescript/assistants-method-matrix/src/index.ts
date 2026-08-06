import OpenAI from "openai";

const client = new OpenAI();

await client.beta.assistants.create({ model: "gpt-4o" });
await client.beta.assistants.retrieve("asst_123");
await client.beta.assistants.update("asst_123", { model: "gpt-4o" });
await client.beta.assistants.list();
await client.beta.assistants.delete("asst_123");
await client.beta.assistants.del("asst_123");

await client.beta.threads.create();
await client.beta.threads.retrieve("thread_123");
await client.beta.threads.update("thread_123", { metadata: {} });
await client.beta.threads.delete("thread_123");
await client.beta.threads.del("thread_123");
await client.beta.threads.createAndRun({ assistant_id: "asst_123" });
await client.beta.threads.createAndRunPoll({ assistant_id: "asst_123" });
await client.beta.threads.createAndRunStream({ assistant_id: "asst_123" });

await client.beta.threads.messages.create("thread_123", { role: "user", content: "Hi" });
await client.beta.threads.messages.retrieve("msg_123", { thread_id: "thread_123" });
await client.beta.threads.messages.update("msg_123", { thread_id: "thread_123" });
await client.beta.threads.messages.list("thread_123");
await client.beta.threads.messages.delete("msg_123", { thread_id: "thread_123" });
await client.beta.threads.messages.del("msg_123", { thread_id: "thread_123" });

await client.beta.threads.runs.create("thread_123", { assistant_id: "asst_123" });
await client.beta.threads.runs.retrieve("run_123", { thread_id: "thread_123" });
await client.beta.threads.runs.update("run_123", { thread_id: "thread_123" });
await client.beta.threads.runs.list("thread_123");
await client.beta.threads.runs.cancel("run_123", { thread_id: "thread_123" });
await client.beta.threads.runs.createAndPoll("thread_123", { assistant_id: "asst_123" });
await client.beta.threads.runs.createAndStream("thread_123", { assistant_id: "asst_123" });
await client.beta.threads.runs.poll("run_123", { thread_id: "thread_123" });
await client.beta.threads.runs.stream("thread_123", { assistant_id: "asst_123" });
await client.beta.threads.runs.submitToolOutputs("run_123", {
  thread_id: "thread_123",
  tool_outputs: [],
});
await client.beta.threads.runs.submitToolOutputsAndPoll("run_123", {
  thread_id: "thread_123",
  tool_outputs: [],
});
await client.beta.threads.runs.submitToolOutputsStream("run_123", {
  thread_id: "thread_123",
  tool_outputs: [],
});

await client.beta.threads.runs.steps.retrieve("step_123", {
  thread_id: "thread_123",
  run_id: "run_123",
});
await client.beta.threads.runs.steps.list("run_123", { thread_id: "thread_123" });
