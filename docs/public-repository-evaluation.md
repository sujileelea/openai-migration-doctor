# Public repository evaluation

The opt-in public-repository evaluation scans three MIT-licensed repositories at exact Git
revisions without committing or executing their source. The manifest pins each repository URL,
revision, license path, license hash, manually reviewed call-site counts, and a hash-bound
ground-truth file containing every expected normalized finding label.

```bash
corepack pnpm build
node scripts/evaluate-public-repositories.mjs --validate-manifest
node scripts/evaluate-public-repositories.mjs --output /tmp/public-repository-ledger.json
```

The full evaluation is a network gate and requires a clean Migration Doctor worktree. It uses an
isolated Git home with system and global configuration disabled, fetches only each pinned revision
into a temporary bare repository, and exports supported-language files and the license directly
from exact Git blobs with `git cat-file`. It does not perform a working-tree checkout, so smudge
filters, line-ending conversion, template hooks, and global URL rewrites cannot change scanned
bytes. It validates the license, compares actual labels with the independently checked-in reviewed
label set, and deletes only the temporary directory it created.

The corpus deliberately includes one direct-call positive application, one cross-file-client
application outside the current same-file proof boundary, and one current negative control. Its
precision and recall are computed from exact set differences between those actual and reviewed
labels and apply only to the manually reviewed supported subset. Out-of-scope call sites are
counted separately and are not converted into supported-subset recall claims.
