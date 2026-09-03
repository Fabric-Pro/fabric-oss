/**
 * Microsoft Integration Utilities
 *
 * Shared execution functions for Microsoft Graph API integrations (Teams, etc.).
 * These functions handle the actual API calls using credentials from WorkflowIntegration.
 *
 * Used by both:
 * - API layer (for listing available chats during project setup)
 * - Temporal activities (for fetching context during workflows)
 *
 * Features:
 * - Automatic token refresh when access token expires
 * - Credentials updated in database after refresh
 */

import {
	extractRelevantExcerpts,
	type RawExtractableMessage,
	type RelevantExcerpt,
} from "@repo/ai";
import { db } from "@repo/database";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import sharp from "sharp";
import type { PendingAttachmentRef } from "../shared/attachment-types";
import { TEAMS_TOOL_LIMITS } from "./config/limits";
import { extractHostedContentRefsFromHtml } from "./hosted-content";
import {
	getRecordingTranscriptContent,
	listRecordingTranscripts,
} from "./stream-transcript";

export { TEAMS_TOOL_LIMITS } from "./config/limits";
// Re-export the not-connected classifier so consumers that only need to
// classify an error string (apps/web, @repo/api, @repo/temporal) can do
// `import { isMicrosoftNotConnectedError } from "@repo/integrations/microsoft"`
// without depending on @repo/api (which @repo/temporal must not).
export { isMicrosoftNotConnectedError } from "./connection-errors";
// Re-export the chat-thread image-attachments helpers from the Microsoft barrel
// so downstream packages can `import { downloadTeamsHostedContent } from
// "@repo/integrations/microsoft"` without reaching into the file directly.
export {
	type DownloadTeamsHostedContentOptions,
	type DownloadTeamsHostedContentResult,
	downloadTeamsHostedContent,
	extractHostedContentRefsFromHtml,
} from "./hosted-content";
export { DownloadFailedError } from "./hosted-content.errors";
// Re-exported so the transcript-sync activity can tell a channel meeting from an
// ordinary one before deciding whether the recording fallback is worth trying.
export { extractChannelThreadId } from "./stream-transcript";

interface TokenCredentials {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	token_type?: string;
}

// Module-level refresh lock to prevent concurrent token refresh races.
// When multiple concurrent requests hit a 401, only the first one refreshes
// the token; the rest await the same promise and reuse the result.
const refreshInProgress = new Map<string, Promise<TokenCredentials>>();

/**
 * Resolve the current Microsoft Graph access token for a given
 * `(userId, organizationId)` pair from the workspace's stored
 * `MICROSOFT_GRAPH` workflow integration. Mirrors the credential-lookup
 * surface that `getSlackCredentials` provides on the Slack side.
 *
 * The caller is expected to invoke this from a server-side handler that has
 * already validated tenant access (e.g. inside `tenantProtectedProcedure`).
 * This helper does NOT re-validate XOR isolation; it only pulls the row that
 * matches the requested user / org filter (the same XOR filter the existing
 * `executeMicrosoftTeamsTool` uses inline today).
 *
 * Behaviour:
 *   - When the stored credentials are present and contain a non-empty
 *     `access_token`, the token is returned verbatim. The on-401 refresh
 *     path that `executeMicrosoftTeamsTool` does internally is NOT performed
 *     here — callers that need a long-lived token must rely on the
 *     downstream `downloadTeamsHostedContent` path failing fast (which the
 *     chat-thread image-attachments orchestrator maps to a
 *     `download_failed` warning rather than refreshing in place).
 *   - When the integration / credentials / token is missing, throws a
 *     descriptive `Error` so the caller can surface a sane warning (the
 *     `attach-pending-media-to-story` orchestrator catches all throws and
 *     maps them to `download_failed` per FR-23).
 *
 * Tenant XOR: matches the existing inline filter in
 * `executeMicrosoftTeamsTool` — when `organizationId` is supplied both
 * `userId` and `organizationId` must match the row; when `organizationId`
 * is omitted the row's `organizationId` must be NULL.
 */
export async function getMicrosoftAccessToken(
	userId: string,
	organizationId?: string,
): Promise<{ accessToken: string; integrationId: string }> {
	const integration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId,
					provider: "MICROSOFT_GRAPH",
					isActive: true,
				},
			})
		: await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId: null,
					provider: "MICROSOFT_GRAPH",
					isActive: true,
				},
			});

	if (!integration?.credentials) {
		throw new Error(
			"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
		);
	}

	const credentialsJson = decryptApiKey(integration.credentials);

	// Handle both OAuth token (JSON) and raw token formats. Mirrors the
	// inline parse logic in `executeMicrosoftTeamsTool` so we read the same
	// stored shape.
	let accessToken: string;
	try {
		const parsed = JSON.parse(credentialsJson);
		if (typeof parsed !== "object" || parsed === null) {
			accessToken = credentialsJson;
		} else {
			const typedParsed = parsed as TokenCredentials & {
				MICROSOFT_ACCESS_TOKEN?: string;
			};
			accessToken =
				typedParsed.access_token ||
				typedParsed.MICROSOFT_ACCESS_TOKEN ||
				"";
		}
	} catch {
		accessToken = credentialsJson;
	}

	if (!accessToken || accessToken.trim() === "") {
		throw new Error(
			"Microsoft access token is missing. Please reconnect your Microsoft account in Settings > Integrations.",
		);
	}

	return { accessToken, integrationId: integration.id };
}

/**
 * Strip HTML (tags + common entities) and truncate for LLM context.
 * Teams messages contain HTML; decoding entities yields cleaner prompts.
 * Default 500 chars — callers pass a larger budget when they need more context.
 */
export function truncateContent(
	content: string | undefined,
	maxLength = 500,
): string {
	if (!content) {
		return "";
	}
	// Bounded span: js/polynomial-redos — callers pass at most a 2000-char
	// maxLength (fetch-new-messages.ts), so a 20000-char prefix is comfortably
	// generous while keeping the tag-strip regex off unbounded raw HTML.
	const bounded = content.slice(0, 20_000);
	const stripped = bounded
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
	if (stripped.length <= maxLength) {
		return stripped;
	}
	return `${stripped.substring(0, maxLength)}... [truncated]`;
}

function getQueryArg(args: Record<string, unknown>): string | undefined {
	return typeof args.query === "string" && args.query.trim() !== ""
		? args.query.trim()
		: undefined;
}

async function maybeExtractExcerpts(params: {
	rawMessages: RawExtractableMessage[];
	args: Record<string, unknown>;
	userId: string;
	organizationId?: string;
	toolName: string;
	maxExcerpts?: number;
}): Promise<RelevantExcerpt[] | null> {
	const { rawMessages, args, userId, organizationId, toolName, maxExcerpts } =
		params;
	const query = getQueryArg(args);
	if (!query || rawMessages.length === 0) {
		return null;
	}
	const stagePrompt =
		typeof args.stagePrompt === "string" && args.stagePrompt.trim() !== ""
			? args.stagePrompt.trim()
			: undefined;

	const result = await extractRelevantExcerpts({
		rawMessages,
		query,
		stagePrompt,
		userId,
		organizationId,
		maxExcerpts: maxExcerpts ?? TEAMS_TOOL_LIMITS.EXCERPTS_PER_PASS,
		maxCharsPerExcerpt: TEAMS_TOOL_LIMITS.MAX_CHARS_PER_EXCERPT,
		timeoutMs: TEAMS_TOOL_LIMITS.EXTRACTOR_TIMEOUT_MS,
		toolName,
	});
	return result.excerpts;
}

/**
 * Parse WebVTT transcript content into structured entries.
 * Supports two VTT variants:
 * 1. Standard: timestamps followed by "<v SpeakerName>text</v>"
 * 2. Metadata: timestamps followed by JSON lines like {"speakerName":"...","spokenText":"..."}
 */
