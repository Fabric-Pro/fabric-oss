/**
 * Raw chat-provider failure text → actionable, admin-facing copy.
 *
 * Extracted from the newsletter mapper (Fizzy #2013) when a second consumer
 * arrived — the publishing-suite broadcast ledger (Fizzy #1850, 1C-4b). The
 * tables encode PROVIDER knowledge, not newsletter knowledge, so a second
 * consumer is the point at which single ownership stops being incidental.
 * Cross-module lib imports are normal in this package — `organizations/lib/
 * membership` alone has 168 importers — so the move is about ownership rather
 * than about a prohibition.
 *
 * Two rules carry over unchanged, and both are load-bearing:
 *
 *  1. The DB keeps the RAW provider string (a Slack error code, a Graph error
 *     body) because that is what an engineer needs. This is the read-time
 *     translation, so copy can improve without a data migration.
 *  2. An unrecognised **`errorMessage`** is NEVER passed through. Both callers
 *     are reachable by read-only viewers, and Graph error bodies carry tenant
 *     identifiers. Unknown failures degrade to a generic message that points at
 *     the logs.
 *
 *     Scoped to that column on purpose. `platform` IS echoed when unrecognised
 *     (see `platformLabel`) and that is pinned by an existing test: it is not
 *     provider-supplied — it comes from the project's own linked-channel rows —
 *     so it carries nothing a viewer of this panel cannot already see.
 *
 * Pure and total: unknown inputs return a generic message, never throw.
 */

const PLATFORM_LABEL: Record<string, string> = {
	SLACK: "Slack",
	TEAMS: "Microsoft Teams",
};

/**
 * Every table lookup in this file goes through `Object.hasOwn`, never a bare
 * index + `??`. A plain object literal inherits from Object.prototype, so a
 * stored value of "constructor" / "toString" / "valueOf" resolves to a FUNCTION
 * — truthy, so it defeats the `??` fallback and is returned in place of a
 * string, breaking the declared `string | null` return type. (It then serializes
 * to undefined over the wire and the panel silently renders nothing.) Nothing
 * constrains what reaches these columns, so the lookups must not assume
 * well-formed keys.
 *
 * Exported because the newsletter mapper's own skip-reason table needs the same
 * guard, and the ten-line reason for it is worth having exactly once.
 */
export function tableLookup(
	table: Record<string, string>,
	key: string,
): string | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Falls back to the raw value, deliberately — this is the ONE lookup in the file
 * that is not fail-closed, and `chat-delivery-error.test.ts` pins it that way
 * with exact assertions on "DISCORD" and "constructor". An unrecognised platform
 * means an operator is looking at a row no writer in this repo can produce, and
 * naming it is more useful to them than "chat".
 *
 * Safe because `platform` is not provider-supplied: both writers type it as
 * "TEAMS" | "SLACK" and it originates in the project's own linked-channel rows,
 * unlike `errorMessage`, which is whatever a provider put on the wire. Rule 2 in
 * the header is scoped to that column for exactly this reason.
 */
function platformLabel(platform: string): string {
	return tableLookup(PLATFORM_LABEL, platform) ?? platform;
}

/** Slack API error codes → actionable copy. */
export const SLACK_ERRORS: Record<string, string> = {
	not_in_channel:
		"Fabric is not a member of this Slack channel. Invite the app to the channel, then send again.",
	invalid_auth:
		"Fabric's Slack connection is no longer valid. Reconnect Slack in Settings.",
	is_archived:
		"This Slack channel is archived. Choose a different channel in Distribution settings.",
	channel_not_found:
		"This Slack channel is no longer visible to Fabric. It may have been archived, or the app needs to be invited to it.",
	missing_scope:
		"Fabric is missing a Slack permission needed to post. Reconnect Slack in Settings to grant it.",
	not_allowed_token_type:
		"Fabric is missing a Slack permission needed to post. Reconnect Slack in Settings to grant it.",
	token_revoked:
		"Fabric's Slack connection is no longer valid. Reconnect Slack in Settings.",
	account_inactive:
		"Fabric's Slack connection is no longer valid. Reconnect Slack in Settings.",
	// Defensive only: the Web API signals rate limiting with HTTP 429, which
	// `postSlackMessage` turns into a thrown status line before the body is
	// parsed. The 429 branch below is the path that actually fires.
	ratelimited:
		"Slack rate-limited this delivery. It should succeed on the next send.",
	// Written by the delivery activity, not by Slack: the post failed with
	// not_in_channel AND the follow-up conversations.join was refused for lack
	// of permission. Distinct from not_in_channel because the remedy differs.
	join_missing_scope:
		"Fabric could not join this Slack channel because its Slack connection is missing a permission. Reconnect Slack in Settings, or invite the app to the channel.",
};

