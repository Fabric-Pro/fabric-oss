/**
 * Slack Integration Utilities
 *
 * Shared execution functions for Slack API integrations.
 * These functions handle the actual API calls using credentials from WorkflowIntegration.
 *
 * Used by both:
 * - API layer (for listing available channels during project setup)
 * - Temporal activities (for fetching context during workflows)
 *
 * Features:
 * - No token refresh needed (Slack bot tokens don't expire)
 * - Slack mrkdwn stripping for clean LLM context
 * - User ID to display name resolution with caching
 */

export { addSlackReaction } from "./add-reaction";
// Export reaction support
export {
	isPermanentSlackError,
	PERMANENT_SLACK_ERRORS,
	SlackConfigurationError,
} from "./api.errors";
// Export credentials helper
export { default as getSlackCredentials } from "./credentials";
// Export authenticated file download (chat-thread image attachments feature)
export {
	type DownloadSlackFileOptions,
	type DownloadSlackFileResult,
	downloadSlackFile,
} from "./download-file";
export {
	AuthFailedError,
	DownloadFailedError,
	ExternalWorkspaceError,
	ScopeMissingError,
} from "./download-file.errors";
// Export pure huddle-canvas parsing/dedup helpers (quip HTML → markdown,
// mention extraction/replacement, content hashing).
export {
	computeHuddleContentHash,
	extractMentionUserIds,
	quipHtmlToMarkdown,
	replaceMentions,
	SLACK_CANVAS_FILETYPE,
	SLACK_DOCS_MIMETYPE,
} from "./huddle-canvas";
// Export message sending
export { sendSlackMessage } from "./send-message";
// Export specific verification utilities for Events API
export {
	cleanMentionText,
	getSlackRetryInfo,
	normalizeThreadId,
	shouldProcessEvent,
	verifySlackSignature,
} from "./verification";

import { db } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { isPermanentSlackError, SlackConfigurationError } from "./api.errors";

/**
 * Truncate message content to avoid bloating LLM context.
 * Slack messages can contain large blocks, attachments, etc.
 * Default 500 chars - keeps context lean.
 */
export function truncateContent(
	content: string | undefined,
	maxLength = 500,
): string {
	if (!content) {
		return "";
	}
	// Strip Slack mrkdwn formatting for cleaner output
	const stripped = stripSlackMrkdwn(content).trim();
	if (stripped.length <= maxLength) {
		return stripped;
	}
	return `${stripped.substring(0, maxLength)}... [truncated]`;
}

/**
 * Strip Slack mrkdwn formatting for cleaner LLM context.
 * Converts bold, italic, strike, code, and user mentions to plain text.
 */
