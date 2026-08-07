class Recorder:
    class Audio:
        class Transcriptions:
            @staticmethod
            def create(**request):
                return request

        transcriptions = Transcriptions()

    audio = Audio()


client = Recorder()
client.audio.transcriptions.create(
    file=b"synthetic-audio",
    model="gpt-4o-mini-transcribe-2025-03-20",
)
