/**
 * GitLab Integration Utilities
 *
 * Shared execution functions for GitLab API integrations.
 * These functions handle the actual API calls using credentials from WorkflowIntegration.
 *
 * Used by both:
 * - Temporal activities (orchestrator tool loader for agent execution)
 * - API layer (for project settings, repo listing)
 *
 * Features:
 * - Automatic token refresh when access token expires
 * - Automatic 401 retry with token refresh
 * - Concurrent refresh lock to prevent race conditions
 */

import { db } from "@repo/database";
import { withRefreshLock } from "@repo/database/prisma/queries/lib/refresh-lock";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { GitLabApiError } from "./rest-client";

export * from "./capabilities";
export * from "./get-valid-access-token";
export * from "./integration-settings";
export * from "./mcp-client";
export * from "./oauth-refresh";
export * from "./pm-adapter";
export * from "./probe-mcp";
export * from "./refresh-failure-writer";
export * from "./refresh-mcp-config-token";
export * from "./rest-client";
export * from "./source";

const GITLAB_API_URL = "https://gitlab.com/api/v4";

// Module-level refresh lock to prevent concurrent token refresh races.
// When multiple concurrent requests hit a 401, only the first one refreshes
// the token; the rest await the same promise and reuse the result.
const refreshInProgress = new Map<string, Promise<string>>();

function gitlabHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"User-Agent": "Fabric-App",
	};
}

export async function gitlabFetch(
	token: string,
	path: string,
	params?: Record<string, string>,
): Promise<unknown> {
	const url = new URL(`${GITLAB_API_URL}${path}`);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "") {
				url.searchParams.set(key, value);
			}
		}
	}

	const response = await fetch(url.toString(), {
		headers: gitlabHeaders(token),
	});

	const data = await response.json();

	if (!response.ok) {
		const message =
			(data as { message?: string; error?: string }).message ||
			(data as { error?: string }).error ||
			`GitLab API error: ${response.status}`;
		throw new GitLabApiError(response.status, message);
	}

	return data;
}

