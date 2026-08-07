from openai import AsyncOpenAI

client = AsyncOpenAI()


async def inspect_thread() -> None:
    await client.beta.threads.messages.list("thread_test")
    async with client.beta.threads.runs.stream(
        "thread_test", assistant_id="assistant_test"
    ) as stream:
        await stream.until_done()
