import { ORPCError } from "@orpc/client";
import { db, resolvePMConfigForUser } from "@repo/database";
import {
	GitLabApiError,
	GitLabMcpError,
	GitLabReauthRequiredError,
} from "@repo/integrations/gitlab";
import { logger } from "@repo/logs";
import {
	pmTicketsListDurationSeconds,
	pmTicketsListErrorsTotal,
	pmTicketsListRequestsTotal,
} from "@repo/observability";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import {
	getGitLabIssueForPM,
	getProjectPMServerKey,
	isGitLabOfficialKey,
	listGitLabIssuesForPM,
	resolveGitLabPMSource,
} from "./gitlab-pm-adapter";
import type {
	PMTicketListError,
	PMTicketListNote,
} from "./list-pm-tickets-filters.types";

/**
 * AUTHORIZATION: Uses canEditProject() — only project owners/editors can list PM tickets
 *
 * Lists unsynced tickets from the connected PM tool for the given project.
 * Returns only items whose external ID does not already exist as a Fabric story
 * in this project, so the user sees only new importable items.
 *
 * All items are fetched from the PM tool in a single large-pageSize request so
 * that filtering, search, and pagination can be applied in-memory against the
 * full result set. This gives an exact item count and makes search work across
 * all available tickets rather than just a single page.
 *
 * Each ticket includes a `displayId` — the user-friendly identifier shown in the PM
 * tool (e.g. "914" for Fizzy, "PROJ-123" for Jira, "42" for GitHub). Search matches
 * against both title and displayId.
 *
 * Filtering (F-1035):
 * - `filters.ids` — explicit ticket IDs. On ADO, invokes the batch-get fast
 *   path (`getWorkItemsByIdsFromPM`) and skips the full-board fetch loop
 *   entirely. On other adapters, full-board fetch + in-memory filter by IDs.
 * - Already-imported IDs are always hidden; on the IDs path each one is
 *   surfaced as a `notes[]` entry so the user knows why the row is absent.
 */

const ticketSchema = z.object({
	id: z.string(),
	/** User-friendly display ID (e.g. "914", "PROJ-123", "#42").
	 *  Falls back to `id` when not available. */
	displayId: z.string(),
	title: z.string(),
	workItemType: z.string().optional(),
	state: z.string().optional(),
	/** Whether this ticket has already been imported into the Fabric project. */
	alreadySynced: z.boolean(),
});

const noteSchema = z.object({
	kind: z.literal("already_imported"),
	id: z.number(),
});

const errorSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("not_found"), id: z.number() }),
	z.object({ kind: z.literal("wrong_board"), id: z.number() }),
	z.object({ kind: z.literal("auth"), id: z.number() }),
	z.object({ kind: z.literal("rate_limited"), id: z.number() }),
	z.object({
		kind: z.literal("server"),
		id: z.number(),
		status: z.number(),
	}),
	z.object({
		kind: z.literal("network"),
		id: z.number(),
		message: z.string(),
	}),
]);

const inputSchema = z.object({
	projectId: z.string(),
	/** 1-based page number (default: 1) */
	page: z.coerce.number().int().min(1).optional().default(1),
	/** Number of items per page (default: 30, max: 100) */
	pageSize: z.coerce.number().int().min(1).max(100).optional().default(30),
	/** Optional text filter applied to ticket title and displayId */
	search: z.string().optional(),
	/**
	 * Optional explicit filters for ticket IDs.
	 * Spec §6.1: ids capped at 200 as defense-in-depth (client already expands
	 * and caps before the request).
	 */
	filters: z
		.object({
			ids: z.array(z.number().int().positive()).max(200).optional(),
		})
		.optional(),
	/** When true, include already-imported tickets annotated with `alreadySynced: true`. */
	includeAlreadySynced: z.boolean().optional().default(false),
});

const outputSchema = z.object({
	tickets: z.array(ticketSchema),
	total: z.number(),
	/** Total tickets found on the board (before filtering out already-synced). */
	totalOnBoard: z.number(),
	/** Number of tickets from this board already imported into Fabric. */
	alreadySynced: z.number(),
	page: z.number(),
	pageSize: z.number(),
	hasNextPage: z.boolean(),
	/** Non-blocking notes (e.g. already-imported IDs on the IDs path). */
	notes: z.array(noteSchema),
	/** Per-ID resolution errors (not found, wrong board) — do not block apply. */
	errors: z.array(errorSchema),
});

/** Inferred input type for dialog + activity consumers. */
export type ListPMTicketsInput = z.input<typeof inputSchema>;
/** Inferred output type for the dialog to render. */
export type ListPMTicketsOutput = z.output<typeof outputSchema>;

