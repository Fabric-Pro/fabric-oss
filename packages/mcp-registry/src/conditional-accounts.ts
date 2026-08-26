/**
 * Conditionally-Enabled MCP Definitions
 *
 * MCPs that require authentication (OAuth) to be available.
 * Unlike always-enabled MCPs, these are only available when the user has connected the service.
 */

import type { AccountDefinition } from "./types";
import {
	GITHUB_WORKFLOW_GUIDANCE,
	GITLAB_WORKFLOW_GUIDANCE,
	MICROSOFT_TEAMS_WORKFLOW_GUIDANCE,
} from "./workflow-guidance";

/**
 * GitHub Account - Available when user has connected GitHub OAuth
 */
export const GITHUB_ACCOUNT: AccountDefinition = {
	id: "github",
	name: "GitHub",
	version: "1.1.0", // Added search_commits, get_commit, get_authenticated_user
	credentialType: "github_oauth",
	authType: "oauth",
	icon: "github",
	alwaysEnabled: false, // Requires OAuth connection
	mcps: [
		{
			id: "github-repos",
			name: "GitHub",
			serverName: "GitHub",
			description:
				"Create pull requests, issues, and manage repositories",
			icon: "git-branch",
			available: true,
			workflowGuidance: GITHUB_WORKFLOW_GUIDANCE,
			tools: [
				{
					name: "list_repositories",
					description: "List repositories for the authenticated user",
					inputSchema: {
						type: "object",
						properties: {
							type: {
								type: "string",
								enum: ["all", "owner", "member"],
								default: "all",
							},
							sort: {
								type: "string",
								enum: [
									"created",
									"updated",
									"pushed",
									"full_name",
								],
								default: "updated",
							},
							per_page: {
								type: "number",
								description: "Results per page (max 100)",
								default: 30,
							},
						},
					},
				},
				{
					name: "get_repository",
					description: "Get repository details",
					inputSchema: {
						type: "object",
						properties: {
							owner: {
								type: "string",
								description: "Repository owner",
							},
							repo: {
								type: "string",
								description: "Repository name",
							},
						},
						required: ["owner", "repo"],
					},
				},
				{
					name: "list_issues",
					description: "List issues for a repository",
					inputSchema: {
						type: "object",
						properties: {
							owner: {
								type: "string",
								description: "Repository owner",
							},
							repo: {
								type: "string",
								description: "Repository name",
							},
							state: {
								type: "string",
								enum: ["open", "closed", "all"],
								default: "open",
							},
							per_page: {
								type: "number",
								description: "Results per page (max 100)",
								default: 30,
							},
						},
						required: ["owner", "repo"],
					},
				},
				{
					name: "get_issue",
					description: "Get a specific issue by number",
					inputSchema: {
						type: "object",
						properties: {
							owner: {
								type: "string",
								description: "Repository owner",
							},
							repo: {
								type: "string",
								description: "Repository name",
							},
							issue_number: {
								type: "number",
								description: "Issue number",
							},
						},
						required: ["owner", "repo", "issue_number"],
					},
				},
				{
					name: "get_pull_request",
					description: "Get a specific pull request by number",
					inputSchema: {
						type: "object",
						properties: {
							owner: {
								type: "string",
								description: "Repository owner",
							},
							repo: {
								type: "string",
								description: "Repository name",
							},
							pull_number: {
								type: "number",
								description: "Pull request number",
							},
						},
						required: ["owner", "repo", "pull_number"],
					},
				},
				{
					name: "list_pull_requests",
					description: "List pull requests for a repository",
					inputSchema: {
						type: "object",
						properties: {
							owner: {
								type: "string",
								description: "Repository owner",
							},
							repo: {
								type: "string",
								description: "Repository name",
							},
							state: {
								type: "string",
								enum: ["open", "closed", "all"],
								default: "open",
							},
							head: {
								type: "string",
								description: "Filter by head branch",
							},
							base: {
								type: "string",
								description: "Filter by base branch",
							},
							per_page: {
								type: "number",
								description: "Results per page (max 100)",
								default: 30,
							},
						},
						required: ["owner", "repo"],
					},
				},
				{
					name: "create_pull_request",
					description: "Create a new pull request",
					inputSchema: {
						type: "object",
						properties: {
							owner: {
								type: "string",
								description: "Repository owner",
							},
							repo: {
								type: "string",
								description: "Repository name",
							},
							title: { type: "string", description: "PR title" },
							head: {
								type: "string",
								description: "Branch containing changes",
							},
							base: {
								type: "string",
								description:
									"Branch to merge into (usually main)",
							},
							body: {
								type: "string",
								description: "PR description",
							},
							draft: {
								type: "boolean",
								description: "Create as draft PR",
								default: false,
							},
						},
						required: ["owner", "repo", "title", "head", "base"],
					},
					approvalRequiredFields: ["title", "head", "base"],
				},
				{
					name: "create_issue",
					description: "Create a new issue",
					inputSchema: {
						type: "object",
						properties: {
							owner: {
								type: "string",
								description: "Repository owner",
							},
							repo: {
								type: "string",
								description: "Repository name",
							},
							title: {
								type: "string",
								description: "Issue title",
							},
							body: {
								type: "string",
								description: "Issue description",
							},
							labels: {
								type: "array",
								items: { type: "string" },
								description: "Labels to add",
							},
							assignees: {
								type: "array",
								items: { type: "string" },
								description: "Users to assign",
							},
						},
						required: ["owner", "repo", "title"],
					},
					approvalRequiredFields: ["title"],
				},
				{
					name: "get_file_contents",
					description: "Get contents of a file from a repository",
					inputSchema: {
						type: "object",
						properties: {
							owner: {
								type: "string",
								description: "Repository owner",
							},
							repo: {
								type: "string",
								description: "Repository name",
							},
							path: { type: "string", description: "File path" },
							ref: {
								type: "string",
								description:
									"Branch/tag/commit (default: main)",
							},
						},
						required: ["owner", "repo", "path"],
					},
				},
				{
					name: "list_branches",
					description: "List branches for a repository",
					inputSchema: {
						type: "object",
						properties: {
							owner: {
								type: "string",
								description: "Repository owner",
							},
							repo: {
								type: "string",
								description: "Repository name",
							},
							per_page: {
								type: "number",
								description: "Results per page (max 100)",
								default: 30,
							},
						},
						required: ["owner", "repo"],
					},
				},
				{
					name: "get_authenticated_user",
					description:
						"Get the authenticated GitHub user's profile. Use this first to discover the current user's login name (used as 'owner' for their personal repositories).",
					inputSchema: {
						type: "object",
						properties: {},
					},
				},
				{
					name: "search_commits",
					description:
						"Search GitHub commits by SHA or keyword. Use this when you have a commit hash but don't know which repository it belongs to — the result includes 'owner' and 'repo' fields you can use in other tools.",
					inputSchema: {
						type: "object",
						properties: {
							sha: {
								type: "string",
								description:
									"Commit SHA to search for (full or partial hash)",
							},
							query: {
								type: "string",
								description:
									"Search query string (alternative to sha)",
							},
						},
					},
				},
				{
					name: "get_commit",
					description:
						"Get details of a specific commit including the top 10 most-changed files with short diff excerpts. Returns filename, status, additions/deletions, and a patch snippet for each file.",
					inputSchema: {
						type: "object",
						properties: {
							owner: {
								type: "string",
								description: "Repository owner",
							},
							repo: {
								type: "string",
								description: "Repository name",
							},
							ref: {
								type: "string",
								description: "Commit SHA, branch name, or tag",
							},
						},
						required: ["owner", "repo", "ref"],
					},
				},
			],
		},
	],
};

