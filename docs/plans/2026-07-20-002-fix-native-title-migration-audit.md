---
title: "Native title= Migration - Audit"
type: fix
date: 2026-07-20
topic: native-title-migration
artifact_contract: ce-unified-plan/v1
artifact_readiness: stage-0-audit
product_contract_source: ce-brainstorm
execution: code
---

# Native title= Migration - Audit

- **Audience**: frontend engineers picking up the remaining `title=` migration batches
- **Owner**: web app team

Stage 2 of the tooltip work planned in
[`2026-07-20-001-fix-global-tooltip-styling-plan.md`](./2026-07-20-001-fix-global-tooltip-styling-plan.md).
Classification of every native `title=` attribute on a JSX **host** element in
`apps/web`. Component props (`<SettingsItem title=`, `<Badge title=`,
`<SettingsMenu title=`), SVG `<title>` children, and Next.js page metadata are
out of scope and are not listed.

Rules applied are from [`fabric/standards/frontend/tooltips.md`](../../fabric/standards/frontend/tooltips.md) §DON'T.

> The original bug report and the first-pass grep both said "182". The true
> count of JSX host-element `title=` attributes is **201** (200 JSX + 1 inside
> an HTML template string in `embed-snippet.ts`).

## Summary — counts per verdict

| Verdict | Count | Notes |
|---|---:|---|
| `MIGRATE` | 130 | Wrap in `<Tooltip>` / `<DestructiveTooltip>`, copy to `tooltips.*` |
| `EXCEPTION-truncation` | 27 | Keep, but 9 are interactive → prefer a real tooltip |
| `EXCEPTION-time` | 21 | 13 on real `<time>`; 8 on `<span>`/`<small>` that should become `<time>` |
| `EXCEPTION-iframe` | 19 | 18 JSX + 1 inside an HTML template string in `embed-snippet.ts` |
| `DROP` | 4 | Title repeats visible text verbatim — delete |
| **Total** | **201** | |

Plus **3 imperative DOM assignments** in `ImageSelectionToolbar.tsx` that are not
JSX at all (see §Flags).

Element breakdown: `span` 73, `button` 67, `iframe` 18, `time` 13, `p` 12,
`div` 8, `a` 3, `li` 2, `small`/`input`/`img`/`h3` 1 each.

## Summary — counts per module

| Module | MIGRATE | trunc | time | iframe | DROP | Total |
|---|---:|---:|---:|---:|---:|---:|
| `app/(saas)/app/agents/` | 1 | 0 | 0 | 0 | 0 | 1 |
| `components/ai-elements/` | 24 | 3 | 0 | 2 | 0 | 29 |
| `modules/marketing/` | 6 | 0 | 1 | 1 | 0 | 8 |
| `modules/saas/admin/` | 0 | 0 | 2 | 0 | 2 | 4 |
| `modules/saas/agent-templates/` | 2 | 0 | 0 | 0 | 0 | 2 |
| `modules/saas/agents/` | 11 | 1 | 0 | 3 | 0 | 15 |
| `modules/saas/ai/` | 2 | 1 | 0 | 4 | 0 | 7 |
| `modules/saas/data-connections/` | 0 | 0 | 1 | 0 | 0 | 1 |
| `modules/saas/frames/` | 0 | 0 | 0 | 4 | 0 | 4 |
| `modules/saas/get-started/` | 1 | 0 | 0 | 0 | 0 | 1 |
| `modules/saas/mcp/` | 1 | 0 | 0 | 0 | 0 | 1 |
| `modules/saas/meeting-digest/` | 0 | 1 | 0 | 0 | 0 | 1 |
| `modules/saas/organizations/` | 1 | 0 | 0 | 0 | 0 | 1 |
| `modules/saas/payments/` | 3 | 0 | 0 | 0 | 0 | 3 |
| `modules/saas/projects/` (non-story) | 27 | 10 | 8 | 4 | 1 | 50 |
| `modules/saas/projects/**/stories/` | 20 | 8 | 0 | 0 | 0 | 28 |
| `modules/saas/projects/**/test-cases/` | 6 | 0 | 2 | 0 | 0 | 8 |
| `modules/saas/projects/lib/` (tiptap) | 12 | 0 | 0 | 0 | 0 | 12 |
| `modules/saas/prompts/` | 1 | 0 | 0 | 0 | 0 | 1 |
| `modules/saas/reports/` | 1 | 0 | 0 | 1 | 0 | 2 |
| `modules/saas/settings/` | 0 | 1 | 2 | 0 | 0 | 3 |
| `modules/saas/shared/` | 8 | 2 | 2 | 0 | 0 | 12 |
| `modules/saas/skills/` | 1 | 0 | 0 | 0 | 0 | 1 |
| `modules/saas/weave/` | 2 | 1 | 0 | 0 | 0 | 3 |
| `modules/saas/workflows/` | 1 | 0 | 0 | 0 | 1 | 2 |

## i18n buckets

`en.json` already has: `common, pipeline, documentEditor, contextSources,
projectSetup, projectSettings, projectHeader, prompts, stories, testCases,
copilot, diagrams, maturation, security` (14 buckets, 262 keys). Reuse these first.

`de.json` has **no** `tooltips` namespace — English is the source locale for this
feature per the standard, so migration touches `en.json` only.

Nine new buckets are proposed:

