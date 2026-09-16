---
"fabric-app": patch
---

Slack search results returned to an AI agent are now neutralized, so a channel message cannot pose as retrieval scaffolding.

Every consumer of the Slack message search — the orchestrator, in-app chat, and
the document-generation agent over the internal search route — hands its output
straight to a model. Message bodies and author names were passed through
verbatim, so a message opening `### Reference 7` or `## Retrieved Context` at a
line start forged structure the agent reads as trusted scaffolding rather than
as channel content. Anyone able to post in a linked channel could do this.

Neutralization is applied where the message object is built, which is the single
point every Slack tool result passes through, so a future consumer cannot
reintroduce the gap by forgetting a wrapper.