function stripSlackMrkdwn(text: string): string {
	return (
		text
			// Bold: *text* → text
			.replace(/\*([^*]+)\*/g, "$1")
			// Italic: _text_ → text
			.replace(/\b_([^_]+)_\b/g, "$1")
			// Strike: ~text~ → text
			.replace(/~([^~]+)~/g, "$1")
			// Code block: ```text``` → text
			.replace(/```[\s\S]*?```/g, (match) =>
				match.replace(/```/g, "").trim(),
			)
			// Inline code: `text` → text
			.replace(/`([^`]+)`/g, "$1")
			// User mentions: <@U12345> → @user
			.replace(/<@([A-Z0-9]+)>/g, "@user")
			// Channel links: <#C12345|channel-name> → #channel-name
			.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
			// URLs: <url|label> → label, <url> → url
			.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
			.replace(/<(https?:\/\/[^>]+)>/g, "$1")
			// Collapse whitespace
			.replace(/\s+/g, " ")
			.trim()
	);
}

// User display name cache (per-token, avoids repeated API calls)
const userNameCache = new Map<string, Map<string, string>>();

/**
 * Resolve a Slack user ID to a display name.
 * Uses an in-memory cache to avoid repeated API calls within the same session.
 *
 * Exported so other Slack-integration consumers (e.g. the huddle-notes ingest
 * activity) reuse this cached `users.info` resolver rather than re-implementing
 * it.
 */
export async function resolveUserName(
	userId: string,
	accessToken: string,
): Promise<string> {
	// Check cache
	let tokenCache = userNameCache.get(accessToken);
	if (!tokenCache) {
		tokenCache = new Map();
		userNameCache.set(accessToken, tokenCache);
	}
	const cached = tokenCache.get(userId);
	if (cached) {
		return cached;
	}

	try {
		const response = await fetch(
			`https://slack.com/api/users.info?user=${userId}`,
			{
				headers: { Authorization: `Bearer ${accessToken}` },
			},
		);

		if (response.ok) {
			const data = (await response.json()) as {
				ok: boolean;
				user?: {
					profile?: {
						display_name?: string;
						real_name?: string;
					};
					real_name?: string;
				};
			};

			if (data.ok && data.user) {
				const name =
					data.user.profile?.display_name ||
					data.user.profile?.real_name ||
					data.user.real_name ||
					userId;
				tokenCache.set(userId, name);
				return name;
			}
		}
	} catch {
		// Non-fatal - return user ID
	}

	tokenCache.set(userId, userId);
	return userId;
}

/**
 * Resolve a batch of Slack user ids to display names (deduped, cached). Returns
 * an id→name map suitable for `replaceMentions` from `huddle-canvas.ts`.
 */
export async function resolveUserNames(
	userIds: string[],
	accessToken: string,
): Promise<Map<string, string>> {
	const unique = [...new Set(userIds)];
	const entries = await Promise.all(
		unique.map(
			async (id): Promise<[string, string]> => [
				id,
				await resolveUserName(id, accessToken),
			],
		),
	);
	return new Map(entries);
}

/**
 * Get Slack credentials from WorkflowIntegration using XOR tenant isolation.
 *
 * Supports two credential formats:
 * 1. OAuth flow: encrypted JSON with { access_token, token_type, scope, ... }
 * 2. Direct bot token: encrypted JSON with { access_token: "xoxb-..." }
 *
 * Excludes _OAUTH_APP config records (those store client_id/secret, not bot tokens).
 */
async function getSlackCredentials(
	userId: string,
	organizationId?: string,
): Promise<{
	accessToken: string;
	userAccessToken?: string;
	integrationId: string;
}> {
	const integration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId,
					provider: "SLACK",
					isActive: true,
					NOT: { name: "SLACK_OAUTH_APP" },
				},
			})
		: await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId: null,
					provider: "SLACK",
					isActive: true,
					NOT: { name: "SLACK_OAUTH_APP" },
				},
			});

	if (!integration) {
		throw new Error(
			"Slack not connected. Please connect your Slack workspace in Settings > Integrations.",
		);
	}

	if (!integration.credentials) {
		throw new Error(
			"Slack credentials missing. Please reconnect your Slack workspace in Settings > Integrations.",
		);
	}

	// Credentials are stored as an encrypted JSON string
	let credentialsJson: string;
	try {
		credentialsJson = decryptApiKey(integration.credentials);
	} catch {
		// Might not be encrypted (legacy) — use raw value
		credentialsJson = integration.credentials;
	}

	let parsed: Record<string, string>;
	try {
		parsed = JSON.parse(credentialsJson) as Record<string, string>;
	} catch {
		throw new Error(
			"Slack credentials are corrupted. Please reconnect your Slack workspace in Settings > Integrations.",
		);
	}

	// Support both OAuth format (access_token) and direct token format (apiKey)
	const accessToken = parsed.access_token || parsed.apiKey;
	if (!accessToken) {
		throw new Error(
			"Slack access token missing. Please reconnect your Slack workspace in Settings > Integrations.",
		);
	}

	return {
		accessToken,
		userAccessToken: parsed.user_access_token || undefined,
		integrationId: integration.id,
	};
}

/**
 * Call the Slack API with proper error handling.
 */
async function callSlackApi(
	method: string,
	accessToken: string,
	params?: Record<string, unknown>,
): Promise<unknown> {
	const url = `https://slack.com/api/${method}`;

	// Slack read methods (search.messages, conversations.replies) silently
	// ignore JSON bodies and respond "missing required field" — they only
	// honor form-urlencoded. Form encoding works for every Slack method, so
	// use it universally rather than per-method dispatch.
	const body = params
		? new URLSearchParams(
				Object.entries(params).reduce<Record<string, string>>(
					(acc, [k, v]) => {
						if (v !== undefined && v !== null) {
							acc[k] = String(v);
						}
						return acc;
					},
					{},
				),
			).toString()
		: undefined;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
		},
		body,
	});

	if (!response.ok) {
		throw new Error(`Slack API ${method} failed: ${response.status}`);
	}

	const data = (await response.json()) as {
		ok: boolean;
		error?: string;
		response_metadata?: { messages?: string[] };
		[key: string]: unknown;
	};

	if (!data.ok) {
		const details = data.response_metadata?.messages?.join("; ");
		const paramKeys = params ? Object.keys(params).join(",") : "";
		const message = `Slack API ${method} error: ${data.error || "unknown"}${
			details ? ` — ${details}` : ""
		}${paramKeys ? ` (params: ${paramKeys})` : ""}`;

		// Slack reports configuration problems with HTTP 200 and ok:false, so
		// they are indistinguishable from transient faults unless classified
		// here. Callers retry the rest; these they must not.
		if (isPermanentSlackError(data.error)) {
			throw new SlackConfigurationError(data.error as string, message);
		}

		throw new Error(message);
	}

	return data;
}

