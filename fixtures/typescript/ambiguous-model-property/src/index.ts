import OpenAI from "openai";

const client = new OpenAI();
const options = {
  file: new File([], "sample.wav"),
  model: "gpt-4o-mini-transcribe-2025-12-15",
};

await client.audio.transcriptions.create({
  model: "gpt-4o-mini-transcribe-2025-03-20",
  ...options,
});

const propertyName = "model";
await client.audio.transcriptions.create({
  file: new File([], "sample.wav"),
  model: "gpt-4o-mini-transcribe-2025-03-20",
  [propertyName]: "gpt-4o-mini-transcribe-2025-12-15",
});

await client.audio.transcriptions.create({
  file: new File([], "sample.wav"),
  model: "gpt-4o-mini-transcribe-2025-03-20",
  model: "gpt-4o-mini-transcribe-2025-12-15",
});
