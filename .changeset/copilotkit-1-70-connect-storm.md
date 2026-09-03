---
"fabric-app": patch
---

Upgrade CopilotKit to 1.70.1 so opening a feature makes one runtime handshake instead of ~55 connects

Opening a feature workspace fired roughly 55 `POST /api/copilotkit` requests in
about 1.5 seconds — two `info` handshakes followed by waves of `agent/connect`.
Every connect wipes the agent's messages and state, which is the title-bar flash
already noted in `StoryWorkspacePage.tsx`. Fizzy #2376.

**Cause, all of it inside the 1.52 client.** `useCopilotChatInternal`
reconnected whenever its agent's threadId differed from the configured one.
`useAgent` built a *provisional* agent per hook instance while the runtime was
Disconnected/Connecting, and recomputed it on every status transition. The
compatibility `<CopilotKit>` provider ran the handshake twice — once when it set
the URL, again when it flipped the transport to "single". The feature page mounts
many chat-hook instances (three in `StoryWorkspace.tsx`, one per hydrated
assistant message in `CopilotAssistantMessage.tsx`, the attachment registry, the
sidebar), so each transition fanned out across all of them.

Upstream fixed this in four steps, which is why the bump has to clear 1.70:
1.63.2 added `useAgent.isReady` and stopped running or connecting before `/info`
settles; 1.64.0 introduced `transport: "auto"`; 1.69.0 stopped the compat
provider forcing single-route transport; 1.70.0 made the chat hook connect only
when `runtimeConnectionStatus === Connected` and remember the last connected
agent.

**Pins moved together** (all exact `1.70.1`): `@copilotkit/react-core`,
`@copilotkit/react-ui`, `@copilotkit/runtime` and `@copilotkit/runtime-client-gql`
in `apps/web`; `@copilotkit/runtime` in `packages/agent-core`; and
`@copilotkit/sdk-js` in the project-document-generator agent, which was on a
floating `^1.52.0` that had already drifted to 1.54.1.

**One source change.** `@copilotkit/shared`'s `UserMessage` is now a bare
`agui.UserMessage`; the deprecated `image` field survives only on `AIMessage`.
`CopilotUserMessage.tsx` narrows that legacy field structurally instead of
reading it off the static type, so a persisted history entry that still carries
`{ format, bytes }` renders exactly as before.

**Lockfile.** The bump forces churn outside the CopilotKit subtree and it cannot
be pruned: `@ag-ui/langgraph@0.0.43` (a dependency of `@copilotkit/runtime`)
depends on `@langchain/core@1.2.9`, which becomes the auto-installed peer for
`@langchain/langgraph-sdk` in `packages/temporal`. Dropping CopilotKit 1.52 also
removes `@langchain/community` and with it `openai@4.104.0`, so `agent-core`'s
`@langchain/*` stack re-binds to the `openai@6.22.0` the rest of the repo already
uses. Regenerating from the previous lockfile with only these three manifests
changed reproduces the committed file byte for byte, and the same regeneration
with the manifests untouched reproduces the previous lockfile byte for byte.

**Transport pinned.** Every `<CopilotKit>` mount now passes `useSingleEndpoint`.
Without it the 1.70 client defaults to `transport: "auto"` and probes
`GET <runtimeUrl>/info` before falling back to the single-route POST envelope;
our route is POST-only, so the probe got a 405, and the fetch interceptor
surfaced that as an "AI request rejected" toast on the first smoke test. With
the prop the probe never runs, which is also the transport 1.52's compat
provider forced. `/api/copilotkit` documents the pairing above `POST`.

Measured after the bump (Aspire browser logs, one story open): one `info`
POST plus 16 `agent/connect` POSTs, down from about 55 requests. The 16 are
one per mounted chat-hook instance; collapsing those is Fizzy #2389.

Verified: `apps/web` and `@repo/agent-core` type-check clean; 49 CopilotKit test
files / 415 tests, 16 agent-core files / 497 tests and 12
project-document-generator files / 321 tests all pass; all eight tsup agents that
inline agent-core build.
