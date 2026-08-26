/**
 * Tests for syncStoryProcedure REST-GitLab fallback (gitlab-rest-pm-parity).
 *
 * Focus: a project whose `projectManagementMcpServerId` resolves to the
 * `gitlab-official` server key, with NO MCPConfig (resolvePMConfigForUser
 * returns null) but an active GITLAB WorkflowIntegration for the tenant, must
 * NOT throw the "not connected" BAD_REQUEST and must reach syncStoryToPM with
 * `mcpConfigId: null` and `mcpServerId` set to the project's server id.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks -----------------------------------------------------------------

vi.mock("@repo/database", () => ({
	resolvePMConfigForUser: vi.fn(),
	getStoryById: vi.fn(),
	hasProjectAccess: vi.fn(),
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
	db: {
		project: {
			findUnique: vi.fn(),
		},
		mCPServer: {
			findUnique: vi.fn(),
		},
		workflowIntegration: {
			findFirst: vi.fn(),
		},
	},
}));

const mockSyncStoryToPM = vi.fn();
const mockSyncTaskToPM = vi.fn();

vi.mock("@repo/temporal", () => ({
	syncStoryToPM: (...args: unknown[]) => mockSyncStoryToPM(...args),
	syncTaskToPM: (...args: unknown[]) => mockSyncTaskToPM(...args),
}));

vi.mock("../../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
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
		resolveOrganizationId: (
			inputOrganizationId: string | null | undefined,
		) => inputOrganizationId ?? undefined,
		Permissions: { STORY_UPDATE: "story:update" },
	};
});

import {
	db,
	getStoryById,
	hasProjectAccess,
	resolvePMConfigForUser,
} from "@repo/database";

// ---- Fixtures --------------------------------------------------------------

const baseCtx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
	tenantContext: { type: "personal" as const, userId: "user-1" },
};

async function loadProcedureHandler() {
	const mod = await import("../sync-story");
	// biome-ignore lint/suspicious/noExplicitAny: test hatch — mocked procedure
	return (mod.syncStoryProcedure as any).handler as (args: {
		input: {
			projectId: string;
			storyId: string;
			direction: "push" | "pull";
			syncTasks?: boolean;
			organizationId?: string | null;
			overrideMismatch?: boolean;
		};
		context: typeof baseCtx;
	}) => Promise<{ success: boolean }>;
}

// ---- Tests -----------------------------------------------------------------

describe("syncStoryProcedure REST-GitLab fallback", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	it("does not throw 'not connected' and calls syncStoryToPM with mcpConfigId:null + mcpServerId for REST-GitLab", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValue(true as never);
		vi.mocked(db.project.findUnique).mockResolvedValue({
			id: "proj-1",
			organizationId: null,
			projectManagementMcpServerId: "mcp-server-gitlab",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "alice/widgets",
			projectManagementAdditionalContext: null,
		} as never);

		// No MCPConfig — tier probe found instance is not MCP-capable.
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null as never);

		// Server resolves to gitlab-official.
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);

		// Active GITLAB WorkflowIntegration for the tenant.
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi-1",
		} as never);

		vi.mocked(getStoryById).mockResolvedValue({
			id: "story-1",
			title: "A story",
			externalId: null,
			tasks: [],
		} as never);

		mockSyncStoryToPM.mockResolvedValue({
			success: true,
			externalId: "1",
			externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
		});

		const handler = await loadProcedureHandler();
		const result = await handler({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				direction: "push",
			},
			context: baseCtx,
		});

		expect(result.success).toBe(true);
		expect(mockSyncStoryToPM).toHaveBeenCalledTimes(1);
		expect(mockSyncStoryToPM).toHaveBeenCalledWith(
			expect.objectContaining({
				storyId: "story-1",
				projectId: "proj-1",
				mcpConfigId: null,
				mcpServerId: "mcp-server-gitlab",
				containerId: "container-1",
				direction: "push",
				userId: "user-1",
			}),
		);
	});

	it("honors the key:gitlab-official sentinel without touching the catalog", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValue(true as never);
		vi.mocked(db.project.findUnique).mockResolvedValue({
			id: "proj-1",
			organizationId: null,
			projectManagementMcpServerId: "key:gitlab-official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "100",
			projectManagementContainerName: "alice/widgets",
			projectManagementAdditionalContext: null,
		} as never);
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi-1",
		} as never);
		vi.mocked(getStoryById).mockResolvedValue({
			id: "story-1",
			title: "A story",
			externalId: null,
			tasks: [],
		} as never);
		mockSyncStoryToPM.mockResolvedValue({
			success: true,
			externalId: "1",
			externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
		});

		const handler = await loadProcedureHandler();
		const result = await handler({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				direction: "push",
			},
			context: baseCtx,
		});

		expect(result.success).toBe(true);
		// Sentinel must short-circuit — catalog lookup must NOT fire.
		expect(vi.mocked(db.mCPServer.findUnique)).not.toHaveBeenCalled();
		expect(mockSyncStoryToPM).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpServerId: "key:gitlab-official",
				mcpConfigId: null,
				direction: "push",
			}),
		);
	});
});

// ---- #1360: terminal-status lifecycle passthrough ---------------------------

describe("syncStoryProcedure lifecycle passthrough (#1360)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	function mockMcpProject() {
		vi.mocked(hasProjectAccess).mockResolvedValue(true as never);
		vi.mocked(db.project.findUnique).mockResolvedValue({
			id: "proj-1",
			organizationId: null,
			projectManagementMcpServerId: "mcp-server-1",
			projectManagementMcpConfigId: "cfg-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "alice/widgets",
			projectManagementAdditionalContext: null,
		} as never);
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg-1",
			enabled: true,
		} as never);
	}

	it("surfaces terminalApplied/lifecycleAction/lifecycleReconciled/terminalStatusLabel from a successful pull", async () => {
		mockMcpProject();
		// Pull requires an already-synced story (externalId set).
		vi.mocked(getStoryById).mockResolvedValue({
			id: "story-1",
			title: "A story",
			externalId: "123",
			tasks: [],
		} as never);

		mockSyncStoryToPM.mockResolvedValue({
			success: true,
			externalId: "123",
			externalUrl: "https://pm.example/issues/123",
			direction: "pull",
			syncedAt: new Date(),
			terminalApplied: true,
			lifecycleAction: "auto-hidden",
			lifecycleReconciled: true,
			terminalStatusLabel: "Done",
		});

		const handler = await loadProcedureHandler();
		const result = (await handler({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				direction: "pull",
			},
			context: baseCtx,
		})) as {
			success: boolean;
			terminalApplied?: boolean;
			lifecycleAction?: string;
			lifecycleReconciled?: boolean;
			terminalStatusLabel?: string | null;
		};

		expect(result.success).toBe(true);
		expect(result.terminalApplied).toBe(true);
		expect(result.lifecycleAction).toBe("auto-hidden");
		expect(result.lifecycleReconciled).toBe(true);
		expect(result.terminalStatusLabel).toBe("Done");
	});

	it("attaches linkPreserved to error.data on an EXTERNAL_ID_NOT_FOUND result", async () => {
		mockMcpProject();
		vi.mocked(getStoryById).mockResolvedValue({
			id: "story-1",
			title: "A story",
			externalId: "123",
			tasks: [],
		} as never);

		mockSyncStoryToPM.mockResolvedValue({
			success: false,
			error: "The linked ticket was not found in the PM tool. The link is kept.",
			errorCode: "EXTERNAL_ID_NOT_FOUND",
			linkPreserved: true,
			direction: "pull",
			syncedAt: new Date(),
		});

		const handler = await loadProcedureHandler();
		let caught:
			| {
					code?: string;
					data?: { errorCode?: string; linkPreserved?: boolean };
			  }
			| undefined;
		try {
			await handler({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					direction: "pull",
				},
				context: baseCtx,
			});
		} catch (e) {
			caught = e as typeof caught;
		}

		expect(caught).toBeDefined();
		expect(caught?.code).toBe("BAD_REQUEST");
		expect(caught?.data?.errorCode).toBe("EXTERNAL_ID_NOT_FOUND");
		expect(caught?.data?.linkPreserved).toBe(true);
	});
});
