---
"fabric-app": patch
---

Readiness checklist: connecting a chat app and defining terminal statuses now satisfy their items, instead of silently waiting on an unrelated toggle.

Two rules asked for a switch their own name never mentions, so a user who did exactly what the
item described watched it stay red.

**Chat app connected** keyed on the project-level auto-monitor flag, on the premise that a monitor
can only be configured against a connected workspace. Channels are linked independently of that
flag, and a linked channel is usable immediately — the manual "Monitor now" run scans linked
channels with no reference to any enabled flag; the flag only governs continuous watching. It now
counts linked Slack channels, Teams channels and Teams chats.

That premise also collapsed two items into one predicate: `chat-app-connected` and
`work-capture-chat` expanded to exactly the same expression, so "connect a chat app" and "turn on
work capture" could never show different states, and the dependency between them carried no
information. Work capture now requires a linked channel AND a monitor, mirroring
`work-capture-transcripts` (a transcript AND auto-analyse) — a monitor enabled over zero linked
channels watches nothing, so the flag alone must not satisfy anything.

**Terminal statuses defined** additionally required the auto-close toggle. The defined list does
real work without it: the PM poll reads the list to classify linked items as terminal and never
consults auto-close, which governs only whether closed items are hidden from the Roadmap. It now
detects the defined list, as its name says.

Both were found in a staging pass against the checklist spreadsheet's own copy, which describes the
durable thing ("Connect a relevant Slack or Teams workspace/channel", "Map completed or closed
PM-system statuses") while the rules waited on switches. The transcripts pair in the same registry
already implemented the correct shape.

Also removes two stray smart quotes that reached users' tooltips from a spreadsheet paste.

Tests cover the query layer, where a registry test handed a ready-made evidence object cannot
reach, and both rule tests now fail if the old predicates are restored.
