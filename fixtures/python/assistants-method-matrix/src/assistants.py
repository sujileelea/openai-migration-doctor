from openai import OpenAI

client = OpenAI()

client.beta.assistants.create()
client.beta.assistants.retrieve()
client.beta.assistants.update()
client.beta.assistants.list()
client.beta.assistants.delete()

client.beta.threads.create()
client.beta.threads.retrieve()
client.beta.threads.update()
client.beta.threads.delete()
client.beta.threads.create_and_run()
client.beta.threads.create_and_run_poll()
client.beta.threads.create_and_run_stream()

client.beta.threads.messages.create()
client.beta.threads.messages.retrieve()
client.beta.threads.messages.update()
client.beta.threads.messages.list()
client.beta.threads.messages.delete()

client.beta.threads.runs.create()
client.beta.threads.runs.retrieve()
client.beta.threads.runs.update()
client.beta.threads.runs.list()
client.beta.threads.runs.cancel()
client.beta.threads.runs.create_and_poll()
client.beta.threads.runs.create_and_stream()
client.beta.threads.runs.poll()
client.beta.threads.runs.stream()
client.beta.threads.runs.submit_tool_outputs()
client.beta.threads.runs.submit_tool_outputs_and_poll()
client.beta.threads.runs.submit_tool_outputs_stream()

client.beta.threads.runs.steps.retrieve()
client.beta.threads.runs.steps.list()
