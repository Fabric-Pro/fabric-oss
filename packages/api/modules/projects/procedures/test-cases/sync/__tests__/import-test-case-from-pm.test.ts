import { ApplicationFailure } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	existing: vi.fn(),
	undelete: vi.fn(),
	getTestCase: vi.fn(),
	upsert: vi.fn(),
	discover: vi.fn(),
	fetch: vi.fn(),
	target: vi.fn(),
	mirror: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.project },
		testCase: { findFirst: mocks.existing, update: mocks.undelete },
	},
	getTestCase: mocks.getTestCase,
}));
vi.mock("@repo/temporal/activities", () => ({
	createOrUpdateTestCaseFromPMItem: mocks.upsert,
	discoverPMToolCapabilities: mocks.discover,
	fetchPMItemsByIds: mocks.fetch,
}));
vi.mock("@repo/temporal/test-case-context-sync", () => ({
	mirrorTestCaseToContext: mocks.mirror,
}));
vi.mock("../../sync-context", () => ({
	mirrorTestCaseToContext: mocks.mirror,
}));
vi.mock("../../../../lib/resolve-pm-target", () => ({
	resolvePmTarget: mocks.target,
}));
vi.mock("../../../../lib/pm-test-case-sync-capability", () => ({
	assertTestCaseSyncSupported: vi.fn(),
}));
vi.mock("../../../../lib/test-cases-feature", () => ({
	assertTestCasesFeatureEnabled: vi.fn(),
}));
vi.mock("../../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const name of ["use", "route", "input"]) {
		chain[name] = () => chain;
	}
	chain.handler = (handler: unknown) => ({ handler });
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: vi.fn(),
		Permissions: { TEST_CASE_UPDATE: "test-case:update" },
	};
});

import { runWithCorrelationId } from "@repo/utils/correlation-id";
import { importTestCaseFromPmProcedure } from "../import-test-case-from-pm";

const proc = importTestCaseFromPmProcedure as unknown as {
	handler: (args: { input: unknown; context: unknown }) => Promise<unknown>;
};
const request = {
	input: { projectId: "proj-1", externalId: "42", overwrite: true },
	context: { user: { id: "user-1" } },
};
const message =
	"Test case TC-001 is linked to an item in a different PM tool, so Fabric did not overwrite it with gitlab item 42.";
beforeEach(() => {
	vi.resetAllMocks();
	mocks.project.mockResolvedValue({
		id: "proj-1",
		organizationId: "org-1",
		projectManagementMcpServerId: "srv-active",
		projectManagementContainerId: "board-1",
	});
	mocks.existing.mockResolvedValue({
		id: "tc-old",
		identifier: "TC-001",
		deletedAt: new Date("2026-01-01"),
	});
	mocks.target.mockResolvedValue({
		kind: "mcp",
		mcpConfigId: "cfg-1",
		mcpConfig: { mcpServerId: "srv-active" },
	});
	mocks.discover.mockResolvedValue({ detectedType: "gitlab" });
	mocks.fetch.mockResolvedValue({
		items: [
			{
				id: "42",
				title: "Pulled case",
				description: "Body",
				url: "https://gitlab.com/example/repo/-/issues/42",
			},
		],
	});
	mocks.upsert.mockResolvedValue({ testCaseId: "tc-old", created: false });
	mocks.getTestCase.mockResolvedValue(null);
});
describe("importTestCaseFromPmProcedure", () => {
	it("passes request correlation to the upsert and returns its current context link", async () => {
		mocks.getTestCase.mockResolvedValue({
			id: "tc-old",
			contextId: "example-context",
		});
		const result = await runWithCorrelationId("example-request", () =>
			proc.handler(request),
		);
		expect(mocks.upsert).toHaveBeenCalledTimes(1);
		expect(mocks.mirror).not.toHaveBeenCalled();
		expect(mocks.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				memo: { correlationId: "example-request" },
				organizationId: "org-1",
			}),
		);
		expect(mocks.getTestCase.mock.invocationCallOrder[0]).toBeGreaterThan(
			mocks.upsert.mock.invocationCallOrder[0],
		);
		expect(result).toMatchObject({
			testCase: { contextId: "example-context" },
		});
	});
	it("uses the resolved MCP config server when the project server is null", async () => {
		mocks.project.mockResolvedValue({
			id: "proj-1",
			organizationId: "org-1",
			projectManagementMcpServerId: null,
			projectManagementContainerId: "board-1",
		});
		mocks.target.mockResolvedValue({
			kind: "mcp",
			mcpConfigId: "cfg-1",
			mcpConfig: { mcpServerId: "srv-from-config" },
		});
		await proc.handler(request);
		expect(mocks.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				externalMcpServerId: "srv-from-config",
				mcpConfigId: "cfg-1",
			}),
		);
	});
	it("maps the typed mismatch to CONFLICT with the activity message", async () => {
		mocks.upsert.mockRejectedValue(
			ApplicationFailure.nonRetryable(
				message,
				"TestCasePullLinkMismatchError",
			),
		);
		await expect(proc.handler(request)).rejects.toMatchObject({
			code: "CONFLICT",
			message,
		});
		expect(mocks.undelete).not.toHaveBeenCalled();
		expect(mocks.getTestCase).not.toHaveBeenCalled();
	});
	it("delegates restoration and tenant config to the activity without undeleting", async () => {
		await proc.handler(request);
		expect(mocks.undelete).not.toHaveBeenCalled();
		expect(mocks.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpConfigId: "cfg-1",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
	});
	it("keeps other failure types as INTERNAL_SERVER_ERROR even with matching text", async () => {
		mocks.upsert.mockRejectedValue(
			ApplicationFailure.nonRetryable(message, "PmConfigNotFoundError"),
		);
		await expect(proc.handler(request)).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message,
		});
	});
});
