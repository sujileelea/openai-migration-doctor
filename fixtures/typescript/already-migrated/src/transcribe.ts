import OpenAI from "openai";

const openai = new OpenAI();

export function transcribe(file: File) {
  return openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe-2025-12-15",
  });
}
