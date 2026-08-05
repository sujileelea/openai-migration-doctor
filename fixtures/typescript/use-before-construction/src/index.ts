import OpenAI from "openai";

await client.audio.transcriptions.create({
  file: new File([], "sample.wav"),
  model: "gpt-4o-mini-transcribe-2025-03-20",
});

const client = new OpenAI();
