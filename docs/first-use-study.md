# External first-use study protocol

This protocol turns first-use observations into bounded Developer Experience evidence. It does not
claim representative usability and does not expand Migration Doctor's supported rule coverage.

## Study gate

Run at least three sessions with developers who did not build Migration Doctor. Recruit both a
JavaScript or TypeScript developer and a Python developer when possible. Freeze one reviewed
40-character Migration Doctor revision for every session in a study round; do not mix results from
moving branches or tags.

The owner coordinates recruitment, scheduling, consent, and any incentive. Repository-local
preparation does not authorize contacting participants.

## Participant prerequisites

- Comfortable cloning a Git repository and reading terminal or GitHub Actions output.
- Uses JavaScript, TypeScript, or Python but has not contributed to Migration Doctor.
- Agrees to use only the bundled fixtures or a disposable public sample repository.
- Does not provide credentials, private source, production data, transcripts, or customer data.

Record only the anonymized language, operating-system category, and assigned track. Do not record a
name, employer, repository URL, handle, IP address, exact machine fingerprint, or raw transcript in
the public evidence file.

## Tracks and tasks

Assign each participant one path before the timer starts.

### Source-build track

1. Give the participant the frozen commit URL and the five-minute quickstart.
2. Start timing when they begin reading the quickstart.
3. Ask them to generate a report for the bundled direct-model fixture in their language.
4. Stop timing when all four report files exist and the participant identifies the command as a
   completed finding result rather than a tool crash.

### GitHub Action track

1. Give the participant a disposable public fixture repository and the frozen 40-character Action
   pin. The repository must contain no secrets or private source.
2. Start timing when they begin reading the Action instructions.
3. Ask them to run the Action, locate the saved report, and distinguish finding exit `1` from tool
   errors `2` through `5`.
4. Stop timing when they locate the complete report bundle and interpret the workflow outcome.

After either track, ask the participant to identify:

- the deprecated model or API surface;
- the official source and recommended destination;
- the automation tier and review boundary;
- the next action they would take.

Do not coach during the timed task. Record a controlled failure category when intervention becomes
necessary, then help the participant finish only after the timed observation is closed.

## Measurements

For every session, record exactly these controlled fields:

- track, language, and operating-system category;
- outcome: `completed`, `failed`, or `stopped`;
- time to first complete report in whole seconds, or `null` if incomplete;
- zero or more setup-failure categories;
- zero or more report-interpretation error categories;
- the next action selected;
- whether a privacy incident triggered the stop condition.

The accepted categories are enforced by `scripts/summarize-first-use.mjs`. Free-form participant
notes are deliberately rejected by the public evidence schema.

## Privacy boundary and stop conditions

Stop immediately if a task would expose a credential, private repository, private source body,
production record, transcript, customer identifier, or unexpected personal information. Also stop
if Migration Doctor writes inside the scanned target or if a participant cannot continue without
installing an unreviewed executable.

Mark a privacy incident only as a boolean and keep the outcome `stopped`. Store any consent record
or raw facilitator notes outside this repository. Public aggregates must not quote participants or
contain free-form notes.

## Anonymized evidence format

Use participant IDs `P01` through `P99`. A minimal completed record looks like this:

```json
{
  "schemaVersion": "1.0.0",
  "toolRevision": "0000000000000000000000000000000000000000",
  "sessions": [
    {
      "id": "P01",
      "track": "source-build",
      "language": "typescript",
      "operatingSystem": "macos",
      "outcome": "completed",
      "timeToFirstReportSeconds": 300,
      "setupFailures": [],
      "interpretationErrors": [],
      "nextAction": "patch-preview",
      "privacyIncident": false
    }
  ]
}
```

Generate the deterministic public summary on stdout:

```bash
corepack pnpm usability:summarize -- /path/to/anonymized-evidence.json \
  > /path/to/first-use-summary.md
```

Review the summary before adding it to the repository. A generated summary is evidence only for its
frozen revision and observed sample. Its friction-candidate table ranks controlled categories by
within-sample impact: an occurrence in a completed session scores `1`, a failed session scores `2`,
and a stopped session scores `3`; ties use frequency and then the fixed schema order. Treat that
table only as a triage queue. Reproduce each candidate before selecting the two product responses,
and do not present the score as a usability benchmark.

## Completion criteria

The study round is complete only when:

1. at least three sessions are represented, including JavaScript or TypeScript and Python when
   recruitment permitted;
2. time-to-first-report and completion outcomes are reported without generalization;
3. the ranked candidates have been reproduced and the two highest-impact reproducible friction
   points are fixed with regression tests or filed as scoped follow-up issues;
4. README or quickstart claims cite only the checked-in anonymized summary;
5. no raw participant notes or identifying information enter the repository.
