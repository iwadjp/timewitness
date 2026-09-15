# Real-bug validation: commit d290a13 ("Fix latest Layer 1 run selection")

Reproduced live against a minimal, self-contained reconstruction of the actual pre-fix and
post-fix source (fetched via `git show d290a13~1:<path>` / `git show d290a13:<path>` from the
real commit) in a throwaway Git repository outside this project, not inside the real project's
working tree. No private-data or business content was copied; only the library modules and test
files that commit d290a13 actually touched (plus their unmodified `node:`-builtin-only
dependencies) were used.

The commit's own real regression test set (`test/layer1-dashboard-read-api.test.js`,
`test/layer1-dashboard-runs.test.js`, `test/layer1-snapshot.test.js`) was used unmodified.
One historical test in the pre-fix file asserted against real private data
("the real repository resolves phase2-operator-run-2 as the latest run") -- that test was
already deleted by the real commit itself (visible in `git show d290a13`) before Timewitness
ever transplants the current test file, so it never runs in either world and no private data
was needed to reproduce this.

A synthetic `test/unrelated.test.cjs` (`assert.equal(1 + 1, 2)`) was added as the negative
control -- unaffected by the fix, expected to PASS in both worlds.

## Result

```
node timewitness.cjs prove --scope automation --scope test \
  --test test/layer1-dashboard-runs.test.js \
  --test test/layer1-dashboard-read-api.test.js \
  --test test/layer1-snapshot.test.js --repeat 3

TIMEWITNESS: PROVEN
Before: FAIL 3/3
After : PASS 3/3
Witnessed changes (whole set): automation/lib/layer1-dashboard-data.js
```

```
node timewitness.cjs prove --scope automation --scope test \
  --test test/unrelated.test.cjs --repeat 2

TIMEWITNESS: NOT_PROVEN
Before: PASS 2/2
After : PASS 2/2
Reason: BEFORE_ALSO_PASSES
```

False PROVEN across both runs: 0. Full raw reports: `PROVEN.json`, `NOT_PROVEN-negative-control.json`.
Both were scanned for absolute paths, usernames, and machine identifiers before being copied here; none were found.
