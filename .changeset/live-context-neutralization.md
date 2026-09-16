---
"fabric-app": patch
---

Messages from linked Slack and Teams channels are now neutralized before they reach an AI prompt, so channel content cannot pose as instructions.

`formatLiveContextForPrompt` wraps recent channel messages in a
`<live_integration_context>` block used by feature enhancement, bug
reevaluation and story generation. The message body and display name were
interpolated verbatim, so text that closed the wrapper — or forged one of the
block's own section headings — was read as prompt rather than as content.
Anyone able to post in a linked channel could do this without holding an
account.

The renderer now runs the shared chat-scaffolding neutralizer plus two passes
for the delimiters this block owns. Tags are mangled rather than deleted, since
deleting an inner tag from a nested construction reassembles a live one, and
display names additionally lose line breaks. Both the Slack and Teams arms are
covered.
