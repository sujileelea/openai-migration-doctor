import { canonicalJson, type Report } from "@migration-doctor/core";

export function renderJson(report: Report): string {
  return canonicalJson(report);
}
