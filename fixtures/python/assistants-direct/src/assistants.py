from openai import OpenAI

client = OpenAI()

assistant = client.beta.assistants.create(
    model="gpt-4.1",
    tools=[{"type": "file_search"}, {"type": "code_interpreter"}],
    tool_resources={"file_search": {"vector_store_ids": ["vs_test"]}},
)
thread = client.beta.threads.create()
message = client.beta.threads.messages.create(
    "thread_test",
    role="user",
    content="hello",
    attachments=[
        {"file_id": "file_test", "tools": [{"type": "file_search"}]},
    ],
)
run = client.beta.threads.runs.create(
    "thread_test",
    assistant_id=assistant.id,
    stream=True,
    tools=[{"type": "function", "function": {"name": "lookup"}}],
)
events = client.beta.threads.runs.create_and_stream("thread_test", assistant_id=assistant.id)
outputs = client.beta.threads.runs.submit_tool_outputs(
    "run_test", thread_id="thread_test", tool_outputs=[], stream=True
)
steps = client.beta.threads.runs.steps.list("thread_test", "run_test")
