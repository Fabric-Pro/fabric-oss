---
"fabric-app": patch
---

Stop a punctuated MCP server name from stripping every tool out of a chat turn

Reported as the Fabric Agent panel being unable to see meeting transcripts: asked "do you
see any meeting transcripts for yesterday?" on a project page, it answered "I don't have
any tools connected in this panel right now... connect the relevant tool in Settings" —
while the composer showed 11 MCP servers and the project attached, and the same question
on the full Fabric AI page answered correctly from the transcript lookup.

The panel's tool wiring was never the problem. Read from the Temporal history of the
failing turn, `executeDirectChatActivity` ran twice, and the first attempt returned:

    tools.12.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'

An MCP tool is named `<server name, lowercased>_<tool name>`, and the server name is free
text the user typed. The prefix replaced whitespace and nothing else, so a name holding
parentheses or an apostrophe produced a tool name outside the provider's grammar.
Anthropic rejects the entire request over one bad name, so every tool in the turn died —
including the meeting-transcript lookup, which is why the symptom looked like the
transcript bug it was filed as.

What the user then read came from the graceful-degradation retry (#1644): the turn had
failed with tools in scope, so it re-ran with tools disabled, and the tools-disabled
prompt says "No tools connected. Suggest the user connect tools in Settings." The model
repeated it. Nothing recorded the failure — the retry's `success: true` is what gets
persisted, so the conversation, the UI and the database all show a healthy turn.

- `buildMcpToolName` repairs a name into the grammar, and returns an already-valid name
  byte-identical so nothing that worked is renamed.
- Names are reserved in a set shared across servers. The name keys both `tools` and
  `toolToServerMap`, so two servers repairing to the same prefix would otherwise overwrite
  each other and dispatch one server's calls to the other — worse than the rejection.
  Over-long names are hashed rather than sliced, for the same reason.
- `validateMcpToolSet` now drops a tool whose name cannot be sent, as the fail-safe behind
  all of it: whatever produces a bad name in future, it costs one tool instead of the turn.

Fizzy #2473. The masking itself — a hard 400 presented as a confident claim about
capability, on a surface whose prompt explicitly forbids that claim — is left alone here
and worth its own fix.
