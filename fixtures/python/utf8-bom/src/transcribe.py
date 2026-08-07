from openai import OpenAI; client = OpenAI(); result = client.audio.transcriptions.create(file=b"audio", model="gpt-4o-mini-transcribe-2025-03-20")
