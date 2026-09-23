/**
 * Tests for syncStoriesBulkProcedure target dispatch (Task 6 of the
 * GitLab REST parity series).
 *
 * Focus: the procedure must use `resolvePmTarget` to accept both MCP
 * projects and REST-GitLab projects (no MCPConfig but server is
 * gitlab-official + active WorkflowIntegration), and only throw
 * BAD_REQUEST when both paths fail (target === null).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks -----------------------------------------------------------------

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: vi.fn(),
			update: vi.fn().mockResolvedValue({}),
		},
	},
	resolvePMConfigForUser: vi.fn(),
}));

vi.mock("../../../../lib/resolve-pm-target", () => ({
	resolvePmTarget: vi.fn(),
}));

const { mocks } = vi.hoisted(() => ({
	mocks: {
		assert: vi.fn(),
		openPmStorySyncJob: vi.fn(),
		failPmStorySyncJob: vi.fn(),
	},
}));

vi.mock("../../../../../capabilities/assert", () => ({
	assertCapabilityAvailable: mocks.assert,
}));

vi.mock("../../../../lib/pm-story-sync-job", () => ({
	openPmStorySyncJob: mocks.openPmStorySyncJob,
	failPmStorySyncJob: mocks.failPmStorySyncJob,
}));

const mockWorkflowStart = vi.fn();
const mockGetTemporalClient = vi.fn();

vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...args: unknown[]) => mockGetTemporalClient(...args),
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
		Permissions: { STORY_UPDATE: "story:update" },
	};
});

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T extends object>(opts: T) => opts,
}));

import { db } from "@repo/database";
import { resolvePmTarget } from "../../../../lib/resolve-pm-target";
import { syncStoriesBulkProcedure } from "../sync-stories-bulk";

// biome-ignore lint/suspicious/noExplicitAny: test hatch — mocked procedure
const handler = (syncStoriesBulkProcedure as any).handler as (args: {
	input: {
		projectId: string;
		direction?: "push" | "pull";
		unsyncedOnly?: boolean;
		storyIds?: string[];
		statusIds?: string[];
		pmExternalIds?: string[];
	};
	context: { user: { id: string } };
}) => Promise<{ workflowId: string; status: string; message: string }>;

const baseCtx = { user: { id: "user-1" } };

function setupProject(
	overrides: Partial<{
		organizationId: string | null;
		readOnlyMode: boolean;
		projectManagementMcpServerId: string | null;
		projectManagementMcpConfigId: string | null;
		projectManagementContainerId: string | null;
		projectManagementContainerName: string | null;
	}> = {},
) {
	const defaults = {
		organizationId: null,
		readOnlyMode: false,
		projectManagementMcpServerId: "srv-gl",
		projectManagementMcpConfigId: null,
		projectManagementContainerId: "100" as string | null,
		projectManagementContainerName: "example-group/fabricgl" as
			| string
			| null,
	};
	vi.mocked(db.project.findUnique).mockResolvedValue({
		id: "proj-1",
		...defaults,
		...overrides,
		projectManagementAdditionalContext: null,
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: mockWorkflowStart },
	});
	mockWorkflowStart.mockResolvedValue({
		workflowId: "wf-abc",
		firstExecutionRunId: "run-abc",
	});
	mocks.assert.mockResolvedValue(null);
	mocks.openPmStorySyncJob.mockResolvedValue(undefined);
	mocks.failPmStorySyncJob.mockResolvedValue(undefined);
});

describe("syncStoriesBulkProcedure — PM target dispatch", () => {
	it("starts the workflow with mcpConfigId=null and mcpServerId set for REST-GitLab projects", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-gl",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "100",
		});
		vi.mocked(resolvePmTarget).mockResolvedValue({
			kind: "rest-gitlab",
			mcpConfigId: null,
		});

		const result = await handler({
			input: { projectId: "proj-1", direction: "pull" },
			context: baseCtx,
		});

		expect(result.status).toBe("started");
		expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
		const [, opts] = mockWorkflowStart.mock.calls[0];
		expect(opts.args[0]).toMatchObject({
			projectId: "proj-1",
			mcpConfigId: null,
			mcpServerId: "srv-gl",
			containerId: "100",
			direction: "pull",
		});
	});

	it("starts the workflow with the resolved MCPConfig id for MCP projects", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-mcp",
			projectManagementMcpConfigId: "cfg-1",
			projectManagementContainerId: "200",
		});
		vi.mocked(resolvePmTarget).mockResolvedValue({
			kind: "mcp",
			mcpConfigId: "cfg-1",
			mcpConfig: {
				id: "cfg-1",
				enabled: true,
			} as never,
		});

		await handler({
			input: { projectId: "proj-1", direction: "push" },
			context: baseCtx,
		});

		const [, opts] = mockWorkflowStart.mock.calls[0];
		expect(opts.args[0]).toMatchObject({
			projectId: "proj-1",
			mcpConfigId: "cfg-1",
			mcpServerId: "srv-mcp",
			direction: "push",
		});
	});

	it("throws BAD_REQUEST when resolvePmTarget returns null (no MCP and no REST path)", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-x",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "300",
		});
		vi.mocked(resolvePmTarget).mockResolvedValue(null);

		await expect(
			handler({
				input: { projectId: "proj-1", direction: "pull" },
				context: baseCtx,
			}),
		).rejects.toThrow(/Integrations|Project Settings/i);

		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("throws BAD_REQUEST when project has no container selected", async () => {
		setupProject({
			projectManagementMcpServerId: "srv-gl",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
		});

		await expect(
			handler({
				input: { projectId: "proj-1", direction: "pull" },
				context: baseCtx,
			}),
		).rejects.toThrow(/Select a board/i);

		expect(resolvePmTarget).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});
});

describe("syncStoriesBulkProcedure — capability gate and job row", () => {
	function setupMcpTarget() {
		vi.mocked(resolvePmTarget).mockResolvedValue({
			kind: "mcp",
			mcpConfigId: "cfg-1",
			mcpConfig: { id: "cfg-1", enabled: true } as never,
		});
	}

	it.each([
		["pull", "roadmap.pull-from-pm"],
		["push", "roadmap.sync-to-pm"],
	] as const)(
		"asserts %s against %s with the project's organization",
		async (direction, capabilityKey) => {
			setupProject({ organizationId: "org-1" });
			setupMcpTarget();

			await handler({
				input: { projectId: "proj-1", direction },
				context: baseCtx,
			});

			expect(mocks.assert).toHaveBeenCalledWith({
				capabilityKey,
				projectId: "proj-1",
				userId: "user-1",
				organizationId: "org-1",
			});
		},
	);

	it("throws the read-only CONFLICT before the capability assert", async () => {
		setupProject({ readOnlyMode: true });

		await expect(
			handler({
				input: { projectId: "proj-1", direction: "push" },
				context: baseCtx,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(mocks.assert).not.toHaveBeenCalled();
	});

	it("leaves the workflow unstarted and opens no row when the gate refuses", async () => {
		setupProject();
		setupMcpTarget();
		mocks.assert.mockRejectedValueOnce(new Error("gate refused"));

		await expect(
			handler({
				input: { projectId: "proj-1", direction: "pull" },
				context: baseCtx,
			}),
		).rejects.toThrow("gate refused");

		expect(mockWorkflowStart).not.toHaveBeenCalled();
		expect(mocks.openPmStorySyncJob).not.toHaveBeenCalled();
	});

	it("opens the PM_STORY_SYNC row just before the start, keyed to the started workflow", async () => {
		setupProject({ organizationId: "org-1" });
		setupMcpTarget();

		await handler({
			input: { projectId: "proj-1", direction: "pull" },
			context: baseCtx,
		});

		const [, opts] = mockWorkflowStart.mock.calls[0];
		expect(mocks.openPmStorySyncJob).toHaveBeenCalledWith({
			workflowId: opts.workflowId,
			projectId: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			direction: "pull",
		});
		expect(
			mocks.openPmStorySyncJob.mock.invocationCallOrder[0],
		).toBeLessThan(mockWorkflowStart.mock.invocationCallOrder[0]);
		expect(mocks.failPmStorySyncJob).not.toHaveBeenCalled();
	});

	it("refuses with CONFLICT when a sync went live between the gate and the open (FR54)", async () => {
		setupProject();
		setupMcpTarget();
		mocks.openPmStorySyncJob.mockResolvedValueOnce({
			workflowId: "story-sync-other",
			direction: "push",
			startedAt: new Date(),
		});

		await expect(
			handler({
				input: { projectId: "proj-1", direction: "pull" },
				context: baseCtx,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringMatching(/already running/),
		});

		expect(mocks.assert.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.openPmStorySyncJob.mock.invocationCallOrder[0],
		);
		expect(mockWorkflowStart).not.toHaveBeenCalled();
		expect(mocks.failPmStorySyncJob).not.toHaveBeenCalled();
	});

	it("fails the opened row when the workflow fails to start", async () => {
		setupProject();
		setupMcpTarget();
		mockWorkflowStart.mockRejectedValueOnce(new Error("boom"));

		await expect(
			handler({
				input: { projectId: "proj-1", direction: "pull" },
				context: baseCtx,
			}),
		).rejects.toThrow(/Failed to start sync/);

		const openedWorkflowId =
			mocks.openPmStorySyncJob.mock.calls[0][0].workflowId;
		expect(mocks.failPmStorySyncJob).toHaveBeenCalledWith({
			workflowId: openedWorkflowId,
			projectId: "proj-1",
			error: "The sync could not be started.",
		});
	});
});
