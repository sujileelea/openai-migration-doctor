from openai import AsyncOpenAI as AsyncClient

client = AsyncClient()


async def transcribe(audio_bytes: bytes):
    return await client.audio.transcriptions.create(
        file=audio_bytes,
        model="gpt-4o-mini-transcribe-2025-03-20",
    )
