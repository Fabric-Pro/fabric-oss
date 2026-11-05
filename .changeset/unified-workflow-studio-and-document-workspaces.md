---
"fabric-app": patch
---

Unify workflow creation and execution in one studio with saved drafts, version publishing, run history, and authorized Databricks SQL and AI connections. Keep workflow navigation clear of the app sidebar, with compact filters and canvas fitting as panels resize. Restore document Workspaces alongside generated Pages, with persistent document chat and shared document-reading tools for Fabric agents.

Show recorded step results before draft configuration and render generated text directly, with raw output available on demand.

Restore credential mapping for Blob, Clerk, Stripe, Superagent, and Webflow workflow actions. Treat MCP tool errors as failed runs, preserve plain-text arguments, and prevent replay on another server after an execution is dispatched. Require the description needed to create Zendesk tickets.

Accept current and legacy connection key formats, honor Firecrawl workflow connections and editor defaults, and record provider failures consistently. Keep Blob upload paths on the configured API origin and reject redirects.

Make Coding Agents launch controls open Portal AI settings, provide explicit desktop installation options, and use registered remote servers for assignment. Remove simulated subscription verification and remote dispatch confirmations.

Direct paused native coding sessions to their authenticated approval controls instead of offering a text reply as a way to approve requests.

Correct the optional local board setup guidance and keep remote assignment available when that board is offline. Show the actual AI provider alongside custom connection labels in provider status summaries.
