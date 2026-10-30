---
title: "CopilotKit runtime properties never reach the agent; the run input does"
date: 2026-10-29
category: integration-issues
module: copilotkit chat route proposal-client-run
problem_type: integration_issue
component: assistant
severity: high
symptoms:
  - "Chat on a client Proposal answered from the agent's built-in prompt template instead of the prompt the server resolved"
  - "A test asserting on the options handed to the mocked runtime endpoint passed while the agent never saw the value"
root_cause: wrong_api
resolution_type: code_fix
related_components: [agents, web-route]
tags: [copilotkit, forwarded-props, agent-run-input, mock-hides-contract, proposal-chat, fizzy-2946]
audience: engineers passing a server-resolved value from a Next.js route to a LangGraph agent through CopilotKit
owner: web app team
---

# CopilotKit runtime properties never reach the agent; the run input does

## Problem

The chat on a client Proposal needs a prompt that only the server may choose: the revision prompt bound to the document, resolved from what the caller may see (Fizzy #2946). The route resolved it correctly and handed it to the runtime in the endpoint's `properties`. The agent never read it. Chat fell back to the agent's built-in template, and nothing failed: no error, no log, a plausible answer from the wrong prompt.

## Symptoms

- A Proposal chat behaved as if no prompt were bound.
- The route's unit test passed. It asserted that the mocked endpoint was created with the resolved prompt in `properties`, which was true, and which says nothing about what the agent receives.

## What Didn't Work

**Trusting the option's name.** In `@copilotkit/runtime` (1.70, and the 1.80 v2 handler) the endpoint's `properties` and telemetry options configure the runtime. They are not part of the agent's run input. The agent receives the browser's parsed run input (`forwardedProps`, `state`, messages) plus the headers the route sets, and nothing else. A value placed anywhere else is dropped without a trace.

**Asserting on the mock's options.** A test that checks what the route passed *to* the runtime proves only that the route did what it intended. The contract that failed lives on the other side of the runtime, where the mock stood.

## Solution

Write the server-resolved values into the run input itself, before the runtime parses it. The route reads the single-route envelope for `agent/run` and `agent/suggest`, then, for every key the route owns in `forwardedProps`:

- deletes whatever value the browser sent, so a client can neither choose the mode nor supply the prompt;
- writes the server's value, or `null` when the key does not apply to this run;
- strips steering state fields on the affected runs, so the browser cannot smuggle the same values in through `state`.

The key list is one constant (`PROPOSAL_FORWARDED_PROP_KEYS`) shared by the writer and by anything that must treat those keys as server-only. Values go in `forwardedProps`, never in `state`, because the agent's state snapshots echo every state field back to the browser (see the runner learning in Related). Resolution runs once per run, never on the handshake calls (`info`, `agent/connect`).

Code: `apps/web/app/api/copilotkit/proposal-client-run.ts` (resolution and key list) and `apps/web/app/api/copilotkit/route.ts` (the envelope rewrite).

## Why This Works

`forwardedProps` is the only server-writable channel the agent reads: the agent-core spreads it into the graph's `configurable`, so the chat node sees the values as config. Rewriting the envelope before the runtime parses it makes the route, not the browser, the author of those keys. Deleting before writing matters as much as writing, since a browser that sends the same key would otherwise win on any run where the server writes nothing.

## Prevention

- When a framework option carries a value "to the agent", find where the agent reads its input and check that the value is on that path. Read the runtime's source or log the agent's received input once; do not infer it from the option's name.
- Test through the real boundary: the real handler and runtime, or the agent's own request parser, fed a request whose envelope the route has rewritten. Assert on what the agent parses, not on the options passed to a mocked endpoint.
- Give the test a negative control: send a browser-supplied value for a route-owned key and assert it is replaced or `null`.
- For every key the route owns, decide what it writes when the key does not apply. An absent key lets the browser's value or the agent's default through.

## Related

- [InMemoryAgentRunner echoes the run input to the browser](../security-issues/in-memory-agent-runner-echoes-the-run-input-to-the-browser.md): why server-only values in `forwardedProps` still need a second guard.
- [A guard belongs on the copy that gets read](../security-issues/a-guard-belongs-on-the-copy-that-gets-read.md): the same shape of mistake, a control placed on a copy nothing reads.