1. `tooltips.agents` — agent cards, launcher, orchestrator config, activity heatmap (~20 rows)
2. `tooltips.modelSelector` — capability chips (11 rows → 7 distinct keys)
3. `tooltips.editor` — tiptap node views, `EditorToolbar`, `ImageSelectionToolbar` (~20 rows)
4. `tooltips.atlas` — Atlas overview/chat/tech-stack (partly already i18n'd)
5. `tooltips.frames` — MCP app frame + frame viz controls
6. `tooltips.admin` — provider health / incident monitoring
7. `tooltips.weave` — Weave plan execution gating copy
8. `tooltips.marketing` — `Mermaid.tsx` diagram controls (blog surface)
9. `tooltips.decisions` — decisions list/table/sheet/atoms

### `tooltips.common.*` reuse — 14 rows collapse to 6 keys

- `common.copy` — `CopilotPage:3698`, `PromptCard:502`, `code-block:602`, `CopilotAssistantMessage:614`
- `common.reload` — `McpAppFrame:1222`, `tiptap-mermaid:818`
- `common.clickToRename` — `DiagramsList:104`, `StoryCard:1218`, `DocumentTitleInlineEdit:279`, `ProjectTitleInlineEdit:135`, `WorkflowBuilder:934` (5 sites, one key with a `{subject}` param)
- `common.openVersionHistory` — `DiffOutcomeChip:114` + `:139`
- `common.openTicketNewTab` — `BacklogAuditDialog:216`, `BacklogSessionHistoryDialog:223`
- `common.ticketDeleted` — `BacklogAuditDialog:233`, `BacklogSessionHistoryDialog:213`
- `common.delete` (existing destructive entry) — `DiagramsList:345`, `tiptap-mermaid:842` + `:980`, `tiptap-excalidraw:174`, `DiffViewer:602`

---

## `app/(saas)/app/agents/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `app/(saas)/app/agents/[agentId]/page.tsx:403` | `div` | `` `${formatShortDate(day.date)}: ${day.count} run${day.count !== 1 ? "s" : ""}` `` | MIGRATE | `tooltips.agents.runsOnDay` *(new bucket; interpolate `date`, `count`; needs ICU plural)* |

## `components/ai-elements/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `ExcalidrawPreview.tsx:690` | `button` | `{label}` (prop) | MIGRATE | key supplied per call site; drop `title`, keep `aria-label` |
| `McpAppFrame.tsx:1222` | `button` | `"Reload"` | MIGRATE | `tooltips.common.reload` *(reuse)* |
| `McpAppFrame.tsx:1231` | `button` | `"Open in Excalidraw editor"` | MIGRATE | `tooltips.frames.openInExcalidraw` *(new)* |
| `McpAppFrame.tsx:1240` | `button` | `isExpanded ? "Minimize (Esc)" : "Expand"` | MIGRATE | `tooltips.frames.collapsePanel` / `tooltips.frames.expandPanel` |
| `McpAppFrame.tsx:1257` | `iframe` | `"MCP App"` | EXCEPTION-iframe | — |
| `available-model-selector.tsx:136` | `span` | `"Fast"` | MIGRATE | `tooltips.modelSelector.capabilityFast` *(new)* |
| `available-model-selector.tsx:145` | `span` | `"Premium"` | MIGRATE | `tooltips.modelSelector.capabilityPremium` |
| `available-model-selector.tsx:154` | `span` | `"Reasoning"` | MIGRATE | `tooltips.modelSelector.capabilityReasoning` |
| `available-model-selector.tsx:163` | `span` | `"Tool Calling"` | MIGRATE | `tooltips.modelSelector.capabilityToolCalling` |
| `available-model-selector.tsx:172` | `span` | `"Vision"` | MIGRATE | `tooltips.modelSelector.capabilityVision` |
| `available-model-selector.tsx:181` | `span` | `"PDF"` | MIGRATE | `tooltips.modelSelector.capabilityPdf` |
| `code-block.tsx:335` | `iframe` | `"HTML Preview"` | EXCEPTION-iframe | — |
| `code-block.tsx:602` | `button` | `isCopied ? "Copied!" : "Click to copy"` | MIGRATE | `tooltips.common.copy` / `tooltips.common.copied` *(reuse)* |
| `inline-citation.tsx:44` | `span` | `{citation.title}` | MIGRATE | `tooltips.citations.sourceTitle` *(new; visible text is `[1]`)* |
| `model-selector.tsx:191` | `span` | `"New"` | MIGRATE | `tooltips.modelSelector.capabilityNew` |
| `model-selector.tsx:200` | `span` | `"Fast"` | MIGRATE | *(dupe)* |
| `model-selector.tsx:209` | `span` | `"Premium"` | MIGRATE | *(dupe)* |
| `model-selector.tsx:218` | `span` | `"Reasoning"` | MIGRATE | *(dupe)* |
| `model-selector.tsx:227` | `span` | `"Tool Calling"` | MIGRATE | *(dupe)* |
| `model-selector.tsx:236` | `span` | `"Vision"` | MIGRATE | *(dupe)* |
| `model-selector.tsx:245` | `span` | `"PDF"` | MIGRATE | *(dupe)* |
| `model-selector.tsx:570` | `span` | `"Fast"` | MIGRATE | *(dupe)* |
| `model-selector.tsx:579` | `span` | `"Premium"` | MIGRATE | *(dupe)* |
| `model-selector.tsx:589` | `span` | `"Reasoning"` | MIGRATE | *(dupe)* |
| `model-selector.tsx:599` | `span` | `"Vision"` | MIGRATE | *(dupe)* |
| `plan.tsx:91` | `p` | `{description}` | EXCEPTION-truncation | `truncate` on same element |
| `plan.tsx:205` | `span` | `{step.title}` | EXCEPTION-truncation | JS-side `truncatedTitle` rendered |
| `search-results/SourcesList.tsx:93` | `a` | `{source.title}` | MIGRATE | `tooltips.citations.sourceTitle` *(visible text is hostname, not the title)* |
| `sources.tsx:173` | `span` | `` sourceTitle \|\| `Source ${index \|\| sourceId}` `` | MIGRATE | `tooltips.citations.sourceFallback` *(interpolate `index`)* |

## `modules/marketing/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `blog/components/Mermaid.tsx:567` | `button` | `"Copy Mermaid source"` | MIGRATE | `tooltips.marketing.copyMermaidSource` *(new)* |
| `blog/components/Mermaid.tsx:586` | `button` | `isFocusOpen ? "Close full-screen diagram" : "Open full-screen diagram"` | MIGRATE | `tooltips.marketing.closeFullScreenDiagram` / `openFullScreenDiagram` |
| `blog/components/Mermaid.tsx:617` | `button` | `"Zoom out"` | MIGRATE | `tooltips.marketing.zoomOut` |
| `blog/components/Mermaid.tsx:628` | `button` | `"Reset to fit"` | MIGRATE | `tooltips.marketing.resetZoom` |
| `blog/components/Mermaid.tsx:637` | `button` | `"Zoom in (Ctrl+scroll)"` | MIGRATE | `tooltips.marketing.zoomIn` |
| `blog/components/Mermaid.tsx:645` | `button` | `"Close diagram"` | MIGRATE | `tooltips.marketing.closeDiagram` |
| `changelog/components/ChangelogSection.tsx:12` | `small` | `formatDate(parseISO(item.date), "yyyy-MM-dd")` | EXCEPTION-time | **not a `<time>`** — convert element to `<time dateTime>` to qualify |
| `shared/lib/embed-snippet.ts:72` | `iframe` | `"Release notes"` | EXCEPTION-iframe | inside an HTML **template string**, not JSX |

## `modules/saas/admin/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `component/monitoring/ActiveIncidentsTable.tsx:540` | `time` | `{row.startedAt.toLocaleString()}` | EXCEPTION-time | — |
| `component/monitoring/IncidentTimelineList.tsx:747` | `time` | `{new Date(event.createdAt).toLocaleString()}` | EXCEPTION-time | — |
| `component/monitoring/ProviderHealthGrid.tsx:265` | `p` | `{row.displayName}` | DROP | identical to visible text; `break-words`, no ellipsis |
| `component/monitoring/ProviderHealthGrid.tsx:271` | `p` | `{row.providerKey}` | DROP | identical to visible text; `break-all`, no ellipsis |

## `modules/saas/agent-templates/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/CreateAgentPage.tsx:2184` | `div` | `` `${template.category} category` `` | MIGRATE | `tooltips.agents.templateCategory` *(interpolate `category`)* |
| `components/TriggersSheet.tsx:1199` | `input` | `{suggestion?.hint}` | MIGRATE | `tooltips.agents.triggerFieldHint` *(dynamic; consider a form description instead)* |

## `modules/saas/agents/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/AgentCard.tsx:145` | `span` | `status === "ERROR" && lastHealthError ? lastHealthError : undefined` | MIGRATE | `tooltips.agents.healthError` *(dynamic; conditional-undefined)* |
| `components/AgentTryCode.tsx:174` | `iframe` | `` `HTML output ${index + 1}` `` | EXCEPTION-iframe | — |
| `components/AgentTryCode.tsx:199` | `iframe` | `` `SVG output ${index + 1}` `` | EXCEPTION-iframe | — |
| `components/FabricAgentLauncher.tsx:724` | `button` | `"Reset conversation"` | MIGRATE | `tooltips.agents.resetConversation` — **destructive** |
| `components/FabricAgentLauncher.tsx:747` | `li` | `{mode.description}` | MIGRATE | `tooltips.agents.modeDescription` *(dynamic)* |
| `components/FabricChat/FabricDirectChat.tsx:3892` | `button` | `"Reopen frame panel"` | MIGRATE | `tooltips.frames.reopenPanel` |
| `components/FabricChat/FabricTemporalOrchestratorChat.tsx:3659` | `button` | `"Reopen frame panel"` | MIGRATE | *(dupe)* |
| `components/FabricChat/orchestrator/TaskPlanView.tsx:190` | `span` | `{step.description}` | EXCEPTION-truncation | JS-side `truncatedDescription` rendered |
| `components/FabricChat/shared/ActiveContextIndicator.tsx:366` | `button` | `isPrioritized ? "Remove priority" : "Prioritize"` | MIGRATE | `tooltips.agents.removePriority` / `prioritize` |
| `components/OrchestratorConfigPanel.tsx:893` | `button` | `… : "Prioritize this agent"` | MIGRATE | `tooltips.agents.prioritizeAgent` |
| `components/OrchestratorConfigPanel.tsx:1087` | `button` | `… : "Prioritize this server"` | MIGRATE | `tooltips.agents.prioritizeServer` |
| `components/OrchestratorConfigPanel.tsx:1288` | `button` | `… : "Prioritize this tool"` | MIGRATE | `tooltips.agents.prioritizeTool` |
| `components/OrchestratorConfigPanel.tsx:1497` | `button` | `… : "Prioritize this integration"` | MIGRATE | `tooltips.agents.prioritizeIntegration` |
| `components/StoppedIndicator.tsx:30` | `span` | `"You stopped this response. Try a new prompt below."` | MIGRATE | `tooltips.agents.responseStopped` |
| `components/cuga/CugaChat.tsx:139` | `iframe` | `"CUGA Agent Interface"` | EXCEPTION-iframe | — |

## `modules/saas/ai/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/CopilotPage.tsx:3698` | `button` | `"Copy"` | MIGRATE | `tooltips.common.copy` *(reuse)* |
| `components/CopilotPage.tsx:4120` | `iframe` | `"HTML Preview"` | EXCEPTION-iframe | — |
| `components/SwipeableChatItem.tsx:50` | `span` | `chat.title ?? messages[0].content ?? "Untitled chat"` | EXCEPTION-truncation | `block truncate` |
| `components/chat/components/DocumentItem.tsx:185` | `button` | `` status === "READY" ? "Click to preview" : `Status: ${status}` `` | MIGRATE | `tooltips.contextSources.previewDocument` / `documentStatus` |
| `components/chat/components/DocumentPreviewDialog.tsx:93` | `iframe` | `{document.filename}` | EXCEPTION-iframe | — |
| `components/chat/components/DocumentPreviewDialog.tsx:128` | `iframe` | `{document.filename}` | EXCEPTION-iframe | — |
| `components/chat/components/DocumentPreviewDialog.tsx:138` | `iframe` | `{document.filename}` | EXCEPTION-iframe | — |

## `modules/saas/data-connections/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/IntegrationIncidentDrawer.tsx:198` | `span` | `{started.toISOString()}` | EXCEPTION-time | **not a `<time>`** — convert |

## `modules/saas/frames/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/FramePreviewSheet.tsx:48` | `iframe` | `frame.title \|\| frame.frameId` | EXCEPTION-iframe | — |
| `components/FrameRenderer.tsx:442` | `iframe` | `block.title \|\| block.id` | EXCEPTION-iframe | — |
| `components/FrameToolResultCard.tsx:119` | `iframe` | `frame.title \|\| frame.frameId` | EXCEPTION-iframe | — |
| `components/FrameVizShell.tsx:817` | `iframe` | `{title}` | EXCEPTION-iframe | — |
| `components/FrameVizShell.tsx:905` | `iframe` | `{title}` | EXCEPTION-iframe | — |

## `modules/saas/get-started/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/PageTourButton.tsx:32` | `button` | `"Get started with this page"` | MIGRATE | `tooltips.common.startPageTour` |

## `modules/saas/mcp/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/McpChatDialog.tsx:187` | `span` | `` `${tools.length} tools available` `` | MIGRATE | `tooltips.frames.toolsAvailable` *(ICU plural)* |

## `modules/saas/meeting-digest/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/CalendarCanvas.tsx:65` | `button` | `meeting.subject ?? "Meeting"` | EXCEPTION-truncation | **interactive** — prefer a real tooltip |

## `modules/saas/organizations/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/OrganizationBrandColorForm.tsx:106` | `button` | `{color.name}` | MIGRATE | `tooltips.projectSettings.brandColorSwatch` |

## `modules/saas/payments/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/AiUsageActivityView.tsx:1393` | `span` | `"Input tokens"` | MIGRATE | `tooltips.common.inputTokens` |
| `components/AiUsageActivityView.tsx:1402` | `span` | `"Output tokens"` | MIGRATE | `tooltips.common.outputTokens` |
| `components/EstimatedAiCost.tsx:98` | `span` | `` `Median over the last ${estimate.sampleCount} successful run${…}` `` | MIGRATE | `tooltips.common.costEstimateBasis` *(ICU plural)* |

## `modules/saas/projects/components/` (non-story)

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `DiagramsList.tsx:104` | `button` | `"Click to rename"` | MIGRATE | `tooltips.common.clickToRename` *(reuse)* |
| `DiagramsList.tsx:345` | `button` | `"Delete diagram"` | MIGRATE | `tooltips.diagrams.delete` — **destructive** |
| `DocumentAssetFrame.tsx:133` | `iframe` | `` `Asset: ${asset.filename}` `` | EXCEPTION-iframe | — |
| `DocumentAutoRefreshToggle.tsx:450` | `span` | `{lastRanAt.toLocaleString()}` | EXCEPTION-time | **not a `<time>`** — convert |
| `DocumentAutoRefreshToggle.tsx:499` | `time` | `{proposedAt.toLocaleString()}` | EXCEPTION-time | — |
| `DocumentTitleInlineEdit.tsx:279` | `button` | `"Click to rename document"` | MIGRATE | `tooltips.common.clickToRename` *(reuse, `{subject}`)* |
| `DocumentVersionHistory.tsx:462` | `span` | `formatDate(version.createdAt)` | EXCEPTION-time | **not a `<time>`** — convert |
| `DocumentsList.tsx:766` | `span` | `status === "FAILED" && generationError ? generationError : undefined` | MIGRATE | `tooltips.documentEditor.generationError` |
| `DocumentsList.tsx:790` | `span` | `{doc.generationError}` | EXCEPTION-truncation | `max-w-[200px] truncate` |
| `EditorToolbar.tsx:384` | `button` | `{color}` (hex) | MIGRATE | `tooltips.editor.textColorSwatch` *(name the colour, not the hex)* |
| `EditorToolbar.tsx:433` | `button` | `{color}` (hex) | MIGRATE | `tooltips.editor.highlightColorSwatch` |
| `MeetingTranscriptSyncSettings.tsx:766` | `p` | `meeting.subject ?? "Untitled meeting"` | EXCEPTION-truncation | `truncate` |
| `MeetingTranscriptSyncSettings.tsx:779` | `span` | `{meeting.organizer}` | EXCEPTION-truncation | `max-w-[200px] truncate` |
| `NotionPageSelector.tsx:756` | `span` | `{crumb.title}` | EXCEPTION-truncation | `max-w-[150px] truncate` |
| `NotionPageSelector.tsx:897` | `p` | `{team.name}` | EXCEPTION-truncation | `truncate` |
| `NotionPageSelector.tsx:1108` | `p` | `page.title \|\| "Untitled"` | EXCEPTION-truncation | `truncate` |
| `ProjectTitleInlineEdit.tsx:135` | `button` | `"Click to rename project"` | MIGRATE | `tooltips.common.clickToRename` *(reuse)* |
| `SlackChannelPickerDialog.tsx:418` | `span` | `` `Bot not in this channel — type /invite @${botName \|\| "your_app"} in Slack…` `` | MIGRATE | `tooltips.contextSources.slackBotNotInChannel` |
| `UrlSourcePageView.tsx:1561` | `span` | `"Time elapsed since processing started. Cancel to stop early; already-indexed pages are preserved."` | MIGRATE | `tooltips.contextSources.crawlElapsed` |
| `UrlSourcePageView.tsx:1973` | `span` | `{lastSynced.toISOString()}` | EXCEPTION-time | **not a `<time>`** — convert |
| `atlas/AtlasChatPanel.tsx:944` | `button` | `{conv.title}` | EXCEPTION-truncation | **interactive** — prefer a real tooltip |
| `atlas/AtlasChatPanel.tsx:1074` | `h3` | `activeConversation?.title ?? chatTitle` | EXCEPTION-truncation | `truncate` |
| `atlas/AtlasOverview.tsx:638` | `button` | `{openInGraph}` (already `t(...)`) | MIGRATE | `tooltips.atlas.openInGraph` |
| `atlas/AtlasOverview.tsx:642` | `span` | `{categoryLabel}` (already `t(...)`) | MIGRATE | `tooltips.atlas.capabilityCategory` |
| `atlas/AtlasOverview.tsx:666` | `span` | `filesTitle ?? undefined` (already `t(...)`) | MIGRATE | `tooltips.atlas.fileCount` |
| `atlas/AtlasOverview.tsx:677` | `span` | `{connectionsTitle}` (already `t(...)`) | MIGRATE | `tooltips.atlas.connectionCount` |
| `atlas/AtlasTechStackPanel.tsx:231` | `span` | `{entry.name}` | EXCEPTION-truncation | `min-w-0 truncate`; already documented in a code comment |
| `copilot/ConversationViewer.tsx:58` | `button` | `"Fork from here — new active conversation with everything up to this point"` | MIGRATE | `tooltips.copilot.forkFromHere` |
| `copilot/ConversationViewer.tsx:98` | `time` | `{formatted.tooltip}` | EXCEPTION-time | — |
| `copilot/CopilotHistoryDrawer.tsx:299` | `span` | `` createdAt ? `Started by ${displayName} on ${…}` : … `` | MIGRATE | `tooltips.copilot.sessionStartedBy` |
| `copilot/DiffOutcomeChip.tsx:114` | `button` | `"Open version history"` | MIGRATE | `tooltips.common.openVersionHistory` *(reuse)* |
| `copilot/DiffOutcomeChip.tsx:139` | `button` | `"Open version history"` | MIGRATE | *(dupe)* |
| `decisions/DecisionAtoms.tsx:108` | `img` | `{name}` | DROP | `alt={name}` already carries it |
| `decisions/DecisionAtoms.tsx:120` | `span` | `{name}` | MIGRATE | `tooltips.decisions.memberName` *(visible text is initials)* |
| `decisions/DecisionAtoms.tsx:149` | `span` | `people.map(p => p.name).join(", ")` | MIGRATE | `tooltips.decisions.memberList` |
| `decisions/DecisionComments.tsx:136` | `span` | `` `Posted on version ${comment.decisionVersion}` `` | MIGRATE | `tooltips.decisions.postedOnVersion` |
| `decisions/DecisionDetailSheet.tsx:204` | `span` | `` vouchedByName ? `Endorsed by ${vouchedByName}` : "Human-endorsed" `` | MIGRATE | `tooltips.decisions.endorsedBy` / `endorsed` |
| `decisions/DecisionsList.tsx:1564` | `span` | `"Human-endorsed — settled in AI context"` | MIGRATE | `tooltips.decisions.humanEndorsed` |
| `decisions/DecisionsList.tsx:1624` | `button` | `` `${rel.kind} ${rel.ref.identifier} — ${rel.ref.title}` `` | MIGRATE | `tooltips.decisions.relatedItem` |
| `decisions/DecisionsTable.tsx:209` | `button` | `` `${rel.kind} ${rel.ref.identifier} — ${rel.ref.title}` `` | MIGRATE | *(dupe)* |
| `kanban/KanbanIframe.tsx:67` | `iframe` | `"Fabric Kanban"` | EXCEPTION-iframe | — |
| `kanban/ProjectKanbanRouteView.tsx:418` | `iframe` | `"Fabric Kanban"` | EXCEPTION-iframe | — |
| `security/BranchScanStatusPanel.tsx:380` | `time` | `{scannedAt.toLocaleString()}` | EXCEPTION-time | — |
| `security/ScanFindingsList.tsx:1078` | `button` | `{ruleSource}` | EXCEPTION-truncation | **interactive** — prefer a real tooltip |
| `security/ScanFindingsList.tsx:2140` | `time` | `absolute ?? undefined` | EXCEPTION-time | — |
| `security/ScanHistoryDialog.tsx:220` | `time` | `{when.toLocaleString()}` | EXCEPTION-time | — |
| `security/SecurityAccessibilityPage.tsx:596` | `span` | `` startedAt ? `Started ${startedAt.toLocaleString()}` : "Elapsed time" `` | MIGRATE | `tooltips.security.scanStartedAt` |
| `security/SecurityAccessibilityPage.tsx:634` | `time` | `{failedAt.toLocaleString()}` | EXCEPTION-time | — |
| `security/SecurityAccessibilityPage.tsx:694` | `time` | `{when.toLocaleString()}` | EXCEPTION-time | — |

## `modules/saas/projects/components/stories/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `BacklogAuditDialog.tsx:216` | `button` | `"Open ticket in a new tab"` | MIGRATE | `tooltips.common.openTicketNewTab` *(reuse)* |
| `BacklogAuditDialog.tsx:233` | `span` | `"This ticket was deleted, so it can no longer be opened"` | MIGRATE | `tooltips.common.ticketDeleted` *(reuse)* |
| `BacklogAuditDialog.tsx:239` | `p` | `{description}` | EXCEPTION-truncation | `truncate` |
| `BacklogAuditDialog.tsx:473` | `div` | `` isBulk ? `${batch.length} changes from one request` : undefined `` | MIGRATE | `tooltips.stories.bulkChangeCount` *(`aria-hidden` div — see flags)* |
| `BacklogChangeDetailDialog.tsx:742` | `span` | `"Type changed from AI suggestion"` | MIGRATE | `tooltips.stories.typeOverridden` |
| `BacklogChangeDetailDialog.tsx:769` | `span` | `"Updates preserve the existing kind. …"` | MIGRATE | `tooltips.stories.kindLockedOnUpdate` |
| `BacklogChangeProposal.tsx:2180` | `span` | `"Type changed from AI suggestion"` | MIGRATE | *(dupe)* |
| `BacklogChangeProposal.tsx:2209` | `span` | `"Updates preserve the existing kind. …"` | MIGRATE | *(dupe)* |
| `BacklogHistoryShared.tsx:75` | `span` | `` `Change source: ${source}` `` | MIGRATE | `tooltips.stories.changeSource` |
| `BacklogSessionHistoryDialog.tsx:213` | `span` | `"This ticket was deleted, …"` | MIGRATE | *(dupe)* |
| `BacklogSessionHistoryDialog.tsx:223` | `button` | `"Open ticket in a new tab"` | MIGRATE | *(dupe)* |
| `BacklogSessionHistoryDialog.tsx:234` | `span` | `{item.title}` | EXCEPTION-truncation | `truncate` |
| `BacklogSessionHistoryDialog.tsx:385` | `span` | `{detail.data.summary}` | EXCEPTION-truncation | `min-w-0 truncate` |
| `BacklogSessionHistoryDialog.tsx:514` | `p` | `{session.summary}` | EXCEPTION-truncation | `truncate` |
| `ConflictResolveDialog.tsx:432` | `p` | `meta \|\| undefined` | EXCEPTION-truncation | `truncate`; documented in a code comment |
| `ConflictResolveDialog.tsx:438` | `p` | `sourceLabel \|\| undefined` | EXCEPTION-truncation | `truncate` |
| `DuplicateResolveDialog.tsx:548` | `button` | `{aiTitle}` (already `t(...)`) | MIGRATE | `tooltips.stories.aiRegenerateMode` |
| `FeatureVersionHistory.tsx:444` | `span` | `formatDate(version.createdAt)` | EXCEPTION-time | **not a `<time>`** — convert |
| `RoadmapFiltersPanel.tsx:176` | `button` | `activeCount > 0 ? summary : undefined` | EXCEPTION-truncation | **interactive** — prefer a real tooltip |
| `StoriesRoadmap.tsx:2956` | `button` | `` `Expand ${section.label}` `` | MIGRATE | `tooltips.stories.expandLane` |
| `StoriesRoadmap.tsx:3026` | `button` | `` `Collapse ${section.label}` `` | MIGRATE | `tooltips.stories.collapseLane` |
| `StoryCard.tsx:1200` | `span` | `{story.title}` | EXCEPTION-truncation | `truncate` |
| `StoryCard.tsx:1218` | `button` | `"Click to rename"` | MIGRATE | `tooltips.common.clickToRename` *(reuse)* |
| `StoryWorkspace.tsx:4563` | `span` | `"When the spec was last refreshed from connected context"` | MIGRATE | `tooltips.stories.contextStaleness` |
| `TaskAgentButton.tsx:269` | `span` | `isConnected ? "Connected (real-time)" : "Disconnected"` | MIGRATE | `tooltips.stories.agentConnected` / `agentDisconnected` |
| `WorkflowProgress.tsx:759` | `span` | `` `Agent: ${status}` `` | MIGRATE | `tooltips.stories.agentStatus` |
| `maturation/SummaryQuestionsPanel.tsx:403` | `span` | `{t("autoProposeHint")}` | MIGRATE | already i18n — relocate to `tooltips.maturation.autoProposeHint` |
| `pm-sync/PmSyncChip.tsx:357` | `button` | `{meta.tip}` | MIGRATE | `tooltips.stories.pmSyncStatus` *(dynamic per status)* |

## `modules/saas/projects/components/test-cases/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `FeatureCoverageList.tsx:278` | `button` | `t("features.viewCasesAria", { identifier })` | MIGRATE | `tooltips.testCases.viewCases` *(already i18n)* |
| `OwnerAvatar.tsx:57` | `span` | `{accessibleLabel}` | MIGRATE | `tooltips.testCases.ownerAssigned` |
| `OwnerAvatar.tsx:75` | `span` | `{accessibleLabel}` | MIGRATE | *(dupe)* |
| `OwnerAvatar.tsx:92` | `span` | `{accessibleLabel}` | MIGRATE | `tooltips.testCases.ownerUnassigned` |
| `RunsSection.tsx:330` | `time` | `{when.toLocaleString()}` | EXCEPTION-time | — |
| `TestCaseRow.tsx:237` | `span` | `{item.automationRef}` | MIGRATE | `tooltips.testCases.automationRef` |
| `TestPlanDetail.tsx:527` | `button` | `t("planDetail.openCaseAria", { identifier })` | MIGRATE | `tooltips.testCases.openCase` *(already i18n)* |
| `TestPlansList.tsx:182` | `time` | `{updatedAt.toLocaleString()}` | EXCEPTION-time | — |

## `modules/saas/projects/lib/` (tiptap node views)

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `tiptap-excalidraw-embed-extension.tsx:109` | `button` | `"Remove placeholder"` | MIGRATE | `tooltips.editor.removeDiagramPlaceholder` — **destructive** |
| `tiptap-excalidraw-embed-extension.tsx:164` | `button` | `"Edit this diagram in the chat assistant"` | MIGRATE | `tooltips.editor.editDiagramInChat` |
| `tiptap-excalidraw-embed-extension.tsx:174` | `button` | `"Remove embedded diagram"` | MIGRATE | `tooltips.editor.removeEmbeddedDiagram` — **destructive** |
| `tiptap-mermaid-extension.tsx:792` | `button` | `"Save changes"` | MIGRATE | *(skip per §When to apply — plain-English, non-destructive; DROP also defensible)* |
| `tiptap-mermaid-extension.tsx:808` | `button` | `"Build with AI"` | MIGRATE | `tooltips.editor.buildDiagramWithAi` |
| `tiptap-mermaid-extension.tsx:818` | `button` | `"Re-render diagram"` | MIGRATE | `tooltips.editor.rerenderDiagram` |
| `tiptap-mermaid-extension.tsx:832` | `button` | `"Show diagram"` | MIGRATE | `tooltips.editor.showDiagram` |
| `tiptap-mermaid-extension.tsx:842` | `button` | `"Delete diagram"` | MIGRATE | `tooltips.diagrams.delete` *(reuse)* — **destructive** |
| `tiptap-mermaid-extension.tsx:948` | `button` | `"Build with AI"` | MIGRATE | *(dupe)* |
| `tiptap-mermaid-extension.tsx:958` | `button` | `"Edit source"` | MIGRATE | `tooltips.editor.editDiagramSource` |
| `tiptap-mermaid-extension.tsx:971` | `button` | `"Add caption"` | MIGRATE | `tooltips.editor.addCaption` |
| `tiptap-mermaid-extension.tsx:980` | `button` | `"Delete diagram"` | MIGRATE | *(dupe)* — **destructive** |

## `modules/saas/prompts/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/PromptCard.tsx:502` | `button` | `"Copy prompt"` | MIGRATE | `tooltips.prompts.copyPrompt` |

## `modules/saas/reports/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/TemplateInstanceDetail.tsx:3768` | `span` | `humanizeReportError(exec.error, "generate")` | MIGRATE | `tooltips.reports.generationError` *(new bucket)* |
| `components/TemplateInstanceDetail.tsx:3903` | `iframe` | `{viewingArtifact.name}` | EXCEPTION-iframe | — |

## `modules/saas/settings/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/SettingsMenu.tsx:74` | `p` | `{menuItems[0].title}` | EXCEPTION-truncation | `truncate` |
| `components/user-activity/MemberActivityDrawer.tsx:168` | `span` | `{when?.absolute}` | EXCEPTION-time | **not a `<time>`** — convert |
| `components/user-activity/MemberActivityTable.tsx:110` | `span` | `{lastLogin.absolute}` | EXCEPTION-time | **not a `<time>`** — convert |

## `modules/saas/shared/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/DiffViewer/DiffViewer.tsx:602` | `button` | `"Remove comment"` | MIGRATE | `tooltips.common.delete` *(reuse)* — **destructive** |
| `components/NavBar.tsx:871` | `div` | `collapsed ? item.label : undefined` | MIGRATE | `tooltips.common.navItemDisabled` *(see flags)* |
| `components/copilot/CopilotAssistantMessage.tsx:584` | `time` | `{formattedTimestamp.tooltip}` | EXCEPTION-time | — |
| `components/copilot/CopilotAssistantMessage.tsx:605` | `button` | `{labels.regenerateResponse}` | MIGRATE | `tooltips.copilot.regenerateResponse` |
| `components/copilot/CopilotAssistantMessage.tsx:614` | `button` | `{labels.copyToClipboard}` | MIGRATE | `tooltips.common.copy` *(reuse)* |
| `components/copilot/CopilotAssistantMessage.tsx:638` | `button` | `{labels.thumbsUp}` | MIGRATE | `tooltips.copilot.thumbsUp` |
| `components/copilot/CopilotAssistantMessage.tsx:652` | `button` | `{labels.thumbsDown}` | MIGRATE | `tooltips.copilot.thumbsDown` |
| `components/copilot/CopilotUserMessage.tsx:124` | `time` | `{formatted.tooltip}` | EXCEPTION-time | — |
| `components/copilot/MessageAttachmentList.tsx:86` | `a` | `att.name ?? "Attached image"` | MIGRATE | `tooltips.copilot.attachedImage` |
| `components/copilot/MessageAttachmentList.tsx:101` | `span` | `` att.name ? `${att.name} (preview unavailable)` : … `` | MIGRATE | `tooltips.copilot.attachmentPreviewUnavailable` |
| `components/copilot/MessageAttachmentList.tsx:132` | `a` | `{label}` | EXCEPTION-truncation | **interactive** — prefer a real tooltip |
| `components/copilot/MessageAttachmentList.tsx:146` | `span` | `` `${label} (download unavailable)` `` | MIGRATE | `tooltips.copilot.attachmentDownloadUnavailable` |
| `components/copilot/ReasoningCollapsible.tsx:233` | `li` | `{title}` (= tool `name`) | EXCEPTION-truncation | child `truncate font-mono` renders the same `name` |

## `modules/saas/skills/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/SkillEditor.tsx:361` | `div` | `` `${selectedCategory.label} category` `` | MIGRATE | `tooltips.agents.templateCategory` *(reuse)* |

## `modules/saas/weave/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/WeavePlanList.tsx:615` | `p` | `{plan.name}` | EXCEPTION-truncation | `truncate` |
| `components/WeavePlanList.tsx:831` | `div` | nested ternary on `repoUrl` / `disableBackgroundAgents` | MIGRATE | `tooltips.weave.repoUrlRequired` / `backgroundAgentsUnavailable` |
| `components/WeavePlanList.tsx:865` | `div` | `!repoUrl ? "Repository URL required. …" : ""` | MIGRATE | *(dupe)* |

## `modules/saas/workflows/`

| Location | Tag | Title | Verdict | Key |
|---|---|---|---|---|
| `components/WorkflowBuilder.tsx:934` | `button` | `"Click to rename workflow"` | MIGRATE | `tooltips.common.clickToRename` *(reuse)* |
| `components/integrations/IntegrationBrandIcon.tsx:62` | `div` | `{label}` | DROP | `aria-hidden="true"` on the same element — decorative |

---

## Flags

### 1. Non-focusable elements — higher effort (98)

All 98 non-`button`/`a`/`input`/`iframe`/`time` occurrences sit on a plain
`span` (73), `p` (12), `div` (8), `li` (2), `small`, `img`, or `h3`. **None**
carry `tabIndex`, `onClick`, or a focusable `role`. `TooltipTrigger asChild`
will attach pointer handlers but the tooltip will never open on keyboard.

Each needs one of:
- promotion to a real `<button>` (correct where the element is already
  clickable-looking, e.g. `inline-citation.tsx:44`, `sources.tsx:173`), **or**
- an added `tabIndex={0}` wrapper (correct for status chips and capability
  icons), **or**
- staying as static text with the copy moved inline / into an adjacent
  `aria-describedby` node (correct for the `role="img"` avatars).

The seven `role="img"` / `role="status"` / `role="timer"` elements
(`OwnerAvatar.tsx:57/75/92`, `TestCaseRow.tsx:237`, `BacklogHistoryShared.tsx:75`,
`BacklogChangeDetailDialog.tsx:769`, `BacklogChangeProposal.tsx:2209`,
`EstimatedAiCost.tsx:98`, `SecurityAccessibilityPage.tsx:596`) already carry an
`aria-label`, so the a11y contract is intact — only the hover affordance needs
rehoming.

Two special cases:
- `BacklogAuditDialog.tsx:473` — the `div` is `aria-hidden="true"`, so its title
  is invisible to assistive tech today. Migrating means giving the bulk marker a
  real accessible identity, not just a tooltip.
- `NavBar.tsx:871` — `aria-disabled="true"` with `cursor-not-allowed`. Radix
  triggers do not fire on `pointer-events: none` children; check that the
  disabled nav row still receives pointer events.

### 2. Dynamic titles needing i18n interpolation (~40 after excluding iframe exceptions)

**Needs ICU plural**
- `app/(saas)/app/agents/[agentId]/page.tsx:403` — `{date}`, `{count}`
- `payments/EstimatedAiCost.tsx:98` — `{count}`
- `mcp/McpChatDialog.tsx:187` — `{count}` tools
- `stories/BacklogAuditDialog.tsx:473` — `{count}` changes

**Two-branch ternary → two keys**
`McpAppFrame.tsx:1240`, `code-block.tsx:602`, `Mermaid.tsx:586`,
`ActiveContextIndicator.tsx:366`, `OrchestratorConfigPanel.tsx:893/1087/1288/1497`,
`DocumentItem.tsx:185`, `TaskAgentButton.tsx:269`, `DecisionDetailSheet.tsx:204`,
`MessageAttachmentList.tsx:101`, `SecurityAccessibilityPage.tsx:596`,
`WeavePlanList.tsx:831` (three-branch)

**Conditional-`undefined` (tooltip should simply not render)**
`AgentCard.tsx:145`, `DocumentsList.tsx:766`, `RoadmapFiltersPanel.tsx:176`,
`NavBar.tsx:871`, `ConflictResolveDialog.tsx:432/438`, `AtlasOverview.tsx:666`,
`ScanFindingsList.tsx:2140`, `WeavePlanList.tsx:865`

**Single-variable interpolation**
`CreateAgentPage.tsx:2184`, `SkillEditor.tsx:361`, `sources.tsx:173`,
`SlackChannelPickerDialog.tsx:418`, `DecisionComments.tsx:136`,
`BacklogHistoryShared.tsx:75`, `StoriesRoadmap.tsx:2956/3026`,
`WorkflowProgress.tsx:759`, `MessageAttachmentList.tsx:146`,
`CopilotHistoryDrawer.tsx:299`

**Multi-variable**
`DecisionsList.tsx:1624` and `DecisionsTable.tsx:209` — `{kind}`, `{identifier}`,
`{title}` (identical shape; one shared key)

**Already routed through `t(...)`** — lowest effort, only the JSX wrapper changes:
`AtlasOverview.tsx:638/642/666/677`, `FeatureCoverageList.tsx:278`,
`TestPlanDetail.tsx:527`, `SummaryQuestionsPanel.tsx:403`,
`DuplicateResolveDialog.tsx:548`

### 3. Imperative DOM assignments — `ImageSelectionToolbar.tsx`

This file builds a tiptap bubble menu with `document.createElement`, outside
React, so `<Tooltip>` cannot wrap these at all.

| Location | Assignment | Copy |
|---|---|---|
| `ImageSelectionToolbar.tsx:158` | `btn.title = …` | `"Small"` / `"Medium"` / `"Large"` (loop over 3 buttons) |
| `ImageSelectionToolbar.tsx:194` | `captionBtn.title = …` | `"Add caption"` |
| `ImageSelectionToolbar.tsx:230` | `delBtn.title = …` | `"Delete image"` |

All three already set a matching `aria-label` via `setAttribute`, so a11y is
covered. Options, in increasing order of cost:

1. **Leave as-is and document a fourth exception** — imperative toolbars built
   outside React have no `TooltipProvider` in scope. Cheapest; requires a
   standards amendment.
2. **Port the toolbar to a React portal node view** — tiptap supports
   `ReactNodeViewRenderer`, and the mermaid and excalidraw extensions in
   `modules/saas/projects/lib/` already do this, so there is in-repo precedent.
   Consistent, and also unblocks i18n for these labels, which are currently
   hardcoded English unreachable by `useTranslations`.
3. **Hand-roll a positioned tooltip element** in the same imperative style —
   rejected: duplicates the primitive and will drift from `TooltipContent`.

Recommend option 2, as its own task rather than folded into the bulk migration.

### 4. Proposed sequencing

- **Batch A (mechanical, 34 rows → 13 keys):** the `tooltips.common.*` reuse set
  plus the `tooltips.modelSelector.*` capability chips. Highest ratio of
  rows-closed to keys-added.
- **Batch B (already-i18n, 9 rows):** copy is already translated; only the JSX
  wrapper changes. No `en.json` churn beyond relocation.
- **Batch C (new buckets, ~87 rows):** the nine new buckets.
- **Batch D (98 non-focusable):** needs a focusability decision per element.
  Do **not** fold into A–C — this is a11y design work, not mechanical migration.
- **Batch E:** `ImageSelectionToolbar.tsx` node-view port.

The 67 exception rows (`iframe` + `time` + `truncation`) need no code change, but:
- the 8 `EXCEPTION-time` rows sitting on `<span>`/`<small>` should be converted
  to `<time dateTime={…}>` so they actually satisfy the documented carve-out;
- the 9 interactive `EXCEPTION-truncation` rows (`AtlasChatPanel.tsx:944`,
  `ScanFindingsList.tsx:1078`, `CalendarCanvas.tsx:65`,
  `RoadmapFiltersPanel.tsx:176`, `MessageAttachmentList.tsx:132`, plus four
  tiptap/story buttons) are worth converting to real tooltips per the standard's
  stated preference.
