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

// The real GitLab container-instance binding runs; the actor's GitLab
// connection is on a self-hosted instance and `srv-gl` is GitLab.
const mockProjectUpdate = vi.hoisted(() => vi.fn());
const mockProjectFindUnique = vi.hoisted(() => vi.fn());
vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findUsableGitLabConnection: async () => ({
		integrationId: "wi-1",
		origin: "https://gitlab.example.com",
	}),
}));

vi.mock("@repo/database", async () => ({
	getEngagementProfileConfig: () => ({
		kanbanTemplateId: "default",
		intakeMode: "document",
	}),
	DEFAULT_NEW_PROJECT_PROFILE: "GOVERNED",
	applyKanbanTemplateForNewProject: async () => ({ applied: false }),

	engagementProfileSchema: (await import("zod")).z.enum([
		"EXPLORE",
		"PROPOSAL",
		"GOVERNED",
		"DELEGATED",
	]),

	createProject: (...args: unknown[]) => mockCreateProject(...args),
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
	pmSelectionUnchangedWhere: (expected: unknown) => ({
		pmSelection: expected,
	}),
	db: {
		project: {
			findFirst: (...args: unknown[]) => mockProjectFindFirst(...args),
			findUnique: (...args: unknown[]) => mockProjectFindUnique(...args),
			update: (...args: unknown[]) => mockProjectUpdate(...args),
		},
		mCPServer: {
			findUnique: async (args: { where: { id: string } }) =>
				args.where.id === "srv-gl" ? { key: "gitlab-official" } : null,
		},
		mCPConfig: { findFirst: async () => null },
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

const mockOpenPmStorySyncJob = vi.fn();
const mockFailPmStorySyncJob = vi.fn();

vi.mock("../../lib/pm-story-sync-job", () => ({
	openPmStorySyncJob: (...args: unknown[]) => mockOpenPmStorySyncJob(...args),
	failPmStorySyncJob: (...args: unknown[]) => mockFailPmStorySyncJob(...args),
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
	mockOpenPmStorySyncJob.mockResolvedValue(undefined);
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

	it("opens a PM_STORY_SYNC row just before the onboarding pull starts", async () => {
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

		await handler({
			input: {
				name: "Test Project",
				organizationId: null,
				projectManagementMcpServerId: "srv-mcp",
				projectManagementMcpConfigId: "cfg-1",
				projectManagementContainerId: "200",
			},
			context: baseCtx,
		});

		const [, opts] = mockWorkflowStart.mock.calls[0];
		expect(mockOpenPmStorySyncJob).toHaveBeenCalledWith({
			workflowId: opts.workflowId,
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			direction: "pull",
		});
		expect(mockOpenPmStorySyncJob.mock.invocationCallOrder[0]).toBeLessThan(
			mockWorkflowStart.mock.invocationCallOrder[0],
		);
		expect(mockFailPmStorySyncJob).not.toHaveBeenCalled();
	});

	it("fails the opened row when the onboarding pull fails to start, and still creates the project", async () => {
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
		mockWorkflowStart.mockRejectedValueOnce(new Error("temporal down"));
		vi.spyOn(console, "error").mockImplementation(() => {});

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

		expect(result.storySyncStarted).toBe(false);
		expect(mockFailPmStorySyncJob).toHaveBeenCalledWith({
			workflowId: mockOpenPmStorySyncJob.mock.calls[0][0].workflowId,
			projectId: "proj-1",
			error: "The sync could not be started.",
		});
	});

	it("skips the onboarding pull when a sync already holds the project, failing no row", async () => {
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
		mockOpenPmStorySyncJob.mockResolvedValueOnce({
			workflowId: "story-sync-live",
			direction: "pull",
			startedAt: new Date(),
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

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

		expect(result.storySyncStarted).toBe(false);
		expect(mockWorkflowStart).not.toHaveBeenCalled();
		expect(mockFailPmStorySyncJob).not.toHaveBeenCalled();
	});

	it("opens no PM_STORY_SYNC row when no sync starts", async () => {
		const project = projectFixture({
			projectManagementMcpServerId: "srv-x",
			projectManagementContainerId: "300",
		});
		mockCreateProject.mockResolvedValue(project);
		vi.mocked(resolvePmTarget).mockResolvedValue(null);

		await handler({
			input: {
				name: "Test Project",
				organizationId: null,
				projectManagementMcpServerId: "srv-x",
				projectManagementContainerId: "300",
			},
			context: baseCtx,
		});

		expect(mockOpenPmStorySyncJob).not.toHaveBeenCalled();
		expect(mockFailPmStorySyncJob).not.toHaveBeenCalled();
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

describe("createProjectProcedure — the GitLab container's instance", () => {
	const GITLAB_SELECTION = {
		projectManagementMcpServerId: "srv-gl",
		projectManagementContainerId: "42",
	};

	beforeEach(() => {
		vi.mocked(resolvePmTarget).mockResolvedValue(null);
	});

	it("records the actor's instance on a fresh project, never the client's", async () => {
		mockCreateProject.mockResolvedValue(projectFixture(GITLAB_SELECTION));

		await handler({
			input: {
				name: "Test Project",
				organizationId: "org-1",
				...GITLAB_SELECTION,
				projectManagementAdditionalContext: {
					gitlabOrigin: "https://client-chosen.example.com",
				},
			},
			context: baseCtx,
		});

		expect(
			mockCreateProject.mock.calls[0][0]
				.projectManagementAdditionalContext,
		).toEqual({ gitlabOrigin: "https://gitlab.example.com" });
	});

	// A person's GitLab connection lives in an organization (ADR-018), and
	// reading it can classify (write) a row in the organization it is given,
	// so a create with none reads nothing and records no instance.
	it("records no instance, and drops the client's, when the create has no organization", async () => {
		mockCreateProject.mockResolvedValue(projectFixture(GITLAB_SELECTION));

		await handler({
			input: {
				name: "Test Project",
				organizationId: null,
				...GITLAB_SELECTION,
				projectManagementAdditionalContext: {
					gitlabOrigin: "https://client-chosen.example.com",
				},
			},
			context: baseCtx,
		});

		expect(
			mockCreateProject.mock.calls[0][0]
				.projectManagementAdditionalContext,
		).toEqual({});
	});

	it("activates a draft only while its selection is the one bound, re-binding after a concurrent change", async () => {
		const draft = {
			...projectFixture({
				projectManagementMcpServerId: "srv-gl",
				projectManagementContainerId: "42",
			}),
			id: "draft-1",
			status: "DRAFT",
			projectManagementAdditionalContext: {
				gitlabOrigin: "https://gitlab.com",
			},
			engagementProfile: "GOVERNED",
		};
		mockProjectFindFirst.mockImplementation(
			async (args: { where: { draftKey?: string } }) =>
				args.where.draftKey ? draft : null,
		);
		// Another save switched the draft to container 77 first.
		mockProjectFindUnique.mockResolvedValue({
			projectManagementMcpServerId: "srv-gl",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "77",
			projectManagementAdditionalContext: {
				gitlabOrigin: "https://gitlab.example.com",
			},
		});
		mockProjectUpdate
			.mockRejectedValueOnce(
				Object.assign(new Error("Record to update not found."), {
					code: "P2025",
				}),
			)
			.mockResolvedValueOnce({ ...draft, status: "ACTIVE" });

		await handler({
			input: {
				name: "Test Project",
				organizationId: null,
				draftKey: "550e8400-e29b-41d4-a716-446655440000",
				// Writes the PM context, so the activation is conditional.
				projectManagementAdditionalContext: { areaPath: "Team" },
			},
			context: baseCtx,
		});

		expect(mockProjectUpdate).toHaveBeenCalledTimes(2);
		const [first, retried] = mockProjectUpdate.mock.calls.map(
			(call) => call[0],
		);
		expect(first.where).toEqual({
			id: "draft-1",
			pmSelection: {
				serverId: "srv-gl",
				configId: null,
				containerId: "42",
				additionalContext: { gitlabOrigin: "https://gitlab.com" },
			},
		});
		expect(retried.where.pmSelection).toMatchObject({ containerId: "77" });
		// Container 77 keeps the instance it was chosen on.
		expect(retried.data.projectManagementAdditionalContext).toEqual({
			areaPath: "Team",
			gitlabOrigin: "https://gitlab.example.com",
		});
		expect(mockCreateProject).not.toHaveBeenCalled();
	});
});
