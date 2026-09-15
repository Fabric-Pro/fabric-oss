---
"fabric-app": patch
---

The Connections page now opens the MCP servers walkthrough on its MCP tab, and Show me for MCP servers points there instead of the sidebar.

Fizzy #2504 follow-up, found while verifying the rename on staging.

The `mcp-servers` page tour had no reachable launcher. Its Compass lived on
`MCPServersHero`, which `McpServersView` rendered only when NOT embedded — and
the Connections page is the component's only caller and embeds it, so that hero
had been rendering `null` for every visitor. The old `/mcp-servers` route
redirects into the page, so nothing else could open the tour, while
`ConnectionsTabs` passed a constant `getStartedPageId="integrations"` and handed
anyone on the MCP tab the integrations walkthrough. The tour's three anchors
(`mcp-servers-add-registry`, `mcp-servers-add-custom`, `mcp-servers-search`)
mount on that tab and were never spotlit.

The drift test did not catch it: `wiredLauncherIds()` greps launcher sources for
a literal `getStartedPageId="<id>"`, which proves the prop is written, not that
it renders. That is also why the header is now two elements rather than one with
a computed id — a ternary inside the prop would read correctly here and silently
un-wire both pages from that scan.

Three smaller repairs ride along on the same surface:

- The drawer's "MCP servers" item anchored at `nav-integrations`, so Show me
  spotlighted a sidebar row labelled Connections — the same row the item above
  it already points at. It now anchors on the MCP tab's own registry card.
- `/mcp-servers` redirected to `/settings/integrations?tab=mcp`, itself a
  redirect to this page, so every old bookmark paid two round trips. It now
  lands directly.
- `MCPServersHero` is deleted, along with the `embedded` prop that existed only
  to suppress it.

The constant predates the rename, so none of this is a regression from it;
merging the two surfaces behind one tabbed route is what made a single id
insufficient.

Pinned by three cases in `ConnectionsTabs.test.tsx`, which also make the
`PageTourButton` stub echo its `pageId` and re-mock `next/navigation` locally so
the tab can be driven from the query string. Verified against staging build
d12643e4f, where the Compass on `?tab=mcp` opened "Step 1 of 3 — The reliable
way to connect a tool".
