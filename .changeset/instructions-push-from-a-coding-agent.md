---
"fabric-app": patch
"@fabricorg/cli": patch
"@fabricorg/sdk": patch
---

A developer's local coding agent can now suggest an edit to a project's coding instructions without opening the browser, through the new `fabric instructions push` command or the MCP tool `fabric_propose_project_instruction_change`.

Both open a proposal that somebody with permission to edit the project's coding instructions approves or rejects in the Coding Instructions tab; nothing an agent sends is published on its own, and the MCP tool has no publish mode at all. `push` computes the change set from `.fabric/instructions.lock`, so it sends only what the last sync wrote and what has changed since, and a new file is sent only when it is named with `--add`. Every change set has to name the published version it was written against, and one written against a version that has since been replaced is refused rather than rebased, with a message that says to sync and try again. Neither surface can publish: they open proposals and nothing else.

A new organization API-key scope, `instructions:write`, reaches this and nothing else. It sits alongside `instructions:read` in the API keys settings and is offered to read-only roles, because proposing is something a reader can already do in the browser; every call independently re-checks the key creator's live permission on the project. No surface the scope reaches can publish, whoever created the key, so the Connect dialog's promise that nothing is published until somebody approves holds for everybody. The dialog now mints the scope for the coding-instructions flow and says so before the key is created.

Saving a coding-instructions change in the browser is also safer against a simultaneous publish: the check that the version you edited is still the published one is now made as the new version is written rather than a moment before, so two people saving at once can no longer produce a version that silently reverts the other's. Instruction file names that a checkout cannot install — Windows device names such as `CON.md`, names ending in a dot or a space, and two spellings of one name that differ only by Unicode normalisation — are now refused when they are uploaded rather than when someone tries to sync them. Files your ignore rules exclude are not judged on their names, and a file that predates this rule can still be deleted, which is how it gets fixed.
