---
"fabric-app": patch
---

Say "Every linked Teams chat is paused", not "teams chat", when a monitor has nothing left to scan.

The noun reaches `throwNoActiveContextSources` already cased for prose — "Teams
chat", "Slack channel" — and the message lowercased it, turning product names
into what reads as a typo. Found by exercising the paused-monitor gate on
staging.
