import type { Finding, MigrationEdge, Report, SourceRef } from "@migration-doctor/core";
import { renderMarkdown } from "./markdown.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function reportTitle(report: Report): string {
  switch (report.kind) {
    case "behavior-verify":
      return "Behavior Verification";
    case "semantic-plan":
      return "Semantic Plan";
    default:
      return `${report.kind[0]?.toUpperCase()}${report.kind.slice(1)}`;
  }
}

function reportStatus(report: Report): { label: string; tone: "attention" | "pass" | "review" } {
  switch (report.kind) {
    case "scan":
      return report.summary.blocking === 0
        ? { label: `No blocking findings (${report.summary.total} total)`, tone: "pass" }
        : {
            label: `${report.summary.blocking} blocking findings (${report.summary.total} total)`,
            tone: "attention",
          };
    case "plan":
    case "semantic-plan":
    case "migrate":
      return report.plan.status === "blocked"
        ? { label: "Plan requires review", tone: "attention" }
        : { label: `Plan ${report.plan.status}`, tone: "review" };
    case "verify":
      return report.verification.passed
        ? { label: "Deterministic verification passed", tone: "pass" }
        : { label: "Deterministic verification failed", tone: "attention" };
    case "behavior-verify":
      return report.passed
        ? { label: "Offline behavior verification passed", tone: "pass" }
        : { label: "Offline behavior verification failed", tone: "attention" };
  }
}

function findingsFor(report: Report): Finding[] {
  return "findings" in report ? report.findings : [];
}

function edgesFor(report: Report): MigrationEdge[] {
  return "migrationEdges" in report ? report.migrationEdges : report.selectedMigrationEdges;
}

function sourcesFor(report: Report): SourceRef[] {
  const sources = new Map<string, SourceRef>();
  for (const edge of edgesFor(report)) {
    for (const source of edge.sources) {
      const key = `${source.url}\u0000${source.title}\u0000${source.contentHash}`;
      if (!sources.has(key)) {
        sources.set(key, source);
      }
    }
  }
  return [...sources.values()];
}

function safeHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function renderFindingTable(findings: Finding[]): string {
  if (findings.length === 0) {
    return "<p>No findings are present in this report.</p>";
  }

  const rows = findings
    .map(
      (finding) => `        <tr>
          <td><code>${escapeHtml(`${finding.location.file}:${finding.location.line}:${finding.location.column}`)}</code></td>
          <td><code>${escapeHtml(finding.ruleId)}</code></td>
          <td>${escapeHtml(finding.severity)}</td>
          <td>${escapeHtml(finding.automationTier)}</td>
          <td>${finding.reviewRequired ? "required" : "not required"}</td>
        </tr>`,
    )
    .join("\n");

  return `<div class="table-scroll">
      <table>
        <thead>
          <tr><th>Location</th><th>Rule</th><th>Severity</th><th>Tier</th><th>Human review</th></tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>`;
}

function renderSources(sources: SourceRef[]): string {
  if (sources.length === 0) {
    return "<p>No migration source is selected for this report.</p>";
  }

  return `<ul class="sources">
${sources
  .map((source) => {
    const url = safeHttpUrl(source.url);
    const title = escapeHtml(source.title);
    const label = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${title}</a>`
      : title;
    return `      <li>${label}<br><code>${escapeHtml(source.contentHash)}</code></li>`;
  })
  .join("\n")}
    </ul>`;
}

export function renderHtml(report: Report): string {
  const title = reportTitle(report);
  const status = reportStatus(report);
  const markdown = renderMarkdown(report);
  const findings = findingsFor(report);
  const sources = sourcesFor(report);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Migration Doctor ${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { width: min(960px, calc(100% - 32px)); margin: 32px auto 64px; }
    header { border-bottom: 1px solid color-mix(in srgb, CanvasText 24%, Canvas); padding-bottom: 20px; }
    h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px; letter-spacing: 0; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 0; }
    .status { border-left: 4px solid #26734d; padding-left: 10px; font-weight: 700; }
    .status.attention { border-left-color: #b54708; }
    .status.review { border-left-color: #2563a6; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    code { overflow-wrap: anywhere; }
    section { margin-top: 24px; }
    h2 { font-size: 18px; letter-spacing: 0; }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); padding: 10px 8px; text-align: left; vertical-align: top; }
    th { font-weight: 700; }
    a { color: LinkText; }
    .sources { padding-left: 20px; }
    .sources li { margin: 10px 0; }
    pre { margin: 0; padding: 18px; border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas); border-radius: 6px; overflow: auto; white-space: pre-wrap; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Migration Doctor ${escapeHtml(title)}</h1>
      <div class="meta">
        <span class="status ${status.tone}">${escapeHtml(status.label)}</span>
        <span>Schema <code>${escapeHtml(report.schemaVersion)}</code></span>
        <span>Source lock <code>${escapeHtml(report.sourceLockHash)}</code></span>
      </div>
    </header>
    <section aria-labelledby="findings">
      <h2 id="findings">Findings</h2>
      ${renderFindingTable(findings)}
    </section>
    <section aria-labelledby="official-sources">
      <h2 id="official-sources">Official sources</h2>
      ${renderSources(sources)}
    </section>
    <section aria-labelledby="report-details">
      <h2 id="report-details">Report details</h2>
      <pre>${escapeHtml(markdown)}</pre>
    </section>
  </main>
</body>
</html>
`;
}
