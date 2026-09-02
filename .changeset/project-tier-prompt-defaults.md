---
"fabric-app": patch
---

A project can now be given its own default prompts, from the project's settings.

The tier already existed everywhere except the UI. `PromptBinding` has carried a
`projectId` since the project-tier migrations, `getBoundPromptVersion` ranks a
project-narrowed binding above the organization's and below a personal override,
and the catalog has been able to display "PROJECT" as the tier in force. Nothing
could create one, so a project could be shown a tier no surface could set.

Project settings gains a "Prompt defaults for this project" card listing every
action, split into what this project has chosen for itself and what it inherits.
An organization admin points an action at any prompt already available for it, or
clears the override to fall back to the organization's choice.

A project default is an organization binding narrowed to one project — the same
row and the same authorization, so this adds a surface and not a permission.
`bind.set` already requires organization admin or owner, and
`resolveProjectForOrg` already proves the project belongs to the caller's
organization before writing. The control is therefore gated on organization
admin rather than the project's own settings permission: a project admin holds
`PROJECT_SETTINGS_EDIT` but not organization admin, and would have been offered a
control the server refuses.