function parseVttToStructured(
	vttContent: string,
): Array<{ speaker: string; text: string; start: string; end: string }> {
	const entries: Array<{
		speaker: string;
		text: string;
		start: string;
		end: string;
	}> = [];
	const lines = vttContent.split("\n");
	let currentStart = "";
	let currentEnd = "";

	for (const line of lines) {
		// Match timestamp lines: "00:00:01.000 --> 00:00:05.000"
		const timestampMatch = line.match(
			/(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/,
		);
		if (timestampMatch) {
			currentStart = timestampMatch[1];
			currentEnd = timestampMatch[2];
			continue;
		}

		// Match speaker lines: "<v Speaker Name>spoken text</v>"
		const speakerMatch = line.match(/<v\s+([^>]+)>(.+?)<\/v>/);
		if (speakerMatch && currentStart) {
			entries.push({
				speaker: speakerMatch[1],
				text: speakerMatch[2],
				start: currentStart,
				end: currentEnd,
			});
			continue;
		}

		// Plain text lines (no speaker tags) associated with a timestamp
		const trimmed = line.trim();
		if (
			trimmed &&
			currentStart &&
			!trimmed.startsWith("WEBVTT") &&
			!trimmed.startsWith("NOTE") &&
			!/^\d+$/.test(trimmed)
		) {
			// Check if the line is embedded JSON metadata from metadataContent endpoint
			// Format: {"startDateTime":"...","endDateTime":"...","speakerName":"...","spokenText":"...","spokenLanguage":"..."}
			if (trimmed.startsWith("{")) {
				try {
					const meta = JSON.parse(trimmed) as {
						speakerName?: string;
						spokenText?: string;
						spokenLanguage?: string;
						startDateTime?: string;
						endDateTime?: string;
					};
					if (meta.spokenText !== undefined) {
						entries.push({
							speaker: meta.speakerName || "Unknown",
							text: meta.spokenText,
							start: meta.startDateTime || currentStart,
							end: meta.endDateTime || currentEnd,
						});
						continue;
					}
				} catch {
					// Not valid JSON, fall through to plain text handling
				}
			}
			entries.push({
				speaker: "Unknown",
				text: trimmed,
				start: currentStart,
				end: currentEnd,
			});
		}
	}

	return entries;
}

/**
 * Resource to redeem the refresh token against.
 *
 * **Always send a scope.** A refresh token here is multi-resource, and a
 * redemption that omits `scope` is issued against whichever resource was
 * redeemed last — so once the channel-recording fallback in
 * `stream-transcript.ts` takes a SharePoint token, every later Graph refresh
 * silently comes back with `aud` = SharePoint and Graph answers 401
 * `InvalidAuthenticationToken` ("Invalid audience"). The retry re-mints the same
 * wrong token, so the connection never recovers on its own (Fizzy #2311).
 *
 * `.default` costs nothing: the scope pins the *resource* only and does not
 * narrow the grant — asking for a single scope still returns every consented
 * one.
 */
const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

/**
 * Refresh Microsoft OAuth access token using refresh token.
 * Returns the new token response or throws if refresh fails.
 */
async function refreshMicrosoftToken(
	refreshToken: string,
): Promise<TokenCredentials> {
	const clientId = process.env.MICROSOFT_GRAPH_CLIENT_ID;
	const clientSecret = process.env.MICROSOFT_GRAPH_CLIENT_SECRET;

	if (!clientId || !clientSecret) {
		throw new Error(
			"Microsoft Graph OAuth not configured. Missing MICROSOFT_GRAPH_CLIENT_ID or MICROSOFT_GRAPH_CLIENT_SECRET.",
		);
	}

	console.log("[MicrosoftTeams] Refreshing expired access token...");

	const response = await fetch(
		"https://login.microsoftonline.com/common/oauth2/v2.0/token",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
				scope: GRAPH_DEFAULT_SCOPE,
			}),
		},
	);

	if (!response.ok) {
		const error = await response.text();
		console.error("[MicrosoftTeams] Token refresh failed:", error);
		throw new Error(
			`Failed to refresh Microsoft token: ${response.status} - ${error}`,
		);
	}

	const raw = await response.json();
	if (!raw?.access_token || typeof raw.access_token !== "string") {
		throw new Error(
			"Invalid token response from Microsoft: missing access_token",
		);
	}
	const tokens = raw as TokenCredentials;
	console.log("[MicrosoftTeams] Successfully refreshed access token");

	return tokens;
}

/**
 * Update stored credentials with new tokens.
 */
async function updateStoredCredentials(
	integrationId: string,
	newTokens: TokenCredentials,
): Promise<void> {
	const credentials: TokenCredentials = {
		access_token: newTokens.access_token,
		refresh_token: newTokens.refresh_token, // Microsoft returns new refresh token with each refresh
		expires_in: newTokens.expires_in,
		token_type: newTokens.token_type,
	};

	const encryptedCredentials = encryptApiKey(JSON.stringify(credentials));

	await db.workflowIntegration.update({
		where: { id: integrationId },
		data: { credentials: encryptedCredentials },
	});

	console.log("[MicrosoftTeams] Updated stored credentials with new tokens");
}

/**
 * Persist a rotated refresh token, leaving the stored access token alone.
 *
 * Acquiring a token for a non-Graph resource (SharePoint, for the channel-meeting
 * recording fallback) redeems the refresh token, and Entra answers every
 * redemption with a fresh one. The new refresh token is good for every resource,
 * so it belongs in storage — but the access token that came with it is scoped to
 * that other resource and would break every subsequent Graph call if written
 * over the Graph one. Hence a merge rather than `updateStoredCredentials`.
 */
async function updateStoredRefreshToken(
	integrationId: string,
	newRefreshToken: string,
): Promise<void> {
	const row = await db.workflowIntegration.findUnique({
		where: { id: integrationId },
		select: { credentials: true },
	});
	if (!row?.credentials) {
		return;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(decryptApiKey(row.credentials));
	} catch {
		// Legacy rows store the bare access token as a string — there is no
		// refresh token in there to rotate.
		return;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return;
	}

	const credentials = {
		...(parsed as TokenCredentials),
		refresh_token: newRefreshToken,
	};
	await db.workflowIntegration.update({
		where: { id: integrationId },
		data: { credentials: encryptApiKey(JSON.stringify(credentials)) },
	});

	console.log("[MicrosoftTeams] Persisted rotated refresh token");
}

/**
 * Compute the backoff delay (ms) before retrying a transient Microsoft Graph
 * failure. Honors the `Retry-After` header (seconds) when present and sane —
 * Graph sets it when throttling — otherwise falls back to exponential backoff
 * (1s, 2s, 4s…) capped to keep a single request well under the Temporal
 * activity timeout. Exported for testing.
 */
export function computeGraphThrottleBackoffMs(
	retryAfterHeader: string | null,
	attempt: number,
): number {
	const retryAfterSec = retryAfterHeader
		? Number(retryAfterHeader)
		: Number.NaN;
	if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
		return Math.min(retryAfterSec * 1000, 15_000);
	}
	return Math.min(2 ** attempt * 1000, 8_000);
}

/**
 * Decide whether a Graph response status is worth retrying in-place.
 *
 * - **429 / 503** — throttling and "service busy", which Graph's own guidance
 *   says to retry after a delay. Retried for every method, as they were before
 *   502/504 joined them.
 * - **502 / 504** — Graph's front door could not complete the backend call
 *   ("Failed to execute backend request"). Also transient, but a gateway can
 *   fail *after* the backend applied the request, so replaying a write risks
 *   duplicating it (posting the same Teams message twice). Retried only for
 *   side-effect-free methods.
 *
 * `method` is the `RequestInit.method` of the request being retried; `fetch`
 * treats an absent method as GET, so does this.
 *
 * Exported for testing.
 */
export function isRetryableGraphStatus(
	status: number,
	method?: string,
): boolean {
	if (status === 429 || status === 503) {
		return true;
	}
	if (status !== 502 && status !== 504) {
		return false;
	}
	const verb = (method ?? "GET").toUpperCase();
	return verb === "GET" || verb === "HEAD";
}

export interface TranscriptForbiddenClassification {
	error: string;
	message: string;
	helpUrl: string;
}

/**
 * Classify a 403 returned by the Graph transcript endpoints.
 *
 * Beyond the app-registration permission (`OnlineMeetingTranscript.Read.All`),
 * Teams exposes two tenant-admin controls that block transcript access even
 * when every application permission has been granted:
 *
 * - "Transcript API access > Microsoft Graph access" — when off, every
 *   transcript request fails with `innerError.code`
 *   `GraphAccessToTranscriptsDisabled`.
 * - "Include speaker attribution" — when off, requesting speaker-attributed
 *   content fails with `innerError.code` `SpeakerAttributionNotAllowed`.
 *
 * Both arrive with a top-level `error.code` of `Forbidden`, so the inner-error
 * checks must run first: Microsoft's guidance is to branch on
 * `innerError.code` rather than the human-readable message, which is not a
 * stable contract. Without that ordering the tenant-toggle case is reported as
 * a missing app permission and sends operators to the wrong admin surface.
 *
 * Returns `null` when the body is not a recognized transcript-access failure,
 * leaving the caller's generic error handling to run. Exported for testing.
 */
export function classifyTranscriptForbidden(errorBody: {
	error?: {
		code?: string;
		message?: string;
		innerError?: { code?: string };
	};
}): TranscriptForbiddenClassification | null {
	const errorCode = errorBody?.error?.code || "";
	const errorMessage = errorBody?.error?.message || "";
	const innerErrorCode = errorBody?.error?.innerError?.code || "";

	if (innerErrorCode === "GraphAccessToTranscriptsDisabled") {
		return {
			error: "Microsoft Graph access to meeting transcripts is disabled for this tenant",
			message:
				"A Teams administrator must enable 'Transcript API access > Microsoft Graph access' in the Teams admin center (Meetings > Meeting settings), or run Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true. Until then, all transcript requests are blocked regardless of app permissions.",
			helpUrl:
				"https://learn.microsoft.com/microsoftteams/meeting-transcript-api-access",
		};
	}

	if (innerErrorCode === "SpeakerAttributionNotAllowed") {
		return {
			error: "Speaker-attributed transcript content is disabled for this tenant",
			message:
				"A Teams administrator must enable 'Include speaker attribution' under Transcript API access in the Teams admin center, or run Set-CsTeamsMeetingConfiguration -EnableAttributedTranscripts $true.",
			helpUrl:
				"https://learn.microsoft.com/microsoftteams/meeting-transcript-api-access",
		};
	}

	if (
		errorCode === "Forbidden" ||
		errorCode === "AccessDenied" ||
		errorMessage.includes("insufficient privileges") ||
		errorMessage.includes("does not have permission")
	) {
		// Deliberately does not lead with "a permission is missing". Graph only
		// returns transcripts for meetings the caller organized that have a
		// backing calendar event, and refuses everything else with the same bare
		// 403 — so on a tenant where OnlineMeetingTranscript.Read.All is already
		// granted, blaming the permission sends the user to an admin who has
		// nothing left to grant. Both causes are named, most likely first.
		return {
			error: "Transcript access denied for this meeting",
			message:
				"Microsoft Graph only returns transcripts for meetings you organized that have a calendar event behind them — a meeting someone else organized, or one started ad hoc from a chat, is out of reach whatever permissions are held. If this is your own scheduled meeting, ask an administrator to confirm the 'OnlineMeetingTranscript.Read.All' permission is granted on the app registration and to check the tenant's transcript API access policy.",
			helpUrl:
				"https://learn.microsoft.com/graph/cloud-communication-online-meeting-application-access-policy",
		};
	}

	return null;
}

/**
 * Execute a Microsoft Teams tool using Microsoft Graph API.
 * Uses credentials from the user's MICROSOFT_GRAPH integration.
 * Automatically refreshes token if expired.
 */
