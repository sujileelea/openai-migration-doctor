import OpenAI from "openai";

const openai = new OpenAI();
void openai;

type FakeClient = {
  audio: {
    transcriptions: {
      create(options: { model: string }): string;
    };
  };
};

export function useFakeClient(openai: FakeClient) {
  return openai.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe-2025-03-20",
  });
}
