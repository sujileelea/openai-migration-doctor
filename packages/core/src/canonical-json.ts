type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function normalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain a non-finite number.");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (typeof value === "object") {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        normalized[key] = normalize(child);
      }
    }
    return normalized;
  }

  throw new TypeError(`Canonical JSON cannot serialize ${typeof value}.`);
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}
