import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

export function fixturePath(name: string): string {
  return path.join(PROJECT_ROOT, "fixtures", "typescript", name);
}
