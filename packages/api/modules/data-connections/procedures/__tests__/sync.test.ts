import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mockWorkflowStart } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mockWorkflowStart = vi.fn();
	return { handlers, mockWorkflowStart };
});

vi.mock("@repo/database", () => ({
	getDataConnectionById: vi.fn(),
	createSyncJob: vi.fn(),
	getSyncJobs: vi.fn(),
	getSyncJobById: vi.fn(),
	updateSyncJob: vi.fn(),
	updateDataConnection: vi.fn(),
	SyncJobTypeSchema: {
		default: () => "INCREMENTAL",
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: {
			start: mockWorkflowStart,
		},
	}),
	isTemporalAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			if (!handlers.start) {
				handlers.start = fn;
			}
			return { _handler: fn };
		},
	};

	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId,
		),
	};
});

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue(true),
}));

import {
	createSyncJob,
	getDataConnectionById,
	getSyncJobs,
	updateDataConnection,
} from "@repo/database";

import "../sync";

describe("startSyncProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getDataConnectionById).mockResolvedValue({
			id: "conn-1",
			provider: "GITHUB",
			status: "CONNECTED",
			config: { workspaceIds: ["ws-1"] },
		} as any);
		vi.mocked(getSyncJobs).mockResolvedValue([]);
		vi.mocked(createSyncJob).mockResolvedValue({
			id: "job-1",
		} as any);
		vi.mocked(updateDataConnection).mockResolvedValue({ count: 1 } as any);
		mockWorkflowStart.mockResolvedValue({});
	});

	it("starts connectorSyncWorkflow on the fabric-worker queue", async () => {
		const result = await handlers.start({
			input: {
				id: "conn-1",
				organizationId: null,
				type: "INCREMENTAL",
			},
			context: {
				user: { id: "user-1" },
				session: { activeOrganizationId: null },
			},
		});

		expect(createSyncJob).toHaveBeenCalled();
		expect(updateDataConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "conn-1",
				organizationId: null,
				userId: "user-1",
				data: { status: "SYNCING" },
			}),
		);
		expect(mockWorkflowStart).toHaveBeenCalledWith(
			"connectorSyncWorkflow",
			expect.objectContaining({
				taskQueue: "fabric-worker",
				args: [
					expect.objectContaining({
						connectorId: "conn-1",
						provider: "GITHUB",
						syncType: "incremental",
						workspaceIds: ["ws-1"],
					}),
				],
			}),
		);
		expect(result.workflowId).toContain("data-sync-conn-1-");
	});

	it("rejects when a sync is already running", async () => {
		vi.mocked(getSyncJobs).mockResolvedValueOnce([
			{ id: "job-running", status: "RUNNING" },
		] as any);

		await expect(
			handlers.start({
				input: {
					id: "conn-1",
					organizationId: null,
					type: "INCREMENTAL",
				},
				context: {
					user: { id: "user-1" },
					session: { activeOrganizationId: null },
				},
			}),
		).rejects.toThrow(ORPCError);

		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});
});
