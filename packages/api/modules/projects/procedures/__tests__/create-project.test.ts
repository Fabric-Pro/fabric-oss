/**
 * Tests for createProjectProcedure auto-sync dispatch (Task 7 of the
 * GitLab REST parity series).
 *
 * Focus: after the project is created, the auto-sync block must use
 * `resolvePmTarget` so both MCP and REST-GitLab projects fire the
 * storySyncWorkflow. The outer guard widens from requiring an MCPConfig
 * id to requiring an MCPServer id, so REST-GitLab projects (no config)
 * are no longer silently skipped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks -----------------------------------------------------------------

const mockCreateProject = vi.fn();
const mockProjectFindFirst = vi.fn();

vi.mock("@repo/database", () => ({
	createProject: (...args: unknown[]) => mockCreateProject(...args),
	db: {
		project: {
			findFirst: (...args: unknown[]) => mockProjectFindFirst(...args),
			update: vi.fn(),
		},
		projectDocument: {
			findFirst: vi.fn(),
			create: vi.fn(),
		},
		documentVersion: {
			create: vi.fn(),
		},
	},
	moveWizardTempContextsToProject: vi.fn(),
	seedTerminalStatusesIfEmpty: vi.fn(),
	Prisma: { JsonNull: "__JSON_NULL__", DbNull: "__DB_NULL__" },
}));

vi.mock("../../lib/resolve-pm-target", () => ({
	resolvePmTarget: vi.fn(),
}));

const mockWorkflowStart = vi.fn();
const mockGetTemporalClient = vi.fn();

vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...args: unknown[]) => mockGetTemporalClient(...args),
}));

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T extends object>(opts: T) => opts,
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue({ id: "mem-1" }),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chain = {
		route: () => chain,
		input: () => chain,
		output: () => chain,
		use: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	};
	return {
		tenantProtectedProcedure: chain,
		requirePermission: () => (handler: unknown) => handler,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
		Permissions: { PROJECT_CREATE: "project:create" },
	};
});

import { resolvePmTarget } from "../../lib/resolve-pm-target";
import { createProjectProcedure } from "../create-project";

// biome-ignore lint/suspicious/noExplicitAny: test hatch — mocked procedure
const handler = (createProjectProcedure as any).handler as (args: {
	input: Record<string, unknown>;
	context: {
		user: { id: string };
		session: { id: string; activeOrganizationId: string | null };
	};
}) => Promise<{
	project: Record<string, unknown>;
	storySyncStarted: boolean;
	migratedContexts: unknown;
}>;

const baseCtx = {
	user: { id: "user-1" },
	session: { id: "sess-1", activeOrganizationId: null },
};

function projectFixture(
	overrides: Partial<{
		projectManagementMcpServerId: string | null;
		projectManagementMcpConfigId: string | null;
		projectManagementContainerId: string | null;
		projectManagementContainerName: string | null;
	}> = {},
) {
	return {
		id: "proj-1",
		name: "Test Project",
		status: "ACTIVE",
		organizationId: null,
		userId: "user-1",
		repositoryUrl: null,
		projectManagementMcpServerId: null,
		projectManagementMcpConfigId: null,
		projectManagementContainerId: null,
		projectManagementContainerName: null,
		projectManagementAdditionalContext: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectFindFirst.mockResolvedValue(null); // no duplicate
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: mockWorkflowStart },
	});
	mockWorkflowStart.mockResolvedValue({ workflowId: "wf-abc" });
});

describe("createProjectProcedure — auto-sync dispatch", () => {
	it("fires storySyncWorkflow with mcpConfigId=null for REST-GitLab projects (no MCPConfig pinned)", async () => {
		const project = projectFixture({
			projectManagementMcpServerId: "srv-gl",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "100",
			projectManagementContainerName: "example-group/fabricgl",
		});
		mockCreateProject.mockResolvedValue(project);
		vi.mocked(resolvePmTarget).mockResolvedValue({
			kind: "rest-gitlab",
			mcpConfigId: null,
		});

		const result = await handler({
			input: {
				name: "Test Project",
				organizationId: null,
				projectManagementMcpServerId: "srv-gl",
				projectManagementContainerId: "100",
				projectManagementContainerName: "example-group/fabricgl",
			},
			context: baseCtx,
		});

		expect(result.storySyncStarted).toBe(true);
		expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
		const [workflowName, opts] = mockWorkflowStart.mock.calls[0];
		expect(workflowName).toBe("storySyncWorkflow");
		expect(opts.args[0]).toMatchObject({
			projectId: "proj-1",
			mcpConfigId: null,
			mcpServerId: "srv-gl",
			containerId: "100",
			direction: "pull",
		});
	});

	it("fires storySyncWorkflow with the resolved MCPConfig id for MCP projects (regression)", async () => {
		const project = projectFixture({
			projectManagementMcpServerId: "srv-mcp",
			projectManagementMcpConfigId: "cfg-1",
			projectManagementContainerId: "200",
		});
		mockCreateProject.mockResolvedValue(project);
		vi.mocked(resolvePmTarget).mockResolvedValue({
			kind: "mcp",
			mcpConfigId: "cfg-1",
			mcpConfig: { id: "cfg-1", enabled: true } as never,
		});

		const result = await handler({
			input: {
				name: "Test Project",
				organizationId: null,
				projectManagementMcpServerId: "srv-mcp",
				projectManagementMcpConfigId: "cfg-1",
				projectManagementContainerId: "200",
			},
			context: baseCtx,
		});

		expect(result.storySyncStarted).toBe(true);
		const [, opts] = mockWorkflowStart.mock.calls[0];
		expect(opts.args[0]).toMatchObject({
			projectId: "proj-1",
			mcpConfigId: "cfg-1",
			mcpServerId: "srv-mcp",
			containerId: "200",
			direction: "pull",
		});
	});

	it("silently skips workflow start when resolvePmTarget returns null (project still created)", async () => {
		const project = projectFixture({
			projectManagementMcpServerId: "srv-x",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "300",
		});
		mockCreateProject.mockResolvedValue(project);
		vi.mocked(resolvePmTarget).mockResolvedValue(null);

		const result = await handler({
			input: {
				name: "Test Project",
				organizationId: null,
				projectManagementMcpServerId: "srv-x",
				projectManagementContainerId: "300",
			},
			context: baseCtx,
		});

		expect(result.project).toBeDefined();
		expect(result.storySyncStarted).toBe(false);
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("short-circuits before any resolution when skipAutoSync=true", async () => {
		const project = projectFixture({
			projectManagementMcpServerId: "srv-gl",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "100",
		});
		mockCreateProject.mockResolvedValue(project);

		const result = await handler({
			input: {
				name: "Test Project",
				organizationId: null,
				projectManagementMcpServerId: "srv-gl",
				projectManagementContainerId: "100",
				skipAutoSync: true,
			},
			context: baseCtx,
		});

		expect(result.storySyncStarted).toBe(false);
		expect(resolvePmTarget).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("skips workflow start when project has no container selected", async () => {
		const project = projectFixture({
			projectManagementMcpServerId: "srv-gl",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
		});
		mockCreateProject.mockResolvedValue(project);

		const result = await handler({
			input: {
				name: "Test Project",
				organizationId: null,
				projectManagementMcpServerId: "srv-gl",
			},
			context: baseCtx,
		});

		expect(result.storySyncStarted).toBe(false);
		expect(resolvePmTarget).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});
});

/**
 * No-double-sync invariant (unified-project-setup spec §4.7 / O1, TG3 §3.4).
 *
 * The unified wizard routes a connected repo and/or backlog through
 * `existingSetup.start` and, for that case, sets `skipAutoSync: true` on
 * `projects.create`. `existingProjectSetupWorkflow` then owns story sync via
 * its Phase 1B backlog ingest. This test pins the create-side guarantee: when
 * the wizard sends the FULL connected-backlog block AND `skipAutoSync: true`,
 * `create-project.ts` must NOT also start `storySyncWorkflow` — otherwise the
 * backlog is pulled twice (storySyncWorkflow + Phase 1B). A regression here
 * silently reintroduces the double-pull O1 was resolved to prevent.
 */
describe("createProjectProcedure — no-double-sync invariant (O1)", () => {
	it("does NOT start storySyncWorkflow when a fully-configured backlog is created with skipAutoSync=true", async () => {
		const project = projectFixture({
			projectManagementMcpServerId: "srv-mcp",
			projectManagementMcpConfigId: "cfg-1",
			projectManagementContainerId: "board-7",
			projectManagementContainerName: "Mobile Board",
		});
		mockCreateProject.mockResolvedValue(project);

		const result = await handler({
			input: {
				name: "Backlog Project",
				organizationId: null,
				// The exact connected-backlog block the unified wizard sends …
				projectManagementMcpServerId: "srv-mcp",
				projectManagementMcpConfigId: "cfg-1",
				projectManagementContainerId: "board-7",
				projectManagementContainerName: "Mobile Board",
				// … alongside skipAutoSync, ceding story sync to
				// existingProjectSetupWorkflow's Phase 1B.
				skipAutoSync: true,
			},
			context: baseCtx,
		});

		// Project is created, but NO storySyncWorkflow fires — Phase 1B is the
		// single owner of backlog ingest (no double-pull).
		expect(result.project).toBeDefined();
		expect(result.storySyncStarted).toBe(false);
		expect(resolvePmTarget).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});
});
