import { describe, expect, it } from "vitest";
import { oauthProviders } from "../oauth-providers";

const microsoftGraphScopes = oauthProviders.MICROSOFT_GRAPH.scopes;

/**
 * Delegated permissions Microsoft Graph requires for the call sites this
 * product actually reaches, mapped from endpoint + HTTP method to the
 * permission Microsoft documents for it.
 *
 * These live in two places that drift silently: this scopes array decides what
 * lands in an issued token, and the Azure app registration decides what may be
 * requested at all. A scope absent from either one is a 403 at runtime, and a
 * token refresh does NOT widen scopes — every affected connection has to be
 * disconnected and re-authorized before a fix reaches it.
 *
 * This guard exists because that drift went unnoticed for months. Do not delete
 * a row to make a failure go away; the row is the reason the feature works.
 */
const REQUIRED_BY_CALL_SITE = [
	{
		scope: "ChannelMessage.Send",
		graphCall: "POST /teams/{id}/channels/{id}/messages",
		feature: "post or reply to a Teams channel message",
	},
	{
		scope: "ChatMessage.Send",
		graphCall: "POST /chats/{id}/messages",
		feature: "send_message to a 1:1 or group chat",
	},
	{
		scope: "Calendars.ReadWrite",
		graphCall: "POST /me/events",
		feature: "workflow create-calendar-event action",
	},
	{
		scope: "Mail.Send",
		graphCall: "POST /me/sendMail",
		feature: "workflow send-email action",
	},
	{
		scope: "Mail.Read",
		graphCall: "GET /me/mailFolders/{id}/messages",
		feature: "workflow mail-folder read action",
	},
	{
		scope: "User.ReadBasic.All",
		graphCall: "GET /users",
		feature: "Teams list_users tool",
	},
] as const;

describe("MICROSOFT_GRAPH OAuth scopes", () => {
	it.each(REQUIRED_BY_CALL_SITE)(
		"requests $scope for $graphCall — $feature",
		({ scope }) => {
			expect(microsoftGraphScopes).toContain(scope);
		},
	);

	it("keeps Calendars.Read alongside Calendars.ReadWrite", () => {
		// ReadWrite is a superset on paper, so Read looks redundant — but it is
		// the only calendar scope currently registered and consented in Azure,
		// and /me/calendarView is load-bearing today (Meeting Digest personal
		// and upcoming meetings, the meetings cache, the Teams list_meetings
		// tool, the workflow get_calendar_events action). Dropping it before
		// ReadWrite is registered would trade a working permission for one the
		// tenant cannot grant. Remove Read in the unused-scope cleanup, once
		// ReadWrite is confirmed granted.
		expect(microsoftGraphScopes).toContain("Calendars.ReadWrite");
		expect(microsoftGraphScopes).toContain("Calendars.Read");
	});

	it("requests offline_access so tokens can be refreshed", () => {
		expect(microsoftGraphScopes).toContain("offline_access");
	});

	it("requests no scope twice", () => {
		expect(new Set(microsoftGraphScopes).size).toBe(
			microsoftGraphScopes.length,
		);
	});
});