export async function gitlabPost(
	token: string,
	path: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const response = await fetch(`${GITLAB_API_URL}${path}`, {
		method: "POST",
		headers: {
			...gitlabHeaders(token),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const data = await response.json();

	if (!response.ok) {
		const message =
			(data as { message?: string; error?: string }).message ||
			(data as { error?: string }).error ||
			`GitLab API error: ${response.status}`;
		throw new GitLabApiError(response.status, message);
	}

	return data;
}

async function gitlabPut(
	token: string,
	path: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const response = await fetch(`${GITLAB_API_URL}${path}`, {
		method: "PUT",
		headers: {
			...gitlabHeaders(token),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const data = await response.json();

	if (!response.ok) {
		const message =
			(data as { message?: string; error?: string }).message ||
			(data as { error?: string }).error ||
			`GitLab API error: ${response.status}`;
		throw new GitLabApiError(response.status, message);
	}

	return data;
}

interface ParsedCredentials {
	access_token?: string;
	GITLAB_ACCESS_TOKEN?: string;
	token?: string;
	apiKey?: string;
	refresh_token?: string;
	expires_in?: number;
	refresh_token_expires_in?: number;
	token_obtained_at?: string;
}

/**
 * Prisma client able to persist the refreshed credential. Satisfied by both the
 * root client and a transaction client, so the locked path can hand in its `tx`
 * and avoid checking out a second pooled connection.
 */
type RefreshWriter = Pick<typeof db, "workflowIntegration">;

/** Parse a stored credentials blob, or null when it is a raw token string. */
function safeParseCredentials(
	credentialsJson: string,
): ParsedCredentials | null {
	try {
		const parsed = JSON.parse(credentialsJson) as ParsedCredentials;
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}

function extractAccessToken(credentialsJson: string): string {
	try {
		const parsed = JSON.parse(credentialsJson) as ParsedCredentials;
		if (typeof parsed !== "object" || parsed === null) {
			return credentialsJson;
		}
		const token =
			parsed.access_token ||
			parsed.GITLAB_ACCESS_TOKEN ||
			parsed.token ||
			parsed.apiKey ||
			"";
		if (!token) {
			throw new Error("No access token found in GitLab credentials");
		}
		return token;
	} catch (e) {
		if (e instanceof SyntaxError) {
			return credentialsJson;
		}
		throw e;
	}
}

function isTokenExpired(credentials: ParsedCredentials): boolean {
	if (!credentials.expires_in) {
		// No expiry info. GitLab OAuth access tokens DO expire (~2h), and rows
		// persisted before `expires_in` was captured will be missing it. When a
		// refresh token is present, force a one-time refresh — the refreshed
		// credentials carry `expires_in`, so subsequent checks are precise.
		// PATs (no refresh token) genuinely don't expire and are left as-is.
		return !!credentials.refresh_token;
	}
	if (!credentials.token_obtained_at) {
		// Has expires_in but no timestamp — pre-patch connection.
		// Conservatively treat as expired to trigger a refresh attempt.
		return !!credentials.refresh_token;
	}
	const obtainedAt = new Date(credentials.token_obtained_at).getTime();
	const expiresAt = obtainedAt + credentials.expires_in * 1000;
	const bufferMs = 5 * 60 * 1000; // Refresh 5 minutes before expiry
	return Date.now() >= expiresAt - bufferMs;
}

async function getGitLabClientCredentials(
	userId?: string,
	organizationId?: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
	// Check env vars first
	const envClientId = process.env.GITLAB_CLIENT_ID;
	const envClientSecret = process.env.GITLAB_CLIENT_SECRET;
	if (envClientId && envClientSecret) {
		return { clientId: envClientId, clientSecret: envClientSecret };
	}

	// Fall back to DB-stored app credentials.
	// Mirror the same lookup chain as getOAuthCredentialsWithDb():
	// org-scoped → personal → any/global (admin-configured)
	try {
		const whereConditions: Record<string, unknown>[] = [];
		if (organizationId) {
			whereConditions.push({
				organizationId,
				provider: "GITLAB",
				name: "GITLAB_OAUTH_APP",
				isActive: true,
			});
		}
		if (userId) {
			whereConditions.push({
				userId,
				organizationId: null,
				provider: "GITLAB",
				name: "GITLAB_OAUTH_APP",
				isActive: true,
			});
		}
		// Also check for system-level admin-configured credentials
		// (must have null userId and organizationId to avoid cross-tenant leakage)
		whereConditions.push({
			userId: null,
			organizationId: null,
			provider: "GITLAB",
			name: "GITLAB_OAUTH_APP",
			isActive: true,
		});

		for (const where of whereConditions) {
			const appConfig = await db.workflowIntegration.findFirst({
				where: where as any,
			});
			if (appConfig?.credentials) {
				try {
					const decrypted = JSON.parse(
						decryptApiKey(appConfig.credentials),
					) as Record<string, string>;
					if (decrypted.client_id && decrypted.client_secret) {
						return {
							clientId: decrypted.client_id,
							clientSecret: decrypted.client_secret,
						};
					}
				} catch {
					// Decryption failed, try next
				}
			}
		}
	} catch {
		// DB lookup failed, fall through
	}

	return null;
}

/**
 * Persist `needsReauth=true` plus failure metadata in the WorkflowIntegration's
 * settings JSON when the refresh exchange returns a permanent failure
 * (invalid_grant, revoked refresh token, bad client creds). The
 * `gitlab/status` procedure reads `settings.needsReauth` and surfaces the
 * "Reconnect required" callout on the provider page — without this write,
 * a dead refresh token only reveals itself when the user tries to USE the
 * integration, never proactively.
 *
 * Mirrors `markNeedsReauthOnTx` in packages/api/modules/integrations/lib/
 * gitlab-token.ts; reimplemented here because that helper lives upstream of
 * this package and pulling it in would invert the dependency direction.
 *
 * Best-effort: a write failure here must not mask the original refresh
 * error the caller is about to throw.
 */
async function markWorkflowIntegrationNeedsReauth(
	integrationId: string,
	reason: string,
	/**
	 * Runs inside `withRefreshLock` on a permanent refresh failure, so it must
	 * write through the transaction client — issuing these two queries on the
	 * outer `db` would request extra pooled connections while the lock already
	 * holds one, which can starve the pool under concurrency.
	 */
	writer: RefreshWriter = db,
): Promise<void> {
	try {
		const wi = await writer.workflowIntegration.findUnique({
			where: { id: integrationId },
			select: { settings: true },
		});
		const existing =
			typeof wi?.settings === "object" && wi.settings !== null
				? (wi.settings as Record<string, unknown>)
				: {};
		// Drop cached capability probe alongside marking needsReauth so the
		// transport badge doesn't keep saying "Connected via REST" after the
		// refresh died. Same shape `markNeedsReauthOnTx` uses.
		const {
			useOfficialMcp: _u,
			mcpProbe: _p,
			...preserved
		} = existing as {
			useOfficialMcp?: unknown;
			mcpProbe?: unknown;
		};
		await writer.workflowIntegration.update({
			where: { id: integrationId },
			data: {
				settings: {
					...preserved,
					needsReauth: true,
					lastRefreshFailedAt: new Date().toISOString(),
					lastRefreshError: reason.slice(0, 500),
				},
			},
		});
		console.warn(
			"[GitLab] Marked WorkflowIntegration needsReauth after permanent refresh failure",
			{ integrationId, reason: reason.slice(0, 200) },
		);
	} catch (markErr) {
		console.error(
			"[GitLab] Failed to persist needsReauth on WorkflowIntegration",
			{
				integrationId,
				error: markErr instanceof Error ? markErr.message : markErr,
			},
		);
	}
}

/**
 * Perform the actual GitLab token refresh via OAuth endpoint.
 * Separated from refreshTokenIfNeeded so it can be reused by the 401 retry path.
 *
 * NOTE: GitLab requires application/x-www-form-urlencoded for token refresh (not JSON).
 */
async function performTokenRefresh(
	integration: {
		id: string;
		settings: unknown;
	},
	refreshTokenValue: string,
	userId?: string,
	organizationId?: string,
	/**
	 * Transaction client when running inside `withRefreshLock`. Writes MUST go
	 * through it: the lock holds one pooled connection for the whole exchange, so
	 * issuing the persist on the outer `db` would request a SECOND connection
	 * from the same (default 10) pool and can deadlock it under concurrency.
	 */
	writer: RefreshWriter = db,
	/** Pre-resolved app credentials, looked up outside the lock. */
	preResolvedCreds?: { clientId: string; clientSecret: string } | null,
): Promise<string> {
	const creds =
		preResolvedCreds !== undefined
			? preResolvedCreds
			: await getGitLabClientCredentials(userId, organizationId);

	if (!creds) {
		throw new Error(
			"Cannot refresh GitLab token: no client credentials configured. " +
				"Set GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET, " +
				"or reconnect your GitLab account.",
		);
	}

	const { clientId, clientSecret } = creds;

	console.log("[GitLab] Refreshing expired access token...");

	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: "refresh_token",
		refresh_token: refreshTokenValue,
	});

	const response = await fetch("https://gitlab.com/oauth/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
	});

	if (!response.ok) {
		// Read the response body to distinguish permanent (invalid_grant,
		// revoked refresh token, bad client creds) from transient (5xx,
		// rate limits) failures. Only the permanent kind warrants flipping
		// needsReauth — surfacing the red "Reconnect required" callout for
		// a transient 503 would make every blip look like the user's fault.
		const errorBody = await response.text().catch(() => "");
		const isPermanent = response.status === 400 || response.status === 401;
		if (isPermanent) {
			await markWorkflowIntegrationNeedsReauth(
				integration.id,
				`GitLab refresh returned ${response.status}: ${errorBody.slice(0, 200)}`,
				writer,
			);
		}
		throw new Error(
			`GitLab token refresh failed: ${response.status}${
				errorBody ? ` ${errorBody.slice(0, 200)}` : ""
			}`,
		);
	}

	const data = (await response.json()) as ParsedCredentials & {
		error?: string;
		token_type?: string;
		scope?: string;
	};

	if (data.error || !data.access_token) {
		// `error` in a 200 body is the OAuth-spec convention for client-side
		// failures GitLab will still return as 200; treat them as permanent
		// the same way as 4xx above.
		if (data.error) {
			await markWorkflowIntegrationNeedsReauth(
				integration.id,
				`GitLab refresh error: ${data.error}`,
				writer,
			);
		}
		throw new Error(
			`GitLab token refresh error: ${data.error || "no access_token in response"}`,
		);
	}

	// Store refreshed credentials
	const newCredentials = JSON.stringify({
		access_token: data.access_token,
		token_type: data.token_type || "bearer",
		scope: data.scope,
		refresh_token: data.refresh_token || refreshTokenValue,
		expires_in: data.expires_in,
		refresh_token_expires_in: data.refresh_token_expires_in,
		token_obtained_at: new Date().toISOString(),
	});

	const existingSettings =
		typeof integration.settings === "object" &&
		integration.settings !== null
			? integration.settings
			: {};

	await writer.workflowIntegration.update({
		where: { id: integration.id },
		data: {
			credentials: encryptApiKey(newCredentials),
			settings: {
				...(existingSettings as Record<string, unknown>),
				tokenExpiresAt: data.expires_in
					? new Date(
							Date.now() + data.expires_in * 1000,
						).toISOString()
					: null,
			},
			updatedAt: new Date(),
		},
	});

	console.log("[GitLab] Successfully refreshed access token");
	return data.access_token;
}

/**
 * Refresh the token with a per-integration lock to prevent concurrent refresh races.
 * If another request is already refreshing, awaits that result instead of duplicating.
 */
async function refreshTokenWithLock(
	integration: {
		id: string;
		settings: unknown;
	},
	refreshTokenValue: string,
	userId?: string,
	organizationId?: string,
): Promise<string> {
	const integrationId = integration.id;
	let existing = refreshInProgress.get(integrationId);
	if (!existing) {
		// In-process dedupe first (cheap), then the cross-process advisory lock.
		// The Map alone only serializes ONE Node process; web and worker are
		// separate processes and GitLab rotates refresh tokens single-use, so
		// without the DB lock they burn each other's grant and the loser both
		// fails AND marks a healthy connection needsReauth. This is what the
		// staging `invalid_grant` storm was.
		// App credentials are static config, not per-integration state, so they
		// are resolved BEFORE the lock. Looking them up inside would hold the
		// lock's pooled connection while requesting a SECOND one from the same
		// (default 10) pool — under concurrency that starves the pool until the
		// transaction times out, and the timeout path then marks healthy
		// connections needsReauth: the very bug this lock exists to prevent.
		existing = getGitLabClientCredentials(userId, organizationId)
			.then((creds) => {
				// Fail fast: a misconfigured deployment must not acquire an advisory
				// lock and a pooled transaction just to throw inside it.
				if (!creds) {
					throw new Error(
						"Cannot refresh GitLab token: no client credentials configured. " +
							"Set GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET, " +
							"or reconnect your GitLab account.",
					);
				}
				return withRefreshLock(`wfint:${integrationId}`, async (tx) => {
					// Re-read inside the lock — a winner may have rotated while we
					// queued, and exchanging their fresh token again would kill it.
					const fresh = await tx.workflowIntegration.findUnique({
						where: { id: integrationId },
						select: { credentials: true },
					});
					if (fresh?.credentials) {
						const decrypted = decryptApiKey(fresh.credentials);
						const parsed = safeParseCredentials(decrypted);
						if (parsed && !isTokenExpired(parsed)) {
							return extractAccessToken(decrypted);
						}
						if (parsed?.refresh_token) {
							refreshTokenValue = parsed.refresh_token;
						}
					}
					return performTokenRefresh(
						integration,
						refreshTokenValue,
						userId,
						organizationId,
						tx,
						creds,
					);
				});
			})
			.finally(() => {
				refreshInProgress.delete(integrationId);
			});
		refreshInProgress.set(integrationId, existing);
	}
	return existing;
}

async function refreshTokenIfNeeded(
	integration: {
		id: string;
		credentials: string;
		settings: unknown;
	},
	userId?: string,
	organizationId?: string,
): Promise<string> {
	const credentialsJson = decryptApiKey(integration.credentials);
	let parsed: ParsedCredentials;
	try {
		parsed = JSON.parse(credentialsJson) as ParsedCredentials;
	} catch {
		return credentialsJson; // Raw token string, no refresh possible
	}

	if (typeof parsed !== "object" || parsed === null) {
		return credentialsJson;
	}

	const currentToken = extractAccessToken(credentialsJson);

	if (!isTokenExpired(parsed) || !parsed.refresh_token) {
		return currentToken;
	}

	// Token is expired and we have a refresh token — try to refresh
	try {
		return await refreshTokenWithLock(
			integration,
			parsed.refresh_token,
			userId,
			organizationId,
		);
	} catch (error) {
		console.error("[GitLab] Pre-emptive token refresh failed:", error);
		// Return current token and let the 401 retry handle it
		return currentToken;
	}
}

// ============================================================================
// Tool Handlers
// ============================================================================

interface GitLabProject {
	id: number;
	name: string;
	path_with_namespace: string;
	visibility: string;
	default_branch: string;
	description: string | null;
	web_url: string;
	updated_at: string;
}

async function listProjects(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const perPage = String(args.per_page || 30);

	const projects = (await gitlabFetch(token, "/projects", {
		membership: "true",
		order_by: "updated_at",
		sort: "desc",
		per_page: perPage,
	})) as GitLabProject[];

	return projects.map((p) => ({
		name: p.path_with_namespace,
		private: p.visibility === "private",
		default_branch: p.default_branch,
		description: p.description,
		url: p.web_url,
		updated_at: p.updated_at,
	}));
}

async function getProject(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id } = args as { project_id: string | number };
	if (!project_id) {
		throw new Error("project_id is required");
	}
	return gitlabFetch(token, `/projects/${encodeURIComponent(project_id)}`);
}

async function listIssues(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id } = args as { project_id: string | number };
	if (!project_id) {
		throw new Error("project_id is required");
	}

	const state = (args.state as string) || "all";
	const perPage = String(args.per_page || 100);
	const page = String(args.page || 1);

	const issues = (await gitlabFetch(
		token,
		`/projects/${encodeURIComponent(project_id)}/issues`,
		{
			state,
			per_page: perPage,
			page,
		},
	)) as Array<{
		iid: number;
		title: string;
		state: string;
		author: { username: string } | null;
		labels: string[];
		created_at: string;
		updated_at: string;
		web_url: string;
		description: string | null;
	}>;

	return issues.map((i) => ({
		number: i.iid,
		title: i.title,
		state: i.state,
		author: i.author?.username,
		labels: i.labels,
		created_at: i.created_at,
		updated_at: i.updated_at,
		url: i.web_url,
		body: i.description ? i.description.substring(0, 500) : null,
	}));
}

async function getIssue(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id, issue_iid } = args as {
		project_id: string | number;
		issue_iid: number;
	};
	if (!project_id || !issue_iid) {
		throw new Error("project_id and issue_iid are required");
	}
	return gitlabFetch(
		token,
		`/projects/${encodeURIComponent(project_id)}/issues/${issue_iid}`,
	);
}

async function listIssueNotes(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id, issue_iid } = args as {
		project_id: string | number;
		issue_iid: number;
	};
	if (!project_id || !issue_iid) {
		throw new Error("project_id and issue_iid are required");
	}
	const perPage = String(args.per_page || 100);
	const page = String(args.page || 1);
	return gitlabFetch(
		token,
		`/projects/${encodeURIComponent(project_id)}/issues/${issue_iid}/notes`,
		{ per_page: perPage, page, sort: "asc", order_by: "created_at" },
	);
}

