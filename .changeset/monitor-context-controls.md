---
"fabric-app": patch
---

Teams and Slack conversations can be paused without deleting their context, and a monitor whose bound account has gone can be reconnected.

Fizzy #2355, extending the meeting-sync controls to the three channel/chat
monitors. Those panels sit beside the meeting one and had none of it: unlinking
was still a single destructive action, and a monitor whose owner had left looked
perfectly healthy while collecting nothing.

**Pause, keep context.** A single `deactivatedAt` timestamp per linked row.
Nothing is deleted, and only each monitor's own lookup filters on it — which is
what makes pausing the non-destructive alternative to unlinking. Deliberately a
pause on the kept row rather than "unlink but skip the context deletion": the
polling cursor and the seen-message ledger both hang off that row, so deleting it
and keeping the context would rescan from the top on relink and append duplicate
bundles into the very context row it preserved.

Every consumer that scans was moved onto the filter, huddle-note ingest
included — pausing a channel means stop ingesting from this conversation, not
stop one of two paths. The channel-name lookup the newsletter uses is
deliberately NOT filtered, so a paused channel's history keeps its label.

**The unlink confirmation became a fork,** as the meeting one already had. It
names what is actually destroyed — the conversation context and its indexed
content, which the old copy never mentioned, only "seen-message history" — and
offers pausing as a third action, which takes focus. The reflex of hitting Enter
now keeps the context. Slack also stops borrowing the Teams wording, which named
the wrong product.

**Unlinking stays admin-only; pausing joins it,** matching the meeting rung.
Linking stays open to editors — a team member may need to add a channel the owner
was not in.

**A dead monitor is no longer silent.** Each monitor runs as one project-level
workflow carrying one user's delegated token, frozen into the workflow's
arguments at enable-time and unreachable from SQL. When that account loses access
the fetch returns an empty list rather than an error, so nothing increments and
the run still stamps a clean `lastRun` — a project quietly collects nothing while
the panel reports "0 threads scanned · last run 5 hours ago". The bound account is
now persisted, and Reconnect rebinds the project after a preflight that probes
each conversation with the monitor's OWN call and names the ones the new account
cannot see. Slack's huddle ingest is rebound in the same step, because it reads
the same rows under the same credentials and would otherwise stay dead behind a
panel that now looks fixed.

The preflight has three outcomes rather than two: "could not check" is never
collapsed into "you can see nothing", because those are opposite
recommendations — the mistake that made the meeting preflight advise against a
repair that would have worked.

Needs a temporal-worker deploy as well as web.
