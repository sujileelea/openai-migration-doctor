from openai import OpenAI


def create_thread():
    return client.beta.threads.create()


client = OpenAI()
