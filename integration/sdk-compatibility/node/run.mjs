import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI, { toFile } from "openai";
import { VERSION } from "openai/version";

const TARGET_MODEL = "gpt-4o-mini-transcribe-2025-12-15";
const AUDIO_SHA256 = "60c0b6c740c791f5d9c1b7d688aa4e6719b93c8f4e7c4b7919ab86ad78b74068";
const audioPath = fileURLToPath(new URL("../audio/silence-10ms.wav.base64", import.meta.url));
const audio = Buffer.from((await readFile(audioPath, "utf8")).trim(), "base64");
if (createHash("sha256").update(audio).digest("hex") !== AUDIO_SHA256) {
  throw new Error("Synthetic audio fixture hash mismatch.");
}

function multipartParts(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType ?? "");
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) {
    throw new Error("SDK request did not include a valid multipart boundary.");
  }
  const delimiter = Buffer.from(`--${boundary}`, "ascii");
  const parts = [];
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    let start = cursor + delimiter.length;
    if (body.subarray(start, start + 2).equals(Buffer.from("--", "ascii"))) {
      break;
    }
    if (body.subarray(start, start + 2).equals(Buffer.from("\r\n", "ascii"))) {
      start += 2;
    }
    const next = body.indexOf(delimiter, start);
    if (next < 0) {
      throw new Error("SDK multipart body ended without a closing boundary.");
    }
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n", "ascii"), start);
    if (headerEnd < 0 || headerEnd >= next) {
      throw new Error("SDK multipart part did not contain a valid header block.");
    }
    let dataEnd = next;
    if (body.subarray(dataEnd - 2, dataEnd).equals(Buffer.from("\r\n", "ascii"))) {
      dataEnd -= 2;
    }
    parts.push({
      headers: body.subarray(start, headerEnd).toString("latin1"),
      data: body.subarray(headerEnd + 4, dataEnd),
    });
    cursor = next;
  }
  return parts;
}

async function writeEvidence(ledger) {
  const output = process.env.SDK_COMPATIBILITY_OUTPUT;
  if (!output) {
    return;
  }
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const normalize = (value) => {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort(compare)
          .map((key) => [key, normalize(value[key])]),
      );
    }
    return value;
  };
  const canonical = normalize(ledger);
  await writeFile(resolved, `${JSON.stringify(canonical)}\n`, { flag: "wx", mode: 0o600 });
}

const toolRevision = process.env.GITHUB_SHA ?? null;
if (process.env.GITHUB_ACTIONS === "true" && !/^[a-f0-9]{40}$/u.test(toolRevision ?? "")) {
  throw new Error("GitHub Actions SDK evidence requires a full GITHUB_SHA revision.");
}

let observedRequest;
const server = createServer((request, response) => {
  const chunks = [];
  let bytes = 0;
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      request.destroy(new Error("SDK request exceeded 1 MiB."));
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    observedRequest = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body: Buffer.concat(chunks),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: "synthetic transcript" }));
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve loopback SDK test server.");
  }
  const client = new OpenAI({
    apiKey: "integration-test-key",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    maxRetries: 0,
    timeout: 5_000,
  });
  const transcription = await client.audio.transcriptions.create({
    file: await toFile(audio, "silence-10ms.wav", { type: "audio/wav" }),
    model: TARGET_MODEL,
  });
  if (transcription.text !== "synthetic transcript" || !observedRequest) {
    throw new Error("Node SDK did not complete the synthetic transcription request.");
  }
  const parts = multipartParts(observedRequest.body, observedRequest.contentType);
  const modelPart = parts.find((part) => part.headers.includes('name="model"'));
  const filePart = parts.find((part) => part.headers.includes('name="file"'));
  const expectations = [
    observedRequest.method === "POST",
    observedRequest.url === "/v1/audio/transcriptions",
    observedRequest.authorization === "Bearer integration-test-key",
    observedRequest.contentType?.startsWith("multipart/form-data; boundary="),
    modelPart?.data.toString("utf8") === TARGET_MODEL,
    filePart?.headers.includes('filename="silence-10ms.wav"'),
    filePart?.headers.toLowerCase().includes("content-type: audio/wav"),
    filePart?.data.equals(audio),
    filePart && createHash("sha256").update(filePart.data).digest("hex") === AUDIO_SHA256,
  ];
  if (!expectations.every(Boolean)) {
    throw new Error("Node SDK multipart transcription request did not match the contract.");
  }
  await writeEvidence({
    schemaVersion: "1.0.0",
    kind: "sdk-compatibility",
    language: "javascript",
    toolRevision,
    sdk: { name: "openai", version: VERSION },
    runtime: {
      name: "node",
      version: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    fixtureSha256: AUDIO_SHA256,
    targetModel: TARGET_MODEL,
    requestBodyVerified: true,
    liveApiUsed: false,
    passed: true,
  });
  process.stdout.write(
    `openai-node ${VERSION} passed local transcription compatibility on ${process.platform}/${process.arch}.\n`,
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
