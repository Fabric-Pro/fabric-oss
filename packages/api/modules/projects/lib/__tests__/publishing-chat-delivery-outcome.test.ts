import { describe, expect, it } from "vitest";
import { describePublishingChatDelivery } from "../publishing-chat-delivery-outcome";

const d = describePublishingChatDelivery;

it("says nothing about a delivered channel", () => {
	expect(d("SENT", null, null, "SLACK")).toBeNull();
});

describe("SENDING distinguishes in-flight from stranded", () => {
	const NOW = new Date("2026-08-20T12:00:00Z").getTime();
	const at = (msAgo: number) => new Date(NOW - msAgo);

	// A row is SENDING for the whole duration of the provider call, and the
	// cycle is listed before the broadcast is dispatched — so the operator who
	// just clicked "Generate now" is the one most likely to see this.
	it("says a fresh row is still broadcasting", () => {
		const out = d("SENDING", null, null, "SLACK", at(5_000), NOW) ?? "";
		expect(out).toContain("still broadcasting");
		expect(out).not.toContain("posting manually");
	});

	it("says an old row was never confirmed", () => {
		const out =
			d("SENDING", null, null, "SLACK", at(60 * 60 * 1000), NOW) ?? "";
		expect(out).toContain("may or may not");
	});

	// A row written before this column was selected, or by an older build.
	it("treats a missing timestamp as stranded, not as in flight", () => {
		expect(d("SENDING", null, null, "SLACK", null, NOW)).toContain(
			"may or may not",
		);
	});
});

describe("SENDING", () => {
	/**
	 * Publishing's claim is written BEFORE the provider is contacted
	 * (broadcast-topics-to-chat.ts:524 vs :569/:593), and the dominant path that
	 * strands SENDING rows is a heartbeat kill in which nothing was posted. The
	 * newsletter copy — "most likely posted" — is therefore false here, and false
	 * exactly in the case that produces these rows in bulk.
	 */
	it("does not claim the message was probably delivered", () => {
		const out = d("SENDING", null, null, "TEAMS") ?? "";
		expect(out).toContain("may or may not");
		expect(out).not.toContain("most likely");
	});

	/** There is no resend: the claim refuses any channel that already has a row. */
	it("does not suggest resending", () => {
		expect(d("SENDING", null, null, "SLACK")).not.toContain("resend");
	});
});

describe("SKIPPED reads `reason`, never `errorMessage`", () => {
	it.each([
		["CHANNEL_NOT_LINKED", "no longer linked"],
		["LINKER_NOT_AUTHORIZED", "no longer has access"],
	])("maps %s", (reason, fragment) => {
		expect(d("SKIPPED", reason, null, "SLACK")).toContain(fragment);
	});

	// TWO cases, and the second is the one with teeth. With a KNOWN reason the
	// table lookup succeeds and the sentinel is absent no matter what, so that
	// case cannot fail for any realistic mutation. With an UNRECOGNISED reason,
	// an implementation that falls back to `errorMessage` returns the sentinel.
	it("ignores errorMessage when the reason is known", () => {
		expect(
			d("SKIPPED", "CHANNEL_NOT_LINKED", "LEAK-SENTINEL", "SLACK"),
		).not.toContain("LEAK-SENTINEL");
	});

	it("ignores errorMessage when the reason is NOT known", () => {
		expect(
			d("SKIPPED", "SOMETHING_NEW", "LEAK-SENTINEL", "SLACK"),
		).not.toContain("LEAK-SENTINEL");
	});

	// `reason` is a bare String? with no enum and no CHECK, and
	// markPublishingChatDelivery accepts it independently of status — a DB test
	// already writes SKIPPED with none.
	it.each([[null], [undefined], [""], ["SOMETHING_NEW"]])(
		"degrades %s to generic skip copy",
		(reason) => {
			const out = d("SKIPPED", reason as string | null, null, "SLACK");
			expect(typeof out).toBe("string");
			expect(out).toContain("skipped");
		},
	);

	it("never returns a function for a prototype key", () => {
		expect(typeof d("SKIPPED", "constructor", null, "SLACK")).toBe(
			"string",
		);
	});
});

describe("FAILED delegates to the provider translator", () => {
	it("maps a known Slack code", () => {
		expect(d("FAILED", "POST_FAILED", "not_in_channel", "SLACK")).toContain(
			"not a member",
		);
	});

	it("never echoes an unrecognised body", () => {
		const out = d(
			"FAILED",
			"POST_FAILED",
			'Microsoft Graph API error: 500 - {"tenantId":"LEAK-SENTINEL"}',
			"TEAMS",
		);
		expect(out).not.toContain("LEAK-SENTINEL");
		expect(out).toContain("Check the worker logs");
	});
});

it("is total for a status the CHECK admits but this code does not know", () => {
	expect(typeof d("QUEUED", null, null, "SLACK")).toBe("string");
});
