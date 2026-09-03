---
"fabric-app": patch
---

Fix the CodeQL baseline findings and scan the public repository on every master push without blocking the relay

CodeQL default setup was enabled on the public repository after the flip and disabled the same night: it posts each new alert as a review thread, master requires conversation resolution with no App bypass, and the relay's squash was refused. This change re-enables scanning as an advanced-setup workflow (`.github/workflows/codeql.yml`) that runs on master pushes, weekly, and on dispatch — never on pull requests — and is a no-op in the private staging repository, which has no GitHub Advanced Security.

The 250-alert baseline from the one full scan was triaged per the new SECURITY.md § Code Scanning policy. Fixed here: a SharePoint transcript fetch whose origin (and bearer-token audience) came from a tool argument with no host check; a sandbox exec command builder that escaped quotes but not backslashes; a substring host check gating a GitHub token; an ADO host suffix check missing its leading dot; the OAuth callback pages embedding an unauthenticated query parameter into an inline script literal and raw HTML; a prompt-enhancer render path that could briefly render un-escaped prompt text as HTML; Math.random browser-session handles with no ownership check; ten `console.*` format strings carrying request-derived values; a workflow missing a `permissions:` block; a seed script shelling out with interpolated values; and the polynomial-backtracking regexes that run over request bodies, user documents, PM-tool payloads, webhook fields and fetched content. The remaining alerts were dismissed in the Security tab with a per-alert reason naming the source and sink.