/**
 * GitLab Account - Available when user has connected GitLab OAuth
 */
export const GITLAB_ACCOUNT: AccountDefinition = {
	id: "gitlab",
	name: "GitLab (Official)",
	version: "2.0.0",
	credentialType: "gitlab_oauth",
	authType: "oauth",
	icon: "gitlab",
	alwaysEnabled: false,
	mcps: [
		{
			id: "gitlab-official",
			name: "GitLab (Official)",
			serverName: "GitLab",
			description:
				"GitLab's official MCP server (Premium/Ultimate). Tools are advertised dynamically via the MCP protocol.",
			icon: "git-branch",
			available: true,
			workflowGuidance: GITLAB_WORKFLOW_GUIDANCE,
			// Tools are discovered at runtime via tools/list against the
			// official MCP server. No static catalog here — the registry
			// would otherwise lock our assumptions about an externally-
			// owned surface.
			tools: [],
		},
	],
};

/**
 * Microsoft Teams Account - Available when user has connected Microsoft Graph OAuth
 */
export const MICROSOFT_TEAMS_ACCOUNT: AccountDefinition = {
	id: "microsoft_teams",
	name: "Microsoft Teams",
	version: "2.0.0", // Bump this when adding/changing tools
	credentialType: "microsoft_graph_oauth",
	authType: "oauth",
	icon: "message-square",
	alwaysEnabled: false, // Requires OAuth connection
	baseScopes: ["openid", "email", "profile", "offline_access"],
	mcps: [
		{
			id: "microsoft-teams",
			name: "Microsoft Teams",
			serverName: "Microsoft_Teams",
			description:
				"Search and access Microsoft Teams messages, channels, shared files, and meeting transcripts",
			icon: "message-square",
			available: true,
			workflowGuidance: MICROSOFT_TEAMS_WORKFLOW_GUIDANCE,
			// Keep in step with oauthProviders.MICROSOFT_GRAPH.scopes in
			// @repo/api — that array is what actually lands in a token, this one
			// only describes the surface. The two packages cannot import each
			// other, so a guard test on each side holds them together.
			requiredScopes: [
				"User.Read",
				"User.ReadBasic.All",
				"Team.ReadBasic.All",
				"Channel.ReadBasic.All",
				"Chat.Read",
				"ChatMessage.Read",
				"ChannelMessage.Read.All",
				"ChannelMessage.Send",
				"ChatMessage.Send",
				"Files.Read.All",
				"OnlineMeetings.Read",
				// Read, not ReadWrite: no Teams tool writes a calendar. The OAuth
				// flow also requests ReadWrite, for the workflow orchestrator's
				// create-event action.
				"Calendars.Read",
				"OnlineMeetingTranscript.Read.All",
			],
			urlPatterns: [
				{
					pattern: "https://teams.microsoft.com/*",
					description: "Microsoft Teams web interface",
				},
			],
			tools: [
				{
					name: "list_teams",
					description: "List all Teams the user has joined",
					inputSchema: {
						type: "object",
						properties: {},
					},
				},
				{
					name: "list_channels",
					description:
						"List channels in a specific team. Requires a teamId from list_teams first.",
					inputSchema: {
						type: "object",
						properties: {
							teamId: {
								type: "string",
								description:
									"Team ID (required - get this from list_teams first)",
							},
						},
						required: ["teamId"],
					},
				},
				{
					name: "search_messages",
					description:
						"Search for messages across all Teams channels and chats. ALWAYS provide a query - use 'from:PersonName' to find messages from a specific person, or keywords to search content. This is the best tool when you don't know the chat or channel ID.",
					inputSchema: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description:
									"REQUIRED: Search query. Use 'from:Alex' to find messages from Alex, 'from:John about project' for combined filters, or just keywords to search content. Never leave empty.",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of results (default: 25)",
								default: 25,
							},
						},
						required: ["query"],
					},
				},
				{
					name: "list_messages",
					description:
						"List messages in a Teams channel. Requires teamId and channelId. First call list_teams to get teamId, then list_channels to get channelId. Use the 'since' parameter to filter messages by date (e.g. for 'last 2 weeks' summaries). For searching messages by content or person, use search_messages instead.",
					inputSchema: {
						type: "object",
						properties: {
							teamId: {
								type: "string",
								description:
									"Team ID (required - get from list_teams)",
							},
							channelId: {
								type: "string",
								description:
									"Channel ID (required - get from list_channels)",
							},
							since: {
								type: "string",
								description:
									"ISO 8601 date to filter messages from (e.g. '2026-01-28T00:00:00Z' for last 2 weeks). Only messages created on or after this date are returned.",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of messages (default: 50)",
								default: 50,
							},
						},
						required: ["teamId", "channelId"],
					},
				},
				{
					name: "list_message_replies",
					description:
						"Get replies to a specific channel message (thread). Channel conversations in Teams are threaded - use this to read the full discussion under a root message. Requires teamId, channelId, and messageId from list_messages.",
					inputSchema: {
						type: "object",
						properties: {
							teamId: {
								type: "string",
								description:
									"Team ID (required - get from list_teams)",
							},
							channelId: {
								type: "string",
								description:
									"Channel ID (required - get from list_channels)",
							},
							messageId: {
								type: "string",
								description:
									"Message ID of the root/parent message (required - get from list_messages)",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of replies to return (default: 25, max: 50)",
								default: 25,
							},
						},
						required: ["teamId", "channelId", "messageId"],
					},
				},
				{
					name: "get_shared_files",
					description: "Get files shared in a Teams channel",
					inputSchema: {
						type: "object",
						properties: {
							teamId: {
								type: "string",
								description: "Team ID",
							},
							channelId: {
								type: "string",
								description: "Channel ID",
							},
						},
						required: ["teamId", "channelId"],
					},
				},
				{
					name: "list_users",
					description:
						"Search for users by name. IMPORTANT: Always provide nameFilter to search for specific users - without it returns first 25 users alphabetically which is rarely useful. Note: Requires admin consent and may return permission error; if so, use search_messages with 'from:PersonName' instead.",
					inputSchema: {
						type: "object",
						properties: {
							nameFilter: {
								type: "string",
								description:
									"Filter users by name (searches displayName and email). Example: 'Alex' to find users named Alex.",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of users to return (default: 25, max: 25)",
								default: 25,
							},
						},
						required: ["nameFilter"],
					},
				},
				{
					name: "list_chats",
					description:
						"List recent chats ordered by last activity. Returns chat ID, members, and last message preview. IMPORTANT: For finding messages from a specific person, use search_messages with 'from:PersonName' instead - it's much faster and more accurate.",
					inputSchema: {
						type: "object",
						properties: {
							chatType: {
								type: "string",
								enum: ["oneOnOne", "group", "meeting"],
								description:
									"Filter by chat type: 'oneOnOne' for direct messages, 'group' for group chats, 'meeting' for meeting chats",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of chats (default: 15, max: 50). Keep low for faster responses.",
								default: 15,
							},
						},
					},
				},
				{
					name: "get_chat_messages",
					description:
						"Get messages from a direct or group chat. Requires a chatId from list_chats. If you don't know the chat ID, use search_messages instead.",
					inputSchema: {
						type: "object",
						properties: {
							chatId: {
								type: "string",
								description:
									"Chat ID (required - get this from list_chats first)",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of messages (default: 50, max: 50)",
								default: 50,
							},
						},
						required: ["chatId"],
					},
				},
				{
					name: "get_full_message",
					description:
						"Get the full, untruncated content of a specific message. Use this when you need the complete text of a message that was truncated in search results or message listings. Requires the message ID from a previous search_messages, list_messages, or get_chat_messages call.",
					inputSchema: {
						type: "object",
						properties: {
							messageId: {
								type: "string",
								description:
									"The message ID to retrieve (required - get this from search_messages, list_messages, or get_chat_messages)",
							},
							chatId: {
								type: "string",
								description:
									"The chat ID containing the message (required for chat messages - get from list_chats)",
							},
							teamId: {
								type: "string",
								description:
									"The team ID (required for channel messages - get from list_teams)",
							},
							channelId: {
								type: "string",
								description:
									"The channel ID (required for channel messages - get from list_channels)",
							},
						},
						required: ["messageId"],
					},
				},
				// ========== Meeting & Transcript Tools ==========
				{
					name: "list_calendar_meetings",
					description:
						"List recent online meetings from the user's calendar. Returns meetings with their subjects, times, organizers, and Teams join URLs. Use this as the starting point for finding meetings to get transcripts from. Only returns meetings that have Teams links (online meetings).",
					inputSchema: {
						type: "object",
						properties: {
							startDate: {
								type: "string",
								description:
									"ISO 8601 start date for the range (default: 30 days ago). Example: '2026-01-01T00:00:00Z'",
							},
							endDate: {
								type: "string",
								description:
									"ISO 8601 end date for the range (default: now). Example: '2026-02-01T00:00:00Z'",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of meetings to return (default: 25, max: 50)",
								default: 25,
							},
						},
					},
				},
				{
					name: "get_meeting_by_join_url",
					description:
						"Resolve a Teams meeting join URL to an online meeting ID. This is required to access transcripts - calendar events have join URLs but transcript APIs need meeting IDs. Get the join URL from list_calendar_meetings first.",
					inputSchema: {
						type: "object",
						properties: {
							joinWebUrl: {
								type: "string",
								description:
									"The Teams meeting join URL (required - get from list_calendar_meetings onlineMeeting.joinUrl)",
							},
						},
						required: ["joinWebUrl"],
					},
				},
				{
					name: "list_meeting_transcripts",
					description:
						"List available transcripts for a specific online meeting. Returns transcript metadata including creation time and organizer. Requires a meetingId from get_meeting_by_join_url. Note: Graph only returns transcripts for meetings the user organized that have a backing calendar event; a meeting someone else organized is not reachable, and no permission change makes it reachable.",
					inputSchema: {
						type: "object",
						properties: {
							meetingId: {
								type: "string",
								description:
									"The online meeting ID (required - get from get_meeting_by_join_url)",
							},
						},
						required: ["meetingId"],
					},
				},
				{
					name: "get_meeting_transcript_content",
					description:
						"Get the actual transcript content for a meeting. Returns structured transcript with speaker names, timestamps, and spoken text. Requires meetingId and transcriptId from list_meeting_transcripts. Note: only reachable for meetings the user organized that have a backing calendar event; a 403 here means the meeting is out of reach, not that a permission is missing.",
					inputSchema: {
						type: "object",
						properties: {
							meetingId: {
								type: "string",
								description:
									"The online meeting ID (required - get from get_meeting_by_join_url)",
							},
							transcriptId: {
								type: "string",
								description:
									"The transcript ID (required - get from list_meeting_transcripts)",
							},
							format: {
								type: "string",
								enum: ["structured", "vtt"],
								description:
									"Output format: 'structured' (default) returns JSON with speaker names and timestamps, 'vtt' returns raw WebVTT text",
								default: "structured",
							},
						},
						required: ["meetingId", "transcriptId"],
					},
				},
				// get_all_my_transcripts stays disabled, but not for want of
				// consent — OnlineMeetingTranscript.Read.All *is* granted. The
				// endpoint only returns meetings the caller organized that have a
				// backing calendar event, so it cannot serve as a general "all my
				// transcripts" listing. Use the per-meeting tools instead.
				// {
				// 	name: "get_all_my_transcripts",
				// 	description: "Get all transcripts for meetings the user organized...",
				// 	inputSchema: { ... },
				// },
			],
		},
	],
};

/**
 * All conditionally-enabled accounts (require OAuth)
 */
export const CONDITIONAL_ACCOUNTS: AccountDefinition[] = [
	GITHUB_ACCOUNT,
	GITLAB_ACCOUNT,
	MICROSOFT_TEAMS_ACCOUNT,
];

/**
 * Get a conditionally-enabled account by ID
 */
export function getConditionalAccount(
	accountId: string,
): AccountDefinition | undefined {
	return CONDITIONAL_ACCOUNTS.find((a) => a.id === accountId);
}
