---
"fabric-app": patch
---

Organization-scoped MCP API keys are now refused as not found on projects hosted by another organization, across the gateway's project read and write tools, so a key issued for one organization can no longer reach another organization's project through its creator's guest membership.

The rule is the one the coding-instructions tools and `fabric_update_project_context` already applied: project access stays project-authoritative, and an organization key must also match the project's hosting organization. It now covers feature, task, status, document, project-context and project-update tools. `fabric_create_bug` and `fabric_create_feature` already refused such a key, but with a message that named the other organization (or, for a guest creator, said the project could still be read); they now give the same generic not found. Personal API keys and browser sessions are unchanged, so an invited guest still reaches a project in another organization through them. `fabric_update_project` now also applies the same project-visibility boundary as the other gateway project writes.
