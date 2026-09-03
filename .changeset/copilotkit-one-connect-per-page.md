---
"fabric-app": patch
---

Share one CopilotKit chat hook per page so opening a feature makes two agent connects instead of one per mounted message

Follow-up to Fizzy #2376 / PR #179. After the 1.70.1 upgrade the double handshake was gone, but opening a
story workspace still fired one `info` POST plus 16 `agent/connect` POSTs, and one chat question was
mirrored into five identical response streams (Fizzy #2389).

Cause: in `@copilotkit/react-core` 1.70 the connect lives inside `useCopilotChatInternal` (and
`useCopilotChat`, a thin wrapper over it). Each call site owns its own `lastConnectedAgentRef` and calls
`copilotkit.connectAgent` from its own effect, and core's `connectAgent` has no already-connected guard.
So every hook instance opened its own connection and its own run stream against the same shared agent.
The story page had seven such call sites plus one per rendered assistant message, so the count grew with
thread length. `useCoAgent`, `useCopilotAction` and `useCopilotReadable` never connect and are unchanged.

Fix: a `CopilotChatSessionProvider` calls the hook once per `<CopilotKit>` mount and publishes the result
through context; every consumer reads `useCopilotChatSession()` instead of calling the hook itself. On the
feature workspace the only remaining connects are the provider's and `CopilotSidebar`'s own internal one.
The suggestion chips are rendered by the app instead of by react-ui's list, whose per-chip button also
called the hook (three static chips measured as three connects). The document editor and a few agent
surfaces still keep direct hook calls of their own; they gain the shared session for the converted
components but their own call sites are unchanged here.
