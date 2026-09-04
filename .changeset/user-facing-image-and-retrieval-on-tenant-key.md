---
"fabric-app": patch
---

Image generation and chat retrieval now run on the tenant's own key, closing the last paths where a waiting user was served on the platform's.

Found by the adversarial gate, and corroborated by three reviewers across two
model families. The glossary this branch added defines the system resolver as
used "only where nobody is waiting — indexing, embedding, tool ingestion", and
says anything a person triggered refuses until they configure a provider. Two
kinds of call did neither.

`generateImageActivity` resolved on the system half, and every one of its
callers has someone waiting: direct chat's image tool, the agent executor, an
MCP tool call, and the orchestrator's Fabric-AI handler. It is also the most
expensive call the product makes, so a keyless tenant was being served the
product's costliest operation on the deployment's key while cheaper ones
refused. The workflow-builder image step resolved the same way and moves with
it.

Direct-chat RAG retrieval is genuinely an embedding step, which is why it sat on
the system half — but the reasoning stops at "embedding", and indexing is
background work while a chat turn is not. Retrieval there builds context for a
reply that the generation step refuses anyway when the tenant has configured
nothing, so it embedded the person's message and their attached documents with
the deployment's key, sending that content to a provider the tenant never chose,
to assemble context nobody would see. For a tenant that has a key nothing
changes: the system resolver would have returned that same key.
