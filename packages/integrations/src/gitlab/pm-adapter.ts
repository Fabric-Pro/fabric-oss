/**
 * GitLab PM adapter — bridges the generic Pull-from-PM pipeline to the
 * GitLab integration's MCP-with-REST-fallback source resolver.
 *
 * Why this exists:
 *   The generic PM pipeline (discoverPMToolCapabilities → executeMcpTool)
 *   talks directly to whatever MCP server is configured for the project.
 *   For GitLab, that MCP server is gated by tier (Premium/Ultimate). Free /
 *   Bronze / Silver users get 404 from `https://gitlab.com/api/v4/mcp`, and
 *   the tier-probe refresh may have already deleted their MCPConfig row —
 *   leaving the user with a working OAuth token but no MCP capability.
 *
 *   Other GitLab call sites (`gitlab-create-issue`, `gitlab-search-issues`,
 *   `gitlab-get-file`) handle this via `resolveGitLabSource()` +
 *   `callMcpWithRestFallback()`, which transparently picks MCP or REST.
 *   This module brings that same dual-mode behavior to the Pull-from-PM
 *   list and import procedures.
 *
 *   Lives in @repo/integrations (not @repo/api) so both API procedures and
 *   Temporal activities can import it — Temporal can't depend on @repo/api.
 */
import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
} from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import {
	executeGitLabTool,
	getGitLabAccessToken,
	refreshMcpConfigToken,
} from "./index";
import { createGitLabRefreshFailureWriter } from "./refresh-failure-writer";
import {
	callMcpWithRestFallback,
	type GitLabSource,
	resolveGitLabSource,
} from "./source";

export const GITLAB_OFFICIAL_MCP_KEY = "gitlab-official";

/**
 * Returns true when the given MCP server key is the GitLab official server.
 * Centralized so the procedures and tests can't drift on the key string.
 */
export function isGitLabOfficialKey(key: string | null | undefined): boolean {
	return key === GITLAB_OFFICIAL_MCP_KEY;
}

/**
 * Look up the MCP server key for a project's configured PM tool.
 * Returns null when no PM tool is configured.
 *
 * Accepts both a real `MCPServer.id` (the normal case) and a
 * `key:<server-key>` sentinel emitted by `listAvailablePmTools` when
 * the catalog row was missing (seed drift). The sentinel form lets the
 * picker recover gracefully without requiring a re-seed before users can
 * select GitLab via REST.
 */
export async function getProjectPMServerKey(
	projectManagementMcpServerId: string | null,
): Promise<string | null> {
	if (!projectManagementMcpServerId) {
		return null;
	}
	if (isPmServerIdKeySentinel(projectManagementMcpServerId)) {
		return readPmServerIdKeySentinel(projectManagementMcpServerId);
	}
	const server = await db.mCPServer.findUnique({
		where: { id: projectManagementMcpServerId },
		select: { key: true },
	});
	return server?.key ?? null;
}

/**
 * Resolve the GitLab source (MCP or REST) for the calling user.
 * Wraps `resolveGitLabSource` with the project's db/decrypt/token-refresh
 * dependencies so the procedures stay free of integration plumbing.
 */
export async function resolveGitLabPMSource(opts: {
	userId: string;
	organizationId: string | null;
	projectId?: string;
}): Promise<GitLabSource | null> {
	return resolveGitLabSource({
		userId: opts.userId,
		organizationId: opts.organizationId,
		projectId: opts.projectId,
		db: db as never,
		decrypt: decryptApiKey,
		refresh: (configId) =>
			refreshMcpConfigToken({ configId, db: db as never }),
		getRestToken: async ({ userId, organizationId }) =>
			(await getGitLabAccessToken(userId, organizationId ?? undefined)) ??
			null,
		// Record the failure so a dead grant is condemned once instead of
		// being retried on every request. See the writer's own doc comment
		// for what it persists and why only a provider rejection may set
		// `needsReauth`.
		markRefreshFailure: createGitLabRefreshFailureWriter(db as never),
	});
}

