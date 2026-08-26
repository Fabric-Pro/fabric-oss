/**
 * Typed telemetry-event registry for the "open existing ticket from a
 * proposal panel" affordance.
 *
 * Parallels `backlog.story.openInNewTab` (see
 * `specs/2026-05-25-backlog-context-menu-open-in-new-tab` and the sibling
 * registry `backlog-context-menu.ts`). The analytics provider at
 * `apps/web/modules/analytics/provider/custom/index.tsx` is a
 * `console.info` shim that accepts `Record<string, unknown>` for the event
 * payload; this file locks the event name and the typed property shape so
 * casing / naming are stable when a real provider lands later.
 *
 * Pure module — no React imports, no side effects.
 */

/** The single event name emitted by this feature. */
export const BACKLOG_OPEN_EXISTING_EVENT =
	"backlog.proposal.openExistingTicket" as const;

/** Which panel the open originated from. */
export type BacklogProposalPanel = "ai-update" | "feature-proposals";

/** Payload shape for `backlog.proposal.openExistingTicket`. */
export type BacklogOpenExistingPayload = {
	panel: BacklogProposalPanel;
};