async function getMergeRequest(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id, merge_request_iid } = args as {
		project_id: string | number;
		merge_request_iid: number;
	};
	if (!project_id || !merge_request_iid) {
		throw new Error("project_id and merge_request_iid are required");
	}
	return gitlabFetch(
		token,
		`/projects/${encodeURIComponent(project_id)}/merge_requests/${merge_request_iid}`,
	);
}

async function listMergeRequests(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id } = args as { project_id: string | number };
	if (!project_id) {
		throw new Error("project_id is required");
	}

	const params: Record<string, string> = {
		state: (args.state as string) || "opened",
		per_page: String(args.per_page || 30),
	};
	if (args.source_branch) {
		params.source_branch = args.source_branch as string;
	}
	if (args.target_branch) {
		params.target_branch = args.target_branch as string;
	}

	const mergeRequests = (await gitlabFetch(
		token,
		`/projects/${encodeURIComponent(project_id)}/merge_requests`,
		params,
	)) as Array<{
		iid: number;
		title: string;
		state: string;
		author: { username: string } | null;
		source_branch: string;
		target_branch: string;
		draft: boolean;
		work_in_progress: boolean;
		merged_at: string | null;
		created_at: string;
		updated_at: string;
		web_url: string;
	}>;

	return mergeRequests.map((mr) => ({
		number: mr.iid,
		title: mr.title,
		state: mr.state,
		author: mr.author?.username,
		source_branch: mr.source_branch,
		target_branch: mr.target_branch,
		draft: mr.draft || mr.work_in_progress,
		merged_at: mr.merged_at,
		created_at: mr.created_at,
		updated_at: mr.updated_at,
		url: mr.web_url,
	}));
}

