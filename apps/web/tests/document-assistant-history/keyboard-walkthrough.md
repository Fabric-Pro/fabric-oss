# CopilotHistoryDrawer — Keyboard-only walkthrough

Covers FR-12 + AC-13 of the chat-history feature.

This walkthrough is the manual a11y receipt for the document AI Assistant
history drawer. Run it before merging changes to the drawer and re-run it
whenever the drawer's structure changes. The `vitest-axe` scan in
`apps/web/__tests__/copilot/copilot-history-drawer.a11y.test.tsx` covers
the static ARIA contract; this script covers focus order + keyboard
operation that axe can't fully assert.

## Setup

1. Local dev server: `pnpm --filter web dev` (port 3001).
2. Sign in with the local credentials from
   `~/.claude/projects/.../memory/user_local_credentials.md`.
3. Open any project document (`/app/<slug>/projects/<id>/documents/<docId>`).
4. Confirm the org has `documentAssistantHistoryEnabled = true` (default).
5. Seed at least three prior conversations on the document so the list
   has rows to traverse.

## Steps

1. **Reach the CopilotSidebar header from outside the chat.**
   - Click anywhere in the document body, then press `Tab` repeatedly
     and verify the focus ring lands on the sidebar's "New conversation"
     plus icon and then the "Open chat history" icon in that order.
   - Expected `aria-label`: `Open chat history`.

2. **Open the drawer.**
   - With the history icon focused, press `Enter` (or `Space`).
   - Expected: the drawer slides in from the right (or instantly
     appears with `prefers-reduced-motion: reduce`). Focus is moved
     into the drawer (Radix Dialog focus-trap).

3. **Arrow-key navigation through the conversation list.**
   - Press `Tab` once to enter the listbox container.
   - Press `↓` (ArrowDown) — the next conversation row becomes
     `aria-selected="true"` and receives focus.
   - Press `↓` again — selection advances.
   - Press `↑` (ArrowUp) — selection retreats by one row.
   - Press `Home` — first row selected; `End` — last row.
   - All rows must show a visible focus ring.

4. **Open a conversation in the viewer pane.**
   - With a row focused, press `Enter`.
   - Expected: the right (or stacked) pane renders the conversation
     read-only. Focus stays in the listbox (so the user can keep
     arrow-keying without losing context).

5. **Reach the kebab "Conversation actions" menu (author-only).**
   - Tab forward until the kebab button is focused.
     Expected `aria-label`: `Conversation actions`.
   - Press `Enter` / `Space` to open. The menu items "Rename" and
     "Delete" should be reachable with `↓` and dismissible with `Esc`.

6. **Use the Rename dialog with keyboard only.**
   - Pick "Rename". The dialog autofocuses the text input.
   - Type a new title, press `Enter` (form submit).
   - Toast "Conversation renamed" appears. Focus returns to the kebab
     trigger when the dialog closes.

7. **Cancel the delete confirm.**
   - Open the kebab again, choose "Delete".
   - With the `Cancel` button focused (Radix's destructive default),
     press `Enter`. Dialog closes. Focus returns to the kebab.

8. **Close the drawer.**
   - Press `Esc`.
   - Expected: the drawer closes. **Focus returns to the history icon
     in the CopilotSidebar header** (Radix Dialog focus restore).

## Reduced-motion behaviour

Enable `Settings → Accessibility → Reduce motion` (macOS) or the
`prefers-reduced-motion: reduce` Chrome DevTools emulation, and repeat
step 2. The drawer must appear without the slide animation; rows must
not animate on selection.

## Edge cases to spot-check

- **Empty drawer** — load a document with zero prior conversations. The
  list pane should show: *"No conversations yet."* with the sub-line
  *"Chat with the AI Assistant — your team's conversations will appear
  here."* The viewer pane should show "Select a conversation to read it
  here." on desktop, and be hidden on mobile until a row is selected.
- **Cross-author kebab** — open a conversation authored by a different
  user. The kebab MUST NOT render. Verify by tabbing through the viewer
  header.
- **Continuation linkage** — when a conversation has
  `parentConversationId`, the "Continued from earlier conversation"
  button is focusable and activates the parent on Enter.

## Verification ledger

- (verified locally before merge — to be filled in by the verifier
  during the final verification pass)
