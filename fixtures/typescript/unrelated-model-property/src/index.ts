const localTranscriber = {
  create(options: { model: string }) {
    return options.model;
  },
};

export const result = localTranscriber.create({
  model: "gpt-4o-mini-transcribe-2025-03-20",
});
