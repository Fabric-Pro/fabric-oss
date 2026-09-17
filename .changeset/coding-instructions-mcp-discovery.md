---
"fabric-app": patch
---

Coding agents connected over the MCP gateway now learn from project responses when a project has published coding instructions, skip re-downloading when the digest they last installed is still current, and see which paths changed when it is not.

Every project returned by `fabric_get_project` and `fabric_list_projects` carries a `codingInstructions` field — the published snapshot's version, file count, digest and publication time, or `published: false` — and the connection handshake tells the agent to install them with `fabric_get_project_instruction_bundle`. The field is omitted for a key that does not hold the instructions scope. `fabric_list_project_instructions` and `fabric_get_project_instruction_bundle` both accept a `sinceDigest`: a digest that still matches is answered without listing files or minting a zip URL, and a known older one adds the added, removed and changed paths to the response it would have given anyway.