/**
 * Owns its own normalisation and empty guard, deliberately.
 *
 * Newsletter computes its `raw` ABOVE its SKIPPED branch, so that line cannot
 * move here — meaning newsletter always hands this function an already-normalised
 * string while publishing hands it the raw `string | null` column. Without the
 * `?? ""` below, `describeChatProviderFailure(null, "SLACK")` would reach
 * `raw.startsWith(...)` and throw a TypeError inside an oRPC handler, 500-ing the
 * panel instead of degrading. Newsletter's double-normalisation is a no-op.
 */
export function describeChatProviderFailure(
	errorMessage: string | null | undefined,
	platform: string,
): string {
	const raw = (errorMessage ?? "").trim();

	const generic = `Delivery to this ${platformLabel(platform)} channel failed. Check the worker logs for the provider error.`;

	if (!raw) {
		return generic;
	}

	// EVERY provider branch below is gated on `platform`. Matching on message
	// shape alone is not safe: `getSlackCredentials` throws prose containing
	// "Please reconnect your Slack workspace", which an ungated Microsoft branch
	// would answer with "Reconnect Microsoft" — telling an operator to fix a
	// product they may not even have connected, which is precisely the
	// misdirection this copy exists to eliminate.
	if (platform === "SLACK") {
		// Bare error codes from a 200 response body.
		const code = tableLookup(SLACK_ERRORS, raw);
		if (code) {
			return code;
		}
		// `postSlackMessage` throws on a non-2xx BEFORE parsing the body, so
		// transport-level failures arrive as a formatted status line and never
		// as a Slack error code. Rate limiting is the common one — the Web API
		// signals it with HTTP 429, not with an in-body "ratelimited".
		if (raw.startsWith("Slack API error: 429")) {
			return "Slack rate-limited this delivery. It should succeed on the next send.";
		}
		if (/^Slack API error: 5\d\d/.test(raw)) {
			return "Slack was temporarily unavailable. It should succeed on the next send.";
		}
		// Credential-resolution failures are prose, not codes.
		if (raw.startsWith("Slack ")) {
			return "Fabric's Slack connection is not usable for this channel. Reconnect Slack in Settings.";
		}
		return generic;
	}

	if (platform === "TEAMS") {
		// Microsoft Graph failures arrive as a formatted message with the HTTP
		// status and the raw JSON body. Match on the shape, never echo the body.
		if (raw.includes("Microsoft Graph API error: 403")) {
			return "Fabric is missing the Microsoft Teams permission needed to post. Reconnect Microsoft in Settings to grant it.";
		}
		if (raw.includes("Microsoft Graph API error: 401")) {
			return "Fabric's Microsoft connection is no longer valid. Reconnect Microsoft in Settings.";
		}
		if (raw.includes("Microsoft Graph API error: 404")) {
			return "This Microsoft Teams channel no longer exists, or Fabric can no longer see it.";
		}
		if (raw.startsWith("Microsoft not connected")) {
			return "The account that linked this channel has no active Microsoft connection. Reconnect Microsoft in Settings.";
		}
		if (
			raw.startsWith("Microsoft access token") ||
			raw.includes("Please reconnect")
		) {
			return "Fabric's Microsoft connection is no longer valid. Reconnect Microsoft in Settings.";
		}
		return generic;
	}

	return generic;
}
