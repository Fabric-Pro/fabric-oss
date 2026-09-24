---
"fabric-app": patch
---

A GitHub push that reaches many projects' coding-instructions syncs now starts at most a fixed number of them from the webhook; the rest are picked up by the automatic poll on their own schedule, and the delivery logs how many it left to it.

Fizzy #2700. The five-second budget bounded the webhook's latency, not the load: a repository followed by many projects started that many workflows in one request. The cap is shared across every sync kind in one delivery.