// =============================================================================
// Message formatting helpers
// =============================================================================

interface SlackMessage {
	ts: string;
	text?: string;
	user?: string;
	bot_id?: string;
	type?: string;
	subtype?: string;
	thread_ts?: string;
	reply_count?: number;
}

interface FormattedMessage {
	id: string;
	content: string;
	from: string;
	createdAt: string;
	channelId?: string;
	channelName?: string;
	/** Parent thread timestamp when this message is in (or starts) a thread. */
	threadTs?: string;
	/** Number of replies in the thread (when present, this message is a thread parent). */
	replyCount?: number;
	/** Direct link to the message in Slack (returned by search.messages only). */
	permalink?: string;
}

async function formatMessages(
	messages: SlackMessage[],
	accessToken: string,
	channelId?: string,
	channelName?: string,
): Promise<FormattedMessage[]> {
	const formatted: FormattedMessage[] = [];

	for (const msg of messages) {
		if (
			!msg.text ||
			msg.subtype === "channel_join" ||
			msg.subtype === "channel_leave"
		) {
			continue;
		}

		const from = msg.user
			? await resolveUserName(msg.user, accessToken)
			: msg.bot_id
				? "Bot"
				: "Unknown";

		formatted.push({
			id: msg.ts,
			content: truncateContent(msg.text),
			from,
			createdAt: new Date(Number.parseFloat(msg.ts) * 1000).toISOString(),
			channelId,
			channelName,
			// Surface threadTs for both replies (msg.thread_ts points at parent)
			// and parents-with-replies (Slack sets thread_ts === ts on the parent,
			// but some response shapes only set reply_count — synthesize from ts
			// in that case so callers can always fetch the thread).
			threadTs:
				msg.thread_ts ||
				(typeof msg.reply_count === "number" && msg.reply_count > 0
					? msg.ts
					: undefined),
			replyCount: msg.reply_count,
		});
	}

	return formatted;
}

// =============================================================================
// Tool Methods
// =============================================================================

/**
 * Execute a Slack tool method.
 *
 * Supported methods:
 * - list_channels: List workspace channels
 * - get_channel_messages: Get recent messages from a channel
 * - search_messages: Search messages across workspace
 * - get_thread_replies: Fetch replies in a message thread
 * - get_shared_files: List files shared in a channel
 * - get_channel_info: Get channel details
 * - list_users: List workspace members
 */
export async function executeSlackTool(
	methodName: string,
	args: Record<string, unknown>,
	userId: string,
	organizationId?: string,
): Promise<unknown> {
	const { accessToken, userAccessToken } = await getSlackCredentials(
		userId,
		organizationId,
	);

	switch (methodName) {
		case "list_channels":
			return listChannels(accessToken, args);
		case "get_channel_messages":
			return getChannelMessages(accessToken, args);
		case "search_messages":
			return searchMessages(userAccessToken || accessToken, args);
		case "get_thread_replies":
			return getThreadReplies(accessToken, args);
		case "get_shared_files":
			return getSharedFiles(accessToken, args);
		case "list_huddle_canvases":
			return listHuddleCanvases(accessToken, args);
		case "get_file_info":
			return getFileInfo(accessToken, args);
		case "get_channel_info":
			return getChannelInfo(accessToken, args);
		case "list_users":
			return listUsers(accessToken, args);
		default:
			throw new Error(`Unknown Slack tool method: ${methodName}`);
	}
}

/**
 * List workspace channels (public + private the bot is in).
 */
