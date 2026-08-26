# Agent Platform Robustness Checklist

> Comprehensive audit of Fabric's agent assignment, omnipresent chat, and multi-modal execution
> platform. Compared against Linear Agent (2026-03-24 changelog) and extended for Fabric's
> broader scope (planning, code execution, multi-agent orchestration).

## Security

| # | Issue | Severity | Status | File(s) |
|---|-------|----------|--------|---------|
| S1 | No rate limiting on `/api/agents/fabric-ai/stream` — most expensive endpoint (LLM inference + MCP tools). A malicious authenticated user can drain LLM budget. | **Critical** | ✅ Fixed | `app/api/agents/fabric-ai/stream/route.ts` |
| S2 | `request.json()` without Zod schema validation in stream route — bypasses oRPC so no automatic validation. Crafted payloads can inject unexpected types. | **High** | ✅ Fixed | `app/api/agents/fabric-ai/stream/route.ts` |
| S3 | Code snippet injection surface — `buildCodeContextPrompt()` concatenates user-provided code directly into prompts. Adversarial code can contain prompt injection. | **Medium** | ✅ Fixed | `FabricAgentLauncher.tsx` |
| S4 | `execute-workflow` route trusts client-supplied `organizationId` from request body instead of validating against session. | **High** | ✅ Fixed | `app/api/agents/fabric-ai/execute-workflow/route.ts` |
| S5 | Weave SSE stream uses `session.activeOrganizationId` which can be stale if user has multiple tabs in different org contexts. Should accept and validate `organizationId` as query param. | **Medium** | ✅ Fixed | `app/api/weave/stream/route.ts` |

## UX Improvements

| # | Issue | Impact | Status | File(s) |
|---|-------|--------|--------|---------|
| U1 | `Cmd+J` opens launcher but does not toggle (close) when already open. Linear toggles on repeat press. | **High** | ✅ Fixed | `FabricAgentLauncher.tsx` |
| U2 | `isEditableTarget` blocks `Cmd+J` in ALL input fields including non-agent inputs. Users writing in a text field can't invoke the agent. | **Medium** | ✅ Fixed | `FabricAgentLauncher.tsx` |
| U3 | No conversation persistence across launcher open/close — each open creates a fresh session. Linear preserves the current conversation. | **High** | ✅ Fixed | `FabricAgentLauncher.tsx` |
| U4 | "Start Work" dropdown has 5 execution modes + 2 links — too much information for new users. Needs progressive disclosure. | **Medium** | ✅ Fixed | `StartWorkButton.tsx` |
| U5 | Fabric Kanban vs Vibe Kanban differentiation is unclear — users don't know when to choose one over the other. | **Medium** | ✅ Fixed | `StartWorkButton.tsx`, `implementation-session-labels.ts` |
| U6 | No validation that local working directory exists before starting local development — typos fail silently at execution time. | **Medium** | ✅ Fixed | `StartCodingRunDialog.tsx` |
| U7 | No inline agent status on feature cards in kanban view — teams can't see at a glance which features have active agent work. | **High** | ✅ Fixed | `StoryCard.tsx` |

## Additional Security / Polish (Round 2)

| # | Issue | Severity | Status | File(s) |
|---|-------|----------|--------|---------|
| S6 | No rate limiting on `/api/copilotkit` — CopilotKit route is an expensive AI endpoint without rate limiting. | **High** | ✅ Fixed | `app/api/copilotkit/route.ts` |
| S7 | Dead `organizationId` field sent in `handleConfirmExecution` body — backend now ignores it, but the dead field was still sent. | **Low** | ✅ Fixed | `FabricDirectChat.tsx` |

## Additional UX / Polish (Round 2)

| # | Issue | Impact | Status | File(s) |
|---|-------|--------|--------|---------|
| U8 | No `Escape` key to close the launcher — `Cmd+J` toggles and clicking outside closes it, but `Escape` did nothing. | **Medium** | ✅ Fixed | `FabricAgentLauncher.tsx` |
| U9 | Weave `autoApproveAll` has no undo — once enabled, no way to re-enable human review. | **Medium** | ✅ Fixed | `signal-approval.ts`, `WeaveExecutionMonitor.tsx`, orchestrator workflow |
| U10 | No conversation export — no way to share a conversation with teammates outside Fabric. | **Medium** | ✅ Fixed | `FabricDirectChat.tsx` — Markdown download button |

## Architectural Gaps (vs. Linear Agent)

