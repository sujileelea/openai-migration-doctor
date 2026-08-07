export const LIBCST_PROTOCOL_VERSION = "1.0.0" as const;

export type LibCstSourceFile = {
  path: string;
  content: string;
};

export type LibCstPosition = {
  line: number;
  column: number;
};

export type LibCstMatch = {
  start: LibCstPosition;
  end: LibCstPosition;
};

export type LibCstWorkerIdentity = {
  pythonVersion: string;
  libcstVersion: string;
  peakRssBytes: number;
};

export type LibCstScanResponse = {
  schemaVersion: typeof LIBCST_PROTOCOL_VERSION;
  kind: "scan-result";
  files: Array<{
    path: string;
    matches: LibCstMatch[];
  }>;
  worker: LibCstWorkerIdentity;
};

export type LibCstRewriteResponse = {
  schemaVersion: typeof LIBCST_PROTOCOL_VERSION;
  kind: "rewrite-result";
  files: Array<{
    path: string;
    content: string;
    changedCount: number;
  }>;
  worker: LibCstWorkerIdentity;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    !actual.every((key, index) => key === sortedExpected[index])
  ) {
    throw new TypeError(`${label} contains unexpected or missing fields.`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function integer(value: unknown, minimum: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function position(value: unknown, label: string): LibCstPosition {
  const parsed = record(value, label);
  exactKeys(parsed, ["line", "column"], label);
  return {
    line: integer(parsed.line, 1, `${label}.line`),
    column: integer(parsed.column, 0, `${label}.column`),
  };
}

function workerIdentity(value: unknown): LibCstWorkerIdentity {
  const parsed = record(value, "worker");
  exactKeys(parsed, ["pythonVersion", "libcstVersion", "peakRssBytes"], "worker");
  return {
    pythonVersion: string(parsed.pythonVersion, "worker.pythonVersion"),
    libcstVersion: string(parsed.libcstVersion, "worker.libcstVersion"),
    peakRssBytes: integer(parsed.peakRssBytes, 0, "worker.peakRssBytes"),
  };
}

function root(value: unknown, expectedKind: "scan-result" | "rewrite-result"): JsonRecord {
  const parsed = record(value, "worker response");
  if (parsed.kind === "error") {
    exactKeys(parsed, ["schemaVersion", "kind", "message"], "worker error");
    throw new TypeError(`LibCST worker rejected the request: ${string(parsed.message, "message")}`);
  }
  exactKeys(parsed, ["schemaVersion", "kind", "files", "worker"], "worker response");
  if (parsed.schemaVersion !== LIBCST_PROTOCOL_VERSION || parsed.kind !== expectedKind) {
    throw new TypeError("LibCST worker returned an unsupported response contract.");
  }
  if (!Array.isArray(parsed.files)) {
    throw new TypeError("worker response files must be an array.");
  }
  return parsed;
}

export function parseLibCstScanResponse(value: unknown): LibCstScanResponse {
  const parsed = root(value, "scan-result");
  const files = (parsed.files as unknown[]).map((value, fileIndex) => {
    const file = record(value, `files[${fileIndex}]`);
    exactKeys(file, ["path", "matches"], `files[${fileIndex}]`);
    if (!Array.isArray(file.matches)) {
      throw new TypeError(`files[${fileIndex}].matches must be an array.`);
    }
    const matches = file.matches.map((value, matchIndex) => {
      const match = record(value, `files[${fileIndex}].matches[${matchIndex}]`);
      exactKeys(match, ["start", "end"], `files[${fileIndex}].matches[${matchIndex}]`);
      return {
        start: position(match.start, `files[${fileIndex}].matches[${matchIndex}].start`),
        end: position(match.end, `files[${fileIndex}].matches[${matchIndex}].end`),
      };
    });
    return { path: string(file.path, `files[${fileIndex}].path`), matches };
  });
  return {
    schemaVersion: LIBCST_PROTOCOL_VERSION,
    kind: "scan-result",
    files,
    worker: workerIdentity(parsed.worker),
  };
}

export function parseLibCstRewriteResponse(value: unknown): LibCstRewriteResponse {
  const parsed = root(value, "rewrite-result");
  const files = (parsed.files as unknown[]).map((value, fileIndex) => {
    const file = record(value, `files[${fileIndex}]`);
    exactKeys(file, ["path", "content", "changedCount"], `files[${fileIndex}]`);
    return {
      path: string(file.path, `files[${fileIndex}].path`),
      content: typeof file.content === "string" ? file.content : invalidContent(fileIndex),
      changedCount: integer(file.changedCount, 0, `files[${fileIndex}].changedCount`),
    };
  });
  return {
    schemaVersion: LIBCST_PROTOCOL_VERSION,
    kind: "rewrite-result",
    files,
    worker: workerIdentity(parsed.worker),
  };
}

function invalidContent(fileIndex: number): never {
  throw new TypeError(`files[${fileIndex}].content must be a string.`);
}
