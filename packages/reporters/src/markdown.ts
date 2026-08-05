import type {
  Finding,
  MigrationEdge,
  MigrationGraphIssue,
  PatchPlan,
  Report,
  VerificationResult,
} from "@migration-doctor/core";

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function edgeForFinding(finding: Finding, edges: MigrationEdge[]): MigrationEdge | undefined {
  const edgeId = finding.migrationEdgeIds[0];
  return edges.find((edge) => edge.id === edgeId);
}

function edgesForFinding(finding: Finding, edges: MigrationEdge[]): MigrationEdge[] {
  const ids = new Set(finding.migrationEdgeIds);
  return edges.filter((edge) => ids.has(edge.id));
}

function renderGraphIssues(issues: MigrationGraphIssue[]): string[] {
  if (issues.length === 0) {
    return [];
  }

  const lines = ["## Migration graph review", ""];
  for (const issue of issues) {
    lines.push(`### ${code(issue.kind)}`, "");
    lines.push(`- Resource: ${code(`${issue.resource.kind}:${issue.resource.id}`)}`);
    lines.push(`- Language: ${issue.language}`);
    lines.push(`- Human review: ${issue.reviewRequired ? "required" : "not required"}`);
    lines.push(`- Reason: ${issue.message}`);
    lines.push("- Official sources:");
    for (const source of issue.sources) {
      lines.push(`  - [${source.title}](${source.url})`);
    }
    lines.push("");
  }
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function renderFindings(findings: Finding[], edges: MigrationEdge[]): string[] {
  if (findings.length === 0) {
    return ["## Findings", "", "No supported deprecated usage was found."];
  }

  const lines = ["## Findings", ""];
  for (const finding of findings) {
    const edge = edgeForFinding(finding, edges);
    const findingEdges = edgesForFinding(finding, edges);
    lines.push(`### ${code(finding.ruleId)}`);
    lines.push("");
    lines.push(
      `- Location: ${code(`${finding.location.file}:${finding.location.line}:${finding.location.column}`)}`,
    );
    lines.push(`- Evidence: ${code(finding.evidence)}`);
    lines.push(`- Confidence: ${finding.confidence}`);
    lines.push(`- Automation tier: ${finding.automationTier}`);
    lines.push(`- Human review: ${finding.reviewRequired ? "required" : "not required"}`);
    if (finding.remediation.kind === "replace-string-literal") {
      lines.push(`- Recommended replacement: ${code(finding.remediation.replacement)}`);
    }
    if (finding.abstentionReason) {
      lines.push(`- Abstention: ${finding.abstentionReason}`);
    }
    if (edge?.shutdownAt) {
      lines.push(`- Shutdown: ${edge.shutdownAt}`);
    }
    if (findingEdges.length > 0) {
      const seenSources = new Set<string>();
      lines.push("- Official sources:");
      for (const findingEdge of findingEdges) {
        for (const source of findingEdge.sources) {
          const key = `${source.url}\u0000${source.title}\u0000${source.contentHash}\u0000${source.retrievedAt}`;
          if (!seenSources.has(key)) {
            seenSources.add(key);
            lines.push(`  - [${source.title}](${source.url})`);
          }
        }
      }
    }
    lines.push("");
  }
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function renderPlan(plan: PatchPlan): string[] {
  const lines = ["## Patch plan", "", `Status: **${plan.status}**`, ""];
  if (plan.edits.length === 0) {
    lines.push("No deterministic edits are planned.");
  } else {
    lines.push("| File | Location | Replacement |", "| --- | ---: | --- |");
    for (const edit of plan.edits) {
      lines.push(
        `| ${code(edit.file)} | ${edit.line}:${edit.column} | ${code(edit.expectedText)} -> ${code(edit.replacementText)} |`,
      );
    }
  }
  if (plan.abstentionReasons.length > 0) {
    lines.push("", "### Abstentions", "");
    for (const reason of plan.abstentionReasons) {
      lines.push(`- ${reason}`);
    }
  }
  return lines;
}

function renderVerification(verification: VerificationResult): string[] {
  const lines = [
    "## Verification",
    "",
    `Deterministic verification: **${verification.passed ? "PASS" : "FAIL"}**`,
    "",
    "| Check | Result | Evidence |",
    "| --- | --- | --- |",
  ];

  for (const check of verification.checks) {
    lines.push(
      `| ${code(check.id)} | ${check.passed ? "PASS" : "FAIL"} | ${check.evidence.join("; ").replaceAll("|", "\\|")} |`,
    );
  }
  lines.push(
    "",
    `Runtime behavior verified: **${verification.runtimeBehaviorVerified ? "yes" : "no"}**`,
  );
  if (verification.changedFiles.length > 0) {
    lines.push(
      "",
      "The snapshot change can alter transcription output. Run the repository's audio evaluation corpus before production rollout.",
    );
  } else {
    lines.push(
      "",
      verification.passed
        ? "No source change was required."
        : "No source change was verified; resolve the blocked plan before evaluating runtime behavior.",
    );
  }
  return lines;
}

export function renderMarkdown(report: Report): string {
  const lines = [
    `# Migration Doctor ${report.kind[0]?.toUpperCase()}${report.kind.slice(1)}`,
    "",
    `Source lock: ${code(report.sourceLockHash)}`,
    "",
  ];

  if (report.graphIssues.length > 0) {
    lines.push(...renderGraphIssues(report.graphIssues), "");
  }

  switch (report.kind) {
    case "scan":
      lines.push(
        `Blocking findings: **${report.summary.blocking}** / ${report.summary.total}`,
        "",
        ...renderFindings(report.findings, report.migrationEdges),
      );
      break;
    case "plan":
      lines.push(
        ...renderFindings(report.findings, report.migrationEdges),
        "",
        ...renderPlan(report.plan),
      );
      break;
    case "migrate":
      lines.push(
        ...renderFindings(report.findings, report.migrationEdges),
        "",
        ...renderPlan(report.plan),
        "",
        "## Patch preview",
        "",
      );
      if (report.files.length === 0) {
        lines.push(
          report.plan.status === "blocked"
            ? "No deterministic patch is available while the plan is blocked."
            : "No patch is required.",
        );
      }
      for (const file of report.files) {
        lines.push(`### ${code(file.path)}`, "", "```diff", file.diff.trimEnd(), "```", "");
      }
      lines.push("The patch was not applied to the source repository.");
      break;
    case "verify":
      lines.push(
        ...renderFindings(report.findings, report.migrationEdges),
        "",
        ...renderPlan(report.plan),
        "",
        ...renderVerification(report.verification),
      );
      break;
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
