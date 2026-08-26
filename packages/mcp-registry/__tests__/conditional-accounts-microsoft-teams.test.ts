import { describe, expect, it } from "vitest";
import { getConditionalAccount } from "../src/conditional-accounts";

const teamsMcp = getConditionalAccount("microsoft_teams")?.mcps.find(
	(mcp) => mcp.id === "microsoft-teams",
);

/**
 * Microsoft Graph delegated permissions the Teams MCP's own tools depend on.
 *
 * This list is declarative — it documents the Teams surface, it does not issue
 * tokens. The array that decides what actually lands in a token is
 * `oauthProviders.MICROSOFT_GRAPH.scopes` in @repo/api. The two cannot import
 * each other, so they are kept in step by a guard on each side; letting them
 * drift is what produced a set of silent 403s that went unnoticed for months.
 *
 * Mail.Read, Mail.Send and Calendars.ReadWrite are deliberately absent: those
 * call sites live in the workflow orchestrator's integration handler, not in a
 * Teams tool. They are requested at OAuth time, but they are not part of what
 * this MCP offers. No Teams tool writes a calendar — the meeting tools only
 * read /me/calendarView — so this list declares Calendars.Read.
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

describe("microsoft_teams conditional account", () => {
	it("registers the Teams MCP", () => {
		expect(teamsMcp).toBeDefined();
	});

	it.each(TEAMS_TOOL_SCOPES)("declares $scope for $tool", ({ scope }) => {
		expect(teamsMcp?.requiredScopes).toContain(scope);
	});

	it("does not claim calendar write, which no Teams tool performs", () => {
		// The OAuth flow requests ReadWrite for the workflow orchestrator's
		// create-event action. Declaring it here would tell a reader the Teams
		// surface writes calendars when it only reads them.
		expect(teamsMcp?.requiredScopes).not.toContain("Calendars.ReadWrite");
	});

	it("declares no scope the OAuth flow does not request", () => {
		// Kept in step by hand — see the note above on why these two lists
		// cannot import each other.
		const requestedAtOauth = new Set([
			"User.Read",
			"User.ReadBasic.All",
			"Files.Read.All",
			"Sites.Read.All",
			"offline_access",
			"Team.ReadBasic.All",
			"Channel.ReadBasic.All",
			"Chat.Read",
			"ChatMessage.Read",
			"ChannelMessage.Read.All",
			"ChannelMessage.Send",
			"ChatMessage.Send",
			"Mail.Read",
			"Mail.Send",
			"OnlineMeetings.Read",
			"Calendars.Read",
			"Calendars.ReadWrite",
			"OnlineMeetingTranscript.Read.All",
		]);

		const undeclared = (teamsMcp?.requiredScopes ?? []).filter(
			(scope) => !requestedAtOauth.has(scope),
		);

		expect(undeclared).toEqual([]);
	});
});