async function createMergeRequest(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id, title, source_branch, target_branch, description } =
		args as {
			project_id: string | number;
			title: string;
			source_branch: string;
			target_branch: string;
			description?: string;
		};
	if (!project_id || !title || !source_branch || !target_branch) {
		throw new Error(
			"project_id, title, source_branch, and target_branch are required",
		);
	}

	const mr = (await gitlabPost(
		token,
		`/projects/${encodeURIComponent(project_id)}/merge_requests`,
		{
			title,
			source_branch,
			target_branch,
			description: description || "",
		},
	)) as { web_url?: string; title?: string; iid?: number };

	return {
		...mr,
		structuredContent: {
			url: mr.web_url,
			title: mr.title ?? title,
			number: mr.iid,
		},
	};
}

async function createIssue(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id, title, description, labels, assignee_ids } = args as {
		project_id: string | number;
		title: string;
		description?: string;
		labels?: string | string[];
		assignee_ids?: number[];
	};
	if (!project_id || !title) {
		throw new Error("project_id and title are required");
	}

	const payload: Record<string, unknown> = { title };
	if (description) {
		payload.description = description;
	}
	if (labels) {
		// GitLab expects labels as a comma-separated string
		payload.labels = Array.isArray(labels) ? labels.join(",") : labels;
	}
	if (assignee_ids?.length) {
		payload.assignee_ids = assignee_ids;
	}

	const issue = (await gitlabPost(
		token,
		`/projects/${encodeURIComponent(project_id)}/issues`,
		payload,
	)) as { web_url?: string; title?: string; iid?: number };

	return {
		...issue,
		structuredContent: {
			url: issue.web_url,
			title: issue.title ?? title,
			number: issue.iid,
		},
	};
}

