/**
 * GitHub Projects (v2) PM adapter.
 *
 * A Fabric project whose PM tool is GitHub Projects targets one Projects v2
 * board (org- or user-owned). Stories travel as real issues in a chosen
 * repository, added to the board, so they keep an Issue Type (Epic, Feature,
 * User Story, Task, …), a parent (sub-issues), labels, comments and a closed
 * state. Without a target repository a story travels as a draft item on the
 * board instead (no type, parent, labels or comments).
 *
 * The board's single-select "Status" field is exposed to the sync pipeline as
 * a scoped pseudo-label `Status::<option name>`: exactly like a GitLab scoped
 * label it has one value at a time, so the shared label↔status machinery
 * (`labelStatusMap`, the §4.5 push gate, the poll) drives it unchanged. The
 * adapter turns those pseudo-labels into Status field writes and never sends
 * them to GitHub as labels.
 *
 * Issues are written over REST (labels are created on first use and `type`
 * takes an Issue Type name); the board, its Status field, draft items and
 * reads go over GraphQL. Both use the caller's own GitHub connection token.
 *
 * Lives in @repo/integrations so API procedures and Temporal activities can
 * share it; it reads no database row itself.
 */
import { throwIfDispatchStopped } from "@repo/utils/dispatch-guard";

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = `${GITHUB_API}/graphql`;

/**
 * The catalog `MCPServer.key` a project's PM selection stores for GitHub
 * Projects. The GitHub row is reused as the PM pointer; PM sync never goes
 * through its MCP server — always through the caller's GitHub connection.
 */
export const GITHUB_PROJECTS_PM_SERVER_KEY = "github-remote";

export function isGitHubProjectsKey(key: string | null | undefined): boolean {
	return key === GITHUB_PROJECTS_PM_SERVER_KEY;
}

/**
 * The repository (`owner/name`) new issues are created in, from the project's
 * `projectManagementAdditionalContext.githubRepository`; null → draft items.
 */
export function readGitHubProjectsRepository(
	additionalContext: unknown,
): string | null {
	if (!additionalContext || typeof additionalContext !== "object") {
		return null;
	}
	const value = (additionalContext as Record<string, unknown>)
		.githubRepository;
	return typeof value === "string" && /^[^/\s]+\/[^/\s]+$/.test(value.trim())
		? value.trim()
		: null;
}

/** Prefix of the pseudo-label carrying the board's Status option. */
export const GITHUB_STATUS_LABEL_PREFIX = "Status::";

/** Name of the board field Fabric maps to its story statuses. */
export const GITHUB_STATUS_FIELD_NAME = "Status";

/** The pseudo-label for a Status option name. */
export function githubStatusLabel(optionName: string): string {
	return `${GITHUB_STATUS_LABEL_PREFIX}${optionName}`;
}

function isStatusLabel(label: string): boolean {
	return label.startsWith(GITHUB_STATUS_LABEL_PREFIX);
}

function statusOptionOf(label: string): string {
	return label.slice(GITHUB_STATUS_LABEL_PREFIX.length);
}

export type GitHubProjectsErrorKind =
	| "auth"
	| "insufficient-scope"
	| "not-found"
	| "forbidden"
	| "rate-limited"
	| "validation"
	| "http";

/**
 * A GitHub call failed. The message is fixed Fabric text plus GitHub's own
 * short reason; a not-found always says "not found" so the shared pull path
 * classifies it as a missing remote item.
 */
export class GitHubProjectsError extends Error {
	constructor(
		public readonly kind: GitHubProjectsErrorKind,
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "GitHubProjectsError";
	}
}

export const GITHUB_PROJECTS_SCOPE_MESSAGE =
	"Your GitHub connection cannot access GitHub Projects. Reconnect GitHub and grant access to projects (the `project` scope, or the Projects permission for the GitHub App).";

/** The caller's GitHub connection and the board a Fabric project targets. */
export interface GitHubProjectsSource {
	token: string;
	/** ProjectV2 node id (`PVT_…`). */
	projectId: string;
	/** `owner/name` new issues are created in; null → draft items. */
	repository: string | null;
}

interface RequestOptions {
	signal?: AbortSignal;
}

function classifyHttp(status: number, detail: string): GitHubProjectsError {
	if (status === 401) {
		return new GitHubProjectsError(
			"auth",
			`GitHub rejected the connection token (401). Reconnect GitHub. ${detail}`.trim(),
			status,
		);
	}
	if (status === 404) {
		return new GitHubProjectsError(
			"not-found",
			`GitHub item not found (404). ${detail}`.trim(),
			status,
		);
	}
	if (status === 403 || status === 429) {
		if (/rate limit/i.test(detail) || status === 429) {
			return new GitHubProjectsError(
				"rate-limited",
				`GitHub rate limit reached. ${detail}`.trim(),
				status,
			);
		}
		return new GitHubProjectsError(
			"forbidden",
			`GitHub refused the request (403). ${detail}`.trim(),
			status,
		);
	}
	if (status === 422) {
		return new GitHubProjectsError(
			"validation",
			`GitHub refused the request (422). ${detail}`.trim(),
			status,
		);
	}
	return new GitHubProjectsError(
		"http",
		`GitHub request failed (${status}). ${detail}`.trim(),
		status,
	);
}

function headers(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		// Issue types and sub-issues; harmless once generally available.
		"GraphQL-Features": "issue_types,sub_issues",
		"User-Agent": "Fabric",
	};
}

