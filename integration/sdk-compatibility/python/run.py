import base64
import hashlib
import http.server
import inspect
import json
import os
import pathlib
import platform
import sys
import threading

import openai
from openai import OpenAI


TARGET_MODEL = "gpt-4o-mini-transcribe-2025-12-15"
AUDIO_SHA256 = "60c0b6c740c791f5d9c1b7d688aa4e6719b93c8f4e7c4b7919ab86ad78b74068"
AUDIO_PATH = pathlib.Path(__file__).parent.parent / "audio" / "silence-10ms.wav.base64"
AUDIO = base64.b64decode(AUDIO_PATH.read_text(encoding="ascii").strip(), validate=True)
if hashlib.sha256(AUDIO).hexdigest() != AUDIO_SHA256:
    raise RuntimeError("Synthetic audio fixture hash mismatch.")


def multipart_parts(body: bytes, content_type: str) -> list[tuple[str, bytes]]:
    marker = "boundary="
    if marker not in content_type:
        raise RuntimeError("SDK request did not include a multipart boundary.")
    boundary = content_type.split(marker, 1)[1].split(";", 1)[0].strip().strip('"')
    if not boundary:
        raise RuntimeError("SDK request included an empty multipart boundary.")
    parts: list[tuple[str, bytes]] = []
    for segment in body.split(("--" + boundary).encode("ascii"))[1:]:
        if segment.startswith(b"--"):
            break
        segment = segment.removeprefix(b"\r\n").removesuffix(b"\r\n")
        headers, separator, data = segment.partition(b"\r\n\r\n")
        if not separator:
            raise RuntimeError("SDK multipart part did not contain a valid header block.")
        parts.append((headers.decode("latin1"), data))
    return parts


def verify_assistants_surface(client: OpenAI) -> None:
    surfaces = [
        (client.beta.assistants, ["create", "retrieve", "update", "list", "delete"]),
        (
            client.beta.threads,
            [
                "create",
                "retrieve",
                "update",
                "delete",
                "create_and_run",
                "create_and_run_poll",
                "create_and_run_stream",
            ],
        ),
        (client.beta.threads.messages, ["create", "retrieve", "update", "list", "delete"]),
        (
            client.beta.threads.runs,
            [
                "create",
                "retrieve",
                "update",
                "list",
                "cancel",
                "create_and_poll",
                "create_and_stream",
                "poll",
                "stream",
                "submit_tool_outputs",
                "submit_tool_outputs_and_poll",
                "submit_tool_outputs_stream",
            ],
        ),
        (client.beta.threads.runs.steps, ["retrieve", "list"]),
    ]
    for resource, methods in surfaces:
        for method in methods:
            if not callable(getattr(resource, method, None)):
                raise RuntimeError(f"Pinned Python SDK is missing reviewed Assistants method {method}.")
    if "stream" not in inspect.signature(client.beta.threads.runs.submit_tool_outputs).parameters:
        raise RuntimeError("Pinned Python SDK submit_tool_outputs no longer exposes stream.")
    if "attachments" not in inspect.signature(client.beta.threads.messages.create).parameters:
        raise RuntimeError("Pinned Python SDK messages.create no longer exposes attachments.")


def write_evidence() -> None:
    output = os.environ.get("SDK_COMPATIBILITY_OUTPUT")
    if output is None:
        return
    path = pathlib.Path(output).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    tool_revision = os.environ.get("GITHUB_SHA")
    if os.environ.get("GITHUB_ACTIONS") == "true" and (
        tool_revision is None
        or len(tool_revision) != 40
        or any(character not in "0123456789abcdef" for character in tool_revision)
    ):
        raise RuntimeError("GitHub Actions SDK evidence requires a full GITHUB_SHA revision.")
    ledger = {
        "fixtureSha256": AUDIO_SHA256,
        "kind": "sdk-compatibility",
        "language": "python",
        "liveApiUsed": False,
        "passed": True,
        "requestBodyVerified": True,
        "runtime": {
            "architecture": platform.machine(),
            "name": "python",
            "platform": sys.platform,
            "version": platform.python_version(),
        },
        "schemaVersion": "1.0.0",
        "sdk": {"name": "openai", "version": openai.__version__},
        "targetModel": TARGET_MODEL,
        "toolRevision": tool_revision,
    }
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(ledger, handle, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        handle.write("\n")


class Handler(http.server.BaseHTTPRequestHandler):
    observed: dict[str, object] | None = None

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > 1024 * 1024:
            self.send_error(413)
            return
        Handler.observed = {
            "method": self.command,
            "path": self.path,
            "authorization": self.headers.get("authorization"),
            "content_type": self.headers.get("content-type"),
            "body": self.rfile.read(length),
        }
        body = b'{"text":"synthetic transcript"}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
client = OpenAI(
    api_key="integration-test-key",
    base_url=f"http://127.0.0.1:{server.server_port}/v1",
    max_retries=0,
    timeout=5.0,
)
try:
    verify_assistants_surface(client)
    transcription = client.audio.transcriptions.create(
        file=("silence-10ms.wav", AUDIO, "audio/wav"),
        model=TARGET_MODEL,
    )
finally:
    client.close()
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)

observed = Handler.observed
if transcription.text != "synthetic transcript" or observed is None:
    raise RuntimeError("Python SDK did not complete the synthetic transcription request.")
parts = multipart_parts(observed["body"], str(observed["content_type"]))
model_part = next((part for part in parts if 'name="model"' in part[0]), None)
file_part = next((part for part in parts if 'name="file"' in part[0]), None)
expectations = [
    observed["method"] == "POST",
    observed["path"] == "/v1/audio/transcriptions",
    observed["authorization"] == "Bearer integration-test-key",
    str(observed["content_type"]).startswith("multipart/form-data; boundary="),
    model_part is not None and model_part[1].decode("utf-8") == TARGET_MODEL,
    file_part is not None and 'filename="silence-10ms.wav"' in file_part[0],
    file_part is not None and "content-type: audio/wav" in file_part[0].lower(),
    file_part is not None and file_part[1] == AUDIO,
    file_part is not None and hashlib.sha256(file_part[1]).hexdigest() == AUDIO_SHA256,
]
if not all(expectations):
    raise RuntimeError("Python SDK multipart transcription request did not match the contract.")
write_evidence()
print(f"openai-python {openai.__version__} passed local transcription compatibility.")
