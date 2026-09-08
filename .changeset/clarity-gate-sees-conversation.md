---
"fabric-app": patch
---

Stop the Loom orchestrator re-asking clarifying questions the conversation already answered

Reported as the assistant repeating the same clarifying question minutes later in one chat
(Fizzy #2406). Two independent gaps, both fixed here.

**The gate never saw the conversation.** The up-front intent-clarity check was called with only
the current message. `input.history` was already on the workflow input and already consumed by
planning and iterative execution — it was simply never handed to the clarity activity, whose
`conversationSummary` parameter and "Conversation so far" prompt slot already existed. Because
every completed turn ends its execution and the next message starts a fresh one, the gate
re-evaluated from a blank slate on every turn. The per-step check had the same blindness (it
received only the current enriched message) and is fixed the same way, with the summary rendered
once per plan rather than once per step.

**The answer never came back.** The clarifying Q&A was recorded in `enrichedMessage` and the
workflow's journey transcript, and both reach the completion phase — but that path feeds pattern
learning and episodic memory only, never the chat transcript. The execution record the client
rebuilds history from is written client-side from the raw typed text, so the exchange reached
long-term memory and never the next turn. Answered clarifications are now kept on the execution,
persisted with it, rehydrated on reload, and replayed into history — covering both the
same-session case and the post-reload case, which fail through different code paths.

The clarity prompt is hardened to match: conversation context is sent ahead of the request rather
than after it, and the reviewer is told never to re-ask what the conversation settles while
explicitly still asking when it genuinely does not — the two pull in opposite directions and both
are covered by tests, since a fix that only suppresses would trade this bug for silent
under-asking.

Scope is the Loom Orchestrator chat, the only surface that renders this card. Agent Template
chats use the separate `ask_clarifying_question` tool path, where the model already receives the
full message array. Prompt and context change only — no schema change, no new feature flag, and
no new Temporal patch marker, since adding a field to an existing activity call changes the
payload and not the command stream.
