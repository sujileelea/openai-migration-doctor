from openai import OpenAI

client = OpenAI()


def inspect(client):
    return client.beta.threads.runs.retrieve("thread_test", "run_test")
