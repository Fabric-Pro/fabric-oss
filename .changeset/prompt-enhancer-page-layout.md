---
"fabric-app": patch
---

The prompt enhancer page no longer hides its title and editor behind the navigation sidebar or the AI assistant panel.

Fizzy #2250, found by a clipping-aware staging check of the enhancer's inline validation. Both enhancer hosts (`PromptEnhancePage` and the agent `.../agents/[agentId]/enhance` page) painted `fixed inset-0` over the whole viewport: at 1440px the expanded app sidebar covered the left of the page (title and breadcrumb cut off mid-word, and the inline "Prompt content cannot be empty" message reduced to its last letter), the docked assistant panel covered the right, and the enhancer's `h-screen` root overflowed the column below the breadcrumb, clipping the bottom. They now follow the documented full-bleed CopilotSidebar host pattern (docs/solutions/ui-bugs/copilotkit-sidebar-editor-overlap.md): `setIsFullscreen(true)` collapses the app sidebar to its 72px rail, the fixed chrome starts at `md:left-[72px]` and reserves the docked panel via `useAiSidebarExpanded(true)` + `AI_SIDEBAR_CONTENT_SHIFT_CLASS`, CopilotKit's injected wrappers get a definite height, the enhancer root is `h-full`, and the breadcrumb and header rows scroll within the column instead of spilling under the panel. Both routes are added to `FULL_BLEED_ROUTE_PATTERNS` so shell notices yield there, and the solution doc's host list now names them.