/**
 * Adapter seam (Task 2.3): the procedure resolves these lazily from
 * `@repo/temporal`. Tests mock `@repo/temporal` directly; the spy then
 * observes which of `getWorkItemsByIdsFromPM` vs `listWorkItemsFromPM` is
 * invoked, per AC-12.
 */
type TemporalPMAdapters = Pick<
	typeof import("@repo/temporal"),
	| "listWorkItemsFromPM"
	| "searchWorkItemsFromPM"
	| "discoverPMToolCapabilities"
	| "listAllFizzyCards"
	| "getWorkItemsByIdsFromPM"
	| "fetchPMItemsByIds"
>;

async function loadTemporalPMAdapters(): Promise<TemporalPMAdapters> {
	const mod = await import("@repo/temporal");
	return {
		listWorkItemsFromPM: mod.listWorkItemsFromPM,
		searchWorkItemsFromPM: mod.searchWorkItemsFromPM,
		discoverPMToolCapabilities: mod.discoverPMToolCapabilities,
		listAllFizzyCards: mod.listAllFizzyCards,
		getWorkItemsByIdsFromPM: mod.getWorkItemsByIdsFromPM,
		fetchPMItemsByIds: mod.fetchPMItemsByIds,
	};
}

/** Match `search_workitem`, `search_workitems`, and prefixed variants. */
const SEARCH_WORKITEM_TOOL_PATTERN = /(?:^|_)search_workitems?$/i;

/**
 * Translate failures from the PM-tool listing path into user-friendly
 * `ORPCError`s. Without this, Temporal `ApplicationFailure`s bubble up as a
 * generic 500 / "Internal server error" in the Pull-from-PM dialog, even when
 * the underlying cause is a configuration issue the user can act on (e.g. the
 * connected ADO team has no backlog configured).
 *
 * Always throws — never returns. Re-throws unknown errors unchanged so
 * unrelated failures still surface their original stack.
 */
function translateListFetchError(
	err: unknown,
	context: { tool: string; projectId: string },
): never {
	const failureType =
		err && typeof err === "object" && "type" in err
			? String((err as { type?: unknown }).type ?? "")
			: "";
	const message =
		err instanceof Error ? err.message : typeof err === "string" ? err : "";

	const isNoBacklog =
		failureType === "NoBacklogConfigured" ||
		message.includes("Could not resolve backlog");

	if (isNoBacklog) {
		logger.warn("pm.tickets.list.no_backlog", {
			projectId: context.projectId,
			tool: context.tool,
		});
		throw new ORPCError("FAILED_PRECONDITION", {
			message:
				"This Azure DevOps team has no backlog configured. Search by Ticket ID, or ask an administrator to configure a backlog for the team in Azure DevOps.",
		});
	}

	throw err;
}

/**
 * Run requested-ID fetches in chunks so we never burst more than `limit`
 * concurrent GitLab REST calls. GitLab.com applies secondary rate limits
 * around 300 req/min per user; the existing per-ID fast path (ADO and the
 * generic non-ADO loop in story-sync) uses 5, so we match that.
 */
async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
	const results: Array<PromiseSettledResult<R>> = new Array(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
		(async () => {
			while (true) {
				const i = cursor++;
				if (i >= items.length) {
					return;
				}
				try {
					results[i] = {
						status: "fulfilled",
						value: await fn(items[i], i),
					};
				} catch (reason) {
					results[i] = { status: "rejected", reason };
				}
			}
		})(),
	);
	await Promise.all(workers);
	return results;
}

/**
 * Map a rejected per-ID fetch promise (from `mapWithConcurrency` against
 * `getGitLabIssueForPM`) to a discriminated `PMTicketListError`. Previously
 * every rejection was reported as `not_found`, which swallowed auth/rate-
 * limit/server/network failures and confused users who typed valid IDs during
 * a 429 window or with an expired OAuth token.
 *
 * Classification is driven by the HTTP status extracted from either
 * `GitLabApiError.status` (REST adapter) or `GitLabMcpError.httpStatus`
 * (official MCP transport, HTTP non-OK branch):
 *   - 404                 -> not_found (back-compat)
 *   - 401 / 403           -> auth
 *   - 429                 -> rate_limited
 *   - any other 4xx       -> server (with status) — validation/timeout/etc.
 *                            are NOT user-network problems
 *   - 5xx                 -> server (with status)
 *   - no HTTP status      -> network (with error message)
 *
 * JSON-RPC-level `GitLabMcpError` (no `httpStatus`) and non-error rejections
 * (e.g. `TypeError("fetch failed")`, AbortError) fall through to `network`,
 * since they cannot be attributed to a specific GitLab HTTP response.
 */
