export class BranchPolicyError extends Error {}

export type BranchRoute = {
  base: "develop" | "main";
  head: string;
  type: string;
};

export function validateBranchRoute(base: string, head: string): BranchRoute;
export function runCli(argv: string[]): number;
