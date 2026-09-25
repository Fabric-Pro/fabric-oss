---
"fabric-app": patch
---

Proposals from monitored Teams chats now link back to the chat message they came from, and Teams and Slack proposals show the original conversation.

Fizzy #2503. The proposal inbox's source panel only read the channel keys
(`channelName`/`channelDisplayName`, `threadRootWebLink`, `channelWebUrl`).
The Teams chat monitor stores `chatTopic`, `linkedChatId` and `threadRootId`
instead, and neither link it could store is ever populated: Graph returns no
`webUrl` for chat messages, and the chat picker never selects the chat's own
`webUrl`. Every Teams chat proposal on staging had no link at all, so the inbox
showed no source panel, and its list badge always read "Posted in Teams chat".

- `teamsChannelMonitor.pendingProposals.get` returns `teamsChatId`, the Graph
  chat id resolved from the linked chat within the proposal's project
  (`getLinkedTeamsChatGraphId`).
- The inbox builds Microsoft's documented chat-message deep link
  (`https://teams.microsoft.com/l/message/<chatId>/<messageId>?context=…`) from
  it and the stored root message id, after the stored thread link and before
  `chatWebUrl`.
- The detail panel and list badge name a chat by its topic.
- The formatted thread every channel monitor already stores in
  `sourceMetadata.transcript` is shown behind "See original conversation",
  reusing the meeting transcript expander (extracted as `SourceTranscript`).
