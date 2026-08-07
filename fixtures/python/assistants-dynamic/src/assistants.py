from openai import OpenAI

client = OpenAI()
stream_enabled = should_stream()
configured_tools = load_tools()
configured_resources = load_tool_resources()
request_options = load_request_options()

client.beta.threads.runs.create(
    "thread_test",
    assistant_id="assistant_test",
    stream=stream_enabled,
    tools=configured_tools,
)
client.beta.assistants.create(model="gpt-4.1", tool_resources=configured_resources)
client.beta.threads.runs.future_method("thread_test", "run_test")
client.beta.threads.runs.create("thread_test", assistant_id="assistant_test", **request_options)
