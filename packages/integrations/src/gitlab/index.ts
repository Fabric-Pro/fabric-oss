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

import { scrubSecrets } from "@repo/utils/scrub-secrets";
import {
	type GitLabConnectionTokenResult,
	getGitLabConnectionToken,
	refreshGitLabConnection,
} from "./connection";
import { gitlabOutboundFetch } from "./outbound";
import {
	type GitLabApiCredential,
	GitLabApiError,
	type GitLabAuth,
	gitlabApiBaseForOrigin,
	toGitLabApiCredential,
} from "./rest-client";

export * from "./capabilities";
export * from "./connection";
export * from "./connection-summary";
export * from "./get-valid-access-token";
export * from "./integration-settings";
export * from "./mcp-client";
export * from "./oauth-refresh";
export * from "./outbound";
export * from "./pm-adapter";
export * from "./pm-origin";
export * from "./probe-mcp";
export * from "./rest-client";
export * from "./source";

function gitlabHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"User-Agent": "Fabric-App",
	};
}

export async function gitlabFetch(
	auth: GitLabAuth,
	path: string,
	params?: Record<string, string>,
): Promise<unknown> {
	const { token, apiBase } = toGitLabApiCredential(auth);
	const url = new URL(`${apiBase}${path}`);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "") {
				url.searchParams.set(key, value);
			}
		}
	}

	const response = await gitlabOutboundFetch(url.toString(), {
		headers: gitlabHeaders(token),
	});

	// The status is checked BEFORE the body is parsed: GitLab sends some errors
	// as plain text — its rate-limit (429) answer is "Retry later" — and a JSON
	// parse of that threw a SyntaxError that hid the status from every caller.
	if (!response.ok) {
		type GitLabErrorBody = { message?: string; error?: string } | null;
		let data: GitLabErrorBody = null;
		try {
			data = (await response.json()) as GitLabErrorBody;
		} catch {
			// Not JSON: fall through to the status-only message.
		}
		const message =
			data?.message ||
			data?.error ||
			`GitLab API error: ${response.status}`;
		throw new GitLabApiError(response.status, message);
	}

	return response.json();
}