| # | Gap | Priority | Status | Notes |
|---|-----|----------|--------|-------|
| G1 | No comment-level agent interaction — `@fabric` works in raw markdown editor but not in general comments. | **Medium** | ✅ Covered | `useFabricMention` is wired into StoryWorkspace, TaskModal, StoryEditorSheet, DocumentEditor. No standalone comment system exists to add it to — current surfaces are covered. |
| G2 | No Slack/Teams bi-directional agent bot — integration exists for fetching messages but no `@Fabric` bot for sending commands from those surfaces. | **Medium** | ✅ Fixed | `sendSlackMessage` in `@repo/integrations`, wired into trigger-system `handleOutput` for thread replies. Webhook handler at `/api/webhooks/slack/events` already processes `@Fabric` mentions and starts orchestrator workflows. |
| G3 | No "Save this conversation as a Skill" flow — Skills exist in DB and can be invoked via `/` slash-command, but there's no way to create one from a conversation. | **Medium** | ✅ Fixed | Added "Save as Skill" in `FabricDirectChat` |
| G4 | No triage-triggered automations — Linear auto-runs Skills when issues enter triage. Fabric has no equivalent. | **Low** | ✅ Fixed | `fireColumnAutomations` in `story-automations.ts` — fires Skills tagged with the target column name when a story is moved. Hooks into `moveStoryProcedure`. |
| G5 | No mobile agent access — launcher is desktop-only (Sheet side panel). | **Low** | ✅ Fixed | Launcher uses bottom drawer on mobile (`side="bottom"` + `85dvh`), drag handle indicator, compressed header, hidden quick actions. PWA manifest added (`/manifest.json`). `useIsMobile` hook. |
| G6 | Launcher chat disconnected from document editing — suggestions from launcher can't directly modify the document in StoryWorkspace. | **Medium** | ✅ Fixed | `registerDocumentEditor` callback in launcher context. StoryWorkspace registers its TipTap editor; FabricDirectChat shows "Apply to document" button when an editor is active. |

## Weave Gaps

| # | Gap | Priority | Status | Notes |
|---|-----|----------|--------|-------|
| W1 | No plan diff view — when Pattern revises a plan, users can't compare what changed. | **Medium** | ✅ Fixed | Previous plan checkboxes are captured before revision; inline `new`/`changed` badges + collapsible previous version view |
| W2 | No cost estimation before execution — users have no sense of token/compute cost. | **Low** | ✅ Fixed | `estimatePlanCost` in WeavePlanList — per-agent token estimates, blended cost calculation. Badge shown on approval screen and execution info block. |
| W3 | Plan feedback is text-only — no way to annotate specific steps. | **Low** | ✅ Fixed | Per-step inline note inputs added to review mode; notes are aggregated into feedback when revising |
| W4 | No partial execution / resume — failure at step 5 of 10 requires restart from beginning. | **Medium** | ✅ Fixed | `retryFromStepSignal` resets failed/skipped steps to pending. API procedure `retryFromStepProcedure`. "Retry from here" button on failed steps in WeaveExecutionMonitor. |
| W5 | No status feedback loop from local agents back to UI — once handed to local dev, Fabric can't show progress. | **Medium** | ✅ Fixed | `pollLiveStatusProcedure` live-polls the execution provider (Fabric Kanban/Vibe) for real-time session state. CodingRunTimeline shows live agent status badge when polling is active. |

---

## Implementation Plans for Planned Items

### G1: Comment-level @fabric Mentions

**Approach:** Add a `useFabricMention` integration to the comment editor component (wherever comments are rendered on stories, tasks, PRs). When a user types `@fabric` followed by a question, extract the mention and open the Fabric Agent launcher with the comment context attached.

**Files to modify:**
- Create `CommentFabricMentionPlugin.tsx` TipTap extension
- Integrate into story comment editor
- Wire `useFabricMention` hook (already exists) into comment surfaces

### G2: Slack/Teams Bot

**Approach:** Register a Slack bot that listens for `@Fabric` mentions in channels linked to projects. Route the message to the Fabric AI stream API with the channel's project context. Post the response back to the thread.

**Files to create:**
- `app/api/integrations/slack/bot/route.ts` — Slack event handler
- `app/api/integrations/teams/bot/route.ts` — Teams bot framework handler
- `packages/ai/src/slack-bot-handler.ts` — Shared bot logic

### G4: Triage Automations

**Approach:** When a story enters a configurable triage status (e.g., `PLACEHOLDER`), trigger a Temporal workflow that runs a bound Skill against the story context. Results are posted as a comment or applied to the story.

**Files to create:**
- `packages/temporal/src/workflows/triage-automation.ts`
- `packages/api/modules/automations/` — CRUD for automation rules
- UI in project settings for configuring triage rules

### W1: Plan Diff View

**Approach:** Store plan version history (checkboxes snapshots) in the `WeavePlan` model. When a plan is revised, save the previous version. Display a side-by-side or inline diff in the `WeavePlanList` expanded view.

### W4: Partial Execution / Resume

**Approach:** Leverage Temporal's continue-as-new with a `startFromStep` parameter. When an execution fails, store the last completed step index. The "Resume" button starts a new execution with `startFromStep = lastCompletedStep + 1`.
