export type FirstUseSession = {
    id: string;
    track: "source-build" | "github-action";
    language: "javascript" | "typescript" | "python";
    operatingSystem: "macos" | "linux" | "windows";
    outcome: "completed" | "failed" | "stopped";
    timeToFirstReportSeconds: number | null;
    setupFailures: string[];
    interpretationErrors: string[];
    nextAction: string;
    privacyIncident: boolean;
};

export type FirstUseEvidence = {
  schemaVersion: "1.0.0";
  toolRevision: string;
  sessions: FirstUseSession[];
};

export type FrictionCandidate = {
  category: string;
  impactScore: number;
  key: string;
  sessionCount: number;
};

export class UsabilityEvidenceError extends Error {}

export function parseFirstUseEvidence(value: unknown): FirstUseEvidence;
export function rankFrictionCandidates(sessions: FirstUseSession[]): FrictionCandidate[];
export function summarizeFirstUseEvidence(evidence: FirstUseEvidence): unknown;
export function renderFirstUseSummary(evidence: FirstUseEvidence): string;
export function runCli(argv: string[]): Promise<number>;
