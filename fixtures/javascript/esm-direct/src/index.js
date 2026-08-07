import Client from "openai";

const client = new Client();

await client.audio.transcriptions.create({
  file: input,
  model: "gpt-4o-mini-transcribe-2025-03-20",
});

await client.beta.assistants.create({ model: "gpt-4.1" });