/**
 * Subset of GitLab REST issue fields we read in the PM pipeline. Both the
 * MCP path (which returns raw GitLab issues) and the REST adapter
 * (`executeGitLabTool` which normalizes some fields) produce shapes that
 * cover this union — we accept both `iid`/`number` and `web_url`/`url`.
 */
interface GitLabIssueResponse {
	iid?: number | string;
	number?: number | string;
	title?: string;
	state?: string;
	updated_at?: string;
	labels?: unknown;
	web_url?: string;
	url?: string;
	description?: string | null;
	body?: string | null;
}

/** Compact item shape returned to the list-pm-tickets procedure. */
export interface GitLabPMListItem {
	id: string;
	displayId: string;
	title: string;
	workItemType: string;
	state?: string;
}

/** Full item shape returned to the import-from-pm procedure. */
export interface GitLabPMFullItem {
	title: string;
	description: string | null;
	externalUrl: string | null;
	labels: string[];
	/** Phase B: native issue state ("opened" | "closed") for terminal detection. */
	state?: string;
	/** Phase B: ISO `updated_at` for the poll's incremental changed-date filter. */
	updatedAt?: string;
}

function normalizeIid(raw: unknown): string | null {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return String(raw);
	}
	if (typeof raw === "string" && raw.length > 0) {
		return raw;
	}
	return null;
}

function normalizeLabels(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw
			.filter(
				(l): l is string | number =>
					typeof l === "string" || typeof l === "number",
			)
			.map((l) => String(l).trim())
			.filter((l) => l.length > 0);
	}
	if (typeof raw === "string" && raw.length > 0) {
		return raw
			.split(",")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	}
	return [];
}

/**
 * Page-size cap matches GitLab's REST limit. Callers requesting a smaller
 * page get it; callers requesting more get clamped to 100.
 */
const GITLAB_MAX_PER_PAGE = 100;

/**
 * List issues for a GitLab project via MCP-with-REST-fallback.
 *
 * Returns the same compact shape the procedure uses for in-memory
 * filtering/pagination. The procedure applies its own already-imported,
 * search, and IDs filters on top of this result.
 */
export async function listGitLabIssuesForPM(input: {
	source: GitLabSource;
	gitlabProjectId: string;
	userId: string;
	organizationId: string | null;
	page: number;
	pageSize: number;
}): Promise<{ items: GitLabPMListItem[] }> {
	const perPage = Math.min(input.pageSize, GITLAB_MAX_PER_PAGE);
	const args = {
		project_id: input.gitlabProjectId,
		state: "all",
		per_page: perPage,
		page: input.page,
	};

	const result = await callMcpWithRestFallback<unknown>({
		source: input.source,
		method: "list_issues",
		args,
		restFallback: () =>
			executeGitLabTool(
				"list_issues",
				args,
				input.userId,
				input.organizationId ?? undefined,
			),
	});

	const rawList: GitLabIssueResponse[] = Array.isArray(result)
		? (result as GitLabIssueResponse[])
		: [];

	const items: GitLabPMListItem[] = [];
	for (const raw of rawList) {
		const iid = normalizeIid(raw.iid ?? raw.number);
		if (!iid) {
			continue;
		}
		items.push({
			id: iid,
			displayId: iid,
			title: raw.title ?? iid,
			workItemType: "Issue",
			state: raw.state,
		});
	}

	return { items };
}

/**
 * Fetch a single GitLab issue for import.
 *
 * Returns the same fields `fetchPMItemData` produces for the generic MCP
 * path so the import procedure can update the story uniformly.
 */
