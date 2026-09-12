# Web application guidance

Apply the root `AGENTS.md` first. Before changing this tree, read
[the UI style guide](../../docs/ui-style-guide.md),
[component standards](../../fabric/standards/frontend/components.md), and
[accessibility standards](../../fabric/standards/frontend/accessibility.md).

- Do not add personal route trees or personal-context UI. Organization routes
  are the only live tenant surface; see [ADR-018](../../docs/adr/018-organization-is-the-only-tenant-context.md).
- Reuse `@ui/components` and design tokens. Match existing interaction and
  loading patterns before creating a new primitive.
- When a shared query, mutation, or hook changes, run every sibling component
  test whose partial oRPC mock may need the new path.
- Navigation, tab, settings-page, and feature-flag changes must update the Get
  Started registry, tour anchors, and translations together; run the drift
  test.
- Changes to one MCP management dialog require inspecting the other entry
  point named in the root guidance.

Run focused component tests, `pnpm format:check`, and validation proportional
to the affected package. Do not claim browser behavior without a browser or
component-level proof.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
