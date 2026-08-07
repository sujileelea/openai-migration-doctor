export class SourceDriftError extends Error {}

export function fetchOfficialMarkdown(
  url: string,
  fetchImplementation?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<Uint8Array>;

export function runCli(argv: string[]): Promise<number>;