async function listChannels(
	accessToken: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const limit = Math.min((args.limit as number) || 100, 200);
	const cursor = args.cursor as string | undefined;
	const types = (args.types as string) || "public_channel,private_channel";

	const data = (await callSlackApi("conversations.list", accessToken, {
		types,
		limit,
		cursor: cursor || undefined,
		exclude_archived: true,
	})) as {
		channels: Array<{
			id: string;
			name: string;
			is_private: boolean;
			is_archived: boolean;
			is_member: boolean;
			num_members: number;
			topic?: { value?: string };
			purpose?: { value?: string };
		}>;
		response_metadata?: { next_cursor?: string };
	};

	return {
		channels: (data.channels || []).map((ch) => ({
			id: ch.id,
			name: ch.name,
			isPrivate: ch.is_private,
			isBotMember: ch.is_member,
			memberCount: ch.num_members,
			topic: ch.topic?.value || "",
			purpose: ch.purpose?.value || "",
		})),
		count: data.channels?.length || 0,
		nextCursor: data.response_metadata?.next_cursor || null,
	};
}

/**
 * Get recent messages from a specific channel.
 */
async function getChannelMessages(
	accessToken: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const channelId = args.channelId as string;
	if (!channelId) {
		throw new Error("channelId is required for get_channel_messages");
	}

	const limit = Math.min((args.limit as number) || 20, 100);

	const data = (await callSlackApi("conversations.history", accessToken, {
		channel: channelId,
		limit,
	})) as {
		messages: SlackMessage[];
		has_more: boolean;
	};

	const channelName = (args.channelName as string) || channelId;
	const messages = await formatMessages(
		data.messages || [],
		accessToken,
		channelId,
		channelName,
	);

	return {
		messages,
		count: messages.length,
		hasMore: data.has_more || false,
	};
}

/**
 * Search messages across the workspace.
 * Requires a user token (xoxp-) with search:read scope.
 * The caller passes userAccessToken when available, falling back to the bot token
 * (which works on Enterprise Grid but not standard workspaces).
 */
async function searchMessages(
	accessToken: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const query = args.query as string;
	if (!query) {
		throw new Error("query is required for search_messages");
	}

	const limit = Math.min((args.limit as number) || 20, 100);

	try {
		const data = (await callSlackApi("search.messages", accessToken, {
			query,
			count: limit,
			sort: "timestamp",
			sort_dir: "desc",
		})) as {
			messages?: {
				matches?: Array<{
					iid: string;
					ts: string;
					text: string;
					user: string;
					channel?: { id: string; name: string };
					permalink?: string;
					thread_ts?: string;
					reply_count?: number;
				}>;
				total?: number;
			};
		};

		const matches = data.messages?.matches || [];
		const messages: FormattedMessage[] = [];

		for (const match of matches) {
			const from = match.user
				? await resolveUserName(match.user, accessToken)
				: "Unknown";

			messages.push({
				id: match.ts,
				content: truncateContent(match.text),
				from,
				createdAt: new Date(
					Number.parseFloat(match.ts) * 1000,
				).toISOString(),
				channelId: match.channel?.id,
				channelName: match.channel?.name,
				// Mirror the channel-message path: prefer match.thread_ts, but
				// fall back to match.ts when reply_count > 0 — Slack search hits
				// can flag a thread parent via reply_count alone.
				threadTs:
					match.thread_ts ||
					(typeof match.reply_count === "number" &&
					match.reply_count > 0
						? match.ts
						: undefined),
				replyCount: match.reply_count,
				permalink: match.permalink,
			});
		}

		return {
			messages,
			count: messages.length,
			totalHits: data.messages?.total || 0,
		};
	} catch (error) {
		// search.messages may fail if token doesn't have search:read scope
		// Return empty results with error info
		const errorMessage =
			error instanceof Error ? error.message : String(error);

		if (
			errorMessage.includes("missing_scope") ||
			errorMessage.includes("not_allowed_token_type")
		) {
			return {
				messages: [],
				count: 0,
				totalHits: 0,
				error: "Search not available. The Slack integration may need to be reconnected with updated permissions.",
			};
		}
		throw error;
	}
}

/**
 * Get replies in a message thread.
 *
 * Calls Slack's `conversations.replies` API. The first message returned by
 * Slack is the thread parent — we filter it out so callers see only replies.
 */