async function getFileContents(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id, path, ref } = args as {
		project_id: string | number;
		path: string;
		ref?: string;
	};
	if (!project_id || !path) {
		throw new Error("project_id and path are required");
	}

	const branch = ref || "main";

	// Try file endpoint first
	try {
		const result = (await gitlabFetch(
			token,
			`/projects/${encodeURIComponent(project_id)}/repository/files/${encodeURIComponent(path)}`,
			{ ref: branch },
		)) as {
			content: string;
			file_name: string;
			file_path: string;
			size: number;
			encoding: string;
			blob_id: string;
		};

		// GitLab returns null content for binary files
		if (!result.content || result.encoding !== "base64") {
			return {
				path: result.file_path,
				sha: result.blob_id,
				size: result.size,
				content: "(binary file)",
				encoding: result.encoding,
				url: `${GITLAB_API_URL}/projects/${encodeURIComponent(project_id)}/repository/files/${encodeURIComponent(path)}`,
			};
		}

		const decoded = Buffer.from(result.content, "base64").toString("utf-8");
		return {
			path: result.file_path,
			sha: result.blob_id,
			size: result.size,
			content: decoded,
			url: `${GITLAB_API_URL}/projects/${encodeURIComponent(project_id)}/repository/files/${encodeURIComponent(path)}`,
		};
	} catch (error) {
		// If 404, try tree endpoint (directory listing)
		if (error instanceof GitLabApiError && error.status === 404) {
			const tree = (await gitlabFetch(
				token,
				`/projects/${encodeURIComponent(project_id)}/repository/tree`,
				{ path, ref: branch },
			)) as Array<{
				name: string;
				path: string;
				type: string;
				mode: string;
			}>;

			return tree.map((item) => ({
				name: item.name,
				path: item.path,
				type: item.type,
				size: 0,
			}));
		}
		throw error;
	}
}

