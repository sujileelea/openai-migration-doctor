import OpenAI from "openai";

declare const replacementClient: OpenAI;

let client = new OpenAI();
client = replacementClient;

await client.audio.transcriptions.create({
  file: new File([], "sample.wav"),
  model: "gpt-4o-mini-transcribe-2025-03-20",
});
