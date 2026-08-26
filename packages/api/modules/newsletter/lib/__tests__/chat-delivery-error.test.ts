import { describe, expect, it } from "vitest";
import { describeChatDeliveryFailure } from "../chat-delivery-error";

describe("describeChatDeliveryFailure", () => {
	it("returns null for a confirmed delivery", () => {
		expect(describeChatDeliveryFailure("SENT", null, "SLACK")).toBeNull();
	});

	it("describes SENDING as unconfirmed, never as skipped", () => {
		// A row is left at SENDING only when the worker died between a
		// successful post and the confirming write. The activity counts it as
		// sent (dup-over-miss), so the operator must be told "unconfirmed".
		expect(describeChatDeliveryFailure("SENDING", null, "TEAMS")).toBe(
			"Delivery was started but never confirmed. The message was most likely posted — check the channel before resending.",
		);
	});

	it("maps a refused channel join to reconnect guidance", () => {
		expect(
			describeChatDeliveryFailure(
				"FAILED",
				"join_missing_scope",
				"SLACK",
			),
		).toBe(
			"Fabric could not join this Slack channel because its Slack connection is missing a permission. Reconnect Slack in Settings, or invite the app to the channel.",
		);
	});

	it("explains a Slack membership failure with the fix", () => {
		expect(
			describeChatDeliveryFailure("FAILED", "not_in_channel", "SLACK"),
		).toBe(
			"Fabric is not a member of this Slack channel. Invite the app to the channel, then send again.",
		);
	});

	it("treats channel_not_found as a membership/visibility problem", () => {
		expect(
			describeChatDeliveryFailure("FAILED", "channel_not_found", "SLACK"),
		).toBe(
			"This Slack channel is no longer visible to Fabric. It may have been archived, or the app needs to be invited to it.",
		);
	});

	it("tells the admin to reconnect when Slack scopes are stale", () => {
		expect(
			describeChatDeliveryFailure("FAILED", "missing_scope", "SLACK"),
		).toBe(
			"Fabric is missing a Slack permission needed to post. Reconnect Slack in Settings to grant it.",
		);
	});

	it("maps a Graph 403 to the re-consent instruction", () => {
		expect(
			describeChatDeliveryFailure(
				"FAILED",
				'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden"}}',
				"TEAMS",
			),
		).toBe(
			"Fabric is missing the Microsoft Teams permission needed to post. Reconnect Microsoft in Settings to grant it.",
		);
	});

	it("maps a missing Microsoft connection", () => {
		expect(
			describeChatDeliveryFailure(
				"FAILED",
				"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
				"TEAMS",
			),
		).toBe(
			"The account that linked this channel has no active Microsoft connection. Reconnect Microsoft in Settings.",
		);
	});

	it("maps a known skip reason", () => {
		expect(
			describeChatDeliveryFailure(
				"SKIPPED",
				"channel no longer linked to project",
				"TEAMS",
			),
		).toBe(
			"This channel is no longer linked to the project. Re-link it in project settings to resume delivery.",
		);
	});

	it("never echoes an unrecognised skip reason", () => {
		// errorMessage is an unconstrained Text column and this procedure is
		// reachable by read-only viewers. Nothing enforces that only the two
		// known skip strings are ever written, so the branch must fail closed
		// rather than pass a stored string through.
		const out = describeChatDeliveryFailure(
			"SKIPPED",
			'unexpected: {"tenantId":"00000000-0000-0000-0000-000000000000"}',
			"TEAMS",
		);
		expect(out).toBe("This channel was skipped for this send.");
		expect(out).not.toContain("tenantId");
	});

	it("never leaks a raw provider payload for an unrecognised failure", () => {
		const out = describeChatDeliveryFailure(
			"FAILED",
			'Microsoft Graph API error: 500 - {"tenantId":"00000000-0000-0000-0000-000000000000"}',
			"TEAMS",
		);
		expect(out).toBe(
			"Delivery to this Microsoft Teams channel failed. Check the worker logs for the provider error.",
		);
		expect(out).not.toContain("tenantId");
	});

	it("is total — handles a null error message", () => {
		expect(describeChatDeliveryFailure("FAILED", null, "SLACK")).toBe(
			"Delivery to this Slack channel failed. Check the worker logs for the provider error.",
		);
	});

	// This branch had no test until the 1C-4b extraction needed one. The strings
	// are thrown by send-newsletter-chat-messages.ts, NOT by a provider, so the
	// branch stays in this newsletter mapper rather than moving to the shared
	// provider module — and without a case here the extraction could delete it
	// with every gate still green. Deleted, the Slack row falls through to the
	// `startsWith("Slack ")` branch and tells an admin to reconnect a workspace
	// that is fine, when the remedy is re-linking the channel.
	it.each([
		["Slack channel has no linking user", "SLACK"],
		["Teams channel has no linking user", "TEAMS"],
	])("keeps the re-link remedy for %s", (raw, platform) => {
		expect(describeChatDeliveryFailure("FAILED", raw, platform)).toBe(
			"The account that linked this channel is no longer available. Re-link the channel in project settings.",
		);
	});

	it("never answers a Slack failure with Microsoft copy", () => {
		// getSlackCredentials throws prose containing "Please reconnect your
		// Slack workspace". An ungated Microsoft branch matched that substring
		// and told the operator to reconnect Microsoft — a product the project
		// may not even have connected. Every provider branch is platform-gated.
		for (const raw of [
			"Slack credentials missing. Please reconnect your Slack workspace in Settings > Integrations.",
			"Slack credentials are corrupted. Please reconnect your Slack workspace in Settings > Integrations.",
			"Slack access token missing. Please reconnect your Slack workspace in Settings > Integrations.",
			"Slack not connected. Please connect your Slack workspace in Settings > Integrations.",
		]) {
			const out = describeChatDeliveryFailure("FAILED", raw, "SLACK");
			expect(out).toBe(
				"Fabric's Slack connection is not usable for this channel. Reconnect Slack in Settings.",
			);
			expect(out).not.toMatch(/Microsoft/);
		}
	});

	it("maps Slack transport failures, which never arrive as error codes", () => {
		// postSlackMessage throws on a non-2xx before the body is parsed, so
		// rate limiting reaches the ledger as a status line, not "ratelimited".
		expect(
			describeChatDeliveryFailure(
				"FAILED",
				"Slack API error: 429 Too Many Requests",
				"SLACK",
			),
		).toBe(
			"Slack rate-limited this delivery. It should succeed on the next send.",
		);
		expect(
			describeChatDeliveryFailure(
				"FAILED",
				"Slack API error: 503 Service Unavailable",
				"SLACK",
			),
		).toBe(
			"Slack was temporarily unavailable. It should succeed on the next send.",
		);
	});

	it("returns a string for prototype-chain keys, never an inherited member", () => {
		// A bare `TABLE[raw] ?? fallback` resolves "constructor"/"toString"
		// through Object.prototype to a truthy FUNCTION, defeating the fallback
		// and violating the declared string|null return type (it then
		// serializes to undefined and the panel renders nothing).
		for (const key of [
			"constructor",
			"toString",
			"valueOf",
			"hasOwnProperty",
		]) {
			expect(
				typeof describeChatDeliveryFailure("FAILED", key, "SLACK"),
			).toBe("string");
			expect(
				typeof describeChatDeliveryFailure("SKIPPED", key, "TEAMS"),
			).toBe("string");
		}
		expect(describeChatDeliveryFailure("FAILED", "x", "constructor")).toBe(
			"Delivery to this constructor channel failed. Check the worker logs for the provider error.",
		);
	});

	it("does not apply provider branches to an unknown platform", () => {
		expect(
			describeChatDeliveryFailure("FAILED", "not_in_channel", "DISCORD"),
		).toBe(
			"Delivery to this DISCORD channel failed. Check the worker logs for the provider error.",
		);
	});
});
