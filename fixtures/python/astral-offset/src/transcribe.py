from openai import OpenAI

client = OpenAI()

transcript = client.audio.transcriptions.create(prompt="🚀", file=b"audio", model='gpt-4o-mini-transcribe-2025-03-20')
