/**
 * Tests for listPMTicketsProcedure (F-1035 / Task 2.4)
 *
 * Focus: adapter routing (ADO batch-get vs full-fetch), filter-bypass rule
 * when IDs are supplied (AC-8), notes/errors emission (AC-9, §6.2), XOR
 * tenant context honored for personal + org projects, and output Zod round-
 * trip on additive fields.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks -----------------------------------------------------------------

// `@repo/logs` pulls in `consola`, which may not be hoisted in some
// dev installs. The logger is only used for observability, so stub it.
vi.mock("@repo/logs", () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

const mockPmTicketsListErrorsTotalInc = vi.fn();
vi.mock("@repo/observability", () => ({
	pmTicketsListDurationSeconds: { observe: vi.fn() },
	pmTicketsListErrorsTotal: { inc: mockPmTicketsListErrorsTotalInc },
	pmTicketsListRequestsTotal: { inc: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	resolvePMConfigForUser: vi.fn(),
	db: {
		project: {
			findUnique: vi.fn(),
		},
		userStory: {
			findMany: vi.fn(),
		},
	},
}));

const mockListWorkItemsFromPM = vi.fn();
const mockSearchWorkItemsFromPM = vi.fn();
const mockGetWorkItemsByIdsFromPM = vi.fn();
const mockDiscoverPMToolCapabilities = vi.fn();
const mockListAllFizzyCards = vi.fn();
const mockFetchPMItemsByIds = vi.fn();

vi.mock("@repo/temporal", () => ({
	listWorkItemsFromPM: mockListWorkItemsFromPM,
	searchWorkItemsFromPM: mockSearchWorkItemsFromPM,
	getWorkItemsByIdsFromPM: mockGetWorkItemsByIdsFromPM,
	discoverPMToolCapabilities: mockDiscoverPMToolCapabilities,
	listAllFizzyCards: mockListAllFizzyCards,
	fetchPMItemsByIds: mockFetchPMItemsByIds,
}));

const mockGetProjectPMServerKey = vi.fn();
const mockIsGitLabOfficialKey = vi.fn();
const mockResolveGitLabPMSource = vi.fn();
const mockListGitLabIssuesForPM = vi.fn();
const mockGetGitLabIssueForPM = vi.fn();

vi.mock("../gitlab-pm-adapter", () => ({
	getProjectPMServerKey: (...args: unknown[]) =>
		mockGetProjectPMServerKey(...args),
	isGitLabOfficialKey: (...args: unknown[]) =>
		mockIsGitLabOfficialKey(...args),
	resolveGitLabPMSource: (...args: unknown[]) =>
		mockResolveGitLabPMSource(...args),
	listGitLabIssuesForPM: (...args: unknown[]) =>
		mockListGitLabIssuesForPM(...args),
	getGitLabIssueForPM: (...args: unknown[]) =>
		mockGetGitLabIssueForPM(...args),
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chain = {
		route: () => chain,
		input: () => chain,
		output: () => chain,
		use: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => (handler: unknown) => handler,
		Permissions: { STORY_READ: "story:read" },
	};
});

import { db, resolvePMConfigForUser } from "@repo/database";
import {
	GitLabApiError,
	GitLabMcpError,
	GitLabReauthRequiredError,
} from "@repo/integrations/gitlab";

// ---- Fixtures --------------------------------------------------------------

type ProjectRow = {
	id: string;
	organizationId: string | null;
	projectManagementMcpServerId: string;
	projectManagementMcpConfigId: string;
	projectManagementContainerId: string;
	projectManagementContainerName: string | null;
	projectManagementAdditionalContext: Record<string, string> | null;
};

function makeProject(overrides: Partial<ProjectRow> = {}): ProjectRow {
	return {
		id: "proj-1",
		organizationId: null,
		projectManagementMcpServerId: "mcp-server-1",
		projectManagementMcpConfigId: "mcp-cfg-1",
		projectManagementContainerId: "container-1",
		projectManagementContainerName: "Board Name",
		projectManagementAdditionalContext: null,
		...overrides,
	};
}

const baseCtx = {
	user: { id: "user-1" },
	session: { id: "session-1" },
};

function adoCapabilities(overrides?: { availableTools?: string[] }) {
	return {
		detectedType: "azure-devops" as const,
		taskList: {
			paginationInfo: { style: "offset-page" as const },
		},
		availableTools: overrides?.availableTools ?? [],
	};
}

function jiraCapabilities() {
	return {
		detectedType: "jira" as const,
		taskList: {
			paginationInfo: { style: "offset-page" as const },
		},
	};
}

function fizzyCapabilities() {
	return {
		detectedType: "fizzy" as const,
		taskList: {
			paginationInfo: { style: "offset-page" as const },
		},
		availableTools: ["fizzy_get_columns", "fizzy_get_cards"],
	};
}

function defaultSetup(overrides?: { project?: Partial<ProjectRow> }) {
	vi.mocked(db.project.findUnique).mockResolvedValue(
		makeProject(overrides?.project) as never,
	);
	vi.mocked(db.userStory.findMany).mockResolvedValue([] as never);
	vi.mocked(resolvePMConfigForUser).mockResolvedValue({
		id: "mcp-cfg-1",
		enabled: true,
	} as never);
	// Non-GitLab default: the procedure consults isGitLabOfficialKey before
	// resolvePMConfigForUser, so any test that doesn't override these mocks
	// gets the generic MCP path.
	mockGetProjectPMServerKey.mockResolvedValue("jira");
	mockIsGitLabOfficialKey.mockImplementation(
		(k: unknown) => k === "gitlab-official",
	);
}

async function loadProcedureHandler() {
	const mod = await import("../list-pm-tickets");
	// biome-ignore lint/suspicious/noExplicitAny: test hatch — mocked procedure
	return (mod.listPMTicketsProcedure as any).handler as (args: {
		input: unknown;
		context: typeof baseCtx;
	}) => Promise<unknown>;
}

// ---- Tests -----------------------------------------------------------------

describe("listPMTicketsProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDiscoverPMToolCapabilities.mockReset();
		mockListWorkItemsFromPM.mockReset();
		mockSearchWorkItemsFromPM.mockReset();
		mockGetWorkItemsByIdsFromPM.mockReset();
		mockListAllFizzyCards.mockReset();
		mockFetchPMItemsByIds.mockReset();
		mockGetProjectPMServerKey.mockReset();
		mockIsGitLabOfficialKey.mockReset();
		mockResolveGitLabPMSource.mockReset();
		mockListGitLabIssuesForPM.mockReset();
		mockGetGitLabIssueForPM.mockReset();
	});

	it("honors XOR tenant context for personal projects (organizationId: null)", async () => {
		defaultSetup({ project: { organizationId: null } });
		mockDiscoverPMToolCapabilities.mockResolvedValue(jiraCapabilities());
		mockListWorkItemsFromPM.mockResolvedValue({
			items: [],
			hasNextPage: false,
			availableWorkItemTypes: [],
			availableStates: [],
		});

		const handler = await loadProcedureHandler();
		await handler({
			input: { projectId: "proj-1", page: 1, pageSize: 30 },
			context: baseCtx,
		});

		expect(resolvePMConfigForUser).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: undefined,
			}),
		);
		expect(mockListWorkItemsFromPM).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: undefined,
			}),
		);
	});

	it("honors XOR tenant context for org projects (organizationId present)", async () => {
		defaultSetup({ project: { organizationId: "org-9" } });
		mockDiscoverPMToolCapabilities.mockResolvedValue(jiraCapabilities());
		mockListWorkItemsFromPM.mockResolvedValue({
			items: [],
			hasNextPage: false,
			availableWorkItemTypes: [],
			availableStates: [],
		});

		const handler = await loadProcedureHandler();
		await handler({
			input: { projectId: "proj-1", page: 1, pageSize: 30 },
			context: baseCtx,
		});

		expect(resolvePMConfigForUser).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-9",
			}),
		);
		expect(mockListWorkItemsFromPM).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-9",
			}),
		);
	});

	// This picker never reads a card description, so it opts into fizzy-mcp's
	// `fields: "summary"` projection — the difference between a multi-MB and a
	// low-KB board listing, since enumerating a board is one call per column.
	// Pinned here rather than only at the activity level: the activity tests
	// prove the arg reaches the wire, but would all still pass if this
	// procedure silently stopped asking for it.
	it("fizzy → requests the summary projection from listAllFizzyCards", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue(fizzyCapabilities());
		mockListAllFizzyCards.mockResolvedValue({
			// Non-empty: an empty result falls through to the generic
			// listWorkItemsFromPM loop, which is a different code path.
			items: [{ id: "card-1", displayId: "42", title: "A card" }],
			hasNextPage: false,
		});

		const handler = await loadProcedureHandler();
		await handler({
			input: { projectId: "proj-1", page: 1, pageSize: 30 },
			context: baseCtx,
		});

		expect(mockListAllFizzyCards).toHaveBeenCalledWith(
			expect.objectContaining({ fields: "summary" }),
		);
	});

	it("ADO + filters.ids → calls getWorkItemsByIdsFromPM, not listWorkItemsFromPM (AC-12)", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue(adoCapabilities());
		mockGetWorkItemsByIdsFromPM.mockResolvedValue({
			items: [
				{
					id: "417",
					displayId: "417",
					title: "Alpha",
					workItemType: "Feature",
					state: "New",
				},
			],
			availableWorkItemTypes: ["Feature"],
			availableStates: [{ name: "New", isTerminal: false }],
			notFoundIds: [9999],
			wrongBoardIds: [],
		});

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				filters: { ids: [417, 9999] },
			},
			context: baseCtx,
		})) as { tickets: unknown[]; errors: { kind: string; id: number }[] };

		expect(mockGetWorkItemsByIdsFromPM).toHaveBeenCalledTimes(1);
		expect(mockGetWorkItemsByIdsFromPM).toHaveBeenCalledWith(
			expect.objectContaining({ ids: [417, 9999] }),
		);
		expect(mockListWorkItemsFromPM).not.toHaveBeenCalled();
		expect(result.tickets).toHaveLength(1);
		expect(result.errors).toEqual([{ kind: "not_found", id: 9999 }]);
	});

	it("ADO + IDs → already-imported IDs emit notes and are not refetched (AC-9)", async () => {
		defaultSetup();
		vi.mocked(db.userStory.findMany).mockResolvedValue([
			{ externalId: "417" },
		] as never);
		mockDiscoverPMToolCapabilities.mockResolvedValue(adoCapabilities());
		mockGetWorkItemsByIdsFromPM.mockResolvedValue({
			items: [],
			availableWorkItemTypes: [],
			availableStates: [],
			notFoundIds: [],
			wrongBoardIds: [],
		});

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				filters: { ids: [417, 418] },
			},
			context: baseCtx,
		})) as { notes: { kind: string; id: number }[] };

		expect(mockGetWorkItemsByIdsFromPM).toHaveBeenCalledWith(
			expect.objectContaining({ ids: [418] }),
		);
		expect(result.notes).toEqual([{ kind: "already_imported", id: 417 }]);
	});

	it("non-ADO + IDs → calls fetchPMItemsByIds, never listWorkItemsFromPM", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue({
			...jiraCapabilities(),
			taskGet: {
				toolName: "get_issue",
				idParam: "issue_iid",
				additionalRequiredParams: ["project_id"],
			},
			availableTools: ["get_issue", "list_issues"],
		});
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				{ id: "417", displayId: "417", title: "Alpha" },
				{ id: "419", displayId: "419", title: "Gamma" },
			],
			total: 2,
			hasNextPage: false,
			failedIds: ["9999"],
			failedIdErrors: { "9999": "404 Not Found" },
		});

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				filters: { ids: [417, 419, 9999] },
			},
			context: baseCtx,
		})) as {
			tickets: { id: string }[];
			errors: { kind: string; id: number }[];
		};

		expect(mockFetchPMItemsByIds).toHaveBeenCalledTimes(1);
		expect(mockFetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({
				externalIds: ["417", "419", "9999"],
				concurrency: 5,
			}),
		);
		expect(mockListWorkItemsFromPM).not.toHaveBeenCalled();
		expect(mockGetWorkItemsByIdsFromPM).not.toHaveBeenCalled();
		expect(result.tickets.map((t) => t.id).sort()).toEqual(["417", "419"]);
		expect(result.errors).toEqual([{ kind: "not_found", id: 9999 }]);
	});

	it("non-ADO + IDs → already-imported ID emits notes and is not refetched", async () => {
		defaultSetup();
		vi.mocked(db.userStory.findMany).mockResolvedValue([
			{ externalId: "417" },
		] as never);
		mockDiscoverPMToolCapabilities.mockResolvedValue({
			...jiraCapabilities(),
			taskGet: {
				toolName: "get_issue",
				idParam: "issue_iid",
				additionalRequiredParams: ["project_id"],
			},
			availableTools: ["get_issue"],
		});
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [],
			total: 0,
			hasNextPage: false,
			failedIds: [],
		});

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				filters: { ids: [417, 418] },
			},
			context: baseCtx,
		})) as { notes: { kind: string; id: number }[] };

		expect(mockFetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({ externalIds: ["418"] }),
		);
		expect(result.notes).toEqual([{ kind: "already_imported", id: 417 }]);
	});

	it("non-ADO + IDs + includeAlreadySynced=true → fetches all requested IDs", async () => {
		defaultSetup();
		vi.mocked(db.userStory.findMany).mockResolvedValue([
			{ externalId: "417" },
		] as never);
		mockDiscoverPMToolCapabilities.mockResolvedValue({
			...jiraCapabilities(),
			taskGet: {
				toolName: "get_issue",
				idParam: "issue_iid",
				additionalRequiredParams: ["project_id"],
			},
			availableTools: ["get_issue"],
		});
		mockFetchPMItemsByIds.mockResolvedValue({
			items: [
				{ id: "417", displayId: "417", title: "Alpha" },
				{ id: "418", displayId: "418", title: "Beta" },
			],
			total: 2,
			hasNextPage: false,
			failedIds: [],
		});

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				filters: { ids: [417, 418] },
				includeAlreadySynced: true,
			},
			context: baseCtx,
		})) as {
			tickets: { id: string; alreadySynced: boolean }[];
			notes: unknown[];
		};

		expect(mockFetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({ externalIds: ["417", "418"] }),
		);
		expect(result.notes).toEqual([]);
		expect(result.tickets.find((t) => t.id === "417")?.alreadySynced).toBe(
			true,
		);
	});

	it("non-ADO without taskGet capability → falls through to listWorkItemsFromPM (no regression)", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue({
			...jiraCapabilities(),
			taskGet: undefined, // tool doesn't expose single-item get
			availableTools: ["list_issues"],
		});
		mockListWorkItemsFromPM.mockResolvedValue({
			items: [{ id: "417", displayId: "417", title: "Alpha" }],
			hasNextPage: false,
			availableWorkItemTypes: [],
			availableStates: [],
		});

		const handler = await loadProcedureHandler();
		await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				filters: { ids: [417] },
			},
			context: baseCtx,
		});

		expect(mockFetchPMItemsByIds).not.toHaveBeenCalled();
		expect(mockListWorkItemsFromPM).toHaveBeenCalled();
	});

	it("non-ADO + IDs → fetchPMItemsByIds throws → returns empty result and does not propagate (fallback)", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue({
			...jiraCapabilities(),
			taskGet: {
				toolName: "get_issue",
				idParam: "issue_iid",
				additionalRequiredParams: ["project_id"],
			},
			availableTools: ["get_issue"],
		});
		mockFetchPMItemsByIds.mockRejectedValueOnce(
			new Error("transport blew up"),
		);

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				filters: { ids: [417, 418] },
			},
			context: baseCtx,
		})) as {
			tickets: unknown[];
			errors: unknown[];
			notes: unknown[];
			total: number;
		};

		expect(mockFetchPMItemsByIds).toHaveBeenCalledTimes(1);
		// Procedure must not propagate the helper's exception — it logs and
		// returns an empty result so the dialog doesn't 500.
		expect(result.tickets).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(result.total).toBe(0);
	});

	it("non-ADO + IDs → all requested IDs already imported (excludeSynced) → emits notes and never calls fetchPMItemsByIds", async () => {
		defaultSetup();
		vi.mocked(db.userStory.findMany).mockResolvedValue([
			{ externalId: "417" },
			{ externalId: "418" },
		] as never);
		mockDiscoverPMToolCapabilities.mockResolvedValue({
			...jiraCapabilities(),
			taskGet: {
				toolName: "get_issue",
				idParam: "issue_iid",
				additionalRequiredParams: ["project_id"],
			},
			availableTools: ["get_issue"],
		});

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				filters: { ids: [417, 418] },
			},
			context: baseCtx,
		})) as {
			tickets: unknown[];
			notes: { kind: string; id: number }[];
			errors: unknown[];
		};

		expect(mockFetchPMItemsByIds).not.toHaveBeenCalled();
		expect(mockListWorkItemsFromPM).not.toHaveBeenCalled();
		expect(result.notes).toEqual([
			{ kind: "already_imported", id: 417 },
			{ kind: "already_imported", id: 418 },
		]);
		expect(result.tickets).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("ADO + keyword search + search_workitem available → uses searchWorkItemsFromPM, skips list/filter path", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue(
			adoCapabilities({ availableTools: ["search_workitem"] }),
		);
		mockSearchWorkItemsFromPM.mockResolvedValue({
			items: [
				{
					id: "417",
					displayId: undefined,
					title: "DealioDesk integration spike",
					workItemType: "Feature",
					state: "Active",
				},
			],
			total: 1,
			hasNextPage: false,
		});

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				search: "dealiodesk",
			},
			context: baseCtx,
		})) as { tickets: unknown[]; total: number; totalOnBoard: number };

		expect(mockSearchWorkItemsFromPM).toHaveBeenCalledTimes(1);
		expect(mockSearchWorkItemsFromPM).toHaveBeenCalledWith(
			expect.objectContaining({ query: "dealiodesk" }),
		);
		// list-and-filter path was bypassed entirely
		expect(mockListWorkItemsFromPM).not.toHaveBeenCalled();
		expect(result.tickets).toHaveLength(1);
		expect(result.total).toBe(1);
	});

	it("ADO + keyword search + search tool exists but throws → silently falls back to listWorkItemsFromPM", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue(
			adoCapabilities({ availableTools: ["search_workitem"] }),
		);
		mockSearchWorkItemsFromPM.mockRejectedValue(
			new Error("ADO Search service not enabled on this collection"),
		);
		mockListWorkItemsFromPM.mockResolvedValue({
			items: [
				{ id: "10", displayId: "10", title: "matching dealiodesk row" },
				{ id: "11", displayId: "11", title: "unrelated" },
			],
			hasNextPage: false,
		});

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				search: "dealiodesk",
			},
			context: baseCtx,
		})) as { tickets: Array<{ id: string }> };

		expect(mockSearchWorkItemsFromPM).toHaveBeenCalledTimes(1);
		expect(mockListWorkItemsFromPM).toHaveBeenCalled();
		// In-memory filter narrows to the matching row only
		expect(result.tickets).toHaveLength(1);
		expect(result.tickets[0]?.id).toBe("10");
	});

	it("ADO + keyword search but no search_workitem tool registered → uses list+filter (no fallback)", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue(
			adoCapabilities({
				availableTools: ["wit_list_backlog_work_items"],
			}),
		);
		mockListWorkItemsFromPM.mockResolvedValue({
			items: [{ id: "1", displayId: "1", title: "Hello" }],
			hasNextPage: false,
		});

		const handler = await loadProcedureHandler();
		await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				search: "hello",
			},
			context: baseCtx,
		});

		expect(mockSearchWorkItemsFromPM).not.toHaveBeenCalled();
		expect(mockListWorkItemsFromPM).toHaveBeenCalled();
	});

	it("non-ADO + keyword search → never invokes searchWorkItemsFromPM even if tool name matches", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue({
			...jiraCapabilities(),
			availableTools: ["search_workitem"], // unlikely on jira but defensive
		});
		mockListWorkItemsFromPM.mockResolvedValue({
			items: [{ id: "1", displayId: "PROJ-1", title: "x" }],
			hasNextPage: false,
		});

		const handler = await loadProcedureHandler();
		await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				search: "x",
			},
			context: baseCtx,
		});

		expect(mockSearchWorkItemsFromPM).not.toHaveBeenCalled();
		expect(mockListWorkItemsFromPM).toHaveBeenCalled();
	});

	it("ADO + server-side search returned 5 items → in-memory substring filter does NOT re-narrow them", async () => {
		// search_workitem matches descriptions / fuzzy / stemming; the server
		// already returned what it considers relevant. Re-applying
		// `title.includes(query)` would drop semantically-relevant matches
		// whose titles don't contain the literal substring.
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue(
			adoCapabilities({ availableTools: ["search_workitem"] }),
		);
		mockSearchWorkItemsFromPM.mockResolvedValue({
			items: [
				{ id: "1", title: "Authentication flow rewrite" }, // matched on description
				{ id: "2", title: "OAuth scopes" }, // matched on description
			],
			total: 2,
			hasNextPage: false,
		});

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				page: 1,
				pageSize: 30,
				search: "login",
			},
			context: baseCtx,
		})) as { tickets: unknown[]; total: number };

		// Both returned even though "login" is in neither title
		expect(result.tickets).toHaveLength(2);
		expect(result.total).toBe(2);
	});

	it("listWorkItemsFromPM throws ApplicationFailure with type=NoBacklogConfigured → procedure throws FAILED_PRECONDITION ORPCError instead of bubbling 500", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue(adoCapabilities());
		// Shape mirrors what @temporalio/common ApplicationFailure.nonRetryable
		// produces: a thrown Error subclass exposing `.type` and `.message`.
		const failure = Object.assign(
			new Error(
				"Could not resolve backlog. Ensure the team has backlogs configured in Azure DevOps.",
			),
			{ type: "NoBacklogConfigured" },
		);
		mockListWorkItemsFromPM.mockRejectedValue(failure);

		const handler = await loadProcedureHandler();
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					page: 1,
					pageSize: 30,
					search: "anything",
				},
				context: baseCtx,
			}),
		).rejects.toMatchObject({
			code: "FAILED_PRECONDITION",
			message: expect.stringContaining("backlog"),
		});
	});

	it("listWorkItemsFromPM throws unrelated error → procedure rethrows unchanged", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue(adoCapabilities());
		mockListWorkItemsFromPM.mockRejectedValue(
			new Error("ECONNRESET upstream"),
		);

		const handler = await loadProcedureHandler();
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					page: 1,
					pageSize: 30,
					search: "anything",
				},
				context: baseCtx,
			}),
		).rejects.toThrow("ECONNRESET upstream");
	});

	it("no filters provided → additive behavior preserved (existing caller compatibility)", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue(jiraCapabilities());
		mockListWorkItemsFromPM.mockResolvedValue({
			items: [{ id: "1", displayId: "1", title: "Only" }],
			hasNextPage: false,
		});

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: { projectId: "proj-1", page: 1, pageSize: 30 },
			context: baseCtx,
		})) as {
			tickets: unknown[];
			notes: unknown[];
			errors: unknown[];
		};

		expect(result.tickets).toHaveLength(1);
		expect(result.notes).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("output satisfies Zod schema round-trip", async () => {
		defaultSetup();
		mockDiscoverPMToolCapabilities.mockResolvedValue(jiraCapabilities());
		mockListWorkItemsFromPM.mockResolvedValue({
			items: [
				{
					id: "1",
					displayId: "1",
					title: "One",
					workItemType: "Feature",
					state: "Active",
				},
			],
			hasNextPage: false,
		});

		const handler = await loadProcedureHandler();
		const result = await handler({
			input: { projectId: "proj-1", page: 1, pageSize: 30 },
			context: baseCtx,
		});

		const { z } = await import("zod");
		const outputSchema = z.object({
			tickets: z.array(
				z.object({
					id: z.string(),
					displayId: z.string(),
					title: z.string(),
					workItemType: z.string().optional(),
					state: z.string().optional(),
					alreadySynced: z.boolean(),
				}),
			),
			total: z.number(),
			totalOnBoard: z.number(),
			alreadySynced: z.number(),
			page: z.number(),
			pageSize: z.number(),
			hasNextPage: z.boolean(),
			notes: z.array(
				z.object({
					kind: z.literal("already_imported"),
					id: z.number(),
				}),
			),
			errors: z.array(
				z.object({
					kind: z.enum(["not_found", "wrong_board"]),
					id: z.number(),
				}),
			),
		});
		expect(() => outputSchema.parse(result)).not.toThrow();
	});

	// ---- includeAlreadySynced tests (Task 1.1–1.3) ----------------------------

	describe("includeAlreadySynced", () => {
		it("default (false) filters out already-imported tickets", async () => {
			defaultSetup();
			vi.mocked(db.userStory.findMany).mockResolvedValue([
				{ externalId: "1" },
			] as never);
			mockDiscoverPMToolCapabilities.mockResolvedValue(
				jiraCapabilities(),
			);
			mockListWorkItemsFromPM.mockResolvedValue({
				items: [
					{ id: "1", displayId: "1", title: "Imported" },
					{ id: "2", displayId: "2", title: "New" },
				],
				hasNextPage: false,
			});

			const handler = await loadProcedureHandler();
			const result = (await handler({
				input: { projectId: "proj-1", page: 1, pageSize: 30 },
				context: baseCtx,
			})) as { tickets: { id: string; alreadySynced: boolean }[] };

			expect(result.tickets).toHaveLength(1);
			expect(result.tickets[0].id).toBe("2");
			expect(result.tickets[0].alreadySynced).toBe(false);
		});

		it("true returns all tickets with correct alreadySynced annotation", async () => {
			defaultSetup();
			vi.mocked(db.userStory.findMany).mockResolvedValue([
				{ externalId: "1" },
			] as never);
			mockDiscoverPMToolCapabilities.mockResolvedValue(
				jiraCapabilities(),
			);
			mockListWorkItemsFromPM.mockResolvedValue({
				items: [
					{ id: "1", displayId: "1", title: "Imported" },
					{ id: "2", displayId: "2", title: "New" },
				],
				hasNextPage: false,
			});

			const handler = await loadProcedureHandler();
			const result = (await handler({
				input: {
					projectId: "proj-1",
					page: 1,
					pageSize: 30,
					includeAlreadySynced: true,
				},
				context: baseCtx,
			})) as { tickets: { id: string; alreadySynced: boolean }[] };

			expect(result.tickets).toHaveLength(2);
			const imported = result.tickets.find((t) => t.id === "1");
			const fresh = result.tickets.find((t) => t.id === "2");
			expect(imported?.alreadySynced).toBe(true);
			expect(fresh?.alreadySynced).toBe(false);
		});

		it("true with search works across both new and already-synced tickets", async () => {
			defaultSetup();
			vi.mocked(db.userStory.findMany).mockResolvedValue([
				{ externalId: "1" },
			] as never);
			mockDiscoverPMToolCapabilities.mockResolvedValue(
				jiraCapabilities(),
			);
			mockListWorkItemsFromPM.mockResolvedValue({
				items: [
					{ id: "1", displayId: "1", title: "Login bug" },
					{ id: "2", displayId: "2", title: "Logout bug" },
					{ id: "3", displayId: "3", title: "Dashboard" },
				],
				hasNextPage: false,
			});

			const handler = await loadProcedureHandler();
			const result = (await handler({
				input: {
					projectId: "proj-1",
					page: 1,
					pageSize: 30,
					search: "bug",
					includeAlreadySynced: true,
				},
				context: baseCtx,
			})) as { tickets: { id: string; alreadySynced: boolean }[] };

			expect(result.tickets).toHaveLength(2);
			expect(result.tickets.map((t) => t.id).sort()).toEqual(["1", "2"]);
			expect(
				result.tickets.find((t) => t.id === "1")?.alreadySynced,
			).toBe(true);
			expect(
				result.tickets.find((t) => t.id === "2")?.alreadySynced,
			).toBe(false);
		});

		it("ADO batch path includes already-imported IDs when flag is true", async () => {
			defaultSetup();
			vi.mocked(db.userStory.findMany).mockResolvedValue([
				{ externalId: "417" },
			] as never);
			mockDiscoverPMToolCapabilities.mockResolvedValue(adoCapabilities());
			mockGetWorkItemsByIdsFromPM.mockResolvedValue({
				items: [
					{
						id: "417",
						displayId: "417",
						title: "Imported",
						workItemType: "Feature",
						state: "Active",
					},
					{
						id: "418",
						displayId: "418",
						title: "Fresh",
						workItemType: "Feature",
						state: "New",
					},
				],
				availableWorkItemTypes: ["Feature"],
				availableStates: [
					{ name: "Active", isTerminal: false },
					{ name: "New", isTerminal: false },
				],
				notFoundIds: [],
				wrongBoardIds: [],
			});

			const handler = await loadProcedureHandler();
			const result = (await handler({
				input: {
					projectId: "proj-1",
					page: 1,
					pageSize: 30,
					filters: { ids: [417, 418] },
					includeAlreadySynced: true,
				},
				context: baseCtx,
			})) as {
				tickets: { id: string; alreadySynced: boolean }[];
				notes: { kind: string; id: number }[];
			};

			// Both IDs should be fetched (not just 418)
			expect(mockGetWorkItemsByIdsFromPM).toHaveBeenCalledWith(
				expect.objectContaining({ ids: [417, 418] }),
			);
			expect(result.tickets).toHaveLength(2);
			expect(
				result.tickets.find((t) => t.id === "417")?.alreadySynced,
			).toBe(true);
			expect(
				result.tickets.find((t) => t.id === "418")?.alreadySynced,
			).toBe(false);
			// No notes emitted when includeAlreadySynced is true
			expect(result.notes).toEqual([]);
		});

		it("non-ADO IDs path does not emit notes when includeAlreadySynced is true", async () => {
			defaultSetup();
			vi.mocked(db.userStory.findMany).mockResolvedValue([
				{ externalId: "417" },
			] as never);
			mockDiscoverPMToolCapabilities.mockResolvedValue(
				jiraCapabilities(),
			);
			mockListWorkItemsFromPM.mockResolvedValue({
				items: [
					{ id: "417", displayId: "417", title: "Imported" },
					{ id: "418", displayId: "418", title: "Fresh" },
				],
				hasNextPage: false,
			});

			const handler = await loadProcedureHandler();
			const result = (await handler({
				input: {
					projectId: "proj-1",
					page: 1,
					pageSize: 30,
					filters: { ids: [417, 418] },
					includeAlreadySynced: true,
				},
				context: baseCtx,
			})) as {
				tickets: { id: string; alreadySynced: boolean }[];
				notes: { kind: string; id: number }[];
			};

			expect(result.tickets).toHaveLength(2);
			expect(
				result.tickets.find((t) => t.id === "417")?.alreadySynced,
			).toBe(true);
			expect(result.notes).toEqual([]);
		});
	});

	// ------------------------------------------------------------------
	// GitLab official branch — bypasses the MCP-discovery path so REST-only
	// users (Free tier / auto-flipped configs) can still list and import.
	// ------------------------------------------------------------------
	describe("GitLab official branch", () => {
		it("routes through listGitLabIssuesForPM when MCP server is gitlab-official", async () => {
			defaultSetup({
				project: {
					projectManagementContainerId: "23",
					projectManagementContainerName: "alice/widgets",
				},
			});
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue({
				kind: "rest-adapter",
				token: "glpat-test",
			} as never);
			mockListGitLabIssuesForPM.mockResolvedValue({
				items: [
					{
						id: "1",
						displayId: "1",
						title: "Add OAuth reconnect flow",
						workItemType: "Issue",
						state: "opened",
					},
					{
						id: "2",
						displayId: "2",
						title: "Fix rate-limit toast copy",
						workItemType: "Issue",
						state: "closed",
					},
				],
			});

			const handler = await loadProcedureHandler();
			const result = (await handler({
				input: {
					projectId: "proj-1",
					page: 1,
					pageSize: 30,
					includeAlreadySynced: false,
				},
				context: baseCtx,
			})) as {
				tickets: Array<{ id: string; title: string }>;
				total: number;
			};

			expect(mockResolveGitLabPMSource).toHaveBeenCalledWith({
				userId: "user-1",
				organizationId: null,
				projectId: "proj-1",
			});
			expect(mockListGitLabIssuesForPM).toHaveBeenCalled();
			// Generic MCP discovery must not run for GitLab.
			expect(mockDiscoverPMToolCapabilities).not.toHaveBeenCalled();
			expect(mockListWorkItemsFromPM).not.toHaveBeenCalled();
			expect(result.tickets).toHaveLength(2);
			expect(result.tickets[0].id).toBe("1");
		});

		it("throws BAD_REQUEST when GitLab is not connected (source resolver returns null)", async () => {
			defaultSetup();
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue(null);

			const handler = await loadProcedureHandler();
			await expect(
				handler({
					input: { projectId: "proj-1", page: 1, pageSize: 30 },
					context: baseCtx,
				}),
			).rejects.toThrow(/GitLab not connected/);
			expect(mockListGitLabIssuesForPM).not.toHaveBeenCalled();
		});

		it("filters by requested IDs via per-ID fetch and emits not_found for misses", async () => {
			defaultSetup();
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue({
				kind: "rest-adapter",
				token: "glpat-test",
			} as never);
			// First ID resolves; second ID rejects with a real 404 GitLabApiError.
			mockGetGitLabIssueForPM.mockImplementation(
				async ({ externalId }: { externalId: string }) => {
					if (externalId === "1") {
						return {
							title: "Add OAuth reconnect flow",
							description: null,
							externalUrl:
								"https://gitlab.com/alice/widgets/-/issues/1",
							labels: [],
						};
					}
					throw new GitLabApiError(404, "issue not found");
				},
			);

			const handler = await loadProcedureHandler();
			const result = (await handler({
				input: {
					projectId: "proj-1",
					page: 1,
					pageSize: 30,
					filters: { ids: [1, 999] },
				},
				context: baseCtx,
			})) as {
				tickets: Array<{ id: string }>;
				errors: Array<{ kind: string; id: number }>;
			};

			expect(mockGetGitLabIssueForPM).toHaveBeenCalledTimes(2);
			expect(result.tickets).toHaveLength(1);
			expect(result.tickets[0].id).toBe("1");
			expect(result.errors).toContainEqual({
				kind: "not_found",
				id: 999,
			});
		});

		describe("error classification (Task 5)", () => {
			function setupGitLabReject(reason: unknown) {
				defaultSetup();
				mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
				mockResolveGitLabPMSource.mockResolvedValue({
					kind: "rest-adapter",
					token: "glpat-test",
				} as never);
				mockGetGitLabIssueForPM.mockRejectedValueOnce(reason);
			}

			async function pullOne(id: number) {
				const handler = await loadProcedureHandler();
				return (await handler({
					input: {
						projectId: "proj-1",
						page: 1,
						pageSize: 30,
						filters: { ids: [id] },
					},
					context: baseCtx,
				})) as {
					tickets: Array<{ id: string }>;
					errors: Array<
						| { kind: "not_found"; id: number }
						| { kind: "auth"; id: number }
						| { kind: "rate_limited"; id: number }
						| { kind: "server"; id: number; status: number }
						| { kind: "network"; id: number; message: string }
					>;
				};
			}

			it("classifies 401 errors as 'auth' not 'not_found'", async () => {
				setupGitLabReject(new GitLabApiError(401, "invalid_token"));
				const result = await pullOne(1);
				expect(result.errors).toEqual([{ kind: "auth", id: 1 }]);
			});

			it("classifies 403 errors as 'auth' not 'not_found'", async () => {
				setupGitLabReject(new GitLabApiError(403, "forbidden"));
				const result = await pullOne(2);
				expect(result.errors).toEqual([{ kind: "auth", id: 2 }]);
			});

			it("classifies 429 errors as 'rate_limited' not 'not_found'", async () => {
				setupGitLabReject(new GitLabApiError(429, "rate limit"));
				const result = await pullOne(3);
				expect(result.errors).toEqual([
					{ kind: "rate_limited", id: 3 },
				]);
			});

			it("classifies 5xx errors as 'server' with the status", async () => {
				setupGitLabReject(
					new GitLabApiError(503, "service unavailable"),
				);
				const result = await pullOne(4);
				expect(result.errors).toEqual([
					{ kind: "server", id: 4, status: 503 },
				]);
			});

			it("classifies non-GitLabApiError rejections as 'network'", async () => {
				setupGitLabReject(new TypeError("fetch failed"));
				const result = await pullOne(5);
				expect(result.errors).toEqual([
					{ kind: "network", id: 5, message: "fetch failed" },
				]);
			});

			it("still classifies 404 as 'not_found' (regression)", async () => {
				setupGitLabReject(new GitLabApiError(404, "issue not found"));
				const result = await pullOne(6);
				expect(result.errors).toEqual([{ kind: "not_found", id: 6 }]);
			});

			it("classifies MCP-path 404 as 'not_found' (via GitLabMcpError.httpStatus)", async () => {
				setupGitLabReject(
					new GitLabMcpError(
						"GitLab MCP HTTP 404: not found",
						undefined,
						404,
					),
				);
				const result = await pullOne(7);
				expect(result.errors).toEqual([{ kind: "not_found", id: 7 }]);
			});

			it("classifies MCP-path 401 as 'auth'", async () => {
				setupGitLabReject(
					new GitLabMcpError(
						"GitLab MCP HTTP 401: unauthorized",
						undefined,
						401,
					),
				);
				const result = await pullOne(8);
				expect(result.errors).toEqual([{ kind: "auth", id: 8 }]);
			});

			it("classifies MCP-path 5xx as 'server' with the status", async () => {
				setupGitLabReject(
					new GitLabMcpError(
						"GitLab MCP HTTP 503: service unavailable",
						undefined,
						503,
					),
				);
				const result = await pullOne(9);
				expect(result.errors).toEqual([
					{ kind: "server", id: 9, status: 503 },
				]);
			});

			it("classifies 422 (validation error) as 'server' with status 422 (NOT network)", async () => {
				setupGitLabReject(new GitLabApiError(422, "validation failed"));
				const result = await pullOne(10);
				expect(result.errors).toEqual([
					{ kind: "server", id: 10, status: 422 },
				]);
			});

			it("classifies 408 (request timeout) as 'server' with status 408 (NOT network)", async () => {
				setupGitLabReject(new GitLabApiError(408, "request timeout"));
				const result = await pullOne(11);
				expect(result.errors).toEqual([
					{ kind: "server", id: 11, status: 408 },
				]);
			});

			it("classifies JSON-RPC-level GitLabMcpError (no httpStatus) as 'network'", async () => {
				// JSON-RPC error (e.g. invalid params, code -32602) has no
				// httpStatus — the transport itself succeeded, the protocol
				// rejected. Falls through to the catch-all network bucket.
				setupGitLabReject(new GitLabMcpError("invalid params", -32602));
				const result = await pullOne(12);
				expect(result.errors).toEqual([
					{ kind: "network", id: 12, message: "invalid params" },
				]);
			});
		});

		it("hides already-imported requested IDs and never refetches them", async () => {
			defaultSetup();
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue({
				kind: "rest-adapter",
				token: "glpat-test",
			} as never);
			vi.mocked(db.userStory.findMany).mockResolvedValue([
				{ externalId: "1" },
			] as never);
			mockGetGitLabIssueForPM.mockResolvedValue({
				title: "Add OAuth reconnect flow",
				description: null,
				externalUrl: null,
				labels: [],
			});

			const handler = await loadProcedureHandler();
			const result = (await handler({
				input: {
					projectId: "proj-1",
					page: 1,
					pageSize: 30,
					filters: { ids: [1] },
				},
				context: baseCtx,
			})) as {
				tickets: Array<{ id: string }>;
				notes: Array<{ kind: string; id: number }>;
			};

			expect(mockGetGitLabIssueForPM).not.toHaveBeenCalled();
			expect(result.tickets).toEqual([]);
			expect(result.notes).toContainEqual({
				kind: "already_imported",
				id: 1,
			});
		});

		describe("procedure-level error mapping (Pull dialog graceful errors)", () => {
			it("translates GitLabReauthRequiredError into UNAUTHORIZED with a Reconnect message", async () => {
				// Mirrors the PR #1222 fix for testPMSync: when the user's
				// refresh token is dead, the Pull dialog must surface
				// "reconnect GitLab" — NOT a generic 500.
				defaultSetup();
				mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
				mockResolveGitLabPMSource.mockResolvedValue({
					kind: "rest-adapter",
					token: "glpat-test",
				} as never);
				mockListGitLabIssuesForPM.mockRejectedValueOnce(
					new GitLabReauthRequiredError(),
				);

				const handler = await loadProcedureHandler();
				await expect(
					handler({
						input: { projectId: "proj-1", page: 1, pageSize: 30 },
						context: baseCtx,
					}),
				).rejects.toMatchObject({
					code: "UNAUTHORIZED",
					message: expect.stringMatching(
						/expired.*Please reconnect.*Settings.*Integrations/i,
					),
				});
			});

			it("translates GitLabApiError(401) into UNAUTHORIZED", async () => {
				defaultSetup();
				mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
				mockResolveGitLabPMSource.mockResolvedValue({
					kind: "rest-adapter",
					token: "glpat-test",
				} as never);
				mockListGitLabIssuesForPM.mockRejectedValueOnce(
					new GitLabApiError(401, "invalid_token"),
				);

				const handler = await loadProcedureHandler();
				await expect(
					handler({
						input: { projectId: "proj-1", page: 1, pageSize: 30 },
						context: baseCtx,
					}),
				).rejects.toMatchObject({
					code: "UNAUTHORIZED",
					message: expect.stringContaining("GitLab"),
				});
			});

			it("translates GitLabApiError(429) into TOO_MANY_REQUESTS", async () => {
				defaultSetup();
				mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
				mockResolveGitLabPMSource.mockResolvedValue({
					kind: "rest-adapter",
					token: "glpat-test",
				} as never);
				mockListGitLabIssuesForPM.mockRejectedValueOnce(
					new GitLabApiError(429, "rate limit"),
				);

				const handler = await loadProcedureHandler();
				await expect(
					handler({
						input: { projectId: "proj-1", page: 1, pageSize: 30 },
						context: baseCtx,
					}),
				).rejects.toMatchObject({
					code: "TOO_MANY_REQUESTS",
					message: expect.stringContaining("rate limit"),
				});
			});

			it("increments pmTicketsListErrorsTotal with the right kind on each branch", async () => {
				// Operators rely on the existing pm.tickets.list error
				// counter (already wired for the generic-MCP path) to spot
				// GitLab failure storms in Grafana. Without metric emission
				// the new GitLab catch is invisible.
				const cases: Array<{
					reason: unknown;
					kind: "reauth" | "auth" | "rate_limited" | "server" | "mcp";
				}> = [
					{
						reason: new GitLabReauthRequiredError(),
						kind: "reauth",
					},
					{ reason: new GitLabApiError(401, "denied"), kind: "auth" },
					{
						reason: new GitLabApiError(429, "rate limit"),
						kind: "rate_limited",
					},
					{
						reason: new GitLabApiError(500, "server fail"),
						kind: "server",
					},
					{
						reason: new GitLabMcpError("mcp boom", -32000),
						kind: "mcp",
					},
				];

				for (const { reason, kind } of cases) {
					mockPmTicketsListErrorsTotalInc.mockClear();
					defaultSetup();
					mockGetProjectPMServerKey.mockResolvedValue(
						"gitlab-official",
					);
					mockResolveGitLabPMSource.mockResolvedValue({
						kind: "rest-adapter",
						token: "glpat-test",
					} as never);
					mockListGitLabIssuesForPM.mockRejectedValueOnce(reason);

					const handler = await loadProcedureHandler();
					await expect(
						handler({
							input: {
								projectId: "proj-1",
								page: 1,
								pageSize: 30,
							},
							context: baseCtx,
						}),
					).rejects.toBeDefined();

					expect(
						mockPmTicketsListErrorsTotalInc,
					).toHaveBeenCalledWith({
						tool: "gitlab",
						kind,
					});
				}
			});

			it("re-throws non-GitLab Errors unchanged (no over-wrapping)", async () => {
				// Pin the passthrough: a `TypeError` or generic `Error` thrown
				// from inside `handleGitLabList` (e.g. a network blip during
				// `resolveGitLabPMSource`) must NOT get wrapped as a friendly
				// BAD_REQUEST. Without this, widening the catch to
				// `instanceof Error` would silently re-label every upstream
				// failure as a 400.
				defaultSetup();
				mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
				mockResolveGitLabPMSource.mockResolvedValue({
					kind: "rest-adapter",
					token: "glpat-test",
				} as never);
				const original = new TypeError("ECONNRESET");
				mockListGitLabIssuesForPM.mockRejectedValueOnce(original);

				const handler = await loadProcedureHandler();
				// Identity equality: the same Error instance comes back out,
				// proving no wrapping occurred.
				await expect(
					handler({
						input: { projectId: "proj-1", page: 1, pageSize: 30 },
						context: baseCtx,
					}),
				).rejects.toBe(original);
			});

			it("translates GitLabMcpError into BAD_REQUEST with provider naming", async () => {
				defaultSetup();
				mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
				mockResolveGitLabPMSource.mockResolvedValue({
					kind: "rest-adapter",
					token: "glpat-test",
				} as never);
				mockListGitLabIssuesForPM.mockRejectedValueOnce(
					new GitLabMcpError("invalid params", -32602),
				);

				const handler = await loadProcedureHandler();
				await expect(
					handler({
						input: { projectId: "proj-1", page: 1, pageSize: 30 },
						context: baseCtx,
					}),
				).rejects.toMatchObject({
					code: "BAD_REQUEST",
					message: expect.stringMatching(
						/GitLab MCP error.*invalid params/i,
					),
				});
			});
		});
	});
});
