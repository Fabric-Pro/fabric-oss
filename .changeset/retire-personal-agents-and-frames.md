---
"fabric-app": patch
---

Retire the personal agents and frames route trees, which sat outside the account group and had been missed

Twenty pages under `/app/agents` and `/app/frames` were personal-rooted — no slug, so no tenant — but lived outside the account route group, so the sweep that counted seventeen directories did not see them. Each tree is now a single redirect into the caller's organization, matching the rest.

Two agent surfaces had no organization counterpart to redirect to and were moved rather than replaced: the document generator, which is a live feature with a copilot binding, and the CUGA generalist. Both already understood organization context; what changed is that their "no organization" branches are gone.

The shared Fabric AI client and its panels lived inside the personal route directory while the organization page imported them across trees. They now sit in the agents module, where a component shared by a route belongs.
