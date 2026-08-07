function require(name) {
  return fakeModules[name];
}

const OpenAI = require("openai");
const client = new OpenAI();

void client.audio.transcriptions.create({
  file: input,
  model: "gpt-4o-mini-transcribe-2025-03-20",
});
void client.beta.assistants.create({ model: "gpt-4.1" });
