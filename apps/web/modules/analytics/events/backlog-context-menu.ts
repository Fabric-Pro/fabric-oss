/**
 * Typed telemetry-event registry for the backlog right-click "Open in
 * new tab" feature.
 *
 * Today the analytics provider at
 * `apps/web/modules/analytics/provider/custom/index.tsx` is a
 * `console.info` shim that accepts `Record<string, unknown>` for the
 * event payload. This file locks the event name and the typed
 * property shape so casing / naming are stable when a real provider
 * lands later.
 *
 * Casing note: the event name uses dotted casing
 * (`backlog.story.openInNewTab`) per the verbatim copy locked in spec
 * decision Q7 — see
 * `specs/2026-05-25-backlog-context-menu-open-in-new-tab/planning/decisions.md`.
 * This intentionally differs from the snake_case used by the
 * Excalidraw precedent (`diagram_auto_inserted`). Casing is fixed at
 * this moment.
 *
 * Pure module — no React imports, no side effects.
 */

/** The single event name emitted by this feature. */
export const BACKLOG_CONTEXT_MENU_EVENT = "backlog.story.openInNewTab" as const;

/** Source of the action invocation. */
type BacklogContextMenuTrigger = "context-menu" | "middle-click" | "keyboard";

/** Payload shape for `backlog.story.openInNewTab`. */
export type BacklogContextMenuPayload = {
	trigger: BacklogContextMenuTrigger;
};