function classifyPullError(id: number, reason: unknown): PMTicketListError {
	// Extract HTTP status whether the error came from the REST adapter
	// (GitLabApiError.status) or the official-MCP HTTP transport
	// (GitLabMcpError.httpStatus). JSON-RPC-level MCP errors (without an
	// httpStatus) fall through to the catch-all 'network' bucket below.
	const status: number | undefined =
		reason instanceof GitLabApiError
			? reason.status
			: reason instanceof GitLabMcpError
				? reason.httpStatus
				: undefined;
	const message = reason instanceof Error ? reason.message : String(reason);

	if (status !== undefined) {
		if (status === 404) {
			return { kind: "not_found", id };
		}
		if (status === 401 || status === 403) {
			return { kind: "auth", id };
		}
		if (status === 429) {
			return { kind: "rate_limited", id };
		}
		// Any other 4xx is a GitLab-side rejection (validation, timeout,
		// legal, etc.) — report it as a 'server' kind with the real
		// status so the UI doesn't tell the user to check their network
		// connection.
		if (status >= 400 && status < 500) {
			return { kind: "server", id, status };
		}
		if (status >= 500) {
			return { kind: "server", id, status };
		}
	}
	return { kind: "network", id, message };
}

/**
 * Handle list-pm-tickets for projects backed by the GitLab official MCP
 * server. Bypasses the generic MCP discovery (which fails on tier-gated
 * accounts) and routes through `resolveGitLabSource` so REST-only users
 * still get a result.
 *
 * Mirrors the generic-path filtering/pagination semantics so the dialog
 * sees the same `tickets`/`total`/`notes`/`errors` shape.
 */
