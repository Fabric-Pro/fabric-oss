/**
 * Unit tests for the Test Case PM-sync API surface.
 *
 * Covers:
 *   - permission gating (every sync procedure declares TEST_CASE_*),
 *   - `sync-test-cases-bulk` starts `testCaseSyncWorkflow` on the "ai-chat"
 *     queue once a PM target resolves (and guards no-board / no-project),
 *   - `dismiss-pm-sync-failure` clears the FAILED flag via `clearPmSyncFailure`
 *     with `itemType: "testCase"`,
 *   - `retry-pm-sync` delegates to the shared `retryPmSyncItem` with
 *     `itemType: "testCase"` (and tenant-guards a missing case).
 *
 * The shared `retry-pm-sync-item` lib is mocked so these tests stay focused on
 * the procedure layer; its testCase→workflow branch is exercised separately.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		projectFindUnique: vi.fn(),
		testCaseFindFirst: vi.fn(),
		mcpServerFindUnique: vi.fn(),
		workflowIntegrationFindFirst: vi.fn(),
		resolvePMConfigForUser: vi.fn(),
		clearPmSyncFailure: vi.fn(),
		workflowStart: vi.fn(),
		retryPmSyncItem: vi.fn(),
		assertTestCaseSyncSupported: vi.fn(),
	},
}));

// LIVE work-item-CRUD gate — mocked so these procedure tests stay focused on the
// dispatch/gating branch, not the live-probe internals (covered in the
// pm-test-case-sync-capability lib tests). Default: resolves = supported; a test
// that needs the "unsupported" branch drives it to reject with BAD_REQUEST.
vi.mock("../../../../lib/pm-test-case-sync-capability", () => ({
	assertTestCaseSyncSupported: mocks.assertTestCaseSyncSupported,
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		testCase: { findFirst: mocks.testCaseFindFirst },
		mCPServer: { findUnique: mocks.mcpServerFindUnique },
		workflowIntegration: {
			findFirst: mocks.workflowIntegrationFindFirst,
		},
	},
	resolvePMConfigForUser: mocks.resolvePMConfigForUser,
	// `key:` prefix marks a sentinel; UUID-style ids fall through to mCPServer.
	isPmServerIdKeySentinel: (id: string) =>
		typeof id === "string" && id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) =>
		typeof id === "string" && id.startsWith("key:") ? id.slice(4) : id,
	clearPmSyncFailure: mocks.clearPmSyncFailure,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart },
	})),
}));

// Mock the shared retry lib so retry-pm-sync.ts doesn't pull in the enqueue /
// Temporal-client chain. Path resolves to projects/lib/retry-pm-sync-item from
// this test file (one level deeper than the procedure that imports it).
vi.mock("../../../../lib/retry-pm-sync-item", () => ({
	retryPmSyncItem: mocks.retryPmSyncItem,
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		resolveOrganizationId: (orgId: unknown) => orgId ?? undefined,
		Permissions: {
			TEST_CASE_READ: "test-case:read",
			TEST_CASE_CREATE: "test-case:create",
			TEST_CASE_UPDATE: "test-case:update",
			TEST_CASE_DELETE: "test-case:delete",
		},
	};
});

import { dismissTestCasePmSyncFailureProcedure } from "../dismiss-pm-sync-failure";
import { retryTestCasePmSyncProcedure } from "../retry-pm-sync";
import { syncTestCasesBulkProcedure } from "../sync-test-cases-bulk";

type Proc = {
	handler: (ctx: { input: unknown; context: unknown }) => Promise<unknown>;
	__permission: string;
};
const bulk = syncTestCasesBulkProcedure as unknown as Proc;
const dismiss = dismissTestCasePmSyncFailureProcedure as unknown as Proc;
const retry = retryTestCasePmSyncProcedure as unknown as Proc;

const ctx = { user: { id: "u1" }, session: {}, tenantContext: {} };

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	// Default: pinned configId resolves to an enabled config (happy path).
	mocks.resolvePMConfigForUser.mockImplementation(
		async ({ configId }: { configId: string | null }) =>
			configId ? { id: configId, enabled: true } : null,
	);
	// Default: the connected tool supports the requested sync (gate passes).
	mocks.assertTestCaseSyncSupported.mockResolvedValue(undefined);
});

describe("permission gating", () => {
	it("bulk / dismiss / retry all require TEST_CASE_UPDATE", () => {
		expect(bulk.__permission).toBe("test-case:update");
		expect(dismiss.__permission).toBe("test-case:update");
		expect(retry.__permission).toBe("test-case:update");
	});
});

describe("syncTestCasesBulkProcedure", () => {
	const project = {
		id: "p1",
		organizationId: null,
		projectManagementMcpServerId: "srv-1",
		projectManagementMcpConfigId: "mcp-1",
		projectManagementContainerId: "container-1",
		projectManagementContainerName: null,
		projectManagementAdditionalContext: null,
	};

	it("starts testCaseSyncWorkflow on the ai-chat queue with the resolved target", async () => {
		mocks.projectFindUnique.mockResolvedValue(project);
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-1" });

		const res = await bulk.handler({
			input: {
				projectId: "p1",
				organizationId: null,
				direction: "push",
				unsyncedOnly: true,
				testCaseIds: ["tc1", "tc2"],
			},
			context: ctx,
		});

		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"testCaseSyncWorkflow",
			expect.objectContaining({
				taskQueue: "ai-chat",
				args: [
					expect.objectContaining({
						projectId: "p1",
						mcpServerId: "srv-1",
						mcpConfigId: "mcp-1",
						containerId: "container-1",
						direction: "push",
						testCaseIds: ["tc1", "tc2"],
					}),
				],
			}),
		);
		expect(res).toEqual({
			workflowId: "wf-1",
			status: "started",
			message: "Test case sync workflow started",
		});
	});

	it("uses a STABLE per-case workflow id + USE_EXISTING for a single-case push (concurrent-dedup)", async () => {
		mocks.projectFindUnique.mockResolvedValue(project);
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-x" });

		await bulk.handler({
			input: {
				projectId: "p1",
				direction: "push",
				testCaseIds: ["tc1"],
				unsyncedOnly: false,
			},
			context: ctx,
		});

		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"testCaseSyncWorkflow",
			expect.objectContaining({
				workflowId: "test-case-sync-p1-tc1",
				workflowIdConflictPolicy: "USE_EXISTING",
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
			}),
		);
	});

	it("uses a per-invocation workflow id (no dedup policy) for a multi-case batch", async () => {
		mocks.projectFindUnique.mockResolvedValue(project);
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-y" });

		await bulk.handler({
			input: {
				projectId: "p1",
				direction: "push",
				testCaseIds: ["tc1", "tc2"],
			},
			context: ctx,
		});

		const opts = mocks.workflowStart.mock.calls.at(-1)?.[1] as {
			workflowId: string;
			workflowIdConflictPolicy?: string;
		};
		expect(opts.workflowId).toMatch(/^test-case-sync-p1-\d+$/);
		expect(opts.workflowIdConflictPolicy).toBeUndefined();
	});

	it("rejects with BAD_REQUEST when the PM tool can't sync work items (gated, no workflow)", async () => {
		mocks.projectFindUnique.mockResolvedValue(project);
		mocks.assertTestCaseSyncSupported.mockRejectedValue(
			new ORPCError("BAD_REQUEST", {
				message:
					"Jira doesn't support creating or updating work items, so test cases can't be pushed.",
			}),
		);

		await expect(
			bulk.handler({
				input: { projectId: "p1", direction: "push" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("rejects with BAD_REQUEST when no board is selected (no workflow)", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			...project,
			projectManagementContainerId: null,
		});

		await expect(
			bulk.handler({
				input: { projectId: "p1", direction: "push" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("rejects with NOT_FOUND for a missing project", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);

		await expect(
			bulk.handler({
				input: { projectId: "missing", direction: "push" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("dismissTestCasePmSyncFailureProcedure", () => {
	it("clears a FAILED case via clearPmSyncFailure(testCase) and reports dismissed:true", async () => {
		mocks.testCaseFindFirst.mockResolvedValue({ id: "tc1" });
		mocks.clearPmSyncFailure.mockResolvedValue({ cleared: 1 });

		const res = (await dismiss.handler({
			input: { projectId: "p1", testCaseId: "tc1", organizationId: null },
			context: ctx,
		})) as { dismissed: boolean };

		expect(mocks.clearPmSyncFailure).toHaveBeenCalledWith({
			itemType: "testCase",
			itemId: "tc1",
			projectId: "p1",
		});
		expect(res.dismissed).toBe(true);
	});

	it("reports dismissed:false when the case was not FAILED (cleared 0)", async () => {
		mocks.testCaseFindFirst.mockResolvedValue({ id: "tc1" });
		mocks.clearPmSyncFailure.mockResolvedValue({ cleared: 0 });

		const res = (await dismiss.handler({
			input: { projectId: "p1", testCaseId: "tc1" },
			context: ctx,
		})) as { dismissed: boolean };

		expect(res.dismissed).toBe(false);
	});

	it("throws NOT_FOUND and never clears when the case is absent (tenant guard)", async () => {
		mocks.testCaseFindFirst.mockResolvedValue(null);

		await expect(
			dismiss.handler({
				input: { projectId: "p1", testCaseId: "missing" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.clearPmSyncFailure).not.toHaveBeenCalled();
	});
});

describe("retryTestCasePmSyncProcedure", () => {
	it("delegates to retryPmSyncItem with itemType testCase for an owned case", async () => {
		mocks.testCaseFindFirst.mockResolvedValue({
			id: "tc1",
			externalId: "EXT-1",
			externalMcpServerId: "srv-1",
			project: {
				organizationId: null,
				projectManagementMcpServerId: "srv-1",
				projectManagementMcpConfigId: "mcp-1",
			},
		});
		mocks.retryPmSyncItem.mockResolvedValue({
			enqueued: true,
			workflowId: "wf-retry",
		});

		const res = (await retry.handler({
			input: { projectId: "p1", testCaseId: "tc1", organizationId: null },
			context: ctx,
		})) as { enqueued: boolean; workflowId?: string };

		expect(mocks.retryPmSyncItem).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "tc1",
				itemType: "testCase",
				projectId: "p1",
				externalId: "EXT-1",
				externalMcpServerId: "srv-1",
			}),
		);
		expect(res).toEqual({
			enqueued: true,
			workflowId: "wf-retry",
			reason: undefined,
		});
	});

	it("throws NOT_FOUND and never retries when the case is absent", async () => {
		mocks.testCaseFindFirst.mockResolvedValue(null);

		await expect(
			retry.handler({
				input: { projectId: "p1", testCaseId: "missing" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.retryPmSyncItem).not.toHaveBeenCalled();
	});

	it("rejects with BAD_REQUEST and never retries when the tool can't sync work items", async () => {
		mocks.testCaseFindFirst.mockResolvedValue({
			id: "tc1",
			externalId: "EXT-1",
			externalMcpServerId: "srv-1",
			project: {
				organizationId: null,
				projectManagementMcpServerId: "srv-1",
				projectManagementMcpConfigId: "mcp-1",
			},
		});
		mocks.assertTestCaseSyncSupported.mockRejectedValue(
			new ORPCError("BAD_REQUEST", {
				message:
					"GitHub doesn't support creating or updating work items, so test cases can't be pushed.",
			}),
		);

		await expect(
			retry.handler({
				input: {
					projectId: "p1",
					testCaseId: "tc1",
					organizationId: null,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.retryPmSyncItem).not.toHaveBeenCalled();
	});
});
