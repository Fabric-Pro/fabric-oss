import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	existing: vi.fn(),
	config: vi.fn(),
	discover: vi.fn(),
	list: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.project },
		testCase: { findMany: mocks.existing },
	},
}));
vi.mock("@repo/logs", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/observability", () => ({
	pmTicketsListDurationSeconds: { observe: vi.fn() },
	pmTicketsListErrorsTotal: { inc: vi.fn() },
	pmTicketsListRequestsTotal: { inc: vi.fn() },
}));
vi.mock("@repo/temporal", () => ({
	listWorkItemsFromPM: mocks.list,
	discoverPMToolCapabilities: mocks.discover,
	searchWorkItemsFromPM: vi.fn(),
	listAllFizzyCards: vi.fn(),
	getWorkItemsByIdsFromPM: vi.fn(),
	fetchPMItemsByIds: vi.fn(),
}));
vi.mock("../../../../lib/gitlab-pm-source", () => ({
	resolveProjectPmConfig: mocks.config,
	rethrowGitLabPmOriginMismatch: (error: unknown) => {
		throw error;
	},
}));
vi.mock("../../../stories/sync/gitlab-pm-adapter", () => ({
	getProjectPMServerKey: vi.fn().mockResolvedValue("jira"),
	isGitLabOfficialKey: () => false,
	getGitLabIssueForPM: vi.fn(),
	listGitLabIssuesForPM: vi.fn(),
	resolveGitLabPMSource: vi.fn(),
}));
vi.mock("../../../../../../orpc/procedures", () => {
	const chain = {
		route: () => chain,
		input: () => chain,
		output: () => chain,
		use: () => chain,
		handler: (handler: unknown) => ({ handler }),
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: vi.fn(),
		Permissions: { TEST_CASE_READ: "test-case:read" },
	};
});

import { listPmTestCasesProcedure } from "../list-pm-test-cases";

const procedure = listPmTestCasesProcedure as unknown as {
	handler: (args: {
		input: unknown;
		context: unknown;
	}) => Promise<{ tickets: { id: string }[] }>;
};

describe("listPmTestCasesProcedure pagination", () => {
	it("advances picker offsets by raw rows before filtering and deduplication", async () => {
		mocks.project.mockResolvedValue({
			id: "example-project",
			organizationId: "example-org",
			projectManagementMcpServerId: "example-server",
			projectManagementMcpConfigId: "example-config",
			projectManagementContainerId: "example-container",
			projectManagementAdditionalContext: null,
		});
		mocks.existing.mockResolvedValue([]);
		mocks.config.mockResolvedValue({ id: "example-config", enabled: true });
		mocks.discover.mockResolvedValue({
			detectedType: "jira",
			taskList: { paginationInfo: { style: "offset-skip" } },
		});
		mocks.list
			.mockResolvedValueOnce({
				items: [{ id: "example-first", title: "Example first" }],
				rawCount: 3,
				total: 5,
				hasNextPage: true,
			})
			.mockResolvedValueOnce({
				items: [
					{ id: "example-first", title: "Example first" },
					{ id: "example-last", title: "Example last" },
				],
				rawCount: 2,
				total: 5,
				hasNextPage: false,
			})
			.mockResolvedValue({ items: [], rawCount: 0, hasNextPage: false });
		const result = await procedure.handler({
			input: { projectId: "example-project", page: 1, pageSize: 30 },
			context: { user: { id: "example-user" } },
		});
		expect(result.tickets.map((item) => item.id)).toEqual([
			"example-first",
			"example-last",
		]);
		expect(mocks.list).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ offset: 0 }),
		);
		expect(mocks.list).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ offset: 3 }),
		);
		expect(mocks.list).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({ offset: 5 }),
		);
	});
});
