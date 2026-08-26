# Remove Old Agent Create Page

## Status: Deprecated (pending removal)

## Context

The old "Create Agent" flow (`/agents/new`) uses the `RegisteredAgent` system and the `CreateAgentPage` component under `modules/saas/agents/components/`. This has been superseded by the agent-templates system (`/agent-templates/create`) which creates `AgentTemplateInstances` with versioning, template support, skills, and prompt binding.

The "New Agent" button on the AI Agents page now points to `/agent-templates/create`. The old pages are kept only for backward compatibility with any bookmarked URLs.

## Files to Remove

| File | Purpose |
|------|---------|
| `apps/web/app/(saas)/app/agents/new/page.tsx` | Personal context page shell |
| `apps/web/app/(saas)/app/(organizations)/[organizationSlug]/agents/new/page.tsx` | Org context page shell |
| `apps/web/modules/saas/agents/components/CreateAgentPage.tsx` | The old create agent component |
| `apps/web/modules/saas/agents/components/ReasoningModeSelector.tsx` | Used only by old CreateAgentPage |

## Prerequisites Before Removal

1. Verify no other pages or components import `CreateAgentPage` from `@saas/agents/components/CreateAgentPage`
2. Verify the `RegisteredAgent` creation API (`orpcClient.agents.create`) is not used elsewhere — if not, the API procedure can also be removed
3. Consider adding a redirect from `/agents/new` to `/agent-templates/create` before fully deleting the pages

## Related

- The `VisualAgentBuilder` under `modules/saas/agents/components/VisualAgentBuilder/` may also be candidates for cleanup if they are only used by the old flow.
