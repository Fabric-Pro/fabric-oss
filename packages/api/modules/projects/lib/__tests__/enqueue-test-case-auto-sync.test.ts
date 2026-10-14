/**
 * `enqueueTestCaseAutoSync` starts a single case's push under the case's one
 * workflow id (`test-case-sync-<project>-<case>`), the id Sync now and Retry
 * use, attaching to a push of the case already running (USE_EXISTING) rather
 * than running beside it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	testCaseFindFirst: vi.fn(),
	projectFindUnique: vi.fn(),
	resolvePmTarget: vi.fn(),
	classifyTestCaseSyncSupport: vi.fn(),
	workflowStart: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		testCase: { findFirst: h.testCaseFindFirst },
		project: { findUnique: h.projectFindUnique },
	},
	PmSyncStatus: { PENDING: "PENDING", FAILED: "FAILED" },
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: h.workflowStart },
	})),
}));

vi.mock("../resolve-pm-target", () => ({
	resolvePmTarget: h.resolvePmTarget,
}));

vi.mock("../pm-test-case-sync-capability", () => ({
	classifyTestCaseSyncSupport: h.classifyTestCaseSyncSupport,
}));

const { enqueueTestCaseAutoSync } = await import(
	"../enqueue-test-case-auto-sync"
);

beforeEach(() => {
	for (const mock of Object.values(h)) {
		mock.mockReset();
	}
	h.testCaseFindFirst.mockResolvedValue({
		id: "tc1",
		externalId: "EXT-1",
		pmAutoSyncEnabled: true,
	});
	h.projectFindUnique.mockResolvedValue({
		id: "p1",
		organizationId: "org-1",
		projectManagementMcpServerId: "srv-1",
		projectManagementMcpConfigId: "mcp-1",
		projectManagementContainerId: "board-1",
		projectManagementContainerName: null,
		projectManagementAdditionalContext: null,
	});
	h.resolvePmTarget.mockResolvedValue({ kind: "mcp", mcpConfigId: "mcp-1" });
	h.classifyTestCaseSyncSupport.mockResolvedValue({ support: "supported" });
	h.workflowStart.mockImplementation(
		async (_type: string, options: { workflowId: string }) => ({
			workflowId: options.workflowId,
		}),
	);
});

describe("enqueueTestCaseAutoSync", () => {
	it("starts the push under the case's one workflow id, attaching to a running push", async () => {
		const result = await enqueueTestCaseAutoSync({
			projectId: "p1",
			testCaseId: "tc1",
			userId: "u1",
		});

		expect(result).toEqual({
			enqueued: true,
			workflowId: "test-case-sync-p1-tc1",
		});
		expect(h.workflowStart).toHaveBeenCalledWith(
			"testCaseSyncWorkflow",
			expect.objectContaining({
				workflowId: "test-case-sync-p1-tc1",
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				workflowIdConflictPolicy: "USE_EXISTING",
			}),
		);
	});
});
