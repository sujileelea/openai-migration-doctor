const OpenAI = require("openai");

const client = new OpenAI();

void client.audio.transcriptions.create({
  file: input,
  model: "gpt-4o-mini-transcribe-2025-03-20",
});

void client.beta.threads.runs.create("thread_123", {
  assistant_id: "asst_123",
  stream: true,
});
