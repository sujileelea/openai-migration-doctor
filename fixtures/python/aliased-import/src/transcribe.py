from openai import OpenAI as OpenAIClient

client = OpenAIClient()

transcript = client.audio.transcriptions.create(
    file=b"synthetic-audio",
    model="gpt-4o-mini-transcribe-2025-03-20",
)