async function shortDetail(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { message?: unknown };
		return typeof body.message === "string"
			? body.message.slice(0, 200)
			: "";
	} catch {
		return "";
	}
}

/** One REST call; JSON body or null for 204. */
async function rest<T>(
	token: string,
	method: string,
	path: string,
	body?: unknown,
	options: RequestOptions = {},
): Promise<T> {
	if (method !== "GET") {
		throwIfDispatchStopped();
	}
	const response = await fetch(`${GITHUB_API}${path}`, {
		method,
		headers: {
			...headers(token),
			...(body === undefined
				? {}
				: { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: options.signal,
	});
	if (!response.ok) {
		throw classifyHttp(response.status, await shortDetail(response));
	}
	if (response.status === 204) {
		return null as T;
	}
	return (await response.json()) as T;
}

interface GraphqlError {
	type?: string;
	message?: string;
	path?: Array<string | number>;
}

/**
 * One GraphQL call. `allowPartial` returns `data` even when some fields
 * errored (a listing across organizations, where one may refuse the app);
 * otherwise any error throws.
 */
async function graphql<T>(
	token: string,
	query: string,
	variables: Record<string, unknown>,
	options: RequestOptions & { allowPartial?: boolean; write?: boolean } = {},
): Promise<T> {
	if (options.write) {
		throwIfDispatchStopped();
	}
	const response = await fetch(GITHUB_GRAPHQL, {
		method: "POST",
		headers: { ...headers(token), "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
		signal: options.signal,
	});
	if (!response.ok) {
		throw classifyHttp(response.status, await shortDetail(response));
	}
	const payload = (await response.json()) as {
		data?: T | null;
		errors?: GraphqlError[];
	};
	const errors = payload.errors ?? [];
	if (errors.length > 0) {
		// A partial listing tolerates a scope error on the organizations
		// branch (reading them needs `read:org`, which a connection may lack):
		// the caller's own boards still list.
		const partial = options.allowPartial && payload.data;
		const scopeError = errors.find(
			(e) =>
				e.type === "INSUFFICIENT_SCOPES" &&
				!(partial && e.path?.includes("organizations")),
		);
		if (scopeError) {
			// GitHub names the scope it wanted ("requires one of the following
			// scopes: ['read:org']"); that sentence carries no credential.
			const wanted = /scopes?:?\s*\[[^\]]*\]/i.exec(
				scopeError.message ?? "",
			)?.[0];
			throw new GitHubProjectsError(
				"insufficient-scope",
				wanted
					? `${GITHUB_PROJECTS_SCOPE_MESSAGE} GitHub ${wanted.startsWith("scope") ? "needs " : ""}${wanted}${scopeError.path ? ` for ${scopeError.path.join(".")}` : ""}.`
					: GITHUB_PROJECTS_SCOPE_MESSAGE,
			);
		}
		if (!(options.allowPartial && payload.data)) {
			const first = errors[0];
			const detail = (first?.message ?? "").slice(0, 200);
			if (first?.type === "NOT_FOUND") {
				throw new GitHubProjectsError(
					"not-found",
					`GitHub item not found. ${detail}`.trim(),
				);
			}
			if (first?.type === "FORBIDDEN") {
				throw new GitHubProjectsError(
					"forbidden",
					`GitHub refused the request. ${detail}`.trim(),
				);
			}
			throw new GitHubProjectsError(
				"validation",
				`GitHub GraphQL error. ${detail}`.trim(),
			);
		}
	}
	if (!payload.data) {
		throw new GitHubProjectsError("http", "GitHub returned no data.");
	}
	return payload.data;
}

// =============================================================================
// External ids
// =============================================================================

/**
 * A story's external id on a GitHub Projects board:
 *   - issue → `owner/name#123` (unique across the repositories one board holds)
 *   - draft → `draft:<DraftIssue node id>`
 */
export type GitHubItemRef =
	| { kind: "issue"; owner: string; name: string; number: number }
	| { kind: "draft"; draftId: string };

const DRAFT_PREFIX = "draft:";

export function formatGitHubIssueExternalId(
	nameWithOwner: string,
	number: number,
): string {
	return `${nameWithOwner}#${number}`;
}

export function parseGitHubExternalId(externalId: string): GitHubItemRef {
	if (externalId.startsWith(DRAFT_PREFIX)) {
		const draftId = externalId.slice(DRAFT_PREFIX.length);
		if (!draftId) {
			throw new Error(`Invalid GitHub draft item id: ${externalId}`);
		}
		return { kind: "draft", draftId };
	}
	const match = externalId.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
	if (!match) {
		throw new Error(`Invalid GitHub issue id: ${externalId}`);
	}
	return {
		kind: "issue",
		owner: match[1] as string,
		name: match[2] as string,
		number: Number(match[3]),
	};
}

/**
 * The external id for what a person typed to name an issue: `owner/name#42`,
 * an issue URL, or `#42` / `42` in the project's own repository. Null when
 * it names no issue (a draft cannot be named by hand).
 */
export function normalizeGitHubItemReference(
	input: string,
	repository: string | null,
): string | null {
	const text = input.trim();
	const url = text.match(
		/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?(?:[?#].*)?$/i,
	);
	if (url) {
		return `${url[1]}/${url[2]}#${Number(url[3])}`;
	}
	const full = text.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
	if (full) {
		return `${full[1]}/${full[2]}#${Number(full[3])}`;
	}
	const bare = text.match(/^#?(\d+)$/);
	if (bare && repository) {
		return `${repository}#${Number(bare[1])}`;
	}
	return null;
}

function parseRepository(nameWithOwner: string): {
	owner: string;
	name: string;
} {
	const [owner, name, ...rest] = nameWithOwner.split("/");
	if (!owner || !name || rest.length > 0) {
		throw new Error(`Invalid GitHub repository: ${nameWithOwner}`);
	}
	return { owner, name };
}

// =============================================================================
// Boards
// =============================================================================

export interface GitHubProjectBoard {
	/** ProjectV2 node id. */
	id: string;
	number: number;
	title: string;
	url: string;
	ownerLogin: string;
	ownerType: "Organization" | "User";
	closed: boolean;
}

export interface GitHubProjectStatusOption {
	id: string;
	name: string;
}

export interface GitHubProjectBoardDetails extends GitHubProjectBoard {
	statusField: {
		id: string;
		options: GitHubProjectStatusOption[];
	} | null;
	/** Repositories linked to the board — the natural targets for new issues. */
	repositories: string[];
}

const BOARD_FIELDS = `
	id number title url closed
	owner { __typename ... on Organization { login } ... on User { login } }
`;

interface RawBoard {
	id: string;
	number: number;
	title: string;
	url: string;
	closed: boolean;
	owner: { __typename: string; login?: string } | null;
}

function toBoard(raw: RawBoard): GitHubProjectBoard {
	return {
		id: raw.id,
		number: raw.number,
		title: raw.title,
		url: raw.url,
		closed: raw.closed,
		ownerLogin: raw.owner?.login ?? "",
		ownerType:
			raw.owner?.__typename === "Organization" ? "Organization" : "User",
	};
}

/**
 * Whether a token can list boards owned by a personal account. GitHub gives
 * fine-grained tokens (`github_pat_`) and GitHub App user tokens (`ghu_`) no
 * permission for them: the listing comes back empty, not refused.
 */
export function githubTokenReadsPersonalBoards(token: string): boolean {
	return !token.startsWith("github_pat_") && !token.startsWith("ghu_");
}

/**
 * Every open board the caller can reach: their own, then each of their
 * organizations'. An organization that refuses the connection (OAuth app
 * restrictions) is skipped, not fatal.
 */
export async function listGitHubProjectBoards(
	token: string,
	options: RequestOptions = {},
): Promise<GitHubProjectBoard[]> {
	// The caller's own boards need only `project`; listing their
	// organizations also needs `read:org`, which a token may not carry. Two
	// queries, so a token without it still lists the caller's own boards.
	const own = await graphql<{
		viewer: { projectsV2: { nodes: Array<RawBoard | null> } | null };
	}>(
		token,
		`query FabricOwnBoards {
			viewer {
				projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
					nodes { ${BOARD_FIELDS} }
				}
			}
		}`,
		{},
		options,
	);
	type OrgBoards = {
		viewer: {
			organizations: {
				nodes: Array<{
					login: string;
					projectsV2: { nodes: Array<RawBoard | null> } | null;
				} | null>;
			} | null;
		};
	};
	let orgs: OrgBoards | null = null;
	try {
		orgs = await graphql<OrgBoards>(
			token,
			`query FabricOrgBoards {
				viewer {
					organizations(first: 50) {
						nodes {
							login
							projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
								nodes { ${BOARD_FIELDS} }
							}
						}
					}
				}
			}`,
			{},
			{ ...options, allowPartial: true },
		);
	} catch (error) {
		// No `read:org`: the organizations' boards are left out.
		if (
			!(error instanceof GitHubProjectsError) ||
			error.kind !== "insufficient-scope"
		) {
			throw error;
		}
	}
	const data = {
		viewer: {
			projectsV2: own.viewer.projectsV2,
			organizations: orgs?.viewer.organizations ?? null,
		},
	};
	const boards: GitHubProjectBoard[] = [];
	const seen = new Set<string>();
	const push = (raw: RawBoard | null) => {
		if (!raw || raw.closed || seen.has(raw.id)) {
			return;
		}
		seen.add(raw.id);
		boards.push(toBoard(raw));
	};
	for (const raw of data.viewer.projectsV2?.nodes ?? []) {
		push(raw);
	}
	for (const org of data.viewer.organizations?.nodes ?? []) {
		for (const raw of org?.projectsV2?.nodes ?? []) {
			push(raw);
		}
	}
	return boards;
}

/** One board with its Status field and linked repositories. */
export async function getGitHubProjectBoard(
	token: string,
	projectId: string,
	options: RequestOptions = {},
): Promise<GitHubProjectBoardDetails> {
	const data = await graphql<{
		node:
			| (RawBoard & {
					field: {
						id?: string;
						options?: GitHubProjectStatusOption[];
					} | null;
					repositories: {
						nodes: Array<{ nameWithOwner: string } | null>;
					};
			  })
			| null;
	}>(
		token,
		`query FabricBoard($id: ID!, $status: String!) {
			node(id: $id) {
				... on ProjectV2 {
					${BOARD_FIELDS}
					field(name: $status) {
						... on ProjectV2SingleSelectField { id options { id name } }
					}
					repositories(first: 50) { nodes { nameWithOwner } }
				}
			}
		}`,
		{ id: projectId, status: GITHUB_STATUS_FIELD_NAME },
		options,
	);
	const node = data.node;
	if (!node?.id) {
		throw new GitHubProjectsError(
			"not-found",
			"GitHub project board not found, or this connection cannot see it.",
		);
	}
	return {
		...toBoard(node),
		statusField:
			node.field?.id && Array.isArray(node.field.options)
				? { id: node.field.id, options: node.field.options }
				: null,
		repositories: node.repositories.nodes
			.map((r) => r?.nameWithOwner)
			.filter((r): r is string => typeof r === "string"),
	};
}

/** Issue Types an organization defines (empty for a user-owned repository). */
export async function listGitHubIssueTypes(
	token: string,
	repository: string,
	options: RequestOptions = {},
): Promise<Array<{ id: string; name: string }>> {
	const { owner, name } = parseRepository(repository);
	const data = await graphql<{
		repository: {
			issueTypes: {
				nodes: Array<{ id: string; name: string } | null>;
			} | null;
		} | null;
	}>(
		token,
		`query FabricIssueTypes($owner: String!, $name: String!) {
			repository(owner: $owner, name: $name) {
				issueTypes(first: 50) { nodes { id name } }
			}
		}`,
		{ owner, name },
		{ ...options, allowPartial: true },
	);
	return (data.repository?.issueTypes?.nodes ?? []).filter(
		(t): t is { id: string; name: string } => t !== null,
	);
}

/**
 * The Status option names in board order, as `Status::<name>` pseudo-labels,
 * paired with the option name — what a settings screen maps to Fabric
 * statuses.
 */
export function githubStatusLabels(
	board: Pick<GitHubProjectBoardDetails, "statusField">,
): Array<{ label: string; optionName: string }> {
	return (board.statusField?.options ?? []).map((o) => ({
		label: githubStatusLabel(o.name),
		optionName: o.name,
	}));
}

// =============================================================================
// Items
// =============================================================================

/** Compact item shape returned to list procedures (mirrors GitLab's). */
export interface GitHubPMListItem {
	id: string;
	displayId: string;
	title: string;
	workItemType: string;
	/** "opened" | "closed" — GitLab's vocabulary, which the poll reads. */
	state?: string;
	/** Board Status option name, if set. */
	status?: string | null;
	labels: string[];
	updatedAt?: string;
}

/** Full item shape returned to the import / pull paths (mirrors GitLab's). */
export interface GitHubPMFullItem {
	title: string;
	description: string | null;
	externalUrl: string | null;
	/** Real labels plus the `Status::<option>` pseudo-label. */
	labels: string[];
	state?: string;
	updatedAt?: string;
	workItemType: string;
	/** Parent issue's external id (sub-issues), if any. */
	parentExternalId: string | null;
	/** Board Status option name, if set. */
	status: string | null;
}

interface RawStatusValue {
	name?: string | null;
}

interface RawIssueContent {
	__typename: "Issue";
	id: string;
	number: number;
	title: string;
	body?: string | null;
	state: string;
	url: string;
	updatedAt: string;
	repository: { nameWithOwner: string };
	issueType?: { name: string } | null;
	labels?: { nodes: Array<{ name: string } | null> } | null;
	parent?: { number: number; repository: { nameWithOwner: string } } | null;
}

interface RawDraftContent {
	__typename: "DraftIssue";
	id: string;
	title: string;
	body?: string | null;
	updatedAt: string;
}

interface RawItem {
	id: string;
	type: string;
	content: RawIssueContent | RawDraftContent | { __typename: string } | null;
	fieldValueByName: RawStatusValue | null;
}

const ITEM_FIELDS = `
	id type
	fieldValueByName(name: "${GITHUB_STATUS_FIELD_NAME}") {
		... on ProjectV2ItemFieldSingleSelectValue { name }
	}
	content {
		__typename
		... on Issue {
			id number title state url updatedAt
			repository { nameWithOwner }
			issueType { name }
			labels(first: 50) { nodes { name } }
		}
		... on DraftIssue { id title updatedAt }
	}
`;

function issueState(raw: string): string {
	return raw === "CLOSED" ? "closed" : "opened";
}

function realLabels(raw: RawIssueContent["labels"]): string[] {
	return (raw?.nodes ?? [])
		.map((l) => l?.name?.trim() ?? "")
		.filter((l) => l.length > 0 && !isStatusLabel(l));
}

/**
 * Work-item type as a label, for repositories without Issue Types (every
 * user-owned repository, and organizations that define none): `type:feature`,
 * `type:story`, `type:bug`, …
 */
export const GITHUB_TYPE_LABEL_PREFIX = "type:";

export function githubTypeLabel(kind: string): string {
	return `${GITHUB_TYPE_LABEL_PREFIX}${kind.trim().toLowerCase().replace(/\s+/g, "-")}`;
}

function isTypeLabel(label: string): boolean {
	return label.toLowerCase().startsWith(GITHUB_TYPE_LABEL_PREFIX);
}

/** "type:user-story" → "User Story"; null when no type label is present. */
function typeFromLabels(labels: readonly string[]): string | null {
	const label = labels.find(isTypeLabel);
	if (!label) {
		return null;
	}
	const words = label
		.slice(GITHUB_TYPE_LABEL_PREFIX.length)
		.split(/[-_\s]+/)
		.filter((w) => w.length > 0);
	return words.length > 0
		? words.map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ")
		: null;
}

/**
 * The repository's Issue Type named `wanted` (case-insensitive), or null when
 * it has none by that name — then the type travels as a `type:` label. A
 * failed lookup reads as none.
 */
async function repositoryIssueType(
	token: string,
	repository: string,
	wanted: string,
): Promise<string | null> {
	try {
		const types = await listGitHubIssueTypes(token, repository);
		return (
			types.find((t) => t.name.toLowerCase() === wanted.toLowerCase())
				?.name ?? null
		);
	} catch {
		return null;
	}
}

function withStatusLabel(labels: string[], status: string | null): string[] {
	return status ? [...labels, githubStatusLabel(status)] : labels;
}

function toListItem(item: RawItem): GitHubPMListItem | null {
	const content = item.content;
	const status = item.fieldValueByName?.name ?? null;
	if (content?.__typename === "Issue") {
		const issue = content as RawIssueContent;
		const id = formatGitHubIssueExternalId(
			issue.repository.nameWithOwner,
			issue.number,
		);
		return {
			id,
			displayId: id,
			title: issue.title,
			workItemType:
				issue.issueType?.name ??
				typeFromLabels(realLabels(issue.labels)) ??
				"Issue",
			state: issueState(issue.state),
			status,
			labels: withStatusLabel(realLabels(issue.labels), status),
			updatedAt: issue.updatedAt,
		};
	}
	if (content?.__typename === "DraftIssue") {
		const draft = content as RawDraftContent;
		return {
			id: `${DRAFT_PREFIX}${draft.id}`,
			displayId: "Draft",
			title: draft.title,
			workItemType: "Draft",
			state: "opened",
			status,
			labels: withStatusLabel([], status),
			updatedAt: draft.updatedAt,
		};
	}
	// Pull requests and redacted items are not stories.
	return null;
}

/** Upper bound on items a single listing walks (100 per GraphQL page). */
const MAX_BOARD_ITEMS = 2000;

/**
 * Every issue and draft item on the board, newest board order. Pull requests
 * are skipped. Cursor-paged over GraphQL; `page`/`pageSize` slice the result
 * so callers keep GitLab's offset contract.
 */
export async function listGitHubProjectItemsForPM(input: {
	source: GitHubProjectsSource;
	page?: number;
	pageSize?: number;
	signal?: AbortSignal;
}): Promise<{ items: GitHubPMListItem[] }> {
	const page = Math.max(1, input.page ?? 1);
	const pageSize = Math.max(1, Math.min(input.pageSize ?? 100, 100));
	const wanted = page * pageSize;
	const all: GitHubPMListItem[] = [];
	let after: string | null = null;
	let fetched = 0;
	do {
		const data: {
			node: {
				items: {
					nodes: Array<RawItem | null>;
					pageInfo: {
						hasNextPage: boolean;
						endCursor: string | null;
					};
				};
			} | null;
		} = await graphql(
			input.source.token,
			`query FabricBoardItems($id: ID!, $after: String) {
				node(id: $id) {
					... on ProjectV2 {
						items(first: 100, after: $after) {
							nodes { ${ITEM_FIELDS} }
							pageInfo { hasNextPage endCursor }
						}
					}
				}
			}`,
			{ id: input.source.projectId, after },
			{ signal: input.signal },
		);
		if (!data.node) {
			throw new GitHubProjectsError(
				"not-found",
				"GitHub project board not found, or this connection cannot see it.",
			);
		}
		for (const raw of data.node.items.nodes) {
			fetched++;
			const item = raw ? toListItem(raw) : null;
			if (item) {
				all.push(item);
			}
		}
		const info = data.node.items.pageInfo;
		after = info.hasNextPage ? info.endCursor : null;
	} while (after && all.length < wanted && fetched < MAX_BOARD_ITEMS);
	return { items: all.slice((page - 1) * pageSize, page * pageSize) };
}

const ISSUE_DETAIL_FIELDS = `
	id number title body state url updatedAt
	repository { nameWithOwner }
	issueType { name }
	labels(first: 50) { nodes { name } }
	parent { number repository { nameWithOwner } }
	projectItems(first: 20) {
		nodes {
			id
			project { id }
			fieldValueByName(name: "${GITHUB_STATUS_FIELD_NAME}") {
				... on ProjectV2ItemFieldSingleSelectValue { name }
			}
		}
	}
`;

type RawIssueDetail = RawIssueContent & {
	projectItems: {
		nodes: Array<{
			id: string;
			project: { id: string };
			fieldValueByName: RawStatusValue | null;
		} | null>;
	};
};

type RawDraftDetail = RawDraftContent & {
	projectV2Items: {
		nodes: Array<{
			id: string;
			project: { id: string };
			fieldValueByName: RawStatusValue | null;
		} | null>;
	};
};

async function readIssue(
	token: string,
	ref: Extract<GitHubItemRef, { kind: "issue" }>,
	options: RequestOptions = {},
): Promise<RawIssueDetail> {
	const data = await graphql<{
		repository: { issue: RawIssueDetail | null } | null;
	}>(
		token,
		`query FabricIssue($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) {
				issue(number: $number) { ${ISSUE_DETAIL_FIELDS} }
			}
		}`,
		{ owner: ref.owner, name: ref.name, number: ref.number },
		options,
	);
	const issue = data.repository?.issue;
	if (!issue) {
		throw new GitHubProjectsError(
			"not-found",
			`GitHub issue ${ref.owner}/${ref.name}#${ref.number} not found.`,
		);
	}
	return issue;
}

async function readDraft(
	token: string,
	draftId: string,
	options: RequestOptions = {},
): Promise<RawDraftDetail> {
	const data = await graphql<{ node: RawDraftDetail | null }>(
		token,
		`query FabricDraft($id: ID!) {
			node(id: $id) {
				... on DraftIssue {
					id title body updatedAt
					projectV2Items(first: 5) {
						nodes {
							id
							project { id }
							fieldValueByName(name: "${GITHUB_STATUS_FIELD_NAME}") {
								... on ProjectV2ItemFieldSingleSelectValue { name }
							}
						}
					}
				}
			}
		}`,
		{ id: draftId },
		options,
	);
	if (!data.node?.id) {
		throw new GitHubProjectsError(
			"not-found",
			"GitHub draft item not found.",
		);
	}
	return data.node;
}

/** One issue or draft, with its Status on this board. */
export async function getGitHubProjectItemForPM(input: {
	source: GitHubProjectsSource;
	externalId: string;
	signal?: AbortSignal;
}): Promise<GitHubPMFullItem> {
	const { source } = input;
	const ref = parseGitHubExternalId(input.externalId);
	if (ref.kind === "draft") {
		const draft = await readDraft(source.token, ref.draftId, input);
		const onBoard = draft.projectV2Items.nodes.find(
			(n) => n?.project.id === source.projectId,
		);
		const status = onBoard?.fieldValueByName?.name ?? null;
		return {
			title: draft.title,
			description: draft.body ?? null,
			externalUrl: null,
			labels: withStatusLabel([], status),
			state: "opened",
			updatedAt: draft.updatedAt,
			workItemType: "Draft",
			parentExternalId: null,
			status,
		};
	}
	const issue = await readIssue(source.token, ref, input);
	const onBoard = issue.projectItems.nodes.find(
		(n) => n?.project.id === source.projectId,
	);
	const status = onBoard?.fieldValueByName?.name ?? null;
	return {
		title: issue.title,
		description: issue.body ?? null,
		externalUrl: issue.url,
		labels: withStatusLabel(realLabels(issue.labels), status),
		state: issueState(issue.state),
		updatedAt: issue.updatedAt,
		workItemType:
			issue.issueType?.name ??
			typeFromLabels(realLabels(issue.labels)) ??
			"Issue",
		parentExternalId: issue.parent
			? formatGitHubIssueExternalId(
					issue.parent.repository.nameWithOwner,
					issue.parent.number,
				)
			: null,
		status,
	};
}

export interface GitHubPMComment {
	author: string | null;
	createdAt: string | null;
	body: string;
}

/** Human comments on an issue (drafts have none). */
export async function getGitHubIssueCommentsForPM(input: {
	source: GitHubProjectsSource;
	externalId: string;
	maxComments?: number;
}): Promise<GitHubPMComment[]> {
	const ref = parseGitHubExternalId(input.externalId);
	if (ref.kind === "draft") {
		return [];
	}
	const raw = await rest<
		Array<{
			body?: string | null;
			created_at?: string;
			user?: { login?: string; type?: string } | null;
		}>
	>(
		input.source.token,
		"GET",
		`/repos/${ref.owner}/${ref.name}/issues/${ref.number}/comments?per_page=100`,
	);
	const comments: GitHubPMComment[] = [];
	for (const c of raw ?? []) {
		if (c.user?.type === "Bot") {
			continue;
		}
		const body = (c.body ?? "").trim();
		if (!body) {
			continue;
		}
		comments.push({
			author: c.user?.login ?? null,
			createdAt: c.created_at ?? null,
			body,
		});
	}
	return comments.slice(-(input.maxComments ?? 20));
}

// =============================================================================
// Writes
// =============================================================================

export interface GitHubPMCreatePayload {
	title: string;
	description?: string;
	/** Real labels plus at most one `Status::<option>` pseudo-label. */
	labels?: string[];
	/** Issue Type name (Epic, Feature, User Story, Task, …); ignored for drafts. */
	issueType?: string | null;
	/** Parent issue's external id; the new issue becomes its sub-issue. */
	parentExternalId?: string | null;
}

export interface GitHubPMUpdatePayload {
	title?: string;
	description?: string;
	labels?: string[];
	addLabels?: string[];
	removeLabels?: string[];
	stateEvent?: "close" | "reopen";
	issueType?: string | null;
	parentExternalId?: string | null;
}

export interface GitHubPMWriteResult {
	externalId: string;
	externalUrl: string | null;
	title: string;
	updatedAt: string | null;
}

function splitLabels(labels: readonly string[] | undefined): {
	real: string[];
	status: string | null;
} {
	const real: string[] = [];
	let status: string | null = null;
	for (const label of labels ?? []) {
		if (isStatusLabel(label)) {
			status = statusOptionOf(label);
		} else if (label.trim().length > 0) {
			real.push(label);
		}
	}
	return { real, status };
}

async function addToBoard(
	token: string,
	projectId: string,
	contentId: string,
): Promise<string> {
	const data = await graphql<{
		addProjectV2ItemById: { item: { id: string } | null } | null;
	}>(
		token,
		`mutation FabricAddItem($project: ID!, $content: ID!) {
			addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
				item { id }
			}
		}`,
		{ project: projectId, content: contentId },
		{ write: true },
	);
	const itemId = data.addProjectV2ItemById?.item?.id;
	if (!itemId) {
		throw new GitHubProjectsError(
			"http",
			"GitHub did not return the board item for the issue.",
		);
	}
	return itemId;
}

/**
 * Set (or clear, with `optionName` null) the board item's Status. An option
 * name the board does not have is skipped with no write: the next poll then
 * reads the board's own value back.
 */
async function setItemStatus(
	token: string,
	projectId: string,
	itemId: string,
	optionName: string | null,
): Promise<void> {
	const board = await getGitHubProjectBoard(token, projectId);
	const field = board.statusField;
	if (!field) {
		return;
	}
	if (optionName === null) {
		await graphql(
			token,
			`mutation FabricClearStatus($project: ID!, $item: ID!, $field: ID!) {
				clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) {
					projectV2Item { id }
				}
			}`,
			{ project: projectId, item: itemId, field: field.id },
			{ write: true },
		);
		return;
	}
	const option = field.options.find(
		(o) => o.name.toLowerCase() === optionName.toLowerCase(),
	);
	if (!option) {
		return;
	}
	await graphql(
		token,
		`mutation FabricSetStatus($project: ID!, $item: ID!, $field: ID!, $option: String!) {
			updateProjectV2ItemFieldValue(input: {
				projectId: $project, itemId: $item, fieldId: $field,
				value: { singleSelectOptionId: $option }
			}) { projectV2Item { id } }
		}`,
		{
			project: projectId,
			item: itemId,
			field: field.id,
			option: option.id,
		},
		{ write: true },
	);
}

interface RestIssue {
	id: number;
	node_id: string;
	number: number;
	title: string;
	html_url: string;
	updated_at?: string;
}

async function linkParent(
	token: string,
	child: { id: number },
	parentExternalId: string,
): Promise<void> {
	const parent = parseGitHubExternalId(parentExternalId);
	if (parent.kind !== "issue") {
		return;
	}
	try {
		await rest(
			token,
			"POST",
			`/repos/${parent.owner}/${parent.name}/issues/${parent.number}/sub_issues`,
			{ sub_issue_id: child.id, replace_parent: true },
		);
	} catch (error) {
		// Already its sub-issue → 422; anything else surfaces.
		if (
			!(
				error instanceof GitHubProjectsError &&
				error.kind === "validation"
			)
		) {
			throw error;
		}
	}
}

/** A Fabric story as a new issue on the board (or a draft without a repository). */
export async function createGitHubProjectItemFromStory(input: {
	source: GitHubProjectsSource;
	payload: GitHubPMCreatePayload;
	signal?: AbortSignal;
}): Promise<GitHubPMWriteResult> {
	const { source, payload } = input;
	const { real, status } = splitLabels(payload.labels);

	if (!source.repository) {
		const data = await graphql<{
			addProjectV2DraftIssue: {
				projectItem: {
					id: string;
					content: {
						id: string;
						title: string;
						updatedAt: string;
					} | null;
				} | null;
			} | null;
		}>(
			source.token,
			`mutation FabricAddDraft($project: ID!, $title: String!, $body: String) {
				addProjectV2DraftIssue(input: { projectId: $project, title: $title, body: $body }) {
					projectItem { id content { ... on DraftIssue { id title updatedAt } } }
				}
			}`,
			{
				project: source.projectId,
				title: payload.title,
				body: payload.description ?? null,
			},
			{ signal: input.signal, write: true },
		);
		const item = data.addProjectV2DraftIssue?.projectItem;
		if (!item?.content?.id) {
			throw new GitHubProjectsError(
				"http",
				"GitHub did not return the new draft item.",
			);
		}
		if (status) {
			await setItemStatus(
				source.token,
				source.projectId,
				item.id,
				status,
			);
		}
		return {
			externalId: `${DRAFT_PREFIX}${item.content.id}`,
			externalUrl: null,
			title: item.content.title,
			updatedAt: item.content.updatedAt,
		};
	}

	const { owner, name } = parseRepository(source.repository);
	const body: Record<string, unknown> = { title: payload.title };
	if (payload.description !== undefined) {
		body.body = payload.description;
	}
	if (real.length > 0) {
		body.labels = real;
	}
	// The story's type: the repository's Issue Type of that name, else a
	// `type:` label — unless the labels already carry one (a story imported
	// as `type:story` keeps it).
	if (payload.issueType) {
		const typeName = await repositoryIssueType(
			source.token,
			source.repository,
			payload.issueType,
		);
		if (typeName) {
			body.type = typeName;
		} else if (!real.some(isTypeLabel)) {
			body.labels = [...real, githubTypeLabel(payload.issueType)];
		}
	}
	let created: RestIssue;
	try {
		created = await rest<RestIssue>(
			source.token,
			"POST",
			`/repos/${owner}/${name}/issues`,
			body,
			{ signal: input.signal },
		);
	} catch (error) {
		// A user-owned repository has no Issue Types: GitHub refuses `type`.
		// Retry once without it, the type then travels as a label.
		if (
			payload.issueType &&
			error instanceof GitHubProjectsError &&
			error.kind === "validation"
		) {
			delete body.type;
			if (!real.some(isTypeLabel)) {
				body.labels = [...real, githubTypeLabel(payload.issueType)];
			}
			created = await rest<RestIssue>(
				source.token,
				"POST",
				`/repos/${owner}/${name}/issues`,
				body,
				{ signal: input.signal },
			);
		} else {
			throw error;
		}
	}
	// From here the issue exists: board / status / parent failures must not
	// hide its id, or a retry would create a second issue. They are retried
	// by the next update push (add-to-board is idempotent).
	try {
		const itemId = await addToBoard(
			source.token,
			source.projectId,
			created.node_id,
		);
		if (status) {
			await setItemStatus(source.token, source.projectId, itemId, status);
		}
		if (payload.parentExternalId) {
			await linkParent(source.token, created, payload.parentExternalId);
		}
	} catch (error) {
		console.warn("[github-projects] issue created; board step failed", {
			repository: source.repository,
			number: created.number,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return {
		externalId: formatGitHubIssueExternalId(
			source.repository,
			created.number,
		),
		externalUrl: created.html_url,
		title: created.title,
		updatedAt: created.updated_at ?? null,
	};
}

/** Apply a story update to its issue or draft and to the board's Status. */
export async function updateGitHubProjectItemFromStory(input: {
	source: GitHubProjectsSource;
	externalId: string;
	payload: GitHubPMUpdatePayload;
}): Promise<GitHubPMWriteResult> {
	const { source, payload } = input;
	const ref = parseGitHubExternalId(input.externalId);
	const added = splitLabels(payload.addLabels);
	const removed = splitLabels(payload.removeLabels);
	const full =
		payload.labels !== undefined ? splitLabels(payload.labels) : null;
	const wantedStatus = full?.status ?? added.status;
	const clearStatus =
		wantedStatus === null && (removed.status !== null || full !== null);

	if (ref.kind === "draft") {
		const draft = await readDraft(source.token, ref.draftId);
		let title = draft.title;
		let updatedAt: string | null = draft.updatedAt;
		if (payload.title !== undefined || payload.description !== undefined) {
			const data = await graphql<{
				updateProjectV2DraftIssue: {
					draftIssue: { title: string; updatedAt: string } | null;
				} | null;
			}>(
				source.token,
				`mutation FabricUpdateDraft($id: ID!, $title: String, $body: String) {
					updateProjectV2DraftIssue(input: { draftIssueId: $id, title: $title, body: $body }) {
						draftIssue { title updatedAt }
					}
				}`,
				{
					id: ref.draftId,
					title: payload.title ?? null,
					body: payload.description ?? null,
				},
				{ write: true },
			);
			title = data.updateProjectV2DraftIssue?.draftIssue?.title ?? title;
			updatedAt =
				data.updateProjectV2DraftIssue?.draftIssue?.updatedAt ??
				updatedAt;
		}
		const onBoard = draft.projectV2Items.nodes.find(
			(n) => n?.project.id === source.projectId,
		);
		if (onBoard && (wantedStatus !== null || clearStatus)) {
			await setItemStatus(
				source.token,
				source.projectId,
				onBoard.id,
				wantedStatus,
			);
		}
		return {
			externalId: input.externalId,
			externalUrl: null,
			title,
			updatedAt,
		};
	}

	const path = `/repos/${ref.owner}/${ref.name}/issues/${ref.number}`;
	const patch: Record<string, unknown> = {};
	if (payload.title !== undefined) {
		patch.title = payload.title;
	}
	if (payload.description !== undefined) {
		patch.body = payload.description;
	}
	if (payload.stateEvent !== undefined) {
		patch.state = payload.stateEvent === "close" ? "closed" : "open";
	}
	if (full) {
		patch.labels = full.real;
	}
	// The type is set only on an issue that has none yet — never replaced: a
	// type someone chose in GitHub (an Epic, a `type:story` label) stays.
	const extraLabels: string[] = [];
	if (payload.issueType) {
		const current = await readIssue(source.token, ref);
		const currentLabels = realLabels(current.labels);
		if (!current.issueType && !currentLabels.some(isTypeLabel)) {
			const typeName = await repositoryIssueType(
				source.token,
				`${ref.owner}/${ref.name}`,
				payload.issueType,
			);
			if (typeName) {
				patch.type = typeName;
			} else if (full) {
				if (!full.real.some(isTypeLabel)) {
					patch.labels = [
						...full.real,
						githubTypeLabel(payload.issueType),
					];
				}
			} else if (!added.real.some(isTypeLabel)) {
				extraLabels.push(githubTypeLabel(payload.issueType));
			}
		}
	}
	let issue: RestIssue;
	try {
		issue = await rest<RestIssue>(source.token, "PATCH", path, patch);
	} catch (error) {
		if (
			patch.type !== undefined &&
			error instanceof GitHubProjectsError &&
			error.kind === "validation"
		) {
			delete patch.type;
			issue = await rest<RestIssue>(source.token, "PATCH", path, patch);
		} else {
			throw error;
		}
	}
	const toAdd = [...added.real, ...extraLabels];
	if (!full && toAdd.length > 0) {
		await rest(source.token, "POST", `${path}/labels`, {
			labels: toAdd,
		});
	}
	if (!full) {
		for (const label of removed.real) {
			try {
				await rest(
					source.token,
					"DELETE",
					`${path}/labels/${encodeURIComponent(label)}`,
				);
			} catch (error) {
				if (
					!(
						error instanceof GitHubProjectsError &&
						error.kind === "not-found"
					)
				) {
					throw error;
				}
			}
		}
	}
	// add-to-board is idempotent: it also re-attaches an issue someone
	// removed from the board, and recovers a create whose board step failed.
	const itemId = await addToBoard(
		source.token,
		source.projectId,
		issue.node_id,
	);
	if (wantedStatus !== null || clearStatus) {
		await setItemStatus(
			source.token,
			source.projectId,
			itemId,
			wantedStatus,
		);
	}
	if (payload.parentExternalId) {
		await linkParent(source.token, issue, payload.parentExternalId);
	}
	return {
		externalId: input.externalId,
		externalUrl: issue.html_url,
		title: issue.title,
		updatedAt: issue.updated_at ?? null,
	};
}
