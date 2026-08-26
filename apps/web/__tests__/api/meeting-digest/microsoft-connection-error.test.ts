import {
	isMeetingLookupForbiddenError,
	isMeetingNotFoundError,
} from "@repo/api/modules/projects/procedures/meeting-digest/microsoft-connection-error";
import { isMicrosoftNotConnectedError } from "@repo/integrations/microsoft";
import { describe, expect, it } from "vitest";

// Messages copied verbatim from packages/integrations/src/microsoft/index.ts.
describe("isMicrosoftNotConnectedError", () => {
	it("matches the never-connected message (index.ts:106)", () => {
		expect(
			isMicrosoftNotConnectedError(
				"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
			),
		).toBe(true);
	});

	it("matches the missing-access-token message (index.ts:135)", () => {
		expect(
			isMicrosoftNotConnectedError(
				"Microsoft access token is missing. Please reconnect your Microsoft account in Settings > Integrations.",
			),
		).toBe(true);
	});

	it("matches the never-connected message from executeMicrosoftTeamsTool (index.ts:510)", () => {
		expect(
			isMicrosoftNotConnectedError(
				"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
			),
		).toBe(true);
	});

	it("matches the missing-token-refresh-failed message (index.ts:574)", () => {
		expect(
			isMicrosoftNotConnectedError(
				"Microsoft access token is missing and refresh failed. Please reconnect your Microsoft account in Settings > Integrations.",
			),
		).toBe(true);
	});

	it("matches the missing-token-no-refresh-token message (index.ts:579)", () => {
		expect(
			isMicrosoftNotConnectedError(
				"Microsoft access token is missing and no refresh token available. Please reconnect your Microsoft account in Settings > Integrations.",
			),
		).toBe(true);
	});

	it("matches the expired-token-refresh-failed message (index.ts:680)", () => {
		expect(
			isMicrosoftNotConnectedError(
				"Microsoft access token expired and refresh failed. Please reconnect your Microsoft account in Settings > Integrations.",
			),
		).toBe(true);
	});

	it("does not match an unrelated Graph error", () => {
		expect(
			isMicrosoftNotConnectedError(
				"Microsoft Graph API error: 500 Internal Server Error - {}",
			),
		).toBe(false);
	});
});

/**
 * DEF-6. Looking a meeting up goes through /me/onlineMeetings, which Graph
 * refuses for meetings the caller cannot resolve — routinely, ones organised by
 * someone else. That is an expected state for a person browsing their own
 * calendar, not a server fault, but it reached the generic 500 path and the UI
 * showed "Failed to load transcript".
 *
 * Captured verbatim from staging on 2026-07-24 while opening a linked project
 * meeting organised by a colleague.
 */
describe("isMeetingLookupForbiddenError", () => {
	const REAL_MESSAGE =
		'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"3003: User does not have access to lookup meeting","innerError":{"date":"2026-07-24T12:33:00","request-id":"x"}}}';

	it("matches the real 3003 lookup-forbidden response from Graph", () => {
		expect(isMeetingLookupForbiddenError(REAL_MESSAGE)).toBe(true);
	});

	it("matches on the 3003 code even if the prose is reworded", () => {
		expect(
			isMeetingLookupForbiddenError(
				'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"3003: Caller does not have permission to look up this meeting"}}',
			),
		).toBe(true);
	});

	it("does not match a 403 about transcript permissions", () => {
		// That case has its own admin-consent affordance and must not be
		// rewritten into "you don't have access to this meeting".
		expect(
			isMeetingLookupForbiddenError(
				'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"Missing OnlineMeetingTranscript.Read.All"}}',
			),
		).toBe(false);
	});

	it("does not match an unrelated Graph error", () => {
		expect(
			isMeetingLookupForbiddenError(
				"Microsoft Graph API error: 500 Internal Server Error - {}",
			),
		).toBe(false);
	});

	it("does not match a not-connected message", () => {
		expect(
			isMeetingLookupForbiddenError(
				"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
			),
		).toBe(false);
	});
});

/**
 * The sibling of DEF-6, found by QA on #2170.
 *
 * `get_meeting_by_join_url` answers 403/3003 when the caller may not look a
 * meeting up, and that case is classified above. But Graph does not commit to
 * one shape for "I cannot resolve this join URL": it also answers 404/3004,
 * and — for a third population — 200 with an empty `value` array, which the
 * integration layer already turns into a graceful "no meeting found".
 *
 * Only the 404 fell through to a rethrow, so an ordinary outcome of browsing
 * your own calendar surfaced as an HTTP 500 and the import told the user to
 * "Try again", advice that can never work. Measured on staging 2026-08-19:
 * 19 of 22 personal meetings on one real calendar hit exactly this.
 *
 * Kept separate from `isMeetingLookupForbiddenError` rather than widening it.
 * 3003 means "this meeting is someone else's"; 3004 means "no such meeting is
 * resolvable for you at all". They read differently to a user and the narrow
 * matching of the 3003 predicate is deliberate.
 *
 * Captured verbatim from staging on 2026-08-19; request ids replaced with "x".
 */
describe("isMeetingNotFoundError", () => {
	const REAL_MESSAGE =
		'Microsoft Graph API error: 404 Not Found - {"error":{"code":"NotFound","message":"3004: Specified meeting is not found","innerError":{"date":"2026-08-19T14:01:19","request-id":"x","client-request-id":"x"}}}';

	it("matches the real 3004 meeting-not-found response from Graph", () => {
		expect(isMeetingNotFoundError(REAL_MESSAGE)).toBe(true);
	});

	it("matches on the 3004 code even if the prose is reworded", () => {
		expect(
			isMeetingNotFoundError(
				'Microsoft Graph API error: 404 Not Found - {"error":{"code":"NotFound","message":"3004: The meeting could not be located"}}',
			),
		).toBe(true);
	});

	it("does not match the 3003 lookup-forbidden response", () => {
		// That one is "someone else organised it" and keeps its own copy.
		expect(
			isMeetingNotFoundError(
				'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"3003: User does not have access to lookup meeting"}}',
			),
		).toBe(false);
	});

	it("does not match a 404 that is not about meeting lookup", () => {
		expect(
			isMeetingNotFoundError(
				'Microsoft Graph API error: 404 Not Found - {"error":{"code":"NotFound","message":"Transcript not found"}}',
			),
		).toBe(false);
	});

	it("does not match an unrelated Graph error", () => {
		expect(
			isMeetingNotFoundError(
				"Microsoft Graph API error: 500 Internal Server Error - {}",
			),
		).toBe(false);
	});
});
