# Official source drift monitoring

Migration Doctor records the SHA-256 of the exact official OpenAI Markdown bytes reviewed for each
source record. The dedicated `Official source drift` workflow compares those hashes with current
upstream bytes every Monday and on manual dispatch. It is separate from detection, normal pull
request CI, and the composite action; none of those paths gains network access.

The live check requires an explicit network gate:

```bash
node scripts/check-source-drift.mjs --network
```

The checker structurally validates `migration.lock`, verifies every locked artifact hash, parses
locked source records, derives canonical `https://developers.openai.com/api/docs/...md` URLs, and
fetches each unique document once. Redirects are rejected, responses are limited to 4 MiB, and the
request times out after 30 seconds.

A changed hash fails the workflow and lists every affected source record. It does not edit source
records, reviewed claims, migration edges, or `migration.lock`. A reviewer must download the new
bytes to a temporary location, reassess the affected claims and edges, create new dated source
records, and update the lock only after that review. Historical reviewed records are not
overwritten.

## Offline fixtures

Tests and local audits can inject files without enabling network access:

```bash
node scripts/check-source-drift.mjs \
  --root /path/to/fixture-project \
  --fixture-manifest /path/to/fixture-manifest.json
```

The manifest is a versioned local mapping whose paths are resolved relative to the manifest and
must stay within that directory:

```json
{
  "schemaVersion": "1.0.0",
  "documents": [
    {
      "url": "https://developers.openai.com/api/docs/deprecations.md",
      "path": "deprecations.md"
    }
  ]
}
```

Exactly one of `--network` and `--fixture-manifest` is required. Exit status `0` means every
reviewed hash is current, `1` means official bytes drifted and require human review, and `2` means
the lock, source metadata, fixture, or network operation was invalid or incomplete.
