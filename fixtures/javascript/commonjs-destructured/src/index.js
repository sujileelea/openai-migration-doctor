const { OpenAI: Client } = require("openai");

const client = new Client();

void client.beta.assistants.create({
  model: "gpt-4.1",
  tools: [{ type: "file_search" }],
});
