import { describe, expect, it } from "vitest";
import {
	describeChatProviderFailure,
	SLACK_ERRORS,
	tableLookup,
} from "../chat-provider-error";

/**
 * The expected table, transcribed ONCE, here, and reviewed once.
 *
 * Not `Object.keys(SLACK_ERRORS)` and not `toBe(SLACK_ERRORS[code])`: both draw
 * the expectation from the module under test, so a value corrupted during the
 * extraction corrupts both sides of the equality together and passes. A
 * key-set-only assertion has the same hole for values.
 *
 * Six of these ten strings have no exact assertion anywhere else in the repo.
 * The untouched newsletter test pins four — not_in_channel, channel_not_found,
 * missing_scope, join_missing_scope. `ratelimited` LOOKS covered there and is
 * not: its rate-limit case passes "Slack API error: 429 Too Many Requests",
 * which takes the HTTP-429 transport branch and returns the same sentence from
 * a different code path, exactly as that file's comment says.
 *
 * This literal is the one place the strings exist independently of the module,
 * which is what makes it a control. A typo HERE goes red immediately; a typo in
 * the moved module goes red only because of this.
 */
const EXPECTED_SLACK_ERRORS = {
	not_in_channel:
		"Fabric is not a member of this Slack channel. Invite the app to the channel, then send again.",
	is_archived:
		"This Slack channel is archived. Choose a different channel in Distribution settings.",
	channel_not_found:
		"This Slack channel is no longer visible to Fabric. It may have been archived, or the app needs to be invited to it.",
	missing_scope:
		"Fabric is missing a Slack permission needed to post. Reconnect Slack in Settings to grant it.",
	not_allowed_token_type:
		"Fabric is missing a Slack permission needed to post. Reconnect Slack in Settings to grant it.",
	invalid_auth:
		"Fabric's Slack connection is no longer valid. Reconnect Slack in Settings.",
	token_revoked:
		"Fabric's Slack connection is no longer valid. Reconnect Slack in Settings.",
	account_inactive:
		"Fabric's Slack connection is no longer valid. Reconnect Slack in Settings.",
	ratelimited:
		"Slack rate-limited this delivery. It should succeed on the next send.",
	join_missing_scope:
		"Fabric could not join this Slack channel because its Slack connection is missing a permission. Reconnect Slack in Settings, or invite the app to the channel.",
};

describe("SLACK_ERRORS survived the extraction intact", () => {
	it("has exactly the ten documented codes with their exact copy", () => {
		expect(SLACK_ERRORS).toEqual(EXPECTED_SLACK_ERRORS);
	});

	it.each(Object.keys(EXPECTED_SLACK_ERRORS))(
		"routes %s through the table rather than the generic fallback",
		(code) => {
			expect(describeChatProviderFailure(code, "SLACK")).toBe(
				EXPECTED_SLACK_ERRORS[
					code as keyof typeof EXPECTED_SLACK_ERRORS
				],
			);
		},
	);
});

describe("Microsoft Graph branch", () => {
	it.each([
		["403", "missing the Microsoft Teams permission"],
		["401", "no longer valid"],
		["404", "no longer exists"],
	])("maps Graph %s without echoing the body", (status, fragment) => {
		const out = describeChatProviderFailure(
			`Microsoft Graph API error: ${status} - {"tenantId":"LEAK-SENTINEL"}`,
			"TEAMS",
		);
		expect(out).toContain(fragment);
		expect(out).not.toContain("LEAK-SENTINEL");
	});

	/**
	 * The Teams condition with no exact-value coverage in the newsletter control,
	 * and its two disjuncts get one case EACH. A single string matching both —
	 * "Microsoft access token expired. Please reconnect." — leaves either half
	 * deletable with the test still green.
	 */
	it.each([
		"Microsoft access token missing.",
		"Teams channel post rejected. Please reconnect.",
	])("maps the Microsoft credential failure %s", (raw) => {
		expect(describeChatProviderFailure(raw, "TEAMS")).toBe(
			"Fabric's Microsoft connection is no longer valid. Reconnect Microsoft in Settings.",
		);
	});
});

/**
 * The cases the newsletter control provably cannot reach: its own `raw` is
 * computed before delegation, so it only ever calls this function with an
 * already-normalised string. Publishing hands over the raw nullable column.
 */
describe("normalisation the caller cannot be relied on to do", () => {
	it.each([
		[null, "SLACK"],
		[undefined, "SLACK"],
		["", "TEAMS"],
		["   ", "TEAMS"],
		[null, "DISCORD"],
	])("returns generic copy for %s on %s", (raw, platform) => {
		const out = describeChatProviderFailure(
			raw as string | null | undefined,
			platform,
		);
		expect(typeof out).toBe("string");
		expect(out).toContain("Check the worker logs");
	});
});

/**
 * Asserted in the SLACK direction, matching the newsletter original.
 *
 * The TEAMS direction cannot express this: that branch matches
 * `includes("Please reconnect")` and returns Microsoft copy, so a test asserting
 * the output does not contain "Slack" passes whether or not the gating works.
 * The real guarantee is that a SLACK row is never answered with Microsoft advice.
 */
it.each([
	"Slack credentials missing. Please reconnect your Slack workspace in Settings > Integrations.",
	"Slack access token missing. Please reconnect your Slack workspace in Settings > Integrations.",
])("never answers Slack prose with Microsoft advice: %s", (raw) => {
	expect(describeChatProviderFailure(raw, "SLACK")).not.toMatch(/Microsoft/);
});

/**
 * The only assertion that can tell trimmed from untrimmed. The `?? ""` half of
 * the normalisation is covered by the null cases above (without it they throw);
 * `.trim()` is not, and it is the half that matters for the new caller, which
 * hands over an unconstrained Text column rather than a pre-normalised string.
 */
it("trims before matching, so padded stored text still resolves", () => {
	expect(describeChatProviderFailure("  not_in_channel  ", "SLACK")).toBe(
		EXPECTED_SLACK_ERRORS.not_in_channel,
	);
});

/**
 * `platform` IS echoed when unrecognised — the one lookup in the module that is
 * not fail-closed. Pinned here as well as in the newsletter suite, because a
 * review of this branch proposed making it fail closed and the change broke that
 * suite: the behaviour is deliberate, not an oversight, and it is safe for a
 * different reason than `errorMessage` is. This column is not provider-supplied.
 */
it("names an unrecognised platform rather than degrading it", () => {
	expect(describeChatProviderFailure("boom", "DISCORD")).toBe(
		"Delivery to this DISCORD channel failed. Check the worker logs for the provider error.",
	);
});

it("never returns a function for a prototype key", () => {
	expect(typeof tableLookup(SLACK_ERRORS, "constructor")).toBe("undefined");
	expect(typeof describeChatProviderFailure("x", "constructor")).toBe(
		"string",
	);
});
