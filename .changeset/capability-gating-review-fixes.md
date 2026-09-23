---
"fabric-app": patch
---

Capability gates now name the real prerequisite, offer a working fix or retry, refresh on their own, and support dismissing a warning for the session.

Fizzy #1930 review round (two independent reviews of 4B). Internal context:

- A repository with code search off (the schema default) no longer reads as "indexing" forever: it is a block pointing at the code-search setting (hard for Atlas Q&A, soft for document generators so pasted source text still lifts it); an enabled repository that never indexed offers a retry that starts the first run. With code indexing off for the whole deployment the gate says so and offers no project remedy. Processing is only ever returned while a job runs, pinned by a registry sweep.
- Each capability depends on what it reads: Atlas Analyze, the repository scanners and release notes need only a working connection; Atlas Q&A needs a ready graph or a usable index; document generators count the index only over a working connection and point at the codebase remedy when the repository is their only possible source.
- Create-with-AI is gated before the create transaction, so the demotion of an existing document can no longer refuse the generation it grounded. Batch generation, Atlas system chat and Describe with AI are gated; batch skips and reports refused types. Approving an already-generated newsletter is no longer gated; Settings → Newsletter shows the gate above Send now.
- CAPABILITY_GATING is resolved for the project's organization on every path, so the per-organization override works.
- Multi-branch scans assert once; feature-scoped scans are not gated; a scan stalled past the gate's window is closed before the retry that replaces it.
- Null-clock stalls fall back to the row's own timestamps; the watchdog sweep also closes never-started (PENDING) scans. This sweep change lives in @repo/database but runs in the Temporal worker, so it takes effect only after a worker deploy.
- Suppression fingerprints are per rule with a completion marker; entries record createdAt and duration; restore takes a list in one write; door refusals are logged; tenant mismatch is a structured NOT_FOUND. Existing stored dismissals stop matching once (their fingerprint format changed), so previously dismissed warnings reappear one time.
- Client: remedy links and codebase retries are owned by the banner; gates poll while Processing and refresh after a 412; the provider requests only mounted surfaces, taking the Atlas status call off every page load.
- Deliberately not built, pending a product decision: Work Capture (FR76-81), automation / living-document refresh (FR72-75), the Settings PM Sync and terminal-status rows. Scheduled newsletter, scheduled document refresh and the PRD-to-tasks pipeline's children run ungated by design. Reports AC-13 remains unmet by design.
