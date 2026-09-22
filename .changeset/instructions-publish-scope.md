---
"fabric-app": patch
"@fabricorg/cli": patch
"@fabricorg/sdk": patch
---

A developer can now publish a coding-instructions change straight from the command line with `fabric instructions push --publish`, using an API key granted a new organization scope, `instructions:publish`, that is separate from the one the Connect dialog issues.

Publishing is a different authority from proposing, not an option on it. `fabric instructions push` and the MCP tool `fabric_propose_project_instruction_change` still open a proposal and nothing else, and the key the Connect dialog mints still carries only `instructions:write`, so its promise that nothing is published until somebody approves holds for every key it has ever issued. `--publish` calls a separate endpoint behind `instructions:publish`, which is granted by hand in the organization's API-key settings, cannot be given to a read-only role, and is never minted by the Connect dialog; its description there says plainly that it creates a new version that publishes without review once its checks pass. A key holding only one of the two scopes can do only that one thing.

The scope is a ceiling and never a grant: every publish independently re-checks that the key's creator still holds the permission the Coding Instructions tab requires to publish that project's instructions, so a key outlives neither its owner's role nor their project access. The change set itself runs the same checks a folder upload from the browser runs — the same verification and secret scan, the same refusal to publish onto a version you did not write against — and the new version replaces the published one only once those checks pass, which the command says rather than claiming the publish has already landed. No agent-facing surface gained a publish mode.
