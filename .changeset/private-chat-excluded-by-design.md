---
"fabric-app": patch
---

A linked one-to-one or group chat now says it is excluded by design, instead of reporting itself as a channel whose messages have not been captured yet.

Fizzy #2228, AC1. Conversation capture covers shared channels only — a project is a wider audience than a private conversation, so the Teams chat analyzer is deliberately untouched. But the export reported both kinds of row through one reason, `CONVERSATION_NOT_CAPTURED`, rendered as *"Linked Microsoft Teams conversation — no messages captured yet"*. For a channel awaiting its first bundle that is accurate. For a one-to-one or group chat the word "yet" promises an export that will never arrive, which is the opposite of the exclusion AC1 requires the UI to communicate — and the ticket's own title is about chat content, so it is the wording the reporter reads first.

The taxonomy now splits the two, because they describe opposite futures rather than two shades of the same one:

- `CONVERSATION_NOT_CAPTURED` keeps its wording and its meaning: a shared channel that capture is running against and has not filled yet.
- `PRIVATE_CONVERSATION_EXCLUDED` is new — *"Linked Microsoft Teams chat — one-to-one and group chats are not captured by design; their messages stay in Microsoft Teams"*. It states the fact and where the content actually lives, and stops there; the reasoning behind the exclusion belongs in the product's documentation, not in a manifest line.

The discriminator is metadata the writers already persist, not a new column: Teams stamps `chatType: "channel"` beside `teamId`/`channelId` and `chatType: "group"` beside `chatId`, and Slack writes `channelId` with no `chatType` at all. So a channel is `channelId` present with `chatType` absent or `"channel"`; anything else with a `chatId` — `"group"`, Graph's `"oneOnOne"`, a value not yet seen — falls to the private-chat reason. Erring that way is deliberate: an unrecognized chat kind reported as a private chat understates capture, while the reverse would go back to promising capture that never comes.

The reason is still derived once by the pure function, rendered once into the manifest and counted once for the in-app summary, so the archive and the toast cannot drift. The MCP gateway's `unavailableReason` was saying the opposite thing about the same rows — that the messages "are captured into separate conversation records" — which for a private chat would send an agent hunting for records that do not exist; it now shares the classifier and tells the same story.

Both exhaustive-render walks gained a guard against `undefined` appearing in a rendered line. They build their samples through a cast, so a future payload-carrying reason would otherwise have rendered "Linked undefined chat" and still passed the distinctness check.
