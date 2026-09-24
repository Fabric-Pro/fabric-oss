---
"fabric-app": patch
---

Roadmaps on maturation boards stop showing Start Building once an item moves past To Do, and several Roadmap review surfaces read more clearly.

Follow-up to the Roadmap entry points / recommendations / AI batch cleanup release, from staging QA:

- Populated rule: Maturation V2 boards only edit the maturation stage, so every item stays in the default Backlog status and the status-only rule never counted anything. With V2 on, the Backlog exclusion (FR41) now applies only while the item's effective stage is still To Do. Hidden, declined and final-status items stay excluded; with V2 off the rule is unchanged.
- Start Building intro names the To Do stage on V2 boards; the Get Started page-tour copy no longer names Backlog/Done.
- Pending-review banner no longer claims every proposal came from monitored Teams channels (it also counts context-recommendation batches).
- Recommendation batch header: the entry point moves to the meta line ("via … · requested …") instead of sitting beside the source label.
- Roadmap source column widened so "AI Recommended" / "Approved Proposal" no longer truncate; the ⋯ Roadmap actions menu moves to the end of the toolbar.
- Capability gate banner stacks its action under the text in narrow containers (auto-refresh popover wrapped one word per line).
