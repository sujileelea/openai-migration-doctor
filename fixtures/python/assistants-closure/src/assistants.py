from openai import OpenAI

client = OpenAI()


def create_thread():
    return client.beta.threads.create()
