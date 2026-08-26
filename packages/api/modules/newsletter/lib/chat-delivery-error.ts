import {
	describeChatProviderFailure,
	tableLookup,
} from "../../../lib/chat-provider-error";

/**
 * Maps a NewsletterChatDelivery row's raw failure text to actionable,
 * admin-facing copy for the "Send & history" panel (Fizzy #2013).
 *
 * The PROVIDER half of this mapper — the Slack code table, the Graph status
 * shapes, the platform gating and the generic fallback — moved to
 * `packages/api/lib/chat-provider-error.ts` when the publishing-suite broadcast
 * ledger became a second consumer (Fizzy #1850, 1C-4b). What stays here is what
 * is specific to THIS ledger: its skip-reason allowlist, its status branches,
 * and the one Fabric-internal failure string below.
 *
 * Two rules still drive the design:
 *
 *  1. The DB keeps the RAW provider string (a Slack error code, a Graph error
 *     body) because that is what an engineer needs. This is the read-time
 *     translation, so copy can improve without a data migration.
 *  2. An unrecognised raw string is NEVER passed through — in ANY branch,
 *     including SKIPPED. `sends.list` and the chat-deliveries procedure are
 *     reachable by read-only viewers, and Graph error bodies carry tenant
 *     identifiers. Unknown failures degrade to a generic message that points at
 *     the logs.
 *
 * Pure and total: unknown inputs return a generic message, never throw.
 */

/**
 * Reasons written by `recordSkip` in the delivery activity. Allowlisted rather
 * than passed through — `errorMessage` is an unconstrained Text column, and
 * nothing enforces that only these two strings ever reach it.
 */
const SKIP_REASONS: Record<string, string> = {
	"channel no longer linked to project":
		"This channel is no longer linked to the project. Re-link it in project settings to resume delivery.",
	"channel linker no longer authorized for project":
		"The account that linked this channel no longer has access to the project. Re-link the channel to resume delivery.",
};

export function describeChatDeliveryFailure(
	status: string,
	errorMessage: string | null | undefined,
	platform: string,
): string | null {
	if (status === "SENT") {
		return null;
	}

	const raw = (errorMessage ?? "").trim();

	// A row stays at SENDING only when the worker died between a successful post
	// and the confirming write. The activity counts it as sent (dup-over-miss),
	// so the honest description is "unconfirmed" — calling it skipped would tell
	// the operator the opposite of what most likely happened.
	//
	// This is a claim about THIS writer. The publishing-suite broadcast claims
	// its row BEFORE contacting the provider, so a SENDING row there does not
	// imply a delivered message; see `describePublishingChatDelivery`.
	if (status === "SENDING") {
		return "Delivery was started but never confirmed. The message was most likely posted — check the channel before resending.";
	}

	// Fail closed: an unrecognised stored reason degrades to a generic sentence
	// rather than being echoed to the read-only-viewer audience.
	if (status === "SKIPPED") {
		return (
			tableLookup(SKIP_REASONS, raw) ??
			"This channel was skipped for this send."
		);
	}

	// Written by the delivery activity for either platform, and checked BEFORE
	// delegating: this is a Fabric-internal failure string, not a provider one,
	// so it does not belong in a module about providers.
	if (raw.endsWith("has no linking user")) {
		return "The account that linked this channel is no longer available. Re-link the channel in project settings.";
	}

	return describeChatProviderFailure(raw, platform);
}
