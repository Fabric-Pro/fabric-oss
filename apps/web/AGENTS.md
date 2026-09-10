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