async function handleGitLabList(args: {
	projectId: string;
	gitlabProjectId: string;
	organizationId: string | null;
	userId: string;
	input: ListPMTicketsInput;
}): Promise<ListPMTicketsOutput> {
	const startTime = Date.now();
	const { projectId, gitlabProjectId, organizationId, userId } = args;
	// `input` is the validated Zod *output* on the procedure side; here it's
	// passed through unchanged so we re-cast to the output type for
	// destructuring the defaulted page/pageSize/includeAlreadySynced.
	const input = args.input as z.output<typeof inputSchema>;

	const source = await resolveGitLabPMSource({
		userId,
		organizationId,
		projectId,
	});
	if (!source) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"GitLab not connected. Connect your GitLab account in Settings → Integrations.",
		});
	}

	const existingRows = await db.userStory.findMany({
		where: { projectId, externalId: { not: null } },
		select: { externalId: true },
	});
	const existingExternalIds = new Set<string>();
	for (const row of existingRows) {
		if (row.externalId) {
			existingExternalIds.add(row.externalId.replace(/^#/, "").trim());
		}
	}

	const requestedIds = input.filters?.ids ?? [];
	const hasRequestedIds = requestedIds.length > 0;
	const notes: PMTicketListNote[] = [];
	const errors: PMTicketListError[] = [];

	type RawItem = {
		id: string;
		displayId: string;
		title: string;
		workItemType: string;
		state?: string;
	};
	const allRaw: RawItem[] = [];

	if (hasRequestedIds) {
		// Already-imported guard: hide before fetching (mirrors generic path).
		const alreadyImportedRequested = requestedIds.filter((id) =>
			existingExternalIds.has(String(id)),
		);
		if (!input.includeAlreadySynced) {
			for (const id of alreadyImportedRequested) {
				notes.push({ kind: "already_imported", id });
			}
		}
		const idsToFetch = input.includeAlreadySynced
			? requestedIds
			: requestedIds.filter((id) => !existingExternalIds.has(String(id)));

		const settled = await mapWithConcurrency(idsToFetch, 5, async (id) => {
			const item = await getGitLabIssueForPM({
				source,
				gitlabProjectId,
				externalId: String(id),
				userId,
				organizationId,
			});
			return { id, item };
		});

		for (let i = 0; i < settled.length; i++) {
			const res = settled[i];
			const id = idsToFetch[i];
			if (res.status === "fulfilled") {
				allRaw.push({
					id: String(id),
					displayId: String(id),
					title: res.value.item.title,
					workItemType: "Issue",
				});
			} else {
				errors.push(classifyPullError(id, res.reason));
			}
		}
	} else {
		// Page-walk until GitLab returns a short page or we hit the cap.
		const PM_FETCH_PAGE_SIZE = 100;
		const PM_FETCH_MAX_ITEMS = 2000;
		let fetchPage = 1;
		while (allRaw.length < PM_FETCH_MAX_ITEMS) {
			const { items } = await listGitLabIssuesForPM({
				source,
				gitlabProjectId,
				userId,
				organizationId,
				page: fetchPage,
				pageSize: PM_FETCH_PAGE_SIZE,
			});
			if (items.length === 0) {
				break;
			}
			if (fetchPage > 1) {
				const seen = new Set(allRaw.map((i) => i.id));
				const fresh = items.filter((i) => !seen.has(i.id));
				if (fresh.length === 0) {
					break;
				}
				allRaw.push(...fresh);
			} else {
				allRaw.push(...items);
			}
			if (items.length < PM_FETCH_PAGE_SIZE) {
				break;
			}
			fetchPage++;
		}
	}

	const totalOnBoard = allRaw.length;
	const alreadySynced = existingExternalIds.size;

	let allItems = input.includeAlreadySynced
		? allRaw
		: allRaw.filter((item) => !existingExternalIds.has(item.id));

	if (input.search?.trim()) {
		const q = input.search.trim().toLowerCase();
		allItems = allItems.filter(
			(item) =>
				item.displayId.toLowerCase().includes(q) ||
				item.title.toLowerCase().includes(q),
		);
	}

	const total = allItems.length;
	const { page, pageSize } = input;
	const start = (page - 1) * pageSize;
	const pageItems = allItems.slice(start, start + pageSize);

	const idsPath: "true" | "false" | "loop" = hasRequestedIds
		? "loop"
		: "false";
	pmTicketsListRequestsTotal.inc({ tool: "gitlab", batch_get: idsPath });
	pmTicketsListDurationSeconds.observe(
		{ tool: "gitlab", batch_get: idsPath },
		(Date.now() - startTime) / 1000,
	);
	for (const err of errors) {
		pmTicketsListErrorsTotal.inc({ tool: "gitlab", kind: err.kind });
	}
	logger.info("pm.tickets.list", {
		projectId,
		detectedType: "gitlab",
		rawDetectedType: "gitlab",
		taskListToolName: "list_issues",
		taskListContainerParam: "project_id",
		paginationStyle: "offset-page",
		containerValue: gitlabProjectId,
		totalOnBoard,
		batchGet: false,
		idsCount: requestedIds.length,
		total,
		alreadySynced,
		notesCount: notes.length,
		errorsCount: errors.length,
		source: source.kind,
	});

	return {
		tickets: pageItems.map((item) => ({
			id: item.id,
			displayId: item.displayId,
			title: item.title,
			workItemType: item.workItemType,
			state: item.state,
			alreadySynced: existingExternalIds.has(item.id),
		})),
		total,
		totalOnBoard,
		alreadySynced,
		page,
		pageSize,
		hasNextPage: start + pageSize < total,
		notes,
		errors,
	};
}

export const listPMTicketsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pm-tickets",
		tags: ["Projects", "Stories", "Sync"],
		summary: "List importable PM tickets",
		description:
			"Fetch tickets from the connected PM tool that have not yet been imported into this Fabric project. All items are fetched then filtered/paginated in-memory for accurate counts and cross-page search.",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// Load project with PM settings
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
				projectManagementContainerName: true,
				projectManagementAdditionalContext: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		if (!project.projectManagementContainerId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Select a board in Project Settings before listing PM tickets.",
			});
		}

		// GitLab official needs its own path: the MCP server is tier-gated and
		// may have been auto-disabled by the refresh probe. Detecting via the
		// MCPServer.key lets us route through resolveGitLabSource (MCP or
		// REST) instead of demanding a still-present MCPConfig row.
		const pmServerKey = await getProjectPMServerKey(
			project.projectManagementMcpServerId,
		);
		if (isGitLabOfficialKey(pmServerKey)) {
			try {
				return await handleGitLabList({
					projectId: input.projectId,
					gitlabProjectId: project.projectManagementContainerId,
					organizationId: project.organizationId,
					userId: user.id,
					input,
				});
			} catch (err) {
				// Map GitLab-side failures to user-actionable ORPCErrors so
				// the Pull dialog surfaces a real cause instead of a 500.
				// Mirrors the testPMSync error-shape contract. Also
				// increments the existing pm.tickets.list error counter and
				// emits a structured log alongside the throw — without
				// these, a dead-token storm is invisible in Grafana because
				// the success path's metrics never run.
				const kind:
					| "reauth"
					| "auth"
					| "rate_limited"
					| "server"
					| "mcp" =
					err instanceof GitLabReauthRequiredError
						? "reauth"
						: err instanceof GitLabApiError
							? err.status === 401 || err.status === 403
								? "auth"
								: err.status === 429
									? "rate_limited"
									: "server"
							: err instanceof GitLabMcpError
								? "mcp"
								: "server";
				pmTicketsListErrorsTotal.inc({ tool: "gitlab", kind });
				logger.warn("pm.tickets.list.gitlab_failed", {
					projectId: input.projectId,
					kind,
					status:
						err instanceof GitLabApiError
							? err.status
							: err instanceof GitLabMcpError
								? err.httpStatus
								: undefined,
					reason: err instanceof Error ? err.message : String(err),
				});
				if (err instanceof GitLabReauthRequiredError) {
					throw new ORPCError("UNAUTHORIZED", {
						message:
							"GitLab access token expired and refresh failed. Please reconnect your GitLab account in Settings → Integrations.",
					});
				}
				if (err instanceof GitLabApiError) {
					if (err.status === 401 || err.status === 403) {
						throw new ORPCError("UNAUTHORIZED", {
							message: `GitLab denied the request (${err.status}). Reconnect your GitLab account in Settings → Integrations.`,
						});
					}
					if (err.status === 429) {
						throw new ORPCError("TOO_MANY_REQUESTS", {
							message:
								"GitLab rate limit hit. Wait a minute and try again.",
						});
					}
					throw new ORPCError("BAD_REQUEST", {
						message: `GitLab error (${err.status}): ${err.message}`,
					});
				}
				if (err instanceof GitLabMcpError) {
					throw new ORPCError("BAD_REQUEST", {
						message: `GitLab MCP error: ${err.message}`,
					});
				}
				throw err;
			}
		}

		// Resolve the calling user's MCP config
		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		if (!userMcpConfig) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"You have not connected your account to the project management tool. Please configure your MCP connection in Settings.",
			});
		}

		if (!userMcpConfig.enabled) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Your project management connection is disabled. Please enable it in Settings.",
			});
		}

		const {
			listWorkItemsFromPM,
			searchWorkItemsFromPM,
			discoverPMToolCapabilities,
			listAllFizzyCards,
			getWorkItemsByIdsFromPM,
			fetchPMItemsByIds,
		} = await loadTemporalPMAdapters();

		const capabilities = await discoverPMToolCapabilities({
			mcpConfigId: userMcpConfig.id,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		if (!capabilities?.taskList) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This PM tool does not support listing tickets. Please use the individual import feature instead.",
			});
		}

		// Azure DevOps uses the project name; everything else uses the container ID
		const isADO = capabilities.detectedType === "azure-devops";
		const containerValue = isADO
			? (project.projectManagementContainerName ??
				project.projectManagementContainerId)
			: project.projectManagementContainerId;

		const additionalContext =
			project.projectManagementAdditionalContext as Record<
				string,
				string
			> | null;

		// Collect external IDs already imported into this project (used to filter below)
		const existingRows = await db.userStory.findMany({
			where: {
				projectId: input.projectId,
				externalId: { not: null },
			},
			select: { externalId: true },
		});
		const existingExternalIds = new Set<string>();
		for (const row of existingRows) {
			if (row.externalId) {
				existingExternalIds.add(
					row.externalId.replace(/^#/, "").trim(),
				);
			}
		}

		const startTime = Date.now();
		const detectedType = capabilities.detectedType;
		const requestedIds = input.filters?.ids ?? [];
		const hasRequestedIds = requestedIds.length > 0;
		const usedBatchGet = isADO && hasRequestedIds;

		const notes: PMTicketListNote[] = [];
		const errors: PMTicketListError[] = [];

		let allRaw: Awaited<ReturnType<typeof listWorkItemsFromPM>>["items"] =
			[];

		// Set when we satisfied the request via the PM tool's native search
		// endpoint (currently ADO `search_workitem`). Lets us skip the
		// in-memory `title.includes(query)` filter further down — the server
		// already did relevance-ranked filtering, and our substring re-filter
		// would only narrow valid results without adding signal.
		let usedServerSideSearch = false;

		// Set when the non-ADO + IDs + taskGet fast path successfully ran.
		// The fast path already populates notes/errors and `allRaw` contains
		// only the requested items, so we skip the legacy in-memory ID
		// filter further down to avoid double-emitting notes/errors.
		let usedNonAdoIdsFastPath = false;

		// Branch: ADO + explicit IDs → batch-get fast path (AC-12). Skip full board fetch.
		if (isADO && hasRequestedIds) {
			// Already-imported hide happens before the adapter call so an imported
			// ID never double-surfaces as both note + error.
			const alreadyImportedRequested = requestedIds.filter((id) =>
				existingExternalIds.has(String(id)),
			);
			if (!input.includeAlreadySynced) {
				for (const id of alreadyImportedRequested) {
					notes.push({ kind: "already_imported", id });
				}
			}
			const idsToFetch = input.includeAlreadySynced
				? requestedIds
				: requestedIds.filter(
						(id) => !existingExternalIds.has(String(id)),
					);

			const batch = await getWorkItemsByIdsFromPM({
				mcpConfigId: userMcpConfig.id,
				containerId: containerValue,
				containerName:
					project.projectManagementContainerName ?? undefined,
				additionalContext: additionalContext ?? undefined,
				userId: user.id,
				organizationId: project.organizationId ?? undefined,
				ids: idsToFetch,
			});

			allRaw = batch.items;
			for (const id of batch.notFoundIds) {
				errors.push({ kind: "not_found", id });
			}
			for (const id of batch.wrongBoardIds) {
				errors.push({ kind: "wrong_board", id });
			}

			// Debug-only trace of the ADO fast path. Never log more than the
			// first ≤5 requested ID values.
			logger.debug("pm.tickets.list.ado_batch_get", {
				projectId: input.projectId,
				requestedIds: idsToFetch.length,
				resolvedIds: batch.items.length,
				firstRequestedIds: idsToFetch.slice(0, 5),
			});
		} else if (!isADO && hasRequestedIds && capabilities.taskGet) {
			// Branch (NEW): non-ADO + explicit IDs + taskGet capability →
			// per-ID fast path. Calls the PM tool's single-item-get tool
			// in parallel for each requested ID, eliminating the 2000-item
			// full-board scan that silently dropped out-of-window IDs.
			const alreadyImportedRequested = requestedIds.filter((id) =>
				existingExternalIds.has(String(id)),
			);
			if (!input.includeAlreadySynced) {
				for (const id of alreadyImportedRequested) {
					notes.push({ kind: "already_imported", id });
				}
			}
			const idsToFetch = input.includeAlreadySynced
				? requestedIds
				: requestedIds.filter(
						(id) => !existingExternalIds.has(String(id)),
					);

			if (idsToFetch.length === 0) {
				// Every requested ID was already imported and excluded —
				// nothing to fetch. allRaw stays empty; the rest of the
				// procedure pages over zero items and returns notes.
				usedNonAdoIdsFastPath = true;
			} else {
				// Mark the fast path as used regardless of success/failure
				// of the inner try. We've already pushed `already_imported`
				// notes above, so the legacy in-memory ID-filter block must
				// be skipped to avoid double-emission. On try-catch failure
				// we accept clean empty results rather than re-running the
				// 2000-item full-board scan that this feature replaces.
				usedNonAdoIdsFastPath = true;
				try {
					const fetched = await fetchPMItemsByIds({
						mcpConfigId: userMcpConfig.id,
						containerId: containerValue,
						additionalContext: additionalContext ?? undefined,
						userId: user.id,
						organizationId: project.organizationId ?? undefined,
						externalIds: idsToFetch.map((n) => String(n)),
						concurrency: 5,
					});

					allRaw = fetched.items;
					const failedIds = fetched.failedIds ?? [];
					for (const failed of failedIds) {
						const asNum = Number(failed);
						if (Number.isFinite(asNum)) {
							errors.push({ kind: "not_found", id: asNum });
						}
					}
					logger.info("pm.tickets.list.ids_loop", {
						projectId: input.projectId,
						tool: detectedType ?? "unknown",
						requestedIds: idsToFetch.length,
						resolvedIds: fetched.items.length,
						failedIds: failedIds.length,
						firstRequestedIds: idsToFetch.slice(0, 5),
					});
				} catch (err) {
					// Defensive fallback: if the per-ID fast path itself
					// throws (transport/auth/etc.), log and leave allRaw
					// empty so the procedure returns clean empty results.
					// Worst case = today's behavior modulo the missing
					// list-and-filter retry; this is preferred over masking
					// real errors.
					logger.warn("pm.tickets.list.fetch_by_ids.fallback", {
						projectId: input.projectId,
						tool: detectedType ?? "unknown",
						reason:
							err instanceof Error ? err.message : String(err),
					});
				}
			}
		} else {
			// Server-side search fast path: when ADO exposes a `search_workitem`
			// tool and the user provided a keyword query, skip the full-board
			// fetch entirely. This avoids the `wit_list_backlogs` dependency
			// (teams without configured backlogs no longer 500), bypasses the
			// 2000-item ceiling, and uses the PM tool's relevance ranking.
			//
			// On any failure we silently fall through to the existing
			// list-and-filter path so we are never worse than today. Failures
			// are logged with a stable signal so we can detect regressions.
			const trimmedQuery = input.search?.trim();
			const searchToolName =
				isADO && trimmedQuery
					? capabilities.availableTools?.find((name: string) =>
							SEARCH_WORKITEM_TOOL_PATTERN.test(name),
						)
					: undefined;

			if (searchToolName && trimmedQuery) {
				try {
					const searchResult = await searchWorkItemsFromPM({
						mcpConfigId: userMcpConfig.id,
						containerId: containerValue,
						additionalContext: additionalContext ?? undefined,
						userId: user.id,
						organizationId: project.organizationId ?? undefined,
						query: trimmedQuery,
						top: 200,
					});
					allRaw = searchResult.items;
					usedServerSideSearch = true;
					logger.info("pm.tickets.list.server_search", {
						projectId: input.projectId,
						tool: detectedType ?? "unknown",
						searchTool: searchToolName,
						resultCount: allRaw.length,
					});
				} catch (err) {
					logger.warn("pm.tickets.search.fallback", {
						projectId: input.projectId,
						tool: detectedType ?? "unknown",
						searchTool: searchToolName,
						reason:
							err instanceof Error ? err.message : String(err),
					});
					// Intentionally swallow: fall through to the list-and-filter
					// path below. allRaw is still empty so the existing branch
					// runs unchanged.
				}
			}

			// Collect all available items from the PM tool across multiple pages.
			const PM_FETCH_PAGE_SIZE = 100;
			const PM_FETCH_MAX_ITEMS = 2000;

			const paginationStyle = capabilities.taskList.paginationInfo.style;

			// Skip the list-and-filter path when server-side search succeeded.
			if (!usedServerSideSearch) {
				try {
					// Fizzy's bulk get_cards API returns max ~15 cards. Use per-column
					// strategy to fetch all cards from every column on the board.
					if (capabilities.detectedType === "fizzy") {
						const fizzyResult = await listAllFizzyCards({
							mcpConfigId: userMcpConfig.id,
							containerId: containerValue,
							additionalContext: additionalContext ?? undefined,
							userId: user.id,
							organizationId: project.organizationId ?? undefined,
							capabilities,
							// This picker returns only id/displayId/title/
							// workItemType/state/alreadySynced, and its search
							// filter matches displayId + title — the card
							// descriptions that dominate a full payload are never
							// read here. Enumerating a board is one call per
							// column, so summary mode is the difference between a
							// multi-MB and a low-KB listing.
							fields: "summary",
						});
						if (fizzyResult) {
							allRaw = fizzyResult.items;
						}
					}

					// Generic fetch loop (non-Fizzy, or Fizzy fallback when per-column failed)
					if (allRaw.length === 0) {
						let fetchPage = 1;
						const keepFetching = true;
						let effectivePageSize: number | undefined;

						while (
							keepFetching &&
							allRaw.length < PM_FETCH_MAX_ITEMS
						) {
							const result = await listWorkItemsFromPM({
								mcpConfigId: userMcpConfig.id,
								containerId: containerValue,
								additionalContext:
									additionalContext ?? undefined,
								userId: user.id,
								organizationId:
									project.organizationId ?? undefined,
								page: fetchPage,
								pageSize: PM_FETCH_PAGE_SIZE,
							});
							const { items, total, hasNextPage } = result;

							if (items.length === 0) {
								break;
							}

							if (fetchPage > 1) {
								const existingIds = new Set(
									allRaw.map((i) => i.id),
								);
								const newItems = items.filter(
									(i) => !existingIds.has(i.id),
								);
								if (newItems.length === 0) {
									break;
								}
								allRaw.push(...newItems);
							} else {
								allRaw.push(...items);
							}

							if (total != null) {
								if (allRaw.length >= total) {
									break;
								}
							} else {
								if (
									effectivePageSize == null &&
									items.length < PM_FETCH_PAGE_SIZE
								) {
									effectivePageSize = items.length;
								}
								const threshold =
									effectivePageSize ?? PM_FETCH_PAGE_SIZE;
								if (items.length < threshold) {
									break;
								}
							}

							if (
								total == null &&
								effectivePageSize == null &&
								(paginationStyle === "offset-page" ||
									paginationStyle === "offset-skip") &&
								!hasNextPage
							) {
								break;
							}

							fetchPage++;
						}
					}
				} catch (err) {
					translateListFetchError(err, {
						tool: detectedType ?? "unknown",
						projectId: input.projectId,
					});
				}
			}
		}

		const totalOnBoard = allRaw.length;
		const alreadySynced = existingExternalIds.size;

		const normalizeId = (id: string) => id.replace(/^#/, "").trim();

		let allItems = input.includeAlreadySynced
			? allRaw
			: allRaw.filter(
					(item) => !existingExternalIds.has(normalizeId(item.id)),
				);

		// Non-ADO IDs path: filter by requested IDs and emit not_found for
		// misses. Skipped when the new per-ID fast path already produced
		// `allRaw` and pushed notes/errors — re-running this would
		// double-emit duplicates.
		if (hasRequestedIds && !isADO && !usedNonAdoIdsFastPath) {
			const requestedIdStrings = new Set(
				requestedIds.map((i) => normalizeId(String(i))),
			);
			// Already-imported requested IDs → notes[] (hide preserved above).
			if (!input.includeAlreadySynced) {
				for (const id of requestedIds) {
					if (existingExternalIds.has(normalizeId(String(id)))) {
						notes.push({ kind: "already_imported", id });
					}
				}
			}
			allItems = allItems.filter(
				(item) =>
					requestedIdStrings.has(normalizeId(item.id)) ||
					(item.displayId != null &&
						requestedIdStrings.has(normalizeId(item.displayId))),
			);
			const resolvedIdStrings = new Set<string>();
			for (const item of allItems) {
				resolvedIdStrings.add(normalizeId(item.id));
				if (item.displayId != null) {
					resolvedIdStrings.add(normalizeId(item.displayId));
				}
			}
			for (const id of requestedIds) {
				const s = normalizeId(String(id));
				if (!resolvedIdStrings.has(s) && !existingExternalIds.has(s)) {
					errors.push({ kind: "not_found", id });
				}
			}
		}

		// Apply search against title and displayId. When the PM tool's native
		// search endpoint already filtered server-side (with relevance ranking
		// across description / additional fields), skip this redundant
		// substring re-filter — it would only narrow valid results without
		// adding signal.
		if (input.search?.trim() && !usedServerSideSearch) {
			const q = input.search.trim().toLowerCase();
			allItems = allItems.filter(
				(item) =>
					(item.displayId ?? item.id).toLowerCase().includes(q) ||
					(item.title ?? "").toLowerCase().includes(q),
			);
		}

		const total = allItems.length;
		const { page, pageSize } = input;
		const start = (page - 1) * pageSize;
		const pageItems = allItems.slice(start, start + pageSize);

		// Telemetry. Counts only — no ticket
		// titles, IDs beyond the debug line above, or customer content.
		const idsPath: "true" | "false" | "loop" = usedBatchGet
			? "true"
			: !isADO && hasRequestedIds && capabilities.taskGet
				? "loop"
				: "false";
		const batchGetLabel = idsPath;
		const toolLabel = detectedType ?? "unknown";
		pmTicketsListRequestsTotal.inc({
			tool: toolLabel,
			batch_get: batchGetLabel,
		});
		pmTicketsListDurationSeconds.observe(
			{ tool: toolLabel, batch_get: batchGetLabel },
			(Date.now() - startTime) / 1000,
		);
		for (const err of errors) {
			pmTicketsListErrorsTotal.inc({
				tool: toolLabel,
				kind: err.kind,
			});
		}
		logger.info("pm.tickets.list", {
			projectId: input.projectId,
			detectedType: toolLabel,
			rawDetectedType: capabilities.detectedType,
			taskListToolName: capabilities.taskList?.toolName,
			taskListContainerParam: capabilities.taskList?.containerParam,
			paginationStyle: capabilities.taskList?.paginationInfo.style,
			containerValue,
			totalOnBoard,
			batchGet: usedBatchGet,
			idsCount: requestedIds.length,
			total,
			alreadySynced,
			notesCount: notes.length,
			errorsCount: errors.length,
		});

		return {
			tickets: pageItems.map((item) => ({
				id: item.id,
				displayId: item.displayId ?? item.id,
				title: item.title ?? item.id,
				workItemType: item.workItemType,
				state: item.state,
				alreadySynced: existingExternalIds.has(item.id),
			})),
			total,
			totalOnBoard,
			alreadySynced,
			page,
			pageSize,
			hasNextPage: start + pageSize < total,
			notes,
			errors,
		};
	});