export async function executeMicrosoftTeamsTool(
	methodName: string,
	args: Record<string, unknown>,
	userId: string,
	organizationId?: string,
): Promise<unknown> {
	// Get Microsoft Graph token from user's workflow integrations
	// Uses XOR pattern with per-user isolation: org context requires both userId AND organizationId
	// to prevent one org member from using another member's credentials
	const integration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId,
					provider: "MICROSOFT_GRAPH",
					isActive: true,
				},
			})
		: await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId: null,
					provider: "MICROSOFT_GRAPH",
					isActive: true,
				},
			});

	if (!integration?.credentials) {
		throw new Error(
			"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
		);
	}

	// Credentials contains the encrypted access token
	const credentialsJson = decryptApiKey(integration.credentials);
	let accessToken: string;
	let refreshToken: string | undefined;

	// Handle both OAuth token (JSON) and raw token formats
	try {
		const parsed = JSON.parse(credentialsJson);

		// Guard: Ensure parsed result is an object, not a primitive (string, number, etc.)
		// JSON.parse("\"<token>\"") returns a string, not an object
		if (typeof parsed !== "object" || parsed === null) {
			// Parsed to a primitive, use as raw token (legacy format)
			accessToken = credentialsJson;
			console.log(
				"[MicrosoftTeams] Using legacy token format (parsed to primitive)",
			);
		} else {
			const typedParsed = parsed as TokenCredentials & {
				MICROSOFT_ACCESS_TOKEN?: string;
			};
			accessToken =
				typedParsed.access_token ||
				typedParsed.MICROSOFT_ACCESS_TOKEN ||
				"";
			refreshToken = typedParsed.refresh_token;

			// Log token presence for debugging (no sensitive data)
			console.log(
				`[MicrosoftTeams] Token loaded - hasAccessToken: ${!!accessToken}, hasRefreshToken: ${!!refreshToken}`,
			);
		}
	} catch {
		// Not JSON, use as-is (legacy format)
		accessToken = credentialsJson;
		console.log("[MicrosoftTeams] Using legacy token format (raw string)");
	}

	// Validate token before proceeding
	if (!accessToken || accessToken.trim() === "") {
		// If we have a refresh token, try to get a new access token
		if (refreshToken) {
			console.log(
				"[MicrosoftTeams] Access token is empty but refresh token exists, attempting refresh...",
			);
			try {
				const newTokens = await refreshMicrosoftToken(refreshToken);
				accessToken = newTokens.access_token;

				// Update stored credentials with new token
				await updateStoredCredentials(integration.id, newTokens);
				console.log(
					"[MicrosoftTeams] Successfully refreshed empty access token",
				);
			} catch (refreshError) {
				console.error(
					"[MicrosoftTeams] Failed to refresh empty access token:",
					refreshError,
				);
				throw new Error(
					"Microsoft access token is missing and refresh failed. Please reconnect your Microsoft account in Settings > Integrations.",
				);
			}
		} else {
			throw new Error(
				"Microsoft access token is missing and no refresh token available. Please reconnect your Microsoft account in Settings > Integrations.",
			);
		}
	}

	const graphBaseUrl = "https://graph.microsoft.com/v1.0";

	/**
	 * Make a Microsoft Graph API request with automatic token refresh on auth errors.
	 * Handles both 401 (token expired) and 403 "No authorization information present" (token missing/invalid).
	 */
	async function graphRequest(
		url: string,
		options: RequestInit = {},
	): Promise<Response> {
		const makeRequest = (token: string) =>
			fetch(url, {
				...options,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					...options.headers,
				},
			});

		// First attempt with current token
		let res = await makeRequest(accessToken);

		// Check if we need to refresh the token
		// Microsoft Graph can return:
		// - 401 Unauthorized: Token expired or invalid
		// - 403 Forbidden with "No authorization information present": Token missing, empty, or malformed
		const needsRefresh =
			res.status === 401 || (res.status === 403 && refreshToken); // On 403, try refresh if we have a refresh token

		if (needsRefresh && refreshToken) {
			// Clone the response to check the error for 403
			if (res.status === 403) {
				const clonedRes = res.clone();
				try {
					const errorBody = await clonedRes.json();
					const errorMessage = errorBody?.error?.message || "";
					const errorCode = errorBody?.error?.code || "";

					// Check BOTH message AND code for auth-related errors
					// Microsoft Graph reports InvalidAuthenticationToken in error.code
					const isAuthError =
						errorMessage.includes("No authorization information") ||
						errorMessage.includes("InvalidAuthenticationToken") ||
						errorMessage.includes("Access token has expired") ||
						errorCode === "InvalidAuthenticationToken" ||
						errorCode === "ExpiredToken" ||
						errorCode === "AuthenticationError";

					// Only refresh if it's an auth-related 403, not a permissions 403
					if (!isAuthError) {
						// This is a real 403 permissions error, not an auth error
						return res;
					}
				} catch {
					// If we can't parse the error, try refresh anyway
				}
			}

			console.log(
				`[MicrosoftTeams] Access token issue (${res.status}), attempting refresh...`,
			);
			try {
				// Use a per-integration lock so concurrent requests share one refresh
				// call rather than all racing to refresh and overwriting each other's
				// new tokens (Microsoft issues a new refresh_token on every refresh).
				const integrationId = integration?.id ?? "unknown";
				let refreshPromise = refreshInProgress.get(integrationId);
				if (!refreshPromise) {
					refreshPromise = refreshMicrosoftToken(refreshToken)
						.then(async (newTokens) => {
							if (integration) {
								await updateStoredCredentials(
									integration.id,
									newTokens,
								);
							}
							return newTokens;
						})
						.finally(() => {
							refreshInProgress.delete(integrationId);
						});
					refreshInProgress.set(integrationId, refreshPromise);
				}
				const newTokens = await refreshPromise;
				accessToken = newTokens.access_token;

				// Retry the request with new token
				res = await makeRequest(accessToken);
			} catch (refreshError) {
				console.error(
					"[MicrosoftTeams] Token refresh failed:",
					refreshError,
				);
				// Re-throw with helpful message
				throw new Error(
					"Microsoft access token expired and refresh failed. Please reconnect your Microsoft account in Settings > Integrations.",
				);
			}
		}

		// Transient-failure backoff. Graph returns 429 (rate limited) or 503
		// (service busy) under load — far more likely now that transcript/
		// calendar requests run concurrently — and 502/504 when its front door
		// cannot reach the backend. All four clear on their own, and retrying
		// here is the only backoff several callers get: activities that report
		// a failed fetch as a return value rather than throwing (the meeting
		// transcript sync, for one) never reach the Temporal retry policy.
		// Honor Retry-After when present, else exponential backoff. A failure
		// that outlives the retries falls through and the caller throws.
		const TRANSIENT_MAX_RETRIES = 3;
		for (
			let attempt = 0;
			isRetryableGraphStatus(res.status, options.method) &&
			attempt < TRANSIENT_MAX_RETRIES;
			attempt++
		) {
			const backoffMs = computeGraphThrottleBackoffMs(
				res.headers.get("Retry-After"),
				attempt,
			);
			// Release the response that is about to be dropped. An unread body
			// holds its connection out of the pool until it is GC'd, which
			// matters here because the retry then sleeps on it.
			await res.body?.cancel().catch(() => {
				// Already errored or consumed — nothing left to release.
			});
			await new Promise((resolve) => setTimeout(resolve, backoffMs));
			res = await makeRequest(accessToken);
		}

		return res;
	}

	/**
	 * Channel messages API caps $top at 50. Chat messages also cap at 50.
	 */
	const MAX_PAGE_SIZE = 50;

	switch (methodName) {
		// ========== Search Messages (No IDs Required) ==========
		// Uses Microsoft Graph /search/query endpoint
		// Note: Search API returns summary snippet, not full body content
		// For full content, use get_chat_messages with a specific chatId
		case "search_messages": {
			const query = args.query as string | undefined;
			const limit = (args.limit as number) || 25;

			// Require a query - don't search all messages
			if (!query || query.trim() === "" || query === "*") {
				return {
					error: "query parameter is required. Provide a search term like 'from:Alex' to find messages from a person, or keywords to search message content.",
					suggestion:
						"Call search_messages with query='from:PersonName' to find messages from a specific person.",
					messages: [],
					count: 0,
				};
			}

			const res = await graphRequest(`${graphBaseUrl}/search/query`, {
				method: "POST",
				body: JSON.stringify({
					requests: [
						{
							entityTypes: ["chatMessage"],
							query: { queryString: query },
							size: limit,
							enableTopResults: true,
						},
					],
				}),
			});

			if (!res.ok) {
				const error = await res.json().catch(() => ({}));
				throw new Error(
					`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
				);
			}

			const data = await res.json();
			const hitsContainers = data.value?.[0]?.hitsContainers || [];
			const hits = hitsContainers[0]?.hits || [];

			// Microsoft Graph Search API response structure:
			// - summary: text snippet with highlighted matches (main content)
			// - from.emailAddress.name: sender's display name
			// - from.emailAddress.address: sender's email
			// Note: Search API doesn't return full body - use get_chat_messages for full content
			return {
				messages: hits.map(
					(hit: {
						summary?: string;
						resource: {
							id: string;
							from?: {
								emailAddress?: {
									name?: string;
									address?: string;
								};
							};
							createdDateTime?: string;
							lastModifiedDateTime?: string;
							channelIdentity?: {
								teamId?: string;
								channelId?: string;
							};
							chatId?: string;
							webLink?: string;
							importance?: string;
							subject?: string;
						};
					}) => ({
						id: hit.resource.id,
						// Summary contains the message content snippet from search
						content:
							hit.summary || "(No content preview available)",
						from:
							hit.resource.from?.emailAddress?.name ||
							hit.resource.from?.emailAddress?.address ||
							"Unknown",
						fromEmail:
							hit.resource.from?.emailAddress?.address || "",
						createdAt: hit.resource.createdDateTime,
						subject: hit.resource.subject || "",
						// Include context about where the message is from
						teamId: hit.resource.channelIdentity?.teamId,
						channelId: hit.resource.channelIdentity?.channelId,
						chatId: hit.resource.chatId,
						webLink: hit.resource.webLink,
					}),
				),
				count: hits.length,
				totalHits: hitsContainers[0]?.total || hits.length,
				query,
				note: "Content shown is a search snippet. Use get_chat_messages with chatId for full message content.",
			};
		}

		case "list_teams": {
			const res = await graphRequest(
				`${graphBaseUrl}/me/joinedTeams?$select=id,displayName,description`,
			);
			if (!res.ok) {
				const error = await res.json().catch(() => ({}));
				throw new Error(
					`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
				);
			}
			const data = await res.json();
			return {
				teams: data.value.map(
					(team: {
						id: string;
						displayName: string;
						description?: string;
					}) => ({
						id: team.id,
						name: team.displayName,
						description: team.description || "",
					}),
				),
				count: data.value.length,
			};
		}

		case "list_channels": {
			const teamId = args.teamId as string;
			if (!teamId) {
				throw new Error(
					"teamId is required for list_channels. First call Microsoft_Teams__list_teams to get available team IDs, then provide one of those IDs as the teamId parameter.",
				);
			}
			const res = await graphRequest(
				`${graphBaseUrl}/teams/${teamId}/channels?$select=id,displayName,description,membershipType`,
			);
			if (!res.ok) {
				const error = await res.json().catch(() => ({}));
				throw new Error(
					`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
				);
			}
			const data = await res.json();
			return {
				channels: data.value.map(
					(channel: {
						id: string;
						displayName: string;
						description?: string;
						membershipType?: string;
					}) => ({
						id: channel.id,
						name: channel.displayName,
						description: channel.description || "",
						type: channel.membershipType || "standard",
					}),
				),
				count: data.value.length,
			};
		}

		case "list_messages": {
			const teamId = args.teamId as string;
			const channelId = args.channelId as string;
			const since = args.since as string | undefined;
			const limit = Math.min((args.limit as number) || 50, MAX_PAGE_SIZE);
			if (!teamId || !channelId) {
				throw new Error(
					"teamId and channelId are required for list_messages. First call Microsoft_Teams__list_teams to get team IDs, then Microsoft_Teams__list_channels with a teamId to get channel IDs.",
				);
			}
			const parsedSince = since ? new Date(since) : null;
			const sinceDate =
				parsedSince && !Number.isNaN(parsedSince.getTime())
					? parsedSince
					: null;
			const pageSize = Math.min(limit, MAX_PAGE_SIZE);
			const initialUrl = `${graphBaseUrl}/teams/${teamId}/channels/${channelId}/messages?$top=${pageSize}`;

			const messages: Array<{
				id: string;
				content: string;
				from: string;
				createdAt: string | undefined;
			}> = [];
			// Only collected when a query is supplied — the extractor runs
			// off full-body content, everyone else gets the truncated list.
			const hasQuery = getQueryArg(args) !== undefined;
			const rawForExtractor: RawExtractableMessage[] = [];
			let fetchedTotal = 0;
			let nextUrl: string | null = initialUrl;
			let pageCount = 0;
			// Paginate more aggressively when filtering by date
			const maxPages = sinceDate ? 5 : 1;
			let moreAvailable = false;

			while (nextUrl && pageCount < maxPages && messages.length < limit) {
				pageCount++;
				const res = await graphRequest(nextUrl);
				if (!res.ok) {
					const error = await res.json().catch(() => ({}));
					throw new Error(
						`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
					);
				}
				const data = await res.json();
				const values = data.value || [];
				fetchedTotal += values.length;

				for (const raw of values) {
					const msg = raw as {
						id: string;
						body?: { content: string };
						from?: { user?: { displayName: string } };
						createdDateTime?: string;
						messageType?: string;
					};
					// Skip system event messages (member joins, team renames, etc.)
					if (msg.messageType && msg.messageType !== "message") {
						continue;
					}
					// Filter by date if since parameter is provided
					if (sinceDate) {
						if (
							!msg.createdDateTime ||
							new Date(msg.createdDateTime) < sinceDate
						) {
							continue;
						}
					}
					messages.push({
						id: msg.id,
						content: truncateContent(msg.body?.content, 500),
						from: msg.from?.user?.displayName || "Unknown",
						createdAt: msg.createdDateTime,
					});
					if (hasQuery) {
						rawForExtractor.push({
							messageId: msg.id,
							from: msg.from?.user?.displayName,
							createdAt: msg.createdDateTime,
							content: msg.body?.content ?? "",
						});
					}
					if (messages.length >= limit) {
						break;
					}
				}

				nextUrl = data["@odata.nextLink"] || null;
				moreAvailable = !!nextUrl;
			}

			const excerpts = await maybeExtractExcerpts({
				rawMessages: rawForExtractor,
				args,
				userId,
				organizationId,
				toolName: "list_messages",
			});
			if (excerpts) {
				return {
					excerpts,
					count: excerpts.length,
					mode: "relevance-extracted" as const,
					...(sinceDate ? { since, totalScanned: fetchedTotal } : {}),
					...(moreAvailable ? { hasMore: true } : {}),
				};
			}

			return {
				messages: messages.slice(0, limit),
				count: messages.length,
				...(sinceDate ? { since, totalScanned: fetchedTotal } : {}),
				...(moreAvailable ? { hasMore: true } : {}),
			};
		}

		case "list_channel_threads": {
			// Thread-aware listing for the Teams Channel Monitor. Returns top-level
			// channel messages expanded with their replies so the monitor can
			// evaluate a full thread's "quiet window" before analyzing it.
			//
			// NOTE: $filter is NOT supported on GET /teams/{id}/channels/{id}/messages
			// per Microsoft docs (only $top, $expand, $orderby desc). Date filtering
			// is done client-side in the fetch-new-messages activity.
			//
			// The caller may pass `nextPageToken` (a Graph @odata.nextLink URL) to
			// resume pagination from a prior call — used by the activity to scan
			// past already-seen threads on busy channels without advancing the
			// channel cursor.
			const teamId = args.teamId as string;
			const channelId = args.channelId as string;
			const maxThreads = Math.max(1, Number(args.top) || 50);
			const perPage = Math.min(50, maxThreads);
			const initialToken =
				typeof args.nextPageToken === "string"
					? args.nextPageToken
					: undefined;
			if (!teamId || !channelId) {
				throw new Error(
					"teamId and channelId are required for list_channel_threads.",
				);
			}
			type RawThread = {
				id: string;
				messageType?: string;
				createdDateTime?: string;
				lastModifiedDateTime?: string;
				webUrl?: string;
				body?: { content?: string };
				from?: { user?: { displayName?: string } };
				replies?: Array<{
					id: string;
					messageType?: string;
					createdDateTime?: string;
					lastModifiedDateTime?: string;
					webUrl?: string;
					body?: { content?: string };
					from?: { user?: { displayName?: string } };
				}>;
			};
			const collected: RawThread[] = [];
			let nextUrl: string | null =
				initialToken ??
				`${graphBaseUrl}/teams/${teamId}/channels/${channelId}/messages?$expand=replies&$top=${perPage}`;
			let pageCount = 0;
			const MAX_PAGES = 20; // hard safety cap per call (20 × 50 = 1000 threads)
			while (
				nextUrl &&
				collected.length < maxThreads &&
				pageCount < MAX_PAGES
			) {
				const res = await graphRequest(nextUrl);
				if (!res.ok) {
					const error = await res.json().catch(() => ({}));
					throw new Error(
						`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
					);
				}
				const data = (await res.json()) as {
					value?: RawThread[];
					"@odata.nextLink"?: string;
				};
				collected.push(...(data.value ?? []));
				nextUrl = data["@odata.nextLink"] ?? null;
				pageCount++;
			}

			// Decision (chat-thread image attachments):
			// keep the Graph URL as `$expand=replies` (no nested
			// `$expand=hostedContents` — Graph refuses nested expand beyond
			// one level on this endpoint) and dereference hostedContent
			// refs from each message's `body.content` HTML at the mapping
			// step via `extractHostedContentRefsFromHtml`. This is robust
			// against Graph expand-depth limits AND keeps the URL shape
			// unchanged for any callers that don't care about attachments.
			const threads = collected
				.filter((m) => !m.messageType || m.messageType === "message")
				.slice(0, maxThreads)
				.map((m) => {
					const rootBody = m.body?.content ?? "";
					const rootRefs = extractHostedContentRefsFromHtml(
						rootBody,
						m.id,
					);
					const replies = (m.replies ?? [])
						.filter(
							(r) =>
								!r.messageType || r.messageType === "message",
						)
						.map((r) => {
							const replyBody = r.body?.content ?? "";
							// Pass the thread root id as `parentMessageId` so
							// the downloader builds the nested
							// `/messages/{rootId}/replies/{replyId}/hostedContents/...`
							// URL (bug_002). Without this, reply attachments
							// 404 at apply time.
							const replyRefs = extractHostedContentRefsFromHtml(
								replyBody,
								r.id,
								m.id,
							);
							return {
								id: r.id,
								createdDateTime: r.createdDateTime,
								lastModifiedDateTime: r.lastModifiedDateTime,
								webUrl: r.webUrl,
								from: r.from?.user?.displayName || "Unknown",
								bodyContent: replyBody,
								pendingAttachments: replyRefs.map(
									(ref): PendingAttachmentRef => ({
										source: "teams" as const,
										ref,
									}),
								),
							};
						});
					// Thread-level `pendingAttachments` flattens root + replies
					// — same shape the Slack side surfaces in
					// `fetchSlackThreadContextActivity`, kept consistent so the
					// activity layer treats both sources uniformly.
					const pendingAttachments: PendingAttachmentRef[] = [
						...rootRefs.map(
							(ref): PendingAttachmentRef => ({
								source: "teams" as const,
								ref,
							}),
						),
						...replies.flatMap((r) => r.pendingAttachments),
					];
					return {
						id: m.id,
						createdDateTime: m.createdDateTime,
						lastModifiedDateTime: m.lastModifiedDateTime,
						webUrl: m.webUrl,
						from: m.from?.user?.displayName || "Unknown",
						bodyContent: rootBody,
						replies,
						pendingAttachments,
					};
				});

			// `fetchedAllPages` is true only when Graph returned no next link
			// AND we didn't truncate against `maxThreads`. The caller uses this
			// to decide whether advancing the cursor is safe — if we bailed at
			// the cap with more pages available, the cursor must stay put so
			// older threads can be picked up on a subsequent tick.
			const fetchedAllPages = !nextUrl && collected.length <= maxThreads;

			return {
				threads,
				count: threads.length,
				pagesFetched: pageCount,
				fetchedAllPages,
				// nextPageToken is the Graph @odata.nextLink where we stopped.
				// The caller can pass it back in to resume pagination past
				// already-seen threads — required for busy channels where the
				// newest N are all seen and unseen threads live deeper.
				nextPageToken: nextUrl ?? undefined,
			};
		}

		case "list_chat_messages_for_monitor": {
			// Monitor-aware chat message listing for the Teams Chat Monitor.
			// Mirrors `list_channel_threads` semantics but for /chats/{chatId}/messages.
			//
			// Differences from `get_chat_messages`:
			//   - Supports `nextPageToken` (Graph @odata.nextLink) so the activity
			//     can resume backward-scan past already-seen messages on busy
			//     chats without advancing the chat cursor.
			//   - Emits `fetchedAllPages` so the caller knows when it's safe to
			//     advance the cursor (vs. truncated against `top`).
			//   - Returns full message body (truncated by the activity, not here)
			//     plus webUrl for citation.
			//
			// Chats have no native reply hierarchy in Microsoft Graph (replyToId
			// is rarely populated in 1:1/group chats), so each message is its
			// own dedup unit — the monitor groups consecutive new messages into
			// a synthetic "thread" at the activity layer.
			const chatId = args.chatId as string;
			const maxMessages = Math.max(1, Number(args.top) || 50);
			const perPage = Math.min(50, maxMessages);
			const initialToken =
				typeof args.nextPageToken === "string"
					? args.nextPageToken
					: undefined;
			if (!chatId) {
				throw new Error(
					"chatId is required for list_chat_messages_for_monitor.",
				);
			}
			type RawChatMessage = {
				id: string;
				messageType?: string;
				createdDateTime?: string;
				lastModifiedDateTime?: string;
				webUrl?: string;
				body?: { content?: string };
				from?: { user?: { displayName?: string } };
			};
			const collected: RawChatMessage[] = [];
			let nextUrl: string | null =
				initialToken ??
				`${graphBaseUrl}/me/chats/${chatId}/messages?$top=${perPage}`;
			let pageCount = 0;
			const MAX_PAGES = 20; // safety cap per call (20 × 50 = 1000 messages)
			while (
				nextUrl &&
				collected.length < maxMessages &&
				pageCount < MAX_PAGES
			) {
				const res = await graphRequest(nextUrl);
				if (!res.ok) {
					const error = await res.json().catch(() => ({}));
					throw new Error(
						`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
					);
				}
				const data = (await res.json()) as {
					value?: RawChatMessage[];
					"@odata.nextLink"?: string;
				};
				collected.push(...(data.value ?? []));
				nextUrl = data["@odata.nextLink"] ?? null;
				pageCount++;
			}

			const messages = collected
				.filter((m) => !m.messageType || m.messageType === "message")
				.slice(0, maxMessages)
				.map((m) => ({
					id: m.id,
					createdDateTime: m.createdDateTime,
					lastModifiedDateTime: m.lastModifiedDateTime,
					webUrl: m.webUrl,
					from: m.from?.user?.displayName || "Unknown",
					bodyContent: m.body?.content ?? "",
				}));

			const fetchedAllPages = !nextUrl && collected.length <= maxMessages;

			return {
				messages,
				count: messages.length,
				pagesFetched: pageCount,
				fetchedAllPages,
				nextPageToken: nextUrl ?? undefined,
			};
		}

		case "list_message_replies": {
			const teamId = args.teamId as string;
			const channelId = args.channelId as string;
			const messageId = args.messageId as string;
			const limit = Math.min((args.limit as number) || 25, MAX_PAGE_SIZE);
			if (!teamId || !channelId || !messageId) {
				throw new Error(
					"teamId, channelId, and messageId are required for list_message_replies. First call list_messages to get a message ID from a channel.",
				);
			}
			const pageSize = Math.min(limit, MAX_PAGE_SIZE);
			const replyUrl = `${graphBaseUrl}/teams/${teamId}/channels/${channelId}/messages/${messageId}/replies?$top=${pageSize}`;

			const replies: Array<{
				id: string;
				content: string;
				from: string;
				createdAt: string | undefined;
			}> = [];
			const hasQuery = getQueryArg(args) !== undefined;
			const rawForExtractor: RawExtractableMessage[] = [];
			let replyNextUrl: string | null = replyUrl;
			let replyPageCount = 0;
			let replyMoreAvailable = false;

			while (
				replyNextUrl &&
				replyPageCount < 3 &&
				replies.length < limit
			) {
				replyPageCount++;
				const res = await graphRequest(replyNextUrl);
				if (!res.ok) {
					const error = await res.json().catch(() => ({}));
					throw new Error(
						`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
					);
				}
				const data = await res.json();
				const values = data.value || [];

				for (const raw of values) {
					const msg = raw as {
						id: string;
						body?: { content: string };
						from?: { user?: { displayName: string } };
						createdDateTime?: string;
						messageType?: string;
					};
					if (msg.messageType && msg.messageType !== "message") {
						continue;
					}
					replies.push({
						id: msg.id,
						content: truncateContent(msg.body?.content, 500),
						from: msg.from?.user?.displayName || "Unknown",
						createdAt: msg.createdDateTime,
					});
					if (hasQuery) {
						rawForExtractor.push({
							messageId: msg.id,
							from: msg.from?.user?.displayName,
							createdAt: msg.createdDateTime,
							content: msg.body?.content ?? "",
						});
					}
					if (replies.length >= limit) {
						break;
					}
				}

				replyNextUrl = data["@odata.nextLink"] || null;
				replyMoreAvailable = !!replyNextUrl;
			}

			const excerpts = await maybeExtractExcerpts({
				rawMessages: rawForExtractor,
				args,
				userId,
				organizationId,
				toolName: "list_message_replies",
			});
			if (excerpts) {
				return {
					excerpts,
					count: excerpts.length,
					mode: "relevance-extracted" as const,
					...(replyMoreAvailable ? { hasMore: true } : {}),
				};
			}

			return {
				replies: replies.slice(0, limit),
				count: replies.length,
				...(replyMoreAvailable ? { hasMore: true } : {}),
			};
		}

		case "get_shared_files": {
			const teamId = args.teamId as string;
			const channelId = args.channelId as string;
			if (!teamId || !channelId) {
				throw new Error(
					"teamId and channelId are required for get_shared_files. First call Microsoft_Teams__list_teams to get team IDs, then Microsoft_Teams__list_channels with a teamId to get channel IDs.",
				);
			}
			const res = await graphRequest(
				`${graphBaseUrl}/teams/${teamId}/channels/${channelId}/filesFolder/children?$select=id,name,webUrl,size,lastModifiedDateTime`,
			);
			if (!res.ok) {
				const error = await res.json().catch(() => ({}));
				throw new Error(
					`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
				);
			}
			const data = await res.json();
			return {
				files: data.value.map(
					(file: {
						id: string;
						name: string;
						webUrl?: string;
						size?: number;
						lastModifiedDateTime?: string;
					}) => ({
						id: file.id,
						name: file.name,
						webUrl: file.webUrl || "",
						size: file.size || 0,
						lastModified: file.lastModifiedDateTime,
					}),
				),
				count: data.value.length,
			};
		}

		// ========== List Users ==========
		// Find users by name to get their user ID for filtering chats
		case "list_users": {
			const nameFilter = args.nameFilter as string | undefined;
			const limit = Math.min((args.limit as number) || 25, 25);

			let url = `${graphBaseUrl}/users?$top=${limit}&$select=id,displayName,mail,userPrincipalName`;

			// Add filter if nameFilter is specified
			if (nameFilter) {
				// Escape single quotes for OData (double them: O'Brien -> O''Brien)
				const escapedFilter = nameFilter.replace(/'/g, "''");
				// Use startswith filter for displayName or userPrincipalName
				const filterQuery = `startswith(displayName,'${escapedFilter}') or startswith(userPrincipalName,'${escapedFilter}')`;
				url += `&$filter=${encodeURIComponent(filterQuery)}`;
			}

			const res = await graphRequest(url);
			if (!res.ok) {
				const error = (await res.json().catch(() => ({}))) as {
					error?: { code?: string };
				};

				// Handle permission denied gracefully - guide LLM to use alternative
				if (
					res.status === 403 ||
					error.error?.code === "Authorization_RequestDenied"
				) {
					return {
						error: "Permission denied for listing users. This requires admin consent for User.ReadBasic.All scope.",
						suggestion:
							"Use search_messages with 'from:PersonName' query instead to find messages from a specific person. Example: search_messages({ query: 'from:Alex' })",
						users: [],
						count: 0,
					};
				}

				throw new Error(
					`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
				);
			}
			const data = await res.json();
			return {
				users: data.value.map(
					(user: {
						id: string;
						displayName: string;
						mail?: string;
						userPrincipalName?: string;
					}) => ({
						id: user.id,
						displayName: user.displayName,
						email: user.mail || user.userPrincipalName || "",
					}),
				),
				count: data.value.length,
			};
		}

		case "list_chats": {
			const chatType = args.chatType as string | undefined;
			const cursor = args.cursor as string | undefined;
			const limit = args.limit as number | undefined;
			const pageSize = limit
				? Math.min(limit, MAX_PAGE_SIZE)
				: MAX_PAGE_SIZE;

			let url: string;
			if (cursor) {
				// Validate cursor is a legitimate Microsoft Graph nextLink URL
				// to prevent SSRF / token leakage to non-Graph hosts.
				// Use URL parsing to check hostname exactly — startsWith() is bypassable
				// via subdomains like "https://graph.microsoft.com.attacker.com/".
				const isValidGraphUrl = (() => {
					try {
						const parsed = new URL(cursor);
						const allowedHosts = [
							"graph.microsoft.com",
							"graph.microsoft.us",
							"graph.microsoft.de",
						];
						return (
							parsed.protocol === "https:" &&
							allowedHosts.includes(parsed.hostname)
						);
					} catch {
						return false;
					}
				})();
				if (!isValidGraphUrl) {
					throw new Error(
						"Invalid pagination cursor: URL must be a Microsoft Graph API endpoint",
					);
				}
				url = cursor;
			} else {
				url = `${graphBaseUrl}/me/chats?$top=${pageSize}&$select=id,topic,chatType,lastUpdatedDateTime&$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc`;
				if (chatType) {
					url += `&$filter=chatType eq '${chatType}'`;
				}
			}

			const res = await graphRequest(url);
			if (!res.ok) {
				const error = await res.json().catch(() => ({}));
				throw new Error(
					`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
				);
			}
			const data = await res.json();
			const nextCursor = (data["@odata.nextLink"] as string) || null;

			type RawChat = {
				id: string;
				topic?: string;
				chatType?: string;
				lastUpdatedDateTime?: string;
				members?: Array<{
					userId?: string;
					displayName?: string;
					email?: string;
				}>;
				lastMessagePreview?: {
					body?: { content?: string };
					from?: {
						user?: { displayName?: string };
						application?: { displayName?: string };
					};
					createdDateTime?: string;
				};
			};

			const values = (data.value || []) as RawChat[];

			// Read caller's Microsoft Graph identity from loaded integration settings
			const accountSettings = (integration.settings || {}) as {
				oderId?: string;
				email?: string;
				login?: string;
			};
			const meId = accountSettings.oderId;
			const meEmail = (
				accountSettings.email ||
				accountSettings.login ||
				""
			).toLowerCase();

			return {
				chats: values.map((chat) => {
					// Limit full member names to first 5 for the members field
					const memberNames =
						chat.members
							?.map((m) => m.displayName || m.email)
							.filter(Boolean)
							.slice(0, 5) || [];
					const memberStr =
						memberNames.length > 0
							? memberNames.join(", ") +
								(chat.members && chat.members.length > 5
									? ` +${chat.members.length - 5} more`
									: "")
							: "";

					const chatType = chat.chatType || "oneOnOne";

					// Compute fallback topic for 1:1 direct chats only when custom topic is absent
					let fallbackTopic = "Unnamed chat";
					if (chatType === "oneOnOne") {
						const otherMembers = (chat.members || []).filter(
							(m) => {
								if (meId && m.userId === meId) {
									return false;
								}
								const email = (m.email || "").toLowerCase();
								if (meEmail && email && email === meEmail) {
									return false;
								}
								return true;
							},
						);
						const otherMemberStr = otherMembers
							.map((m) => m.displayName || m.email)
							.filter(Boolean)
							.join(", ");
						fallbackTopic = otherMemberStr
							? `1:1 with ${otherMemberStr}`
							: "1:1 Direct Chat";
					}

					return {
						id: chat.id,
						topic: chat.topic || fallbackTopic,
						type: chatType,
						lastUpdated: chat.lastUpdatedDateTime,
						members: memberStr,
						memberCount: chat.members?.length || 0,
						lastMessage: chat.lastMessagePreview
							? {
									from:
										chat.lastMessagePreview.from?.user
											?.displayName ||
										chat.lastMessagePreview.from
											?.application?.displayName ||
										"Unknown",
									preview: truncateContent(
										chat.lastMessagePreview.body?.content,
										100,
									),
									time: chat.lastMessagePreview
										.createdDateTime,
								}
							: null,
					};
				}),
				count: values.length,
				nextCursor,
			};
		}

		case "get_chat_messages": {
			const chatId = args.chatId as string;
			const limit = Math.min((args.limit as number) || 50, MAX_PAGE_SIZE);
			if (!chatId) {
				throw new Error(
					"chatId is required for get_chat_messages. First call Microsoft_Teams__list_chats to get available chat IDs, then provide one of those IDs as the chatId parameter.",
				);
			}
			const pageSize = Math.min(limit, MAX_PAGE_SIZE);
			const initialUrl = `${graphBaseUrl}/me/chats/${chatId}/messages?$top=${pageSize}`;

			const chatMessages: Array<{
				id: string;
				content: string;
				from: string;
				createdAt: string | undefined;
			}> = [];
			const hasQuery = getQueryArg(args) !== undefined;
			const rawForExtractor: RawExtractableMessage[] = [];
			let chatNextUrl: string | null = initialUrl;
			let chatPageCount = 0;
			let chatMoreAvailable = false;

			while (
				chatNextUrl &&
				chatPageCount < 3 &&
				chatMessages.length < limit
			) {
				chatPageCount++;
				const res = await graphRequest(chatNextUrl);
				if (!res.ok) {
					const error = await res.json().catch(() => ({}));
					throw new Error(
						`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
					);
				}
				const data = await res.json();
				const values = data.value || [];

				for (const raw of values) {
					const msg = raw as {
						id: string;
						body?: { content: string };
						from?: { user?: { displayName: string } };
						createdDateTime?: string;
						messageType?: string;
					};
					// Skip system event messages
					if (msg.messageType && msg.messageType !== "message") {
						continue;
					}
					chatMessages.push({
						id: msg.id,
						content: truncateContent(msg.body?.content, 500),
						from: msg.from?.user?.displayName || "Unknown",
						createdAt: msg.createdDateTime,
					});
					if (hasQuery) {
						rawForExtractor.push({
							messageId: msg.id,
							from: msg.from?.user?.displayName,
							createdAt: msg.createdDateTime,
							content: msg.body?.content ?? "",
						});
					}
					if (chatMessages.length >= limit) {
						break;
					}
				}

				chatNextUrl = data["@odata.nextLink"] || null;
				chatMoreAvailable = !!chatNextUrl;
			}

			const excerpts = await maybeExtractExcerpts({
				rawMessages: rawForExtractor,
				args,
				userId,
				organizationId,
				toolName: "get_chat_messages",
			});
			if (excerpts) {
				return {
					excerpts,
					count: excerpts.length,
					mode: "relevance-extracted" as const,
					...(chatMoreAvailable ? { hasMore: true } : {}),
				};
			}

			return {
				messages: chatMessages.slice(0, limit),
				count: chatMessages.length,
				...(chatMoreAvailable ? { hasMore: true } : {}),
			};
		}

		// ========== Get Full Message Content ==========
		// Retrieves the complete, untruncated content of a specific message
		case "get_full_message": {
			const messageId = args.messageId as string;
			const chatId = args.chatId as string | undefined;
			const teamId = args.teamId as string | undefined;
			const channelId = args.channelId as string | undefined;

			if (!messageId) {
				throw new Error(
					"messageId is required for get_full_message. Get this from search_messages, list_messages, or get_chat_messages results.",
				);
			}

			let url: string;
			let messageType: "chat" | "channel";

			if (chatId) {
				// Chat message (direct or group chat)
				url = `${graphBaseUrl}/me/chats/${chatId}/messages/${messageId}`;
				messageType = "chat";
			} else if (teamId && channelId) {
				// Channel message (Note: $select is not supported on channel messages endpoint)
				url = `${graphBaseUrl}/teams/${teamId}/channels/${channelId}/messages/${messageId}`;
				messageType = "channel";
			} else {
				throw new Error(
					"Either chatId (for chat messages) or both teamId and channelId (for channel messages) are required. " +
						"Use list_chats to get chatId, or list_teams and list_channels to get teamId and channelId.",
				);
			}

			const res = await graphRequest(url);
			if (!res.ok) {
				const error = await res.json().catch(() => ({}));
				throw new Error(
					`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
				);
			}

			const msg = (await res.json()) as {
				id: string;
				body?: { content: string; contentType?: string };
				from?: {
					user?: { displayName: string; email?: string };
					application?: { displayName: string };
				};
				createdDateTime?: string;
				lastModifiedDateTime?: string;
				subject?: string;
				importance?: string;
				webUrl?: string;
				attachments?: Array<{
					id: string;
					name?: string;
					contentType?: string;
				}>;
			};

			// Strip HTML tags for readability but preserve all text.
			// We cap the payload at FULL_MESSAGE_MAX_CHARS so a single call
			// to get_full_message can't blow past the model context — fanning
			// out drill-down reads across many messageIds is the common
			// overflow path.
			const rawContent = msg.body?.content || "";
			const strippedContent = rawContent
				.replace(/<[^>]*>/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			const fullCap = TEAMS_TOOL_LIMITS.FULL_MESSAGE_MAX_CHARS;
			const contentTruncated = strippedContent.length > fullCap;
			const cleanContent = contentTruncated
				? `${strippedContent.slice(0, fullCap).trimEnd()}… [truncated at ${fullCap} chars — call get_message_hosted_content for embedded images]`
				: strippedContent;

			return {
				id: msg.id,
				messageType,
				content: cleanContent,
				contentLength: cleanContent.length,
				originalContentLength: strippedContent.length,
				contentTruncated,
				from:
					msg.from?.user?.displayName ||
					msg.from?.application?.displayName ||
					"Unknown",
				fromEmail: msg.from?.user?.email || "",
				createdAt: msg.createdDateTime,
				lastModified: msg.lastModifiedDateTime,
				subject: msg.subject || "",
				importance: msg.importance || "normal",
				webUrl: msg.webUrl || "",
				hasAttachments: (msg.attachments?.length || 0) > 0,
				attachments: msg.attachments?.map((a) => ({
					id: a.id,
					name: a.name || "unnamed",
					type: a.contentType || "unknown",
				})),
			};
		}

		case "get_message_hosted_content": {
			const MAX_IMAGES = 3;
			// Max dimension for resized images — keeps base64 under ~50KB
			const MAX_IMAGE_WIDTH = 800;
			const JPEG_QUALITY = 60;

			/**
			 * Resize an image buffer to fit within MAX_IMAGE_WIDTH and convert to JPEG.
			 * Returns { base64, contentType } or null on failure.
			 */
			async function resizeImage(
				buf: ArrayBuffer,
			): Promise<{ base64: string; contentType: string } | null> {
				try {
					const resized = await sharp(Buffer.from(buf))
						.resize({
							width: MAX_IMAGE_WIDTH,
							withoutEnlargement: true,
						})
						.jpeg({ quality: JPEG_QUALITY })
						.toBuffer();
					return {
						base64: resized.toString("base64"),
						contentType: "image/jpeg",
					};
				} catch {
					return null;
				}
			}

			const messageId = args.messageId as string;
			const chatId = args.chatId as string | undefined;
			const teamId = args.teamId as string | undefined;
			const channelId = args.channelId as string | undefined;

			if (!messageId) {
				throw new Error(
					"messageId is required for get_message_hosted_content.",
				);
			}

			let baseMessageUrl: string;
			if (chatId) {
				baseMessageUrl = `${graphBaseUrl}/me/chats/${chatId}/messages/${messageId}`;
			} else if (teamId && channelId) {
				baseMessageUrl = `${graphBaseUrl}/teams/${teamId}/channels/${channelId}/messages/${messageId}`;
			} else {
				throw new Error(
					"Either chatId or both teamId and channelId are required.",
				);
			}

			const hostedImages: Array<{
				id: string;
				contentType: string;
				base64: string;
				source: string;
			}> = [];

			// Strategy 1: Extract inline image URLs from the message HTML body.
			// Teams embeds images as <img> tags with src pointing to Graph API URLs
			// e.g. https://graph.microsoft.com/.../hostedContents/{id}/$value
			//
			// The parse-`<img>`-and-extract step delegates to the shared helper
			// `extractHostedContentRefsFromHtml` so the channel-monitor fetch
			// activity (Group 3 of the chat-thread image-attachments feature)
			// and this AI Assistant tool share one implementation. The download
			// still uses the local `graphRequest` because that path carries the
			// in-place token-refresh logic that's specific to the AI Assistant
			// caller (the apply-time orchestrator uses a static token via
			// `downloadTeamsHostedContent`).
			try {
				const msgRes = await graphRequest(baseMessageUrl);
				if (msgRes.ok) {
					const msgData = (await msgRes.json()) as {
						body?: { content: string; contentType?: string };
					};
					const htmlBody = msgData.body?.content || "";

					const hostedRefs = extractHostedContentRefsFromHtml(
						htmlBody,
						messageId,
					);
					const seenHostedIds = new Set<string>();

					for (const ref of hostedRefs) {
						if (hostedImages.length >= MAX_IMAGES) {
							break;
						}
						if (seenHostedIds.has(ref.id)) {
							continue;
						}
						seenHostedIds.add(ref.id);

						try {
							const contentUrl = `${baseMessageUrl}/hostedContents/${ref.id}/$value`;
							const imgRes = await graphRequest(contentUrl);

							if (imgRes.ok) {
								const ct =
									imgRes.headers.get("content-type") ||
									"image/png";
								if (ct.startsWith("image/")) {
									const buf = await imgRes.arrayBuffer();
									const resized = await resizeImage(buf);
									if (resized) {
										hostedImages.push({
											id: ref.id,
											contentType: resized.contentType,
											base64: resized.base64,
											source: "inline_html",
										});
									}
								}
							}
						} catch {
							// Skip individual image fetch failures
						}
					}
				}
			} catch {
				// Non-fatal: fall through to hostedContents API
			}

			// Strategy 2: List hosted contents via the dedicated API endpoint.
			// Catches images uploaded as hosted content blobs (not inline).
			try {
				const listUrl = `${baseMessageUrl}/hostedContents`;
				const listRes = await graphRequest(listUrl);
				if (listRes.ok) {
					const listData = (await listRes.json()) as {
						value: Array<{ id: string; contentType?: string }>;
					};

					for (const item of listData.value || []) {
						if (hostedImages.length >= MAX_IMAGES) {
							break;
						}

						const ct = item.contentType || "";
						if (!ct.startsWith("image/")) {
							continue;
						}
						// Skip if already fetched via inline URL
						if (hostedImages.some((img) => img.id === item.id)) {
							continue;
						}

						try {
							const contentUrl = `${baseMessageUrl}/hostedContents/${item.id}/$value`;
							const contentRes = await graphRequest(contentUrl);
							if (contentRes.ok) {
								const buf = await contentRes.arrayBuffer();
								const resized = await resizeImage(buf);
								if (resized) {
									hostedImages.push({
										id: item.id,
										contentType: resized.contentType,
										base64: resized.base64,
										source: "hosted_content_api",
									});
								}
							}
						} catch {
							// Skip individual fetch failures
						}
					}
				}
			} catch {
				// Non-fatal
			}

			if (hostedImages.length === 0) {
				return {
					images: [],
					count: 0,
					message: "No images found in this message.",
				};
			}

			return {
				images: hostedImages,
				count: hostedImages.length,
			};
		}

		// ========== Meeting & Transcript Tools ==========

		case "list_calendar_meetings": {
			const now = new Date();
			const thirtyDaysAgo = new Date(
				now.getTime() - 30 * 24 * 60 * 60 * 1000,
			);
			const startDate =
				(args.startDate as string) || thirtyDaysAgo.toISOString();
			const endDate = (args.endDate as string) || now.toISOString();
			// Note: isOnlineMeeting does not support $filter on calendarView, so we fetch
			// all events and filter client-side to only include online meetings with join URLs.
			// We paginate through every page so date-range selection is never silently truncated.
			type CalendarEvent = {
				id: string;
				subject?: string;
				start?: { dateTime: string; timeZone: string };
				end?: { dateTime: string; timeZone: string };
				organizer?: {
					emailAddress?: {
						name?: string;
						address?: string;
					};
				};
				isOnlineMeeting?: boolean;
				onlineMeeting?: { joinUrl?: string };
				webLink?: string;
			};
			const allOnlineMeetings: CalendarEvent[] = [];
			const pageSize = 50;
			let nextUrl: string | null =
				`${graphBaseUrl}/me/calendarView?startDateTime=${encodeURIComponent(startDate)}&endDateTime=${encodeURIComponent(endDate)}&$select=id,subject,start,end,organizer,isOnlineMeeting,onlineMeeting,webLink&$top=${pageSize}&$orderby=start/dateTime desc`;

			// Paginate through all Graph API pages (safety cap at 20 pages = 1000 raw events)
			for (let page = 0; page < 20 && nextUrl; page++) {
				const res = await graphRequest(nextUrl);
				if (!res.ok) {
					const error = await res.json().catch(() => ({}));
					throw new Error(
						`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
					);
				}
				const data = await res.json();

				const onlineMeetings = (
					(data.value || []) as CalendarEvent[]
				).filter(
					(event) =>
						event.isOnlineMeeting && event.onlineMeeting?.joinUrl,
				);
				allOnlineMeetings.push(...onlineMeetings);

				nextUrl = data["@odata.nextLink"] || null;
			}

			return {
				meetings: allOnlineMeetings.map((event) => ({
					id: event.id,
					subject: event.subject || "Untitled Meeting",
					start: event.start?.dateTime,
					end: event.end?.dateTime,
					organizer:
						event.organizer?.emailAddress?.name ||
						event.organizer?.emailAddress?.address ||
						"Unknown",
					joinUrl: event.onlineMeeting?.joinUrl || null,
					webLink: event.webLink || "",
				})),
				count: allOnlineMeetings.length,
				dateRange: { startDate, endDate },
				tip: "Use get_meeting_by_join_url with the joinUrl to resolve the meeting ID needed for transcript access.",
			};
		}

		case "get_meeting_by_join_url": {
			const joinWebUrl = args.joinWebUrl as string;
			if (!joinWebUrl) {
				throw new Error(
					"joinWebUrl is required for get_meeting_by_join_url. Get this from list_calendar_meetings results (the joinUrl field).",
				);
			}

			// Decode any percent-encoding (LLM may pass already-encoded URLs from Teams links)
			// then use URL + searchParams to properly encode the OData filter value,
			// avoiding double-encoding while handling special chars like @ and : safely.
			// Guard against malformed %-sequences (e.g. truncated URLs) that throw URIError.
			let decodedUrl: string;
			try {
				decodedUrl = decodeURIComponent(joinWebUrl);
			} catch {
				decodedUrl = joinWebUrl;
			}
			const graphUrl = new URL(`${graphBaseUrl}/me/onlineMeetings`);
			graphUrl.searchParams.set(
				"$filter",
				`JoinWebUrl eq '${decodedUrl}'`,
			);
			const url = graphUrl.toString();

			const res = await graphRequest(url);
			if (!res.ok) {
				const error = await res.json().catch(() => ({}));
				if (res.status === 400) {
					return {
						error: "Invalid meeting join URL. The URL provided may not be a valid Teams meeting link. Ensure you use the joinUrl from list_calendar_meetings results.",
						meeting: null,
						detail: `${res.status} ${res.statusText}`,
					};
				}
				throw new Error(
					`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
				);
			}
			const data = await res.json();
			const meetings = data.value || [];

			if (meetings.length === 0) {
				return {
					error: "No online meeting found for this join URL. The meeting may have expired or the URL may be incorrect.",
					meeting: null,
				};
			}

			const meeting = meetings[0] as {
				id: string;
				subject?: string;
				startDateTime?: string;
				endDateTime?: string;
				joinWebUrl?: string;
				participants?: {
					organizer?: {
						identity?: {
							user?: { displayName?: string; id?: string };
						};
					};
				};
			};

			return {
				meeting: {
					id: meeting.id,
					subject: meeting.subject || "Untitled Meeting",
					startDateTime: meeting.startDateTime,
					endDateTime: meeting.endDateTime,
					joinWebUrl: meeting.joinWebUrl,
					organizer:
						meeting.participants?.organizer?.identity?.user
							?.displayName || "Unknown",
					organizerUserId:
						meeting.participants?.organizer?.identity?.user?.id ||
						null,
				},
				tip: "Use the meeting id with list_meeting_transcripts to find available transcripts.",
			};
		}

		case "list_meeting_transcripts": {
			const meetingId = args.meetingId as string;
			if (!meetingId) {
				throw new Error(
					"meetingId is required for list_meeting_transcripts. Get this from get_meeting_by_join_url first.",
				);
			}

			const url = `${graphBaseUrl}/me/onlineMeetings/${meetingId}/transcripts?$select=id,createdDateTime,meetingOrganizer`;

			const res = await graphRequest(url);

			// Graceful 403 handling: distinguish the tenant-admin transcript
			// controls from a genuinely missing app permission.
			if (res.status === 403) {
				const error = (await res.json().catch(() => ({}))) as {
					error?: {
						code?: string;
						message?: string;
						innerError?: { code?: string };
					};
				};
				const classification = classifyTranscriptForbidden(error);
				if (classification) {
					return {
						...classification,
						transcripts: [],
						count: 0,
					};
				}
			}

			if (!res.ok) {
				const error = await res.json().catch(() => ({}));
				throw new Error(
					`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
				);
			}

			const data = await res.json();
			return {
				transcripts: (data.value || []).map(
					(transcript: {
						id: string;
						createdDateTime?: string;
						meetingOrganizer?: {
							identity?: {
								user?: {
									displayName?: string;
									id?: string;
								};
							};
						};
					}) => ({
						id: transcript.id,
						createdDateTime: transcript.createdDateTime,
						organizer:
							transcript.meetingOrganizer?.identity?.user
								?.displayName || "Unknown",
					}),
				),
				count: (data.value || []).length,
				tip: "Use get_meeting_transcript_content with the transcript id to fetch the actual transcript text.",
			};
		}

		case "get_meeting_transcript_content": {
			const meetingId = args.meetingId as string;
			const transcriptId = args.transcriptId as string;
			const format = (args.format as string) || "structured";

			if (!meetingId || !transcriptId) {
				throw new Error(
					"meetingId and transcriptId are required for get_meeting_transcript_content. Get these from list_meeting_transcripts.",
				);
			}

			// Try structured metadata first (preferred), fall back to VTT
			const useStructured = format !== "vtt";
			const contentEndpoint = useStructured
				? "metadataContent"
				: "content";
			const url = `${graphBaseUrl}/me/onlineMeetings/${meetingId}/transcripts/${transcriptId}/${contentEndpoint}`;

			let res = await graphRequest(url, {
				headers: {
					Accept: useStructured ? "application/json" : "text/vtt",
				},
			});

			// Graceful 403 handling: distinguish the tenant-admin transcript
			// controls from a genuinely missing app permission.
			if (res.status === 403) {
				const error = (await res.json().catch(() => ({}))) as {
					error?: {
						code?: string;
						message?: string;
						innerError?: { code?: string };
					};
				};
				const classification = classifyTranscriptForbidden(error);
				if (classification) {
					return classification;
				}
			}

			// If structured metadata fails with 404, fall back to VTT
			if (!res.ok && useStructured && res.status === 404) {
				const vttUrl = `${graphBaseUrl}/me/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content`;
				res = await graphRequest(vttUrl, {
					headers: { Accept: "text/vtt" },
				});

				if (res.ok) {
					const vttContent = await res.text();
					// Parse VTT into structured format
					const entries = parseVttToStructured(vttContent);
					return {
						format: "vtt_parsed",
						entries,
						count: entries.length,
						note: "Structured metadata was not available. Parsed from WebVTT format.",
					};
				}
			}

			if (!res.ok) {
				const error = await res.json().catch(() => ({}));
				throw new Error(
					`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
				);
			}

			if (useStructured) {
				// The metadataContent endpoint may return VTT instead of JSON
				// depending on the tenant/meeting configuration. Check content-type
				// before parsing to avoid JSON parse errors on VTT responses.
				const contentType = res.headers.get("content-type") || "";
				const responseText = await res.text();

				if (
					contentType.includes("application/json") ||
					responseText.trimStart().startsWith("{") ||
					responseText.trimStart().startsWith("[")
				) {
					const data = JSON.parse(responseText);
					// metadataContent may return a top-level array, or an object with .values/.value
					const rawEntries = Array.isArray(data)
						? data
						: data.values || data.value || [];
					const entries = rawEntries.map(
						(entry: {
							speakerName?: string;
							spokenText?: string;
							spokenLanguage?: string;
							startDateTime?: string;
							endDateTime?: string;
						}) => ({
							speaker: entry.speakerName || "Unknown",
							text: entry.spokenText || "",
							language: entry.spokenLanguage || "",
							start: entry.startDateTime,
							end: entry.endDateTime,
						}),
					);
					return {
						format: "structured",
						entries,
						count: entries.length,
					};
				}

				// Response is VTT text despite requesting structured - parse it
				const entries = parseVttToStructured(responseText);
				return {
					format: "vtt_parsed",
					entries,
					count: entries.length,
					note: "Structured metadata returned VTT format. Parsed from WebVTT.",
				};
			}

			// Raw VTT format
			const vttContent = await res.text();
			return {
				format: "vtt",
				content: vttContent,
				contentLength: vttContent.length,
			};
		}

		// ========== Channel-meeting transcripts, via the recording ==========
		// Graph's meeting-transcript API answers 200-with-an-empty-list for
		// channel meetings (`19:…@thread.tacv2`), so these two mirror
		// list_meeting_transcripts / get_meeting_transcript_content against the
		// recording in the channel's SharePoint library instead. Deliberately
		// not advertised to the assistant: this is a fallback for the sync
		// pipeline, and the Graph pair remains the route for every meeting type
		// Graph actually serves. See ./stream-transcript.ts.

		case "list_recording_transcripts": {
			const joinUrl = args.joinUrl as string;
			const meetingSubject = (args.meetingSubject as string) || "";
			const meetingDate = args.meetingDate as string;

			if (!joinUrl || !meetingDate) {
				throw new Error(
					"joinUrl and meetingDate are required for list_recording_transcripts.",
				);
			}

			return await listRecordingTranscripts({
				graphFetch: graphRequest,
				graphBaseUrl,
				joinUrl,
				meetingSubject,
				meetingDate,
				userId,
			});
		}

		case "get_recording_transcript_content": {
			const driveId = args.driveId as string;
			const recordingItemId = args.recordingItemId as string;
			const recordingWebUrl = args.recordingWebUrl as string;

			if (!driveId || !recordingItemId || !recordingWebUrl) {
				throw new Error(
					"driveId, recordingItemId and recordingWebUrl are required for get_recording_transcript_content. Get these from list_recording_transcripts.",
				);
			}
			if (!refreshToken) {
				throw new Error(
					"Microsoft account in Settings must be reconnected: no refresh token is stored, and reading a channel recording needs one.",
				);
			}

			const { entries, speakerCount } =
				await getRecordingTranscriptContent({
					graphFetch: graphRequest,
					graphBaseUrl,
					driveId,
					recordingItemId,
					recordingWebUrl,
					refreshToken,
					integrationId: integration.id,
					onRefreshTokenRotated: (rotated) =>
						updateStoredRefreshToken(integration.id, rotated),
				});

			return {
				format: "structured",
				entries,
				count: entries.length,
				speakerCount,
			};
		}

		// get_all_my_transcripts stays disabled, but NOT for the reason previously
		// recorded here: OnlineMeetingTranscript.Read.All admin consent *is*
		// granted on the app registration (verified against the tenant's Graph
		// permission list). The real limit is what the endpoint can reach — it
		// returns only meetings the caller organized that have a backing calendar
		// event, and 403s with code 3003 otherwise, so it cannot stand in for a
		// general "all my transcripts" listing. No permission change fixes that.
		// Use the per-meeting tools instead (get_meeting_by_join_url →
		// list_meeting_transcripts → get_meeting_transcript_content).
		// case "get_all_my_transcripts": { ... }

		// ========== Send Message ==========
		case "send_message": {
			const teamId = args.teamId as string | undefined;
			const channelId = args.channelId as string | undefined;
			const chatId = args.chatId as string | undefined;
			const messageId = args.messageId as string | undefined;
			const text = args.text as string | undefined;
			const content = args.content as string | undefined;

			const messageBody = text || content || "";
			if (!messageBody) {
				throw new Error(
					"send_message requires 'text' or 'content' parameter",
				);
			}

			const body = {
				body: {
					contentType: "text",
					content: messageBody,
				},
			};

			let url: string;
			if (teamId && channelId && messageId) {
				// Reply to a channel message
				url = `${graphBaseUrl}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies`;
			} else if (teamId && channelId) {
				// Post to a channel
				url = `${graphBaseUrl}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
			} else if (chatId) {
				// Post to a chat
				url = `${graphBaseUrl}/chats/${encodeURIComponent(chatId)}/messages`;
			} else {
				throw new Error(
					"send_message requires either (teamId + channelId) or chatId. For replies, also provide messageId.",
				);
			}

			const res = await graphRequest(url, {
				method: "POST",
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const error = await res.json().catch(() => ({}));
				throw new Error(
					`Microsoft Graph API error: ${res.status} ${res.statusText} - ${JSON.stringify(error)}`,
				);
			}

			const data = await res.json();
			return {
				success: true,
				messageId: data.id,
				conversation: {
					id: data.conversation?.id,
					conversationType: data.conversation?.conversationType,
				},
				createdDateTime: data.createdDateTime,
			};
		}

		default:
			throw new Error(`Unknown Microsoft Teams tool: ${methodName}`);
	}
}
