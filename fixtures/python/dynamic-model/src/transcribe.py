from openai import OpenAI

client = OpenAI()
MODEL = "gpt-4o-mini-transcribe-2025-03-20"
client.audio.transcriptions.create(file=b"synthetic-audio", model=MODEL)
