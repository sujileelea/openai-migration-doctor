import { readFile } from "node:fs/promises";
import { MigrationError } from "./errors.js";
import { sha256 } from "./hash.js";
import { resolveRepositoryFile } from "./repository.js";
import {
  type PatchPlan,
  type PatchPreview,
  type PatchPreviewFile,
  PatchPreviewSchema,
  SCHEMA_VERSION,
  type ScanResult,
  type TextEdit,
} from "./schemas.js";

function validateEdits(content: string, fileHash: string, edits: TextEdit[]): void {
  let previousEnd = -1;
  for (const edit of edits) {
    if (edit.originalFileHash !== fileHash) {
      throw new MigrationError(`Stale patch plan for ${edit.file}: file hash changed.`);
    }
    if (edit.startOffset < previousEnd) {
      throw new MigrationError(`Overlapping edits are not allowed in ${edit.file}.`);
    }
    if (content.slice(edit.startOffset, edit.endOffset) !== edit.expectedText) {
      throw new MigrationError(`Stale patch plan for ${edit.file}: expected text changed.`);
    }
    previousEnd = edit.endOffset;
  }
}

export function applyTextEdits(content: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((left, right) => left.startOffset - right.startOffset);
  validateEdits(content, sha256(content), sorted);

  let patched = content;
  for (const edit of [...sorted].reverse()) {
    patched = `${patched.slice(0, edit.startOffset)}${edit.replacementText}${patched.slice(
      edit.endOffset,
    )}`;
  }
  return patched;
}

function createUnifiedDiff(file: string, before: string, after: string, edits: TextEdit[]): string {
  const beforeLines = before.split(/\r?\n/u);
  const afterLines = after.split(/\r?\n/u);
  const changedLines = [...new Set(edits.map((edit) => edit.line))].sort((a, b) => a - b);
  const lines = [`--- a/${file}`, `+++ b/${file}`];

  for (const lineNumber of changedLines) {
    lines.push(`@@ -${lineNumber},1 +${lineNumber},1 @@`);
    lines.push(`-${beforeLines[lineNumber - 1] ?? ""}`);
    lines.push(`+${afterLines[lineNumber - 1] ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function createPatchPreview(
  repositoryRoot: string,
  scan: ScanResult,
  plan: PatchPlan,
): Promise<PatchPreview> {
  if (plan.sourceLockHash !== scan.sourceLockHash) {
    throw new MigrationError("Patch plan and scan use different source locks.");
  }
  if (plan.status === "blocked") {
    throw new MigrationError(`Patch plan is blocked: ${plan.abstentionReasons.join(" ")}`);
  }

  const editsByFile = new Map<string, TextEdit[]>();
  for (const edit of plan.edits) {
    const group = editsByFile.get(edit.file) ?? [];
    group.push(edit);
    editsByFile.set(edit.file, group);
  }

  const files: PatchPreviewFile[] = [];
  for (const file of [...editsByFile.keys()].sort()) {
    const edits = editsByFile.get(file);
    if (!edits) {
      continue;
    }
    edits.sort((left, right) => left.startOffset - right.startOffset);
    const before = await readFile(resolveRepositoryFile(repositoryRoot, file), "utf8");
    const beforeHash = sha256(before);
    validateEdits(before, beforeHash, edits);
    const after = applyTextEdits(before, edits);
    files.push({
      path: file,
      beforeHash,
      afterHash: sha256(after),
      diff: createUnifiedDiff(file, before, after, edits),
      edits,
    });
  }

  return PatchPreviewSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    kind: "migrate",
    sourceLockHash: scan.sourceLockHash,
    migrationEdges: scan.migrationEdges,
    findings: scan.findings,
    plan,
    files,
    applied: false,
  });
}
