---
"fabric-app": patch
---

Repoint public-tree links at the open-source repository, drop instructions and run logs that only made sense inside the private tree.

Pre-public-flip content review (Fizzy #2303). Every finding is docs or metadata; no product behaviour changes.

- `docs/external-agents.md` deleted: it told the reader to clone the private repo with `--recurse-submodules` and to add a submodule the tree does not contain (no `.gitmodules`, no `agents/langchain/cuga`). The agent's architecture is already documented under `agents/docs/`.
- `docs/deployment.md`: the release-App install target and secrets URL now name the open-source repository; the trailing one-off backfill checkbox is removed.
- Links that would 404 for a first-time reader repointed: `fabric-app`'s `repository.url`, the six `integrations-*` third-party notices (these ship inside the npm tarballs), the Fabric MCP catalog entry, the agent-orchestrator project config, and the "GitHub repository" link in a published blog post.
- Azure alert `runbook_url`s (and their mirrored ARM template) pointed at `docs/runbooks/*` on a branch name that does not exist; those runbooks are operator documents deliberately excluded from the public tree, so a paged responder would have followed a permanent 404. Each alert now links the section of `docs/monitoring/alerts.md` describing the rule that fired, and its description says "alert catalogue" rather than "runbook", which is what it now points at. The catalogue headings dropped their rule counts: they are link targets, and a count in a heading rots the anchor the moment a rule is added. The monitoring docs themselves no longer link the excluded runbooks either, and the alert catalogue gained the two repo-integration rules it had never listed — the payload lands there now, so the table has to contain the rule.
- Two pre-open-source pull-request links de-linked: the numbers do not resolve in the new repository and would eventually collide with unrelated pull requests.
- Dated staging run logs removed from `docs/qa/pr-review.md` and `docs/qa/workflow-editor.md` (they named an internal project, the private repo and internal PR numbers). Three environment-neutral lessons from inside the workflow-editor log are kept under the preceding heading: the manual-credential rows, the `executionId` requirement, and asserting a bounding box rather than visibility.
- The real staging hostname replaced with placeholder domains where it was only serving as an example value. Fixture and test usages are untouched.
- The seeded Fizzy MCP entry no longer carries an icon URL that 404s. Its `defaultUrl` is kept: that endpoint is live and answers 401 asking for the caller's own personal access token, which is exactly what the entry's API-key auth method expects.
