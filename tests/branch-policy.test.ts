import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BranchPolicyError, validateBranchRoute } from "../scripts/check-branch-policy.mjs";
import { PROJECT_ROOT } from "./helpers.js";

describe("branch policy", () => {
  it.each([
    ["develop", "feat/dx-evidence-loop"],
    ["develop", "fix/report-exit-code"],
    ["develop", "dependabot/npm_and_yarn/vitest-4.0.0"],
    ["develop", "release/v0.2.0"],
    ["develop", "hotfix/v0.1.1"],
    ["main", "release/v0.2.0"],
    ["main", "hotfix/v0.1.1"],
  ])("allows %s <- %s", (base, head) => {
    expect(validateBranchRoute(base, head)).toMatchObject({ base, head });
  });

  it.each([
    ["main", "feat/bypass-release"],
    ["main", "docs/update-readme"],
    ["develop", "feature/nonstandard-prefix"],
    ["develop", "feat/Uppercase"],
    ["develop", "feat/double//separator"],
    ["staging", "feat/unknown-base"],
  ])("rejects %s <- %s", (base, head) => {
    expect(() => validateBranchRoute(base, head)).toThrow(BranchPolicyError);
  });

  it("keeps the GitHub workflow bound to protected pull-request targets", async () => {
    const workflow = await readFile(
      path.join(PROJECT_ROOT, ".github/workflows/branch-policy.yml"),
      "utf8",
    );

    expect(workflow).toContain("branches: [develop, main]");
    expect(workflow).toContain(`BASE_REF: \${{ github.base_ref }}`);
    expect(workflow).toContain(`HEAD_REF: \${{ github.head_ref }}`);
    expect(workflow).toContain(
      'node scripts/check-branch-policy.mjs --base "$BASE_REF" --head "$HEAD_REF"',
    );
  });
});
