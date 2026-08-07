import type { Finding } from "@migration-doctor/core";

export interface TypeScriptAnalysisCache {
  get(key: string): Promise<readonly Finding[] | undefined>;
  set(key: string, findings: readonly Finding[]): Promise<void>;
}

export class MemoryTypeScriptAnalysisCache implements TypeScriptAnalysisCache {
  readonly #entries = new Map<string, Finding[]>();

  async get(key: string): Promise<readonly Finding[] | undefined> {
    const findings = this.#entries.get(key);
    return findings === undefined ? undefined : structuredClone(findings);
  }

  async set(key: string, findings: readonly Finding[]): Promise<void> {
    this.#entries.set(key, structuredClone([...findings]));
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
