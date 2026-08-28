---
"fabric-app": patch
---

Monitored Teams and Slack channels now keep their conversations, so they export and the assistant can cite them.

Fizzy #2228, U5. A linked channel's `ProjectContext` row is a pointer — a cursor and dedup markers, `content` empty. The messages only ever existed inside a `PendingBacklogProposal`'s `sourceMetadata.transcript`, and only when the analyzer proposed something. An analyzer run that proposed nothing left no trace of the discussion anywhere, which is why "Download All" reported those channels as having nothing to export.

Capture now runs ahead of the analyzer, so it happens on both branches of its outcome. Each analyzed bundle becomes one `ProjectContextConversationBundle` row under the channel's context row, neutralized with `neutralizeAiChatAttachmentBody` before the write so every derived copy — vector payload, retrieval result, export archive, MCP read — inherits the guard.

Three things carry the correctness:

- **Message identity is what gets claimed, not bundle identity.** Each message is claimed by an INSERT under `(parentContextId, providerMessageId)`, and the bundle is assembled only from the messages that INSERT actually won. Two workers over overlapping snapshots of one thread therefore write disjoint bundles whatever each fetched, without either holding a lock. A worker that wins nothing writes no bundle.
- **Claiming and bundling share one transaction.** Claims committing without their bundle would make the messages unrecoverable: a retry finds them already claimed, computes an empty claim set, and writes nothing. The rollback is what makes a retry re-win them.
- **Embedding is a separately claimable step, and its claim is not the field that records success.** A lease on `embeddingLeaseAt` is taken by compare-and-set; `embeddedAt` stays null until the vector store confirms. A crash between the two leaves a row the recovery sweep can still find. The point id is derived from the bundle row id, so a repeat overwrites rather than duplicating — and that determinism is what lets the embedder delete its own point when an unlink lands mid-write.

Slack needed a pointer row before it had anything to hang bundles off: channels linked from Project Settings had a monitor row and no `ProjectContext` at all, so capture would have been a permanent no-op for them. `ensureSlackChannelIntegrationContext` mirrors the Teams helper and is called from the link procedure at link time — never from the capture path, so an unlinked channel is not recreated mid-run. It matches on `metadata.channelId` alone because the Add-Context dialog and the wizard never persist a workspace id.

On Slack this also moved the thread fetch outside the claim-as-lock, since capture has to precede the claim and needs the fetched text. Two workers racing a thread now both fetch; the per-message claim is what makes that safe, and the lock keeps protecting what it was written to protect — the analyzer and proposal work.

Scope: shared channels only. One-to-one and group chats are excluded by decision, and the Teams chat analyzer is untouched.
