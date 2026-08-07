from openai import OpenAI

client = OpenAI()
documentation_example = "gpt-4o-mini-transcribe-2025-03-20"
audio_bytes = b"synthetic-audio"

transcript = client.audio.transcriptions.create(
    file=audio_bytes,
    model="gpt-4o-mini-transcribe-2025-03-20",
)
