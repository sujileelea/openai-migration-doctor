from openai import OpenAI as OpenAIClient  # keep the import explanation

client = OpenAIClient()  # keep the client comment


def transcribe(audio_bytes: bytes):
    # Keep this comment and the intentionally unusual spacing.
    return client.audio.transcriptions.create( file = audio_bytes, model = 'gpt-4o-mini-transcribe-2025-03-20', )  # keep the trailing comment
