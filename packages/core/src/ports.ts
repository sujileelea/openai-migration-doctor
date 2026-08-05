import type { Finding, MigrationEdge } from "./schemas.js";

export type AdapterScanRequest = {
  repositoryRoot: string;
  migrationEdges: MigrationEdge[];
};

export interface LanguageAdapter {
  readonly id: string;
  readonly extensions: readonly string[];
  scan(request: AdapterScanRequest): Promise<Finding[]>;
}
