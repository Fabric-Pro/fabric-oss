# Prompts Improvements Backlog

> Items 1-3 were implemented in the current sprint.
> This document tracks items 4-9 for future implementation.

---

## Item 4: AB Testing / Prompt Experimentation Mode

**Priority**: P1 (needs design spec before implementation)

**Problem**: A teammate: *"Why can't we create two different versions at the same time using an AB test?"* and *"An experiment mode... try different prompts, compare versions."*

**Proposed approach**: Allow generating a document with multiple prompts simultaneously, creating side-by-side draft versions for comparison.

**Requirements**:
- Multi-prompt generation trigger in document editor
- Side-by-side version comparison UI
- Voting/selection mechanism to pick the winner
- Track which prompt produced which version (uses `promptVersionId` on `DocumentVersion` from Item 3)

**Affected areas**: Document editor, Temporal workflows, version history UI

**Status**: Needs design spec

---

## Item 5: Prompt Versioning Lineage & Diff

**Priority**: P2

**Problem**: A teammate: *"Lineages, versions of prompts."* PromptVersion model exists but there's no diff/changelog between versions.

**Proposed approach**: Add a diff view between prompt versions on the prompt details page.

**Implementation ideas**:
- Use a markdown diff library to show changes between prompt versions
- Add a "Compare versions" dropdown on the prompt details page
- Show side-by-side or inline diff like the existing `VersionDiffViewer` for documents

**Affected files**:
- `apps/web/modules/saas/prompts/components/PromptDetails.tsx`
- New component: `PromptVersionDiff.tsx`

---

## Item 6: Prompt Ownership & Permissions (Promote to System)

**Priority**: P2

**Problem**: A teammate: *"Ownership of prompts... what if I want something to be a system prompt?"*

**Proposed approach**: Permission-based workflow for users to nominate their prompts to be promoted to ORG or SYSTEM scope.

**Existing infrastructure**:
- `PromptChangeRequest` model already exists in schema for PR-like workflow
- Has `status`, `reviewedBy`, `reviewNote` fields
- Supports `SCOPE_CHANGE` request type

**Implementation ideas**:
- "Request Promotion" button on USER/ORG prompts
- Admin review queue for pending promotion requests
- Notification system for request status updates

**Affected files**:
- `packages/api/modules/prompts/procedures/` (new approval procedures)
- `apps/web/modules/saas/prompts/components/` (request UI + admin queue)
- `apps/web/modules/saas/admin/` (admin review page)

---

## Item 7: Better Tagging / Folder Structure

**Priority**: P2

**Problem**: A teammate: *"Like folders in Gmail... prompts can belong to different folders, tagging or folder structuring."*

**Existing infrastructure**:
- `tags[]` field on Prompt model
- `category` field on Prompt model
- Tags are displayed but not filterable

**Proposed approach**: Enhanced tagging/categorization with multi-tag filtering.

**Implementation ideas**:
- Tag-based filtering sidebar on prompts page
- Multi-select tag filter
- Optional folder/collection model for organizing prompts
- Drag-and-drop organization

**Affected files**:
- `apps/web/modules/saas/prompts/components/PromptManagementPage.tsx`
- `packages/api/modules/prompts/procedures/list.ts` (add tag filtering)

---

## Item 8: Prompt Sharing & Crowdsourcing

**Priority**: P2

**Problem**: A teammate: *"Level of crowdsourcing that we should be doing."*

**Existing infrastructure**:
- `isPublic` field on Prompt model
- `PromptVote` model with `userId`, `promptId`
- `voteCount` field on Prompt
- `isFeatured` field on Prompt
- `ShareDropdown` component exists

**Proposed approach**: Prompt marketplace/gallery where users can share effective prompts, vote, and adopt.

**Implementation ideas**:
- Public prompt gallery page
- Trending/popular prompts section
- One-click "Use this prompt" to fork into personal collection
- Community ratings and reviews

**Affected files**:
- New page: prompt gallery/marketplace
- `packages/api/modules/prompts/procedures/browse.ts` (already exists, may need enhancement)
- `apps/web/modules/saas/prompts/components/UpvoteButton.tsx` (already exists)

---

## Item 9: Proposal Maturation Flow

**Priority**: P2

**Problem**: A teammate: *"Like to have a proposal maturation type of flow... analysis phase, questions, discovery."*

**Proposed approach**: Multi-stage document generation workflow:
1. **Analysis phase** - AI analyzes context and identifies gaps
2. **Questions phase** - AI generates clarifying questions for the user
3. **Discovery phase** - User answers questions, AI refines understanding
4. **Proposal phase** - AI generates the actual document with full context

**Note**: This is a separate feature from prompts, more related to the document generation workflow/agent behavior. The prompt system would support this by allowing stage-specific prompts.

**Affected areas**:
- Temporal workflows (multi-step generation)
- Agent prompts (stage-specific system prompts)
- Document editor UI (step-by-step wizard)
- New database models for tracking generation stages
