---
title: "Retrieved text reaches every reader of the conversation it lands in"
date: 2026-10-06
category: security-issues
module: advisor company-context orchestrator debug-logs session-tools
problem_type: security_issue
component: assistant
severity: high
symptoms:
  - "The Orchestrator's per-iteration debug dump printed a company context search's query and results to the worker's log"
  - "After the search was redacted by tool name, a follow-up turn still printed an earlier answer that quoted the same passage as plain text"
  - "The Advisor's session tools listed and opened every member's Advisor conversations in the organization, including a project guest's turn"
root_cause: scope_issue
resolution_type: code_fix
related_components: [temporal, orchestrator, direct-chat, rag]
tags: [company-context, tenant-isolation, logging, redaction, conversation-scope, advisor, fizzy-2719]
audience: engineers adding a tool that retrieves tenant text into a chat, or a read of stored conversations
owner: web app team
---

# Retrieved text reaches every reader of the conversation it lands in

## Problem

The Advisor gained a tool that searches the organization's company context (Fizzy #2719). Access was checked carefully at the tool: membership on every call, the feature gate, ready sources only, no project guests. The text the tool returned, though, did not stay with the tool. It moved into the model's answer, the next turn's history and other tools' arguments, and every log line and reader of the conversation then saw it. Two readers had no business seeing it: an unconditional debug log, and other people.

## Symptoms

- `runAgentIteration` logs the last four messages it sends to the model and the tool calls it returns, unconditionally, as JSON. Both carried the search's query and the matched company passages.
- The first fix redacted parts whose `toolName` was the search tool. A cross-model review then showed the next leak: on a follow-up turn, the history holds the earlier **answer** as plain text, and that answer quoted the passage. The dump printed it.
- `list_recent_sessions` and `get_session` in the Advisor's tools filtered conversations by `{ organizationId }` alone. Every Direct turn gets these tools, including one whose organization was resolved for a project guest. Any member's Advisor answer built on company context was readable by anyone in the organization, and by such a guest.

## What Didn't Work

**Redacting by tool name.** It held for the search call and its result, then failed in three places it could not see:
- an earlier answer carried as plain text (a follow-up turn's history keeps only role and content);
- another tool's arguments, into which the model can copy a passage;
- and, in the last review pass, model-written argument **names**.

None of these can be recognized by what produced them.

**A test that passed against the vulnerable code.** The first end-to-end test put the quoting answer fifth from the end of the history. The dump is `messages.slice(-4)`, so the answer was never printed, and the test was green with the redaction removed. It failed only on an unrelated assertion (the user's question), which hid that the follow-up path was not exercised.

**Judging the durable copies by where they are written.** The search result also lands in the workflow's tool-call state, the workflow output and the conversation's saved metadata. That looks like a leak until you ask who can read each copy. All of them were owner-only: `userId` plus the organization filter in the API, the `per_user_within_org` RLS policy, and the run-memo check on Temporal status and resume. They take the same paths `project_rag_query` already takes. The real cross-user path was a different one: a tool reading other people's conversations.

## Solution

**Debug dumps print a conversation's shape, never its text.** That covers every part type and every tool, not just the sensitive one:

```ts
// run-agent-iteration.ts
export function messagesForLog<M extends { role?: unknown; content: unknown }>(
  messages: readonly M[],
): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    ...(Array.isArray(message.content)
      ? { parts: message.content.map(partForLog) } // { type, toolName?, chars }
      : { chars: sizeOf(message.content) }),
  }));
}

export function toolCallsForLog(calls: readonly AgentToolCall[]): unknown[] {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    argCount: Object.keys(call.args ?? {}).length, // not the names: the model writes those too
    argsChars: sizeOf(call.args),
  }));
}
```

**Personal records use the exclusive owner filter.** One `scope` constant served both organization-shared resources (agents, connections) and personal ones (conversations). The conversation reads now match the app's own query (`getAgentConversationById` filters `{ id, userId, ...orgFilter }`):

```ts
// advisor-tools.ts
const scope = organizationId ? { organizationId } : { userId }; // agents, connections
const conversationScope = organizationId
  ? { organizationId, userId }
  : { organizationId: null, userId };                             // conversations
```

## Why This Works

Once the model has read a passage, the passage can turn up anywhere the model writes: in its answer, in the next call's arguments, in an argument's name. From then on, nothing distinguishes it from any other text. A filter keyed on where text came from cannot follow it, but a rule about what a sink may hold can. A debug dump needs roles, tool names and sizes to diagnose a loop, never the text itself.

A tool's access check governs only who may *run* the search. Who may *read the result* is decided by every place the result lands: the answer, the stored conversation, and every reader of that conversation. The session tools were such a reader, with a wider scope than the app's.

## Prevention

- When a tool retrieves tenant text, list every **reader** of the conversation it lands in (logs, saved conversation reads, other tools that read conversations, exports) and compare each reader's filter with the in-app query for the same records. A reader may be narrower than the app, never broader.
- Do not reuse an organization-wide `scope` for records that belong to a person. Write the personal filter out: `{ organizationId, userId }` or `{ organizationId: null, userId }`.
- Never log message bodies or tool arguments, at any log level that ships. Log shape: roles, part types, tool names, counts, sizes.
- In a test for a windowed dump, put the sensitive text **inside** the window. Check the test against the old code and read **which** assertion fails; a failure on an unrelated assertion does not prove the path is covered:

```ts
it("print no earlier answer on a follow-up turn, while the model still gets it", async () => {
  // history: [user, assistant answer quoting PASSAGE, user follow-up]; all within slice(-4)
  const result = await runAgentIteration(buildInput(FOLLOW_UP_HISTORY));
  expect(consoleOutput(consoleSpies)).not.toContain(PASSAGE);
  expect(JSON.stringify(streamTextMock.mock.calls[0][0].messages)).toContain(PASSAGE);
});
```

## Related

- [A guard belongs on the copy that gets read](a-guard-belongs-on-the-copy-that-gets-read.md): the same shape for prompt injection, where neutralization sat on the stored copy nothing read.
- [A trust boundary has more than one axis](a-trust-boundary-has-more-than-one-axis.md): authorization reviewed along one axis while another stayed open.
- [Company Context](../../features/company-context.md): the Advisor section describes who gets the search.
