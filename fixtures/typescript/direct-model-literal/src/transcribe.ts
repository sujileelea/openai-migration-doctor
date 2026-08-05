import OpenAI from "openai";

const openai = new OpenAI();
const documentationExample = "gpt-4o-mini-transcribe-2025-03-20";

export async function transcribe(file: File) {
  // This nearby duplicate proves that the patch is not a global string replacement.
  void documentationExample;
  return openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe-2025-03-20",
  });
}
