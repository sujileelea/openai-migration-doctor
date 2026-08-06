import type {
  BehaviorVerifyReport,
  Finding,
  MigrationEdge,
  MigrationGraphIssue,
  PatchPlan,
  Report,
  VerificationResult,
} from "@migration-doctor/core";

function code(value: string): string {
  let longestBacktickRun = 0;
  let currentBacktickRun = 0;
  for (const character of value) {
    if (character === "`") {
      currentBacktickRun += 1;
      longestBacktickRun = Math.max(longestBacktickRun, currentBacktickRun);
    } else {
      currentBacktickRun = 0;
    }
  }

  const fence = "`".repeat(Math.max(1, longestBacktickRun + 1));
  const isOnlySpaces = /^ +$/u.test(value);
  const needsPadding =
    value.startsWith("`") ||
    value.endsWith("`") ||
    (!isOnlySpaces && value.startsWith(" ") && value.endsWith(" "));
  const padding = needsPadding ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
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
    lines.push(`- Analysis family: ${code(finding.analysis.family)}`);
    lines.push(`- Feature: ${code(finding.analysis.feature)}`);
    lines.push(`- Pattern: ${code(finding.analysis.pattern)}`);
    lines.push(`- Disposition: ${finding.analysis.disposition}`);
    if (finding.analysis.reasonCode) {
      lines.push(`- Reason code: ${code(finding.analysis.reasonCode)}`);
    }
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
  if (plan.manualActions.length > 0) {
    lines.push("", "### Manual migration actions", "");
    for (const action of plan.manualActions) {
      const target = action.target ? `${action.target.kind}:${action.target.id}` : "unresolved";
      lines.push(`#### ${code(action.findingId)}`, "");
      lines.push(`- Target: ${code(target)}`);
      lines.push(`- Reason code: ${code(action.reasonCode)}`);
      lines.push(`- Reason: ${action.reason}`);
      if (action.behaviorChanges.length > 0) {
        lines.push("- Behavior changes:");
        for (const behaviorChange of action.behaviorChanges) {
          lines.push(`  - ${behaviorChange}`);
        }
      }
      lines.push("");
    }
    if (lines.at(-1) === "") {
      lines.pop();
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

function renderBehaviorVerification(report: BehaviorVerifyReport): string[] {
  const lines = [
    "## Behavioral contract verification",
    "",
    `Result: **${report.passed ? "PASS" : "FAIL"}**`,
    "",
    `Contract: ${code(report.contractId)}`,
    `Scenario: ${code(report.scenarioId)}`,
    `Evidence scope: ${code(report.evidenceScope)}`,
    `Live API used: **${report.liveApiUsed ? "yes" : "no"}**`,
    "Repository runtime behavior verified: **no**",
    "",
    "### Inputs",
    "",
    `- Contract hash: ${code(report.inputHashes.contract)}`,
    `- Baseline observation: ${code(report.observationIds.baseline)}`,
    `- Baseline hash: ${code(report.inputHashes.baseline)}`,
    `- Candidate observation: ${code(report.observationIds.candidate)}`,
    `- Candidate hash: ${code(report.inputHashes.candidate)}`,
    "",
    "### Checks",
    "",
    "| Check | Result | Mismatch paths |",
    "| --- | --- | --- |",
  ];

  for (const check of report.checks) {
    lines.push(
      `| ${code(check.id)} | ${check.passed ? "PASS" : "FAIL"} | ${
        check.mismatchPaths.length === 0
          ? "None"
          : check.mismatchPaths.map(code).join(", ").replaceAll("|", "\\|")
      } |`,
    );
  }

  lines.push("", "### Changed files", "");
  if (report.changedFiles.length === 0) {
    lines.push("None");
  } else {
    for (const file of report.changedFiles) {
      lines.push(`- ${code(file)}`);
    }
  }

  lines.push("", "### Selected migration edges", "");
  for (const edge of report.selectedMigrationEdges) {
    lines.push(`- ${code(edge.id)}`);
  }

  return lines;
}

export function renderMarkdown(report: Report): string {
  const reportTitle =
    report.kind === "behavior-verify"
      ? "Behavior Verification"
      : `${report.kind[0]?.toUpperCase()}${report.kind.slice(1)}`;
  const lines = [
    `# Migration Doctor ${reportTitle}`,
    "",
    `Source lock: ${code(report.sourceLockHash)}`,
    "",
  ];

  if ("graphIssues" in report && report.graphIssues.length > 0) {
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
    case "behavior-verify":
      lines.push(...renderBehaviorVerification(report));
      break;
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
