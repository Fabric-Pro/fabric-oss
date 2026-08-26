/**
 * Bug 1429 — epic-suppression source gate (shared by the Teams + Slack approve
 * procedures).
 *
 * `PendingBacklogProposalSource` (schema.prisma) is one of:
 *   TEAMS_CHANNEL | TEAMS_CHAT | SLACK_CHANNEL | AI_UPDATE_SIDEBAR | MONITORED_MEETING
 *
 * The monitored-channel + monitored-meeting sources are feature/bug-only, so
 * the approve procedures normalize `epic → feature` and dispatch the apply
 * workflow with `forbidEpics: true`. `AI_UPDATE_SIDEBAR` (the general AI Update
 * flow) keeps `epic` first-class and must NOT be suppressed — even though it can
 * be routed to the Teams approve procedure via `endpointForSource()`'s default
 * fallthrough in the inbox UI. `MONITORED_MEETING` is auto-analyzed with
 * `allowEpics: false` / `allowUpdates: false` (capture-as-is, same posture as
 * Slack/Teams), so it gets the same epic→feature normalization. Gating on
 * `proposal.source` here is the backend counterpart of the inbox's
 * `isChannelMonitorSource` gate (`PendingBacklogProposalsInbox`).
 */
export function isChannelMonitorSource(
	source: string | null | undefined,
): boolean {
	return (
		source === "TEAMS_CHANNEL" ||
		source === "TEAMS_CHAT" ||
		source === "SLACK_CHANNEL" ||
		source === "MONITORED_MEETING"
	);
}
