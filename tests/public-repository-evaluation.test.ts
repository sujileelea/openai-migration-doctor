import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "./helpers.js";

describe("public repository evaluation manifest", () => {
  it("validates every pinned repository and hash-bound ground-truth label file offline", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(PROJECT_ROOT, "scripts/evaluate-public-repositories.mjs"), "--validate-manifest"],
      { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 10_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("Public-repository manifest is valid.\n");
  });
});
