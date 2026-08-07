from openai import OpenAI

if should_create_client:
    client = OpenAI()

client.audio.transcriptions.create(
    file=b"synthetic-audio",
    model="gpt-4o-mini-transcribe-2025-03-20",
)
