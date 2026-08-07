from openai import OpenAI

client = OpenAI()


def transcribe(client):
    return client.audio.transcriptions.create(
        file=b"synthetic-audio",
        model="gpt-4o-mini-transcribe-2025-03-20",
    )
