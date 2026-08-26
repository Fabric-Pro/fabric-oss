import { describe, expect, it } from "vitest";
import { oauthProviders } from "../../../integrations/lib/oauth-providers";
import { getMcpDefinition, getRequiredScopes } from "../account-mcp-registry";

const teamsMcp = getMcpDefinition("microsoft_teams", "microsoft-teams");

/**
 * The account MCP registry declares the Graph scopes each MCP depends on. It is
 * the third place a Microsoft permission is written down — alongside
 * `oauthProviders.MICROSOFT_GRAPH.scopes` (which issues the token) and the
 * @repo/mcp-registry conditional account (which describes the same surface).
 *
 * Unlike those two, this one had fallen furthest behind: it never picked up the
 * meeting, transcript, calendar or directory scopes at all. Because both
 * registries are declarative today — `getRequiredScopes` has no production
 * caller — the staleness never surfaced as a runtime failure, it just made the
 * declaration untrustworthy as documentation.
 */
const TEAMS_TOOL_SCOPES = [
	{ scope: "User.Read", tool: "signed-in user profile" },
	{ scope: "User.ReadBasic.All", tool: "list_users" },
	{ scope: "Team.ReadBasic.All", tool: "list_teams" },
	{ scope: "Channel.ReadBasic.All", tool: "list_channels" },
	{ scope: "Chat.Read", tool: "list_chats / get_chat_messages" },
	{ scope: "ChatMessage.Read", tool: "chat message reads" },
	{
		scope: "ChannelMessage.Read.All",
		tool: "list_messages / search_messages",
	},
	{ scope: "ChannelMessage.Send", tool: "send_message to a channel" },
	{ scope: "ChatMessage.Send", tool: "send_message to a chat" },
	{ scope: "Files.Read.All", tool: "get_shared_files" },
	{ scope: "OnlineMeetings.Read", tool: "meeting lookup" },
	{ scope: "Calendars.Read", tool: "calendar-based meeting discovery" },
	{
		scope: "OnlineMeetingTranscript.Read.All",
		tool: "list_meeting_transcripts",
	},
] as const;

describe("microsoft_teams account MCP scope declaration", () => {
	it("registers the Teams MCP", () => {
		expect(teamsMcp).toBeDefined();
	});

	it.each(TEAMS_TOOL_SCOPES)("declares $scope for $tool", ({ scope }) => {
		expect(teamsMcp?.requiredScopes).toContain(scope);
	});

	it("does not claim calendar write, which no Teams tool performs", () => {
		// ReadWrite is requested at OAuth time for the workflow orchestrator's
		// create-event action, not for anything on the Teams surface.
		expect(teamsMcp?.requiredScopes).not.toContain("Calendars.ReadWrite");
	});

	it("declares no scope the Microsoft Graph OAuth flow does not request", () => {
		// Both lists live in @repo/api, so this one can compare directly rather
		// than restating the OAuth array by hand.
		const requestedAtOauth = new Set(oauthProviders.MICROSOFT_GRAPH.scopes);

		const undeclared = getRequiredScopes("microsoft_teams", [
			"microsoft-teams",
		]).filter(
			(scope) =>
				!requestedAtOauth.has(scope) &&
				// OIDC scopes, granted by the identity platform rather than Graph.
				!["openid", "email", "profile"].includes(scope),
		);

		expect(undeclared).toEqual([]);
	});
});
