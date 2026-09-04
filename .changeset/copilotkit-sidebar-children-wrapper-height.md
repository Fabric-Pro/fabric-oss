---
"fabric-app": patch
---

Fix feature and document workspaces not scrolling with the mouse (no scrollbar, keyboard scroll only) after the CopilotKit 1.70 upgrade

`@copilotkit/react-ui` 1.70 wraps the page content it receives in a second real DOM div, `.copilotKitModalChildrenWrapper`, inside the existing `.copilotKitSidebarContentWrapper` (absent in 1.52). Both pages that host `<CopilotSidebar>` inside a bounded `flex-1 min-h-0 overflow-hidden` region only forced the outer wrapper to `height: 100%`, so the new inner wrapper stayed auto-height, the workspace's own `h-full` collapsed to content height, and its inner `overflow-y-auto` scroll container became as tall as its content. The outer region then clipped everything: no scrollbar, wheel scrolling dead, keyboard scrolling still working because focus-driven scrolling moves an overflow-hidden box. Reproduced in Chromium with the exact height chain: without the fix the scroll container measures 3000px for 3000px of content and a wheel gesture moves nothing; with it, 440px with a scrollbar and the wheel scrolls.

Fix: extend the direct-child selector on both host pages so `.copilotKitModalChildrenWrapper` is also `height: 100%`. Not using react-ui's new `fullHeightChildren` prop because it sets the wrapper to `100dvh`, which is wrong inside a page that already has header rows above the region.

Also applied to the backlog chat overlay (`BacklogChat.tsx`), whose click-to-dismiss backdrop is an `h-full` child under the same wrappers inside a `fixed inset-0` host. That one was already collapsed on 1.52 (the outer wrapper existed there too and nothing sized it), so it is a pre-existing gap fixed with the same rule rather than a 1.70 regression; with it the backdrop covers the viewport and dismisses the overlay as the code intends.