export async function getGitLabIssueForPM(input: {
	source: GitLabSource;
	gitlabProjectId: string;
	externalId: string;
	userId: string;
	organizationId: string | null;
}): Promise<GitLabPMFullItem> {
	const iidNum = Number(input.externalId);
	if (!Number.isInteger(iidNum) || iidNum <= 0) {
		throw new Error(`Invalid GitLab issue IID: ${input.externalId}`);
	}
	const args = { project_id: input.gitlabProjectId, issue_iid: iidNum };

	const result = (await callMcpWithRestFallback<unknown>({
		source: input.source,
		method: "get_issue",
		args,
		restFallback: () =>
			executeGitLabTool(
				"get_issue",
				args,
				input.userId,
				input.organizationId ?? undefined,
			),
	})) as GitLabIssueResponse | null;

	const raw: GitLabIssueResponse = result ?? {};

	return {
		title: raw.title ?? `Issue #${iidNum}`,
		description: raw.description ?? raw.body ?? null,
		externalUrl: raw.web_url ?? raw.url ?? null,
		labels: normalizeLabels(raw.labels),
		state: raw.state,
		updatedAt: raw.updated_at,
	};
}

/** Comment shape returned to the AI-Update context builder. Matches the
 *  structural fields of `@repo/temporal`'s `PmComment` without importing it
 *  (that would invert the package dependency). */
export interface GitLabPMComment {
	author: string | null;
	createdAt: string | null;
	body: string;
}

interface GitLabNoteResponse {
	id?: number;
	body?: string | null;
	system?: boolean;
	created_at?: string;
	author?: { name?: string; username?: string };
}

