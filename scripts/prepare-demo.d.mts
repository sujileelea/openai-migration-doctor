export class DemoPreflightError extends Error {}

export type DemoPreparation = {
  reportDirectory: string;
  remoteRefs: string[];
  rehearsal: boolean;
  revision: string;
};

export const EXPECTED_REPORT_FILES: string[];
export const PROJECT_ROOT: string;
export function parseRemoteRefs(value: string): string[];
export function validateReportBundle(reportDirectory: string): Promise<void>;
export function prepareDemo(options: { rehearsal: boolean }): Promise<DemoPreparation>;
export function runCli(argv: string[]): Promise<number>;