async function getThreadReplies(
	accessToken: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const channelId = (args.channelId as string) || (args.channel as string);
	const threadTs = (args.threadTs as string) || (args.thread_ts as string);

	if (!channelId) {
		throw new Error("channelId is required for get_thread_replies");
	}
	if (!threadTs) {
		throw new Error("threadTs is required for get_thread_replies");
	}

	const limit = Math.min((args.limit as number) || 50, 200);

	const data = (await callSlackApi("conversations.replies", accessToken, {
		channel: channelId,
		ts: threadTs,
		limit,
	})) as {
		messages?: SlackMessage[];
		has_more?: boolean;
	};

	const channelName = (args.channelName as string) || channelId;
	// First message is the parent — drop it so the caller sees only replies.
	const replyOnly = (data.messages || []).filter((m) => m.ts !== threadTs);
	const messages = await formatMessages(
		replyOnly,
		accessToken,
		channelId,
		channelName,
	);

	return {
		messages,
		count: messages.length,
		hasMore: data.has_more || false,
		threadTs,
	};
}

/**
 * List files shared in a channel.
 *
 * Calls Slack's `files.list` scoped to a single channel. Returns file metadata
 * and Slack URLs; binary download is left to the caller (use `permalink` for
 * a clickable link or `urlPrivate` for an authenticated download).
 */
async function getSharedFiles(
	accessToken: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const channelId = (args.channelId as string) || (args.channel as string);
	if (!channelId) {
		throw new Error("channelId is required for get_shared_files");
	}

	const count = Math.min((args.limit as number) || 20, 100);
	const types = (args.types as string) || undefined;

	const data = (await callSlackApi("files.list", accessToken, {
		channel: channelId,
		count,
		...(types ? { types } : {}),
	})) as {
		files?: Array<{
			id: string;
			name?: string;
			title?: string;
			mimetype?: string;
			filetype?: string;
			size?: number;
			user?: string;
			created?: number;
			url_private?: string;
			permalink?: string;
			channels?: string[];
		}>;
		paging?: { total?: number };
	};

	const rawFiles = data.files || [];
	const uniqueUserIds = [
		...new Set(
			rawFiles.map((f) => f.user).filter((id): id is string => !!id),
		),
	];
	const userNames = new Map<string, string>(
		await Promise.all(
			uniqueUserIds.map(
				async (id): Promise<[string, string]> => [
					id,
					await resolveUserName(id, accessToken),
				],
			),
		),
	);

	const files = rawFiles.map((f) => ({
		id: f.id,
		name: f.name || f.title || f.id,
		title: f.title,
		mimetype: f.mimetype,
		filetype: f.filetype,
		size: f.size,
		createdBy: f.user ? userNames.get(f.user) : undefined,
		createdAt:
			typeof f.created === "number"
				? new Date(f.created * 1000).toISOString()
				: undefined,
		urlPrivate: f.url_private,
		permalink: f.permalink,
		channelId,
	}));

	return {
		files,
		count: files.length,
		total: data.paging?.total ?? files.length,
	};
}

// =============================================================================
// Huddle AI-notes canvas detection (Slack huddle ingestion)
// =============================================================================

/**
 * A Slack file as it pertains to huddle-canvas detection. Carries the huddle
 * markers that `getSharedFiles` drops. Fields are best-effort — whether
 * `files.list` or `files.info` surfaces them is validated live.
 */
export interface SlackHuddleCanvasFile {
	id: string;
	urlPrivate?: string;
	mimetype?: string;
	filetype?: string;
	created?: number;
	channelId: string;
	title?: string;
	isHuddleCanvas: boolean;
	huddleTranscriptFileId?: string;
	huddleSummaryId?: string;
	huddleDateStart?: number;
	huddleDateEnd?: number;
}

interface RawSlackFile {
	id: string;
	title?: string;
	name?: string;
	mimetype?: string;
	filetype?: string;
	created?: number;
	url_private?: string;
	is_huddle_canvas?: boolean;
	huddle_transcript_file_id?: string;
	huddle_summary_id?: string;
	huddle_date_start?: number;
	huddle_date_end?: number;
}

function mapHuddleFields(
	file: RawSlackFile,
	channelId: string,
): SlackHuddleCanvasFile {
	return {
		id: file.id,
		urlPrivate: file.url_private,
		mimetype: file.mimetype,
		filetype: file.filetype,
		created: file.created,
		channelId,
		title: file.title || file.name,
		isHuddleCanvas: file.is_huddle_canvas === true,
		huddleTranscriptFileId: file.huddle_transcript_file_id,
		huddleSummaryId: file.huddle_summary_id,
		huddleDateStart: file.huddle_date_start,
		huddleDateEnd: file.huddle_date_end,
	};
}

