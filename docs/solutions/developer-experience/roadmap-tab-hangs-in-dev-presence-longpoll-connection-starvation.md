---
title: "Project Roadmap tab hangs on skeleton in local dev (presence long-polls starve chunk loads)"
date: 2026-07-08
category: developer-experience
module: web project roadmap
problem_type: developer_experience
component: frontend
severity: medium
symptoms:
  - "The project Roadmap tab shows a loading skeleton forever in local dev; the board never renders."
  - "Network tab shows _next/static/chunks for StoriesRoadmap/StoryCard/StoryWorkspace/pm-sync failing with net::ERR_ABORTED."
  - "Zero console errors; backend RPCs (projects/get, statuses) all return 200; a Playwright/MCP browser times out driving the page."
root_cause: "The project page opens several concurrent /api/projects/{id}/presence long-poll requests (held ~5 min each) that saturate the browser's ~6-connection-per-origin HTTP/1.1 limit, so the roadmap's lazy dynamic-import chunk requests get no free connection and are aborted."
resolution_type: workaround
applies_when:
  - "Verifying or driving the project Roadmap UI in local Aspire/Next dev (HTTP/1.1)"
  - "A heavy dynamic-import route renders only a loading skeleton with ERR_ABORTED on its JS chunks and no console/compile error"
  - "Repeated reloads make it worse rather than better"
tags: [roadmap, presence, long-poll, http1.1, connection-limit, turbopack, dynamic-import, err-aborted, local-dev, playwright]
related_components: [stories, project-detail]
---

# Project Roadmap tab hangs on skeleton in local dev (presence long-polls starve chunk loads)

## Context

While verifying a feature in the project **Roadmap** tab on a local Aspire + Next.js (Turbopack) dev stack, the tab rendered only a loading skeleton (`animate-pulse`) and never mounted the board. The "Add" (create work item) button — and everything else in `StoriesRoadmap` — was unreachable. There were **zero console errors**, **zero compile errors**, and backend RPCs (`projects/get`, statuses) all returned **200**. A Playwright MCP browser timed out on nearly every action against the page.

The misleading part: it looks like a backend hang or a Turbopack compile failure, and it is neither.

## Guidance

Diagnose it from the **network** panel, not the console. The roadmap's lazy (`dynamic()`) JS chunks — `StoriesRoadmap.tsx`, `StoryCard.tsx`, `StoryWorkspace.tsx`, `pm-sync`, `maturation`, backlog components — return `net::ERR_ABORTED`. The web dev log then reveals the real cause: multiple

```
POST /api/projects/{id}/presence 200 in 5.0min   (application-code: 5.0min)
```

i.e. several **presence long-poll requests, each held open ~5 minutes**, fired concurrently by one page load.

Root cause: Next.js dev serves over **HTTP/1.1**, where a browser allows only **~6 concurrent connections per origin**. The concurrent 5-minute presence long-polls occupy the whole pool, so the roadmap's ~10 lazy chunk requests **never get a free connection** and the browser aborts them → the component never mounts → permanent skeleton. Repeated reloads make it worse because each reload spawns fresh presence connections the server keeps holding.

**Workaround to unblock local UI verification** — block `/presence` in the browser so the connection pool frees up for the chunks. With Playwright (incl. the Playwright MCP `browser_run_code_unsafe`):

```js
await page.route('**/presence', route => route.abort());
await page.goto('http://localhost:3001/app/projects/<id>');
// roadmap chunks now load; the board renders
```

This was the confirming experiment: with `/presence` aborted, the roadmap rendered **immediately** — proving the connection-starvation diagnosis.

## Why This Matters

`ERR_ABORTED` on script chunks with no console error is easy to misread as "Turbopack is flaky" or "the backend hung," sending you down `.next` wipes, `pnpm install`, and AppHost restarts that don't help. The real lever is the HTTP/1.1 connection budget vs. long-lived requests. Knowing this turns a multi-hour rabbit hole into a one-line `page.route` abort.

It is **dev-only**: production preloads critical chunks with high priority before the app opens presence connections, and typically serves over HTTP/2 (no ~6-connection cap), so users never hit this.

## When to Apply

Reach for this whenever a heavy dynamic-import route in local dev renders only a skeleton, its JS chunks show `ERR_ABORTED`, and there are no console or compile errors — especially when the page also opens long-poll/SSE connections (presence, notifications, realtime).

## Examples

- **Diagnosis signature:** skeleton + `ERR_ABORTED` on `_next/static/chunks/*stories*` + web log showing `POST .../presence 200 in 5.0min` (several of them).
- **Unblock:** `page.route('**/presence', r => r.abort())` before navigating.
- **Real fix candidates (not just workaround):** cap/dedupe the number of concurrent `/presence` long-polls opened per page (one shared connection, not one per component/hook), shorten the long-poll hold, or serve the dev app over HTTP/2 so the 6-connection cap does not apply. Worth a DX ticket — this affects anyone opening a project page in local dev, independent of any feature work.
</content>
