# SARIF validation

Migration Doctor validates a generated report against the official OASIS SARIF 2.1.0 JSON Schema:

```bash
corepack pnpm validate:sarif
```

This is an explicit network gate. It fetches the schema from the stable OASIS 2.1.0 OS URL, limits
the response to 1 MiB, and requires SHA-256
`ad6db49878699b091f3eeb765b6e29e92a34bad4da88664d000c923b549c3a25` before parsing it. The URL,
hash, version, and byte limit are recorded in
[`sarif-schema-lock.json`](../config/sarif-schema-lock.json). The schema body is not vendored; the
[provenance policy](provenance.md) keeps the external validation source at the official URL and
hash boundary.

After the hash check, the command generates SARIF through the built CLI from the labeled
TypeScript fixture and validates the complete document with exact-pinned Ajv and `ajv-formats`
dependencies. Ajv keeps strict schema checks except `strictRequired`, which the official schema's
cross-subschema `required` constraints need, and uses legacy ECMAScript regular-expression mode for
the schema's language pattern. A changed upstream schema, oversized response, fetch failure, wrong
report schema identity, malformed JSON, or validation error fails the gate.

The schema fetch belongs only to this validation command and its separately named CI step. `scan`,
`report`, deterministic planning, and verification do not call it and remain local, deterministic
detection paths. Unit tests inspect the pin and workflow without fetching the network; CI runs the
network gate independently.