/**
 * List candidate huddle canvases in a channel via `files.list`, passing the
 * huddle markers through (unlike `getSharedFiles`, which drops them and is used
 * elsewhere). `ts_from` is the forward-only lower bound. The caller filters
 * `isHuddleCanvas === true` (and may fall back to `get_file_info` per candidate
 * when `files.list` returns a leaner object).
 *
 * Security: never logs the bot token or any `url_private`; returns structured
 * fields only.
 */
async function listHuddleCanvases(
	accessToken: string,
	args: Record<string, unknown>,
): Promise<{ files: SlackHuddleCanvasFile[]; count: number }> {
	const channelId = (args.channelId as string) || (args.channel as string);
	if (!channelId) {
		throw new Error("channelId is required for list_huddle_canvases");
	}

	const count = Math.min((args.limit as number) || 100, 200);
	const tsFrom = args.tsFrom as number | string | undefined;
	// Do NOT default the `types` filter. Slack's files.list `types` accepts
	// documented values (all/spaces/snippets/images/gdocs/zips/pdfs) — `quip` is
	// a *filetype*, not a `types` value, so filtering on it can return nothing and
	// defeat detection entirely. `ts_from` already bounds the set small; the
	// caller filters client-side on `isHuddleCanvas` / the docs mimetype. Only
	// honor an explicit caller-supplied `types`.
	const types = args.types as string | undefined;

	const data = (await callSlackApi("files.list", accessToken, {
		channel: channelId,
		count,
		...(types ? { types } : {}),
		...(tsFrom !== undefined ? { ts_from: tsFrom } : {}),
	})) as { files?: RawSlackFile[] };

	const files = (data.files || []).map((f) => mapHuddleFields(f, channelId));

	return { files, count: files.length };
}

/**
 * Fetch a single file's huddle markers + `url_private` via `files.info`. Used as
 * the detection fallback (when `files.list` returns a leaner object) and to
 * obtain the notes-body download URL. Security: structured fields only.
 */
async function getFileInfo(
	accessToken: string,
	args: Record<string, unknown>,
): Promise<SlackHuddleCanvasFile> {
	const fileId = args.fileId as string;
	if (!fileId) {
		throw new Error("fileId is required for get_file_info");
	}

	const data = (await callSlackApi("files.info", accessToken, {
		file: fileId,
	})) as { file?: RawSlackFile };

	const file = data.file;
	if (!file) {
		throw new Error(`Slack files.info returned no file for ${fileId}`);
	}

	// files.info doesn't echo a channel id directly; the caller knows it.
	const channelId =
		(args.channelId as string) || (args.channel as string) || "";
	return mapHuddleFields(file, channelId);
}

/**
 * Get channel details.
 */
async function getChannelInfo(
	accessToken: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const channelId = args.channelId as string;
	if (!channelId) {
		throw new Error("channelId is required for get_channel_info");
	}

	const data = (await callSlackApi("conversations.info", accessToken, {
		channel: channelId,
	})) as {
		channel: {
			id: string;
			name: string;
			is_private: boolean;
			is_archived: boolean;
			num_members: number;
			topic?: { value?: string };
			purpose?: { value?: string };
			created: number;
		};
	};

	const ch = data.channel;
	return {
		id: ch.id,
		name: ch.name,
		isPrivate: ch.is_private,
		isArchived: ch.is_archived,
		memberCount: ch.num_members,
		topic: ch.topic?.value || "",
		purpose: ch.purpose?.value || "",
		created: new Date(ch.created * 1000).toISOString(),
	};
}

/**
 * List workspace members.
 */
async function listUsers(
	accessToken: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const limit = Math.min((args.limit as number) || 100, 200);
	const cursor = args.cursor as string | undefined;

	const data = (await callSlackApi("users.list", accessToken, {
		limit,
		cursor: cursor || undefined,
	})) as {
		members: Array<{
			id: string;
			name: string;
			real_name?: string;
			profile?: {
				display_name?: string;
				email?: string;
				image_48?: string;
			};
			is_bot: boolean;
			deleted: boolean;
		}>;
		response_metadata?: { next_cursor?: string };
	};

	return {
		users: (data.members || [])
			.filter((u) => !u.is_bot && !u.deleted)
			.map((u) => ({
				id: u.id,
				name: u.profile?.display_name || u.real_name || u.name,
				email: u.profile?.email || null,
				avatarUrl: u.profile?.image_48 || null,
			})),
		count: data.members?.length || 0,
		nextCursor: data.response_metadata?.next_cursor || null,
	};
}