async function listBranches(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id } = args as { project_id: string | number };
	if (!project_id) {
		throw new Error("project_id is required");
	}

	const perPage = String(args.per_page || 30);

	const branches = (await gitlabFetch(
		token,
		`/projects/${encodeURIComponent(project_id)}/repository/branches`,
		{ per_page: perPage },
	)) as Array<{
		name: string;
		protected: boolean;
		commit: { id: string } | null;
	}>;

	return branches.map((b) => ({
		name: b.name,
		protected: b.protected,
		sha: b.commit?.id,
	}));
}

async function searchCommits(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id, search, ref_name } = args as {
		project_id: string | number;
		search?: string;
		ref_name?: string;
	};
	if (!project_id) {
		throw new Error("project_id is required");
	}
	if (!search) {
		throw new Error("search query is required");
	}

	// GitLab commit search requires project_id (unlike GitHub's global search)
	const commits = (await gitlabFetch(
		token,
		`/projects/${encodeURIComponent(project_id)}/repository/commits`,
		{
			search,
			per_page: "5",
			...(ref_name ? { ref_name } : {}),
		},
	)) as Array<{
		id: string;
		message: string;
		author_name: string;
		authored_date: string;
		web_url: string;
	}>;

	return {
		total_count: commits.length,
		commits: commits.map((c) => ({
			sha: c.id,
			message: c.message,
			author: c.author_name,
			date: c.authored_date,
			url: c.web_url,
		})),
	};
}

async function getCommit(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id, sha } = args as {
		project_id: string | number;
		sha: string;
	};
	if (!project_id || !sha) {
		throw new Error("project_id and sha are required");
	}

	// Get commit with stats
	const commit = (await gitlabFetch(
		token,
		`/projects/${encodeURIComponent(project_id)}/repository/commits/${sha}`,
		{ stats: "true" },
	)) as {
		id: string;
		message: string;
		author_name: string;
		authored_date: string;
		web_url: string;
		stats?: { additions: number; deletions: number; total: number };
	};

	// Get file diffs separately
	const diffs = (await gitlabFetch(
		token,
		`/projects/${encodeURIComponent(project_id)}/repository/commits/${sha}/diff`,
	)) as Array<{
		old_path: string;
		new_path: string;
		new_file: boolean;
		renamed_file: boolean;
		deleted_file: boolean;
		diff: string;
	}>;

	// Sort by change size (most changed first) and limit to 10 files
	// to keep context manageable for downstream analysis and diagram creation
	const sortedFiles = diffs
		.map((f) => {
			const additions = (f.diff.match(/^\+[^+]/gm) || []).length;
			const deletions = (f.diff.match(/^-[^-]/gm) || []).length;
			return { ...f, additions, deletions };
		})
		.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
		.slice(0, 10);

	return {
		sha: commit.id,
		message: commit.message,
		author: commit.author_name,
		date: commit.authored_date,
		url: commit.web_url,
		stats: commit.stats,
		// Include diff patches for the most significant files.
		// Keep patches short (400 chars) to preserve context for diagram creation.
		files: sortedFiles.map((f) => {
			const status = f.new_file
				? "added"
				: f.deleted_file
					? "removed"
					: f.renamed_file
						? "renamed"
						: "modified";
			return {
				filename: f.new_path,
				status,
				additions: f.additions,
				deletions: f.deletions,
				patch: f.diff
					? f.diff.length > 400
						? `${f.diff.slice(0, 400)}... (+${f.diff.length - 400} chars)`
						: f.diff
					: undefined,
			};
		}),
		totalFiles: diffs.length,
	};
}

async function getAuthenticatedUserInfo(
	token: string,
	_args: Record<string, unknown>,
): Promise<unknown> {
	const user = (await gitlabFetch(token, "/user")) as {
		username: string;
		name: string | null;
		email: string | null;
		avatar_url: string;
		web_url: string;
		organization: string | null;
	};

	return {
		login: user.username,
		name: user.name,
		email: user.email,
		url: user.web_url,
		public_repos: null,
		company: user.organization,
	};
}

// ============================================================================
// Direct API Functions (for project wizard repo picker etc.)
// ============================================================================

/**
 * Get the GitLab access token for a user's workflow integration.
 * Automatically refreshes the token if expired.
 * Returns null if not configured.
 */
