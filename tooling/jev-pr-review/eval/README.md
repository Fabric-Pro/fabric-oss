# Jev PR review evaluation

**Audience** — contributors tuning the advisory Jev check.  
**Owner** — CI maintainers.

The harness measures how many labeled defects the Jev check catches and how
often it flags clean changes at six cutoffs from 0.70 through 0.95. It uses
`readDiffs` and `loadDecision` from [main.mjs](../main.mjs) and `evaluate` from
[review.mjs](../review.mjs), so it sends the same packed source diffs and
questions as the review check. It calls the decision model through AI Gateway
and prints raw per-case maxima from primary scoring requests. The harness skips
file localization, so the shipped cutoffs do not affect case inclusion. Cases
with incomplete primary requests or diffs are listed as **not evaluated** and
excluded from the counts.

From a checkout with workspace dependencies installed, run:

```sh
node --env-file=.env.local tooling/jev-pr-review/eval/run.mjs --out /tmp/jev-baseline.json
node --env-file=.env.local tooling/jev-pr-review/eval/run.mjs \
  --questions tooling/jev-pr-review/eval/variants/tenant-scope-linked-records.mjs \
  --only tenant_scope --out /tmp/jev-tenant-variant.json
```

Set `AI_GATEWAY_API_KEY` and configure `origin` with access to the history. The
runner fetches missing commit IDs from `origin`. An alternate module exports a
`QUESTIONS` map with all four keys. `--only` restricts the case set to the named
question and shared clean controls, and prints only that question's cutoff
table. Each selected case still sends all four questions so its scores can be
compared with a full run.

Add cases in [dataset.json](./dataset.json) with a unique `id`, full `base` and
`head` commit IDs, a question key, `label` (`defect` or `clean`), a one-line
`note`, and `source` (`live-finding`, `fix-history`, or `clean-sample`). For a
history defect, use the introducing commit and its first parent, and name the
introducing location and fixing commit in the note. For a clean sample use
`question: "all"`. Use synthetic-safe notes without identities, private
URLs, copied review comments or credentials.

Run the same dataset before and after changing the wording or cutoffs. Use the
same case selection and compare coverage as well as the cutoff tables, since
wording can shift scores and case exclusions can change the denominators.

## Last measurement (2026-11-17)

Three runs of the shipped questions on this dataset, after the fixes to the
dataset and to case inclusion. Scores for the same case varied by up to about
0.05 between runs.

| Question | Cutoff | Defects caught | Clean flagged | Why this cutoff |
| --- | --- | --- | --- | --- |
| tenant_scope | 0.95 | 0/8 | 0/44 | Live false alarms scored 0.80-0.92, above every history defect (0.71-0.77); no cutoff separates them, so the question is off in practice |
| authz | global (0.8) | 0/4 | 0/40 | No change; the one live defect exceeds the request cap and is not evaluated |
| secrets | 0.75 | 3/7 | 0/40 | Live defects scored 0.79-0.86, so 0.8 sometimes missed one; no clean case passed 0.56 |
| failure_success | 0.85 | 1/9 | 0/43 | Live false alarms scored 0.78-0.84; the live defect scored 0.86-0.88 |

The two wording variants in `variants/` were measured before those fixes and
did not beat the shipped questions: the tenant-scope variant caught fewer
defects at every cutoff, and the failure-success variant matched the shipped
question with one more clean case flagged at 0.80.
