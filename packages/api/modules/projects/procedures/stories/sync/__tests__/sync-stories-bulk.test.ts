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
		projectManagementMcpServerId: string | null;
		projectManagementMcpConfigId: string | null;
		projectManagementContainerId: string | null;
		projectManagementContainerName: string | null;
	}> = {},
) {
	const defaults = {
		organizationId: null,
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
	mockWorkflowStart.mockResolvedValue({ workflowId: "wf-abc" });
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