export async function getGitLabAccessToken(
	userId: string,
	organizationId?: string,
): Promise<string | null> {
	const integration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId,
					provider: "GITLAB",
					isActive: true,
				},
			})
		: await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId: null,
					provider: "GITLAB",
					isActive: true,
				},
			});

	if (!integration?.credentials) {
		return null;
	}

	try {
		return await refreshTokenIfNeeded(integration, userId, organizationId);
	} catch (error) {
		// Surface decrypt/refresh failures — otherwise callers see only the
		// downstream `null` (rendered as "Could not resolve your GitLab
		// connection") with no signal pointing at the actual cause.
		console.error("[GitLab] getGitLabAccessToken failed", {
			userId,
			organizationId,
			integrationId: integration.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Get the authenticated GitLab user's info. Throws on any failure
 * (`GitLabApiError` for HTTP errors, generic `Error` for network/parse
 * failures) so callers can distinguish auth rejection (401/403) from
 * transport errors and surface a useful message to the user.
 */
export async function getAuthenticatedUser(
	token: string,
): Promise<{ login: string; name: string | null; avatar_url: string }> {
	const data = (await gitlabFetch(token, "/user")) as {
		username: string;
		name: string | null;
		avatar_url: string;
	};
	return {
		login: data.username,
		name: data.name,
		avatar_url: data.avatar_url,
	};
}

interface GitLabSearchProject {
	name: string;
	path_with_namespace: string;
	description: string | null;
	visibility: string;
	web_url: string;
	default_branch: string;
	last_activity_at: string;
	star_count: number;
	forked_from_project?: unknown;
	namespace: { full_path: string; avatar_url?: string };
}

/**
 * Search GitLab projects using the Projects API.
 */
export async function searchGitLabProjects(
	token: string,
	query: string,
	perPage = 100,
): Promise<GitLabSearchProject[]> {
	const data = (await gitlabFetch(token, "/projects", {
		search: query,
		membership: "true",
		per_page: String(perPage),
		order_by: "updated_at",
		sort: "desc",
	})) as GitLabSearchProject[];
	return data ?? [];
}

/**
 * List the authenticated user's projects (all accessible).
 */
export async function listUserProjects(
	token: string,
	perPage = 100,
): Promise<GitLabSearchProject[]> {
	const projects = (await gitlabFetch(token, "/projects", {
		membership: "true",
		order_by: "updated_at",
		sort: "desc",
		per_page: String(perPage),
	})) as GitLabSearchProject[];
	return projects;
}

/**
 * Parse a GitLab project URL to extract the full project path.
 * Handles:
 * - https://gitlab.com/group/project
 * - https://gitlab.com/group/subgroup/project
 * - git@gitlab.com:group/project.git
 */
export function parseGitLabProjectUrl(
	url: string,
): { projectPath: string } | null {
	const patterns = [
		// HTTPS URL: gitlab.com/group/project or gitlab.com/group/subgroup/project
		/gitlab\.com\/(.+?)(?:\.git)?(?:\/)?(?:\?.*)?$/i,
		// SSH URL: git@gitlab.com:group/project.git
		/git@gitlab\.com:(.+?)(?:\.git)?$/i,
	];

	for (const pattern of patterns) {
		const match = url.match(pattern);
		if (match) {
			// Remove trailing slashes
			const projectPath = match[1].replace(/\/+$/, "");
			// Must have at least group/project (two segments)
			if (projectPath.includes("/")) {
				return { projectPath };
			}
		}
	}
	return null;
}

/**
 * Fetch file content from GitLab
 */
export async function fetchFileContent(
	token: string,
	args: { project_id: string | number; path: string; ref?: string },
): Promise<{ content: string; path: string; size: number; url: string }> {
	const result = (await getFileContents(token, args)) as {
		content: string;
		path: string;
		size: number;
		url: string;
	};
	return result;
}

/**
 * Get GitLab token for a user/organization
 */
export async function getGitLabToken({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string;
}): Promise<string | null> {
	const integration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId,
					provider: "GITLAB",
					isActive: true,
				},
			})
		: await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId: null,
					provider: "GITLAB",
					isActive: true,
				},
			});

	if (!integration?.credentials) {
		return null;
	}

	return refreshTokenIfNeeded(integration, userId, organizationId);
}

// ============================================================================
// Main Executor
// ============================================================================