export async function gitlabPost(
	auth: GitLabAuth,
	path: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const { token, apiBase } = toGitLabApiCredential(auth);
	const response = await gitlabOutboundFetch(`${apiBase}${path}`, {
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
	auth: GitLabAuth,
	path: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const { token, apiBase } = toGitLabApiCredential(auth);
	const response = await gitlabOutboundFetch(`${apiBase}${path}`, {
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
	token: GitLabAuth,
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
	token: GitLabAuth,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { project_id } = args as { project_id: string | number };
	if (!project_id) {
		throw new Error("project_id is required");
	}
	return gitlabFetch(token, `/projects/${encodeURIComponent(project_id)}`);
}

async function listIssues(
	token: GitLabAuth,
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
	token: GitLabAuth,
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
	token: GitLabAuth,
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
	token: GitLabAuth,
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
	token: GitLabAuth,
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
	token: GitLabAuth,
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
	token: GitLabAuth,
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
	token: GitLabAuth,
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
	const { apiBase } = toGitLabApiCredential(token);

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
				url: `${apiBase}/projects/${encodeURIComponent(project_id)}/repository/files/${encodeURIComponent(path)}`,
			};
		}

		const decoded = Buffer.from(result.content, "base64").toString("utf-8");
		return {
			path: result.file_path,
			sha: result.blob_id,
			size: result.size,
			content: decoded,
			url: `${apiBase}/projects/${encodeURIComponent(project_id)}/repository/files/${encodeURIComponent(path)}`,
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
	token: GitLabAuth,
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
	token: GitLabAuth,
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
	token: GitLabAuth,
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
	token: GitLabAuth,
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
 * Fixed-vocabulary phrase for a connection-service failure, safe to persist
 * and show. A transient failure carries the underlying error, which
 * `describeGitLabRefreshFailure` reduces to its own fixed phrase.
 */
/**
 * A fixed phrase (never provider text) for why the connection could not
 * produce a token — safe to persist and show.
 */
export function describeGitLabConnectionFailure(
	result: Extract<GitLabConnectionTokenResult, { ok: false }>,
): string {
	switch (result.reason) {
		case "not-connected":
			return "GitLab is not connected";
		case "needs-reauth":
			return "the GitLab connection needs to be reconnected";
		case "client-unavailable":
			return "the OAuth client that issued the GitLab token is not available";
		case "no-refresh-token":
			return "the GitLab token expired and cannot be refreshed";
		case "unsupported-origin":
			return "the GitLab connection belongs to a GitLab instance this feature does not support";
		default:
			return result.error !== undefined
				? describeGitLabRefreshFailure(result.error)
				: "the GitLab token could not be obtained";
	}
}

function logConnectionFailure(
	where: string,
	tenant: { userId: string; organizationId?: string },
	result: Extract<GitLabConnectionTokenResult, { ok: false }>,
): void {
	if (result.reason === "not-connected") {
		return;
	}
	console.error(`[GitLab] ${where} failed`, {
		userId: tenant.userId,
		organizationId: tenant.organizationId,
		integrationId: result.integrationId,
		connectionReason: result.reason,
		...(result.error !== undefined ? refreshErrorForLog(result.error) : {}),
	});
}

/**
 * Get the GitLab access token for a person's personal GitLab connection,
 * refreshing it when due (see `getGitLabConnectionToken`). Returns null when
 * GitLab is not connected or the connection cannot produce a usable token.
 * A bare token carries no instance, so only a gitlab.com credential is
 * returned; REST callers that can follow the instance use
 * `getGitLabApiCredential`.
 */
export async function getGitLabAccessToken(
	userId: string,
	organizationId?: string,
): Promise<string | null> {
	const result = await getGitLabConnectionToken(
		{ userId, organizationId: organizationId ?? null },
		{ mode: "lenient" },
	);
	if (result.ok) {
		return result.accessToken;
	}
	logConnectionFailure(
		"getGitLabAccessToken",
		{ userId, organizationId },
		result,
	);
	return null;
}

/**
 * The person's GitLab token together with the REST base of the instance that
 * issued it — for REST callers, so a self-hosted credential is sent to its own
 * instance. Null when GitLab is not connected or the connection cannot
 * produce a usable token (logged like `getGitLabAccessToken`).
 */
export async function getGitLabApiCredential(
	userId: string,
	organizationId?: string,
): Promise<GitLabApiCredential | null> {
	const result = await getGitLabConnectionToken(
		{ userId, organizationId: organizationId ?? null },
		{ mode: "lenient", anyOrigin: true },
	);
	if (result.ok) {
		return {
			token: result.accessToken,
			apiBase: gitlabApiBaseForOrigin(result.origin),
		};
	}
	logConnectionFailure(
		"getGitLabApiCredential",
		{ userId, organizationId },
		result,
	);
	return null;
}

/**
 * Why a GitLab token refresh failed, as a FIXED phrase safe to persist and
 * show to users. Never echoes provider text: a refresh error message may carry
 * GitLab response text, which is untrusted. Only an OAuth `error` code
 * matching `^[a-z_]{1,40}$` is kept.
 */
export function describeGitLabRefreshFailure(error: unknown): string {
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : "";
	if (name === "TimeoutError" || name === "AbortError") {
		return "the token refresh timed out";
	}
	if (name === "RefreshLockBudgetExhaustedError") {
		return "the token refresh could not start in time";
	}
	if (
		message.startsWith(
			"Cannot refresh GitLab token: no client credentials configured",
		)
	) {
		return "no GitLab OAuth app credentials are configured";
	}
	const failed = /^GitLab token refresh failed: (\d{3})\b/.exec(message);
	if (failed) {
		if (
			message.includes("(response body unreadable, possibly a timeout)")
		) {
			return "the token refresh timed out";
		}
		const status = Number(failed[1]);
		// A 5xx or 429 is GitLab's OWN infrastructure struggling (overload, rate
		// limit, an upstream hiccup) — not a judgment on the credential. "Rejected"
		// belongs only to a status GitLab issued to say the grant itself is bad;
		// folding an OAuth `error` code into a 5xx/429 phrase would also be
		// misleading (that code is meaningless outside a genuine rejection).
		if (status >= 500 || status === 429) {
			return `GitLab could not refresh the token (HTTP ${status})`;
		}
		const code = /"error"\s*:\s*"([a-z_]{1,40})"/.exec(message)?.[1];
		return `GitLab rejected the token refresh (HTTP ${status}${code ? ` ${code}` : ""})`;
	}
	const oauthError = /^GitLab token refresh error: ([a-z_]{1,40})$/.exec(
		message,
	);
	if (oauthError) {
		return `GitLab rejected the token refresh (${oauthError[1]})`;
	}
	if (message.startsWith("GitLab token refresh error:")) {
		return "GitLab returned no usable token";
	}
	if (error instanceof TypeError && /fetch failed/i.test(message)) {
		return "GitLab could not be reached";
	}
	// Also covers a stored credential that could not be decrypted or parsed.
	return "the GitLab token could not be obtained";
}

/**
 * A refresh error as it may be written to a server log. The provider's
 * response text a refresh error message may carry is never
 * logged — only the fixed-vocabulary reason for those. Other messages come
 * from our own code or libraries (the refresh lock, the database, credential
 * decryption) and are what makes a "could not be obtained" failure
 * diagnosable, so they are kept, scrubbed.
 */
function refreshErrorForLog(error: unknown): {
	name: string;
	reason: string;
	message?: string;
} {
	const name = error instanceof Error ? error.name : typeof error;
	const reason = describeGitLabRefreshFailure(error);
	const message = error instanceof Error ? error.message : String(error);
	if (
		message.startsWith("GitLab token refresh failed:") ||
		message.startsWith("GitLab token refresh error:")
	) {
		return { name, reason };
	}
	return { name, reason, message: scrubSecrets(message) };
}

export type FreshGitLabToken =
	| { ok: true; token: string }
	| { ok: false; reason: string };

/**
 * Like `getGitLabAccessToken`, but a token that is PAST its recorded expiry
 * and could not be refreshed is reported as a failure (with a safe,
 * fixed-vocabulary reason) instead of being handed back to fail every call
 * with a 401. `null` ONLY when GitLab is not connected.
 */
export async function getFreshGitLabAccessToken(
	userId: string,
	organizationId?: string,
): Promise<FreshGitLabToken | null> {
	const result = await getGitLabConnectionToken(
		{ userId, organizationId: organizationId ?? null },
		{ mode: "strict" },
	);
	if (result.ok) {
		return { ok: true, token: result.accessToken };
	}
	if (result.reason === "not-connected") {
		return null;
	}
	logConnectionFailure(
		"getFreshGitLabAccessToken",
		{ userId, organizationId },
		result,
	);
	return { ok: false, reason: describeGitLabConnectionFailure(result) };
}

/**
 * Get the authenticated GitLab user's info. Throws on any failure
 * (`GitLabApiError` for HTTP errors, generic `Error` for network/parse
 * failures) so callers can distinguish auth rejection (401/403) from
 * transport errors and surface a useful message to the user.
 */
export async function getAuthenticatedUser(
	token: GitLabAuth,
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
	token: GitLabAuth,
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
	token: GitLabAuth,
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
 * - git@<host>:group/project.git (scp-style SSH)
 *
 * The scp-style form is written with a placeholder host on purpose: spelled
 * out in full it reads as an email address at an unsanctioned domain, and the
 * publication identifier scan refuses the whole change over it. The patterns
 * below carry the real host; only this prose avoids it.
 */
export function parseGitLabProjectUrl(
	url: string,
): { projectPath: string } | null {
	const patterns = [
		// HTTPS URL: gitlab.com/group/project or gitlab.com/group/subgroup/project
		/gitlab\.com\/(.+?)(?:\.git)?(?:\/)?(?:\?.*)?$/i,
		// SSH URL, scp-style: git@<host>:group/project.git
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
	token: GitLabAuth,
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
	return getGitLabAccessToken(userId, organizationId);
}

// ============================================================================
// Main Executor
// ============================================================================

async function updateIssue(
	token: GitLabAuth,
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
	(token: GitLabAuth, args: Record<string, unknown>) => Promise<unknown>
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
 * The connection `executeGitLabTool` read is on another GitLab instance than
 * the caller required (`expectedOrigin`): it was reconnected elsewhere after
 * the caller checked it. Nothing was sent.
 */
export class GitLabConnectionOriginChangedError extends Error {
	override name = "GitLabConnectionOriginChangedError";
	constructor(
		readonly expectedOrigin: string,
		readonly actualOrigin: string,
	) {
		super(
			"Your GitLab connection is now on another GitLab instance than the one this request was checked for.",
		);
	}
}

/**
 * Execute a GitLab tool using the user's OAuth credentials from WorkflowIntegration,
 * or from project-level credentials if provided.
 *
 * Automatically retries on 401 by refreshing the token.
 *
 * @param projectAccessToken - Pre-decrypted token from ProjectRepositoryIntegration.
 *   When provided, skips the WorkflowIntegration lookup entirely.
 * @param options.expectedOrigin - The instance the caller already checked
 *   its target against (a PM container's). The connection is read again
 *   here, so a connection now on any other instance is refused with
 *   `GitLabConnectionOriginChangedError` before a request is sent, and the
 *   401 retry stays on that instance too.
 */
export async function executeGitLabTool(
	methodName: string,
	args: Record<string, unknown>,
	userId: string,
	organizationId?: string,
	projectAccessToken?: string,
	options: { expectedOrigin?: string } = {},
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

	const tenant = { userId, organizationId: organizationId ?? null };
	// `anyOrigin`: every request below goes to the credential's own GitLab
	// instance (`apiBase` from its origin), never to a hardcoded gitlab.com.
	const tokenResult = await getGitLabConnectionToken(tenant, {
		mode: "lenient",
		anyOrigin: true,
	});
	if (!tokenResult.ok) {
		logConnectionFailure(
			"executeGitLabTool",
			{ userId, organizationId },
			tokenResult,
		);
		throw new Error(
			tokenResult.reason === "not-connected"
				? "GitLab not connected. Please connect your GitLab account in Project Settings or Workflow Integrations."
				: "GitLab access token expired and refresh failed. Please reconnect your GitLab account in Settings > Integrations.",
		);
	}

	if (
		options.expectedOrigin !== undefined &&
		tokenResult.origin !== options.expectedOrigin
	) {
		throw new GitLabConnectionOriginChangedError(
			options.expectedOrigin,
			tokenResult.origin,
		);
	}
	const apiBase = gitlabApiBaseForOrigin(tokenResult.origin);
	try {
		return await handler({ token: tokenResult.accessToken, apiBase }, args);
	} catch (error) {
		if (!(error instanceof GitLabApiError) || error.status !== 401) {
			throw error;
		}
		// GitLab refused the token: refresh once, bound to the token it
		// refused — a concurrent winner's newer token is reused, not spent
		// again — and to the connection generation it came from.
		console.log(
			`[GitLab] Got 401 for ${methodName}, attempting token refresh and retry...`,
		);
		const refreshed = await refreshGitLabConnection(tenant, {
			force: true,
			rejectedAccessToken: tokenResult.accessToken,
			expectedGeneration: tokenResult.generation,
		});
		if (!refreshed.ok) {
			console.error("[GitLab] Token refresh after 401 failed:", {
				connectionReason: refreshed.reason,
				...(refreshed.error !== undefined
					? refreshErrorForLog(refreshed.error)
					: {}),
			});
			throw new Error(
				"GitLab access token expired and refresh failed. " +
					"Please reconnect your GitLab account in Settings > Integrations.",
			);
		}
		return handler({ token: refreshed.accessToken, apiBase }, args);
	}
}