function normalizeNoteDate(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) {
		return null;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Fetch human comments (notes) for a GitLab issue via MCP-with-REST-fallback.
 * System notes (status/label changes) are excluded. Read-only and supplemental:
 * callers treat a throw as "no comments" and proceed (handled at the call site).
 */
export async function getGitLabIssueNotesForPM(input: {
	source: GitLabSource;
	gitlabProjectId: string;
	externalId: string;
	userId: string;
	organizationId: string | null;
	maxComments?: number;
}): Promise<GitLabPMComment[]> {
	const iidNum = Number(input.externalId);
	if (!Number.isInteger(iidNum) || iidNum <= 0) {
		throw new Error(`Invalid GitLab issue IID: ${input.externalId}`);
	}
	const args = {
		project_id: input.gitlabProjectId,
		issue_iid: iidNum,
		per_page: 100,
		page: 1,
	};

	const result = (await callMcpWithRestFallback<unknown>({
		source: input.source,
		method: "list_issue_notes",
		args,
		restFallback: () =>
			executeGitLabTool(
				"list_issue_notes",
				args,
				input.userId,
				input.organizationId ?? undefined,
			),
	})) as GitLabNoteResponse[] | null;

	const raw = Array.isArray(result) ? result : [];
	const comments: GitLabPMComment[] = [];
	for (const note of raw) {
		if (note.system === true) {
			continue;
		}
		const body = (note.body ?? "").trim();
		if (!body) {
			continue;
		}
		comments.push({
			author: note.author?.name ?? note.author?.username ?? null,
			createdAt: normalizeNoteDate(note.created_at),
			body,
		});
	}

	const max = input.maxComments ?? 20;
	return comments.slice(-max);
}

// =============================================================================
// Write-side functions (REST + MCP fallback)
//
// Symmetric counterparts to listGitLabIssuesForPM / getGitLabIssueForPM used
// by the push direction (Fabric story → GitLab issue create/update). Both
// dispatch through callMcpWithRestFallback so the official MCP server is
// preferred when available and REST is used otherwise.
// =============================================================================

export interface GitLabPMCreatePayload {
	title: string;
	description?: string;
	labels?: string[];
}

export interface GitLabPMUpdatePayload {
	title?: string;
	description?: string;
	/** Full-replace label set. Prefer addLabels/removeLabels for delta semantics. */
	labels?: string[];
	/** Labels to add via GitLab's `add_labels` parameter (delta, no clobber). */
	addLabels?: string[];
	/** Labels to remove via GitLab's `remove_labels` parameter (delta). */
	removeLabels?: string[];
	stateEvent?: "close" | "reopen";
}

export interface GitLabPMWriteResult {
	externalId: string;
	externalUrl: string | null;
	title: string;
}

interface GitLabIssueWriteResponse {
	iid: number;
	title: string;
	web_url?: string;
}

function buildCreateArgs(
	gitlabProjectId: string,
	payload: GitLabPMCreatePayload,
): Record<string, unknown> {
	const args: Record<string, unknown> = {
		project_id: gitlabProjectId,
		title: payload.title,
	};
	if (payload.description !== undefined) {
		args.description = payload.description;
	}
	if (payload.labels !== undefined && payload.labels.length > 0) {
		// createIssue accepts arrays or comma-joined strings; pre-join here so
		// the MCP path (which forwards args verbatim) gets the same shape.
		args.labels = payload.labels.join(",");
	}
	return args;
}

function buildUpdateArgs(
	gitlabProjectId: string,
	externalId: string,
	payload: GitLabPMUpdatePayload,
): Record<string, unknown> {
	const args: Record<string, unknown> = {
		project_id: gitlabProjectId,
		issue_iid: Number(externalId),
	};
	if (payload.title !== undefined) {
		args.title = payload.title;
	}
	if (payload.description !== undefined) {
		args.description = payload.description;
	}
	if (payload.labels !== undefined) {
		args.labels = payload.labels.join(",");
	}
	if (payload.addLabels !== undefined && payload.addLabels.length > 0) {
		args.add_labels = payload.addLabels.join(",");
	}
	if (payload.removeLabels !== undefined && payload.removeLabels.length > 0) {
		args.remove_labels = payload.removeLabels.join(",");
	}
	if (payload.stateEvent !== undefined) {
		args.state_event = payload.stateEvent;
	}
	return args;
}

function toWriteResult(raw: GitLabIssueWriteResponse): GitLabPMWriteResult {
	return {
		externalId: String(raw.iid),
		externalUrl: raw.web_url ?? null,
		title: raw.title,
	};
}

/**
 * Create a GitLab issue from a Fabric story via MCP-with-REST-fallback.
 */
export async function createGitLabIssueFromStory(input: {
	source: GitLabSource;
	gitlabProjectId: string;
	payload: GitLabPMCreatePayload;
	userId: string;
	organizationId: string | null;
}): Promise<GitLabPMWriteResult> {
	const { source, gitlabProjectId, payload, userId, organizationId } = input;
	const args = buildCreateArgs(gitlabProjectId, payload);

	const raw = (await callMcpWithRestFallback<unknown>({
		source,
		method: "create_issue",
		args,
		// Write: do not blindly retry over REST on an ambiguous MCP network
		// error — the issue may already have been created server-side.
		idempotent: false,
		restFallback: () =>
			executeGitLabTool(
				"create_issue",
				args,
				userId,
				organizationId ?? undefined,
			),
	})) as GitLabIssueWriteResponse;

	return toWriteResult(raw);
}

/**
 * Update a GitLab issue from a Fabric story via MCP-with-REST-fallback.
 */
export async function updateGitLabIssueFromStory(input: {
	source: GitLabSource;
	gitlabProjectId: string;
	externalId: string;
	payload: GitLabPMUpdatePayload;
	userId: string;
	organizationId: string | null;
}): Promise<GitLabPMWriteResult> {
	const {
		source,
		gitlabProjectId,
		externalId,
		payload,
		userId,
		organizationId,
	} = input;
	const iidNum = Number(externalId);
	if (!Number.isInteger(iidNum) || iidNum <= 0) {
		throw new Error(`Invalid GitLab issue IID: ${externalId}`);
	}
	const args = buildUpdateArgs(gitlabProjectId, externalId, payload);

	const raw = (await callMcpWithRestFallback<unknown>({
		source,
		method: "update_issue",
		args,
		// Write: do not blindly retry over REST on an ambiguous MCP network
		// error — the update may already have been applied server-side.
		idempotent: false,
		restFallback: () =>
			executeGitLabTool(
				"update_issue",
				args,
				userId,
				organizationId ?? undefined,
			),
	})) as GitLabIssueWriteResponse;

	return toWriteResult(raw);
}