async function updateIssue(
	token: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id, issue_iid } = args as {
		project_id: string | number;
		issue_iid: number;
	};
	if (!project_id || !issue_iid) {
		throw new Error("project_id and issue_iid are required");
	}

	const payload: Record<string, unknown> = {};
	if (typeof args.title === "string") {
		payload.title = args.title;
	}
	if (typeof args.description === "string") {
		payload.description = args.description;
	}
	if (typeof args.state_event === "string") {
		payload.state_event = args.state_event; // "close" | "reopen"
	}
	if (args.labels !== undefined) {
		payload.labels = Array.isArray(args.labels)
			? (args.labels as string[]).join(",")
			: (args.labels as string);
	}
	if (args.add_labels !== undefined) {
		payload.add_labels = Array.isArray(args.add_labels)
			? (args.add_labels as string[]).join(",")
			: (args.add_labels as string);
	}
	if (args.remove_labels !== undefined) {
		payload.remove_labels = Array.isArray(args.remove_labels)
			? (args.remove_labels as string[]).join(",")
			: (args.remove_labels as string);
	}
	if (Array.isArray(args.assignee_ids)) {
		payload.assignee_ids = args.assignee_ids;
	}

	const issue = (await gitlabPut(
		token,
		`/projects/${encodeURIComponent(project_id)}/issues/${issue_iid}`,
		payload,
	)) as { web_url?: string; title?: string; iid?: number; labels?: string[] };

	return {
		...issue,
		structuredContent: {
			url: issue.web_url,
			title: issue.title,
			number: issue.iid,
			labels: issue.labels,
		},
	};
}

const TOOL_HANDLERS: Record<
	string,
	(token: string, args: Record<string, unknown>) => Promise<unknown>
> = {
	list_projects: listProjects,
	get_project: getProject,
	list_issues: listIssues,
	get_issue: getIssue,
	list_issue_notes: listIssueNotes,
	update_issue: updateIssue,
	get_merge_request: getMergeRequest,
	list_merge_requests: listMergeRequests,
	create_merge_request: createMergeRequest,
	create_issue: createIssue,
	get_file_contents: getFileContents,
	list_branches: listBranches,
	search_commits: searchCommits,
	get_commit: getCommit,
	get_authenticated_user: getAuthenticatedUserInfo,
};

/**
 * Execute a GitLab tool using the user's OAuth credentials from WorkflowIntegration,
 * or from project-level credentials if provided.
 *
 * Automatically retries on 401 by refreshing the token.
 *
 * @param projectAccessToken - Pre-decrypted token from ProjectRepositoryIntegration.
 *   When provided, skips the WorkflowIntegration lookup entirely.
 */
export async function executeGitLabTool(
	methodName: string,
	args: Record<string, unknown>,
	userId: string,
	organizationId?: string,
	projectAccessToken?: string,
): Promise<unknown> {
	const handler = TOOL_HANDLERS[methodName];
	if (!handler) {
		throw new Error(
			`Unknown GitLab tool: ${methodName}. Available tools: ${Object.keys(TOOL_HANDLERS).join(", ")}`,
		);
	}

	if (projectAccessToken) {
		// Project-level credentials — no refresh available, execute directly
		return handler(projectAccessToken, args);
	}

	// Get GitLab integration for token lookup and refresh
	const integration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId,
					provider: "GITLAB",
					isActive: true,
				},
			})
		: await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId: null,
					provider: "GITLAB",
					isActive: true,
				},
			});

	if (!integration?.credentials) {
		throw new Error(
			"GitLab not connected. Please connect your GitLab account in Project Settings or Workflow Integrations.",
		);
	}

	let accessToken = await refreshTokenIfNeeded(
		integration,
		userId,
		organizationId,
	);

	// First attempt
	try {
		return await handler(accessToken, args);
	} catch (error) {
		// If 401 and we have a refresh token, try refreshing and retrying.
		//
		// Re-read the row first. The pre-emptive refresh above may already have
		// rotated (and thereby killed) the refresh token held in our snapshot —
		// GitLab's rotation is single-use — so reusing `integration.credentials`
		// here spends a dead token and fails with `invalid_grant`. That produced
		// the paired "Pre-emptive token refresh failed" / "Token refresh after
		// 401 failed" lines seen in staging for the same integration in the same
		// second, and wrongly flagged healthy connections as needing reauth.
		if (error instanceof GitLabApiError && error.status === 401) {
			const fresh = await db.workflowIntegration.findUnique({
				where: { id: integration.id },
				select: { credentials: true },
			});
			const credentialsJson = decryptApiKey(
				fresh?.credentials ?? integration.credentials,
			);
			let refreshTokenValue: string | undefined;
			try {
				const parsed = JSON.parse(credentialsJson) as ParsedCredentials;
				refreshTokenValue =
					typeof parsed === "object" && parsed !== null
						? parsed.refresh_token
						: undefined;
			} catch {
				// Can't parse credentials for refresh token
			}

			if (refreshTokenValue) {
				console.log(
					`[GitLab] Got 401 for ${methodName}, attempting token refresh and retry...`,
				);
				try {
					accessToken = await refreshTokenWithLock(
						integration,
						refreshTokenValue,
						userId,
						organizationId,
					);
					return await handler(accessToken, args);
				} catch (refreshError) {
					console.error(
						"[GitLab] Token refresh after 401 failed:",
						refreshError,
					);
					throw new Error(
						"GitLab access token expired and refresh failed. " +
							"Please reconnect your GitLab account in Settings > Integrations.",
					);
				}
			}
		}

		// Not a 401, or no refresh token — rethrow original error
		throw error;
	}
}
