---
title: "InMemoryAgentRunner echoes the run input to the browser"
date: 2026-10-29
category: security-issues
module: copilotkit proposal-run-runner thread-owners
problem_type: security_issue
component: assistant
severity: high
symptoms:
  - "A server-resolved prompt written into the run input's forwardedProps appeared in the RUN_STARTED event streamed to the browser"
  - "Any user who knew a thread id could replay that thread, forwardedProps included, through agent/connect"
root_cause: scope_issue
resolution_type: code_fix
related_components: [agents, web-route]
tags: [copilotkit, in-memory-agent-runner, forwarded-props, thread-isolation, redaction, negative-control, fizzy-2946]
audience: engineers putting a server-only value into a CopilotKit run input, or running the default in-memory runner
owner: web app team
---

# InMemoryAgentRunner echoes the run input to the browser

## Problem

To get a server-resolved value to the agent, the route writes it into the run input's `forwardedProps` (see the first Related entry). That is the only channel the agent reads, and it turned out to be a channel the browser reads too. Fizzy #2946 put the bound client revision prompt, the settled-decisions block and carried answer texts there. On a client Proposal, a project guest must never receive the prompt, and a member must never receive the block.

## Symptoms

- The default `InMemoryAgentRunner` stamps `{...request.input}`, `forwardedProps` included, onto the agent's `RUN_STARTED` event when the agent's own event carries no `input`. It streams that event to the browser.
- It also keeps the event in one process-global thread store and replays it on every later `agent/connect` for that thread id. The store records no owner, so the replay goes to whoever names the id.
- So the leak had two paths: the live stream of the run, and a replay to a different user.

## What Didn't Work

**Writing to `state` instead.** The agent's state snapshots echo every state field to the browser by design.

**Hoping the agent's event hid it.** The runner adds the input only when the agent's `RUN_STARTED` has none, which is the common case.

**Asserting on the route.** A test of the route's rewrite cannot see what the runner later does with the rewritten input. The echo happens after the route and inside the runtime.

## Solution

Wrap the runner. `apps/web/app/api/copilotkit/proposal-run-runner.ts` hands the inner runner a copy of the request whose `forwardedProps` has the route-owned keys removed, and overrides the request agent's `runAgent` so the agent itself still receives the full values:

```typescript
const redacted = { ...forwardedProps };
for (const key of PROPOSAL_FORWARDED_PROP_KEYS) delete redacted[key];

const { agent } = request;
const runAgent = agent.runAgent.bind(agent);
agent.runAgent = (parameters, subscriber) =>
	runAgent({ ...parameters, forwardedProps }, subscriber);

return this.inner.run({ ...request, input: { ...request.input, forwardedProps: redacted } });
```

Everything the inner runner emits or stores is therefore built from the redacted copy. The agent is cloned per request, so the override reaches no other run.

Because the store replays by thread id, the wrapper also binds each thread to the session user on its first run (`apps/web/app/api/copilotkit/thread-owners.ts`). It refuses another user's run, replay, stop or running check with one `RUN_ERROR` (`THREAD_ACCESS_DENIED`). The runtime has already answered 200 when it asks the runner, and a thrown error would reach the browser only as a generic failure. The registry is bounded (insertion order, oldest dropped first); a running thread whose owner was dropped is joined by nobody. The wrapper sets no `ɵsupportsLocalThreadEndpoints`, which keeps the runtime's thread list, events and clear endpoints off, since they read the same store with no owner check.

## Why This Works

The leak was not in anything the route wrote. It was in what a shared component does with its input: any input that reaches a runner may reach its output and its store. Removing the keys before the runner sees them is the only placement that covers the stream, the stored copy and the replay at once. The agent gets its values by a separate path that the runner never touches. Owner binding closes the second reader, since the store would otherwise treat a thread id as a capability.

## Prevention

- Treat the run input as public. A value you put there for the agent is readable by the browser unless something removes it before the runner, and a replay widens "the browser" to anyone with the thread id.
- When a shared in-memory store replays by id, check that it records an owner. If it does not, add one before any per-user content goes into it.
- Test with the real `InMemoryAgentRunner`, not a stub, and run a negative control: the same test against the unwrapped runner must fail by showing the secret in the streamed events and in a replay from another user. Read which assertion fails; a pass proves nothing if the control is also green.
- Add a replay case: a second user's `agent/connect` on the first user's thread id gets `THREAD_ACCESS_DENIED` and none of the first user's events.

Tests: `apps/web/app/api/copilotkit/__tests__/proposal-run-runner.test.ts`.

## Related

- [CopilotKit runtime properties never reach the agent](../integration-issues/copilotkit-runtime-properties-never-reach-the-agent.md): why the values go in `forwardedProps` at all.
- [Retrieved text reaches every reader of the conversation it lands in](retrieved-text-reaches-every-reader-of-the-conversation.md): the same lesson about readers a store has beyond the one you designed for.
- [A guard belongs on the copy that gets read](a-guard-belongs-on-the-copy-that-gets-read.md)
