# SDK compatibility evidence

This opt-in harness sends the target transcription-model request through exact-pinned official Node
and Python SDKs to a loopback HTTP server. It validates the request path, authorization shape,
multipart model field, filename, MIME type, and response decoding against a hash-pinned 10 ms PCM
silence WAV fixture. The file part must contain the exact fixture bytes. The Python harness also
checks that all 31 reviewed Assistants methods still exist and that the two parameter shapes used by
the analyzer expose `stream` and `attachments`. It never contacts the OpenAI API and uses a
non-secret test key.

The scheduled and manually dispatched workflow runs Node.js 22 and 24 plus Python 3.10 and 3.13 on
GitHub-hosted Linux and macOS. A passing result proves request-shape compatibility only for the
listed SDK/runtime matrix; it is not transcription-quality or live-service evidence. Each matrix
job uploads a commit-bound JSON ledger with the SDK, runtime, platform, architecture, fixture hash,
target model, and evidence boundary.
