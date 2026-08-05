import type { Finding, MigrationEdge, MigrationGraphIssue } from "./schemas.js";

export type AdapterScanRequest = {
  repositoryRoot: string;
  migrationEdges: MigrationEdge[];
};

export type AdapterScanResult = {
  findings: Finding[];
  graphIssues: MigrationGraphIssue[];
};

export interface LanguageAdapter {
  readonly id: string;
  readonly extensions: readonly string[];
  scan(request: AdapterScanRequest): Promise<AdapterScanResult>;
}
