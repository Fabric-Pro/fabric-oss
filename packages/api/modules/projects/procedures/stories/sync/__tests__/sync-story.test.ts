/**
 * Tests for syncStoryProcedure REST-GitLab fallback (gitlab-rest-pm-parity).
 *
 * Focus: a project whose `projectManagementMcpServerId` resolves to the
 * `gitlab-official` server key, with NO MCPConfig (resolvePMConfigForUser
 * returns null) but a usable personal GitLab connection for the caller, must
 * NOT throw the "not connected" BAD_REQUEST and must reach syncStoryToPM with
 * `mcpConfigId: null` and `mcpServerId` set to the project's server id.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks -----------------------------------------------------------------

vi.mock("@repo/database", () => ({
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
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
	},
}));

// The GitLab REST gate asks the connection service for the caller's usable
// personal connection; its own behaviour (classification, reconnect-required) is
// covered against the real service in
// modules/projects/__tests__/gitlab-personal-connection-gates.test.ts.
const mockFindUsableGitLabConnection = vi.hoisted(() => vi.fn());
vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findUsableGitLabConnection: mockFindUsableGitLabConnection,
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

const mockAssertCapabilityAvailable = vi.fn();

vi.mock("../../../../../capabilities/assert", () => ({
	assertCapabilityAvailable: (...args: unknown[]) =>
		mockAssertCapabilityAvailable(...args),
}));

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

		// A usable personal GitLab connection for the caller.
		mockFindUsableGitLabConnection.mockResolvedValue({
			integrationId: "wi-1",
			origin: "https://gitlab.com",
		});

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

	it("refuses a connection on another GitLab instance than the container, before any sync", async () => {
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

		// A usable personal GitLab connection for the caller.
		mockFindUsableGitLabConnection.mockResolvedValue({
			integrationId: "wi-1",
			origin: "https://gitlab.example.com",
		});

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
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					direction: "push",
				},
				context: baseCtx,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("different GitLab instance"),
		});
		expect(mockSyncStoryToPM).not.toHaveBeenCalled();
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
		mockFindUsableGitLabConnection.mockResolvedValue({
			integrationId: "wi-1",
			origin: "https://gitlab.com",
		});
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

	it("reports a legacy link to another PM tool as BAD_REQUEST with its own code (not the migrate code)", async () => {
		mockMcpProject();
		vi.mocked(getStoryById).mockResolvedValue({
			id: "story-1",
			title: "A story",
			externalId: "77",
			tasks: [],
		} as never);

		mockSyncStoryToPM.mockResolvedValue({
			success: false,
			error: "This item is linked to a ticket in a different PM tool, so Fabric did not create a new one in fizzy. To make a new ticket in fizzy, use Unlink & re-create (the old ticket is not deleted).",
			errorCode: "PM_TOOL_MISMATCH_LEGACY",
			direction: "push",
			syncedAt: new Date(),
		});

		const handler = await loadProcedureHandler();
		let caught:
			| { code?: string; message?: string; data?: { errorCode?: string } }
			| undefined;
		try {
			await handler({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					direction: "push",
				},
				context: baseCtx,
			});
		} catch (e) {
			caught = e as typeof caught;
		}

		expect(caught?.code).toBe("BAD_REQUEST");
		// Not "PM_TOOL_MISMATCH": that would offer a migrate push, which
		// cannot replace an unstamped link.
		expect(caught?.data?.errorCode).toBe("PM_TOOL_MISMATCH_LEGACY");
		expect(caught?.message).toEqual(
			expect.stringContaining("Unlink & re-create"),
		);
	});
});

describe("syncStoryProcedure story.pm_pushed audit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		mockAssertCapabilityAvailable.mockResolvedValue(null);
		vi.mocked(hasProjectAccess).mockResolvedValue(true as never);
		vi.mocked(db.project.findUnique).mockResolvedValue({
			id: "proj-1",
			organizationId: "org-1",
			readOnlyMode: false,
			projectManagementMcpServerId: "mcp-server-1",
			projectManagementMcpConfigId: "cfg-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "example-org/widgets",
			projectManagementAdditionalContext: null,
		} as never);
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg-1",
			enabled: true,
		} as never);
		vi.mocked(getStoryById).mockResolvedValue({
			id: "story-1",
			title: "A story",
			externalId: null,
			tasks: [],
		} as never);
	});

	async function push() {
		const handler = await loadProcedureHandler();
		return handler({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				direction: "push",
				organizationId: "org-1",
			},
			context: baseCtx,
		});
	}

	async function pushedAudits() {
		const { recordAuditFromRequest } = await import(
			"../../../../../../lib/audit"
		);
		return vi
			.mocked(recordAuditFromRequest)
			.mock.calls.filter(
				([, entry]) =>
					(entry as { action?: string }).action === "story.pm_pushed",
			);
	}

	it("is not recorded for a push skipped because another run linked the story first", async () => {
		mockSyncStoryToPM.mockResolvedValue({
			success: true,
			externalId: "88",
			externalUrl: "https://pm.example.com/items/88",
			direction: "push",
			syncedAt: new Date(),
			pushSkipped: "already-linked",
		});

		const result = await push();

		expect(result.success).toBe(true);
		expect(await pushedAudits()).toHaveLength(0);
	});

	it("is recorded for a real push, with its link", async () => {
		mockSyncStoryToPM.mockResolvedValue({
			success: true,
			externalId: "88",
			externalUrl: "https://pm.example.com/items/88",
			direction: "push",
			syncedAt: new Date(),
		});

		await push();

		const audits = await pushedAudits();
		expect(audits).toHaveLength(1);
		expect(audits[0]?.[1]).toMatchObject({
			action: "story.pm_pushed",
			resource: { type: "story", id: "story-1" },
			metadata: { externalId: "88" },
		});
	});

	it("counts only the tasks this push created, not linked or failed ones", async () => {
		vi.mocked(getStoryById).mockResolvedValue({
			id: "story-1",
			title: "A story",
			externalId: null,
			tasks: [
				{ id: "task-1", identifier: "TASK-001" },
				{ id: "task-2", identifier: "TASK-002" },
				{ id: "task-3", identifier: "TASK-003" },
			],
		} as never);
		mockSyncStoryToPM.mockResolvedValue({
			success: true,
			externalId: "88",
			externalUrl: "https://pm.example.com/items/88",
			direction: "push",
			syncedAt: new Date(),
		});
		mockSyncTaskToPM
			.mockResolvedValueOnce({ success: true, externalId: "90" })
			.mockResolvedValueOnce({
				success: true,
				externalId: "91",
				skipped: true,
			})
			.mockResolvedValueOnce({ success: false, error: "boom" });

		const handler = await loadProcedureHandler();
		const result = await handler({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				direction: "push",
				syncTasks: true,
				organizationId: "org-1",
			},
			context: baseCtx,
		});

		expect(mockSyncTaskToPM).toHaveBeenCalledTimes(3);
		expect(result.taskResults?.[1]).toMatchObject({
			taskId: "task-2",
			skipped: true,
		});
		const audits = await pushedAudits();
		expect(audits[0]?.[1]).toMatchObject({
			metadata: { syncedTasks: 1 },
		});
	});
});

describe("syncStoryProcedure capability gate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		mockAssertCapabilityAvailable.mockResolvedValue(null);
	});

	function mockMcpProject(overrides: Record<string, unknown> = {}) {
		vi.mocked(hasProjectAccess).mockResolvedValue(true as never);
		vi.mocked(db.project.findUnique).mockResolvedValue({
			id: "proj-1",
			organizationId: "org-1",
			readOnlyMode: false,
			projectManagementMcpServerId: "mcp-server-1",
			projectManagementMcpConfigId: "cfg-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "alice/widgets",
			projectManagementAdditionalContext: null,
			...overrides,
		} as never);
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg-1",
			enabled: true,
		} as never);
		vi.mocked(getStoryById).mockResolvedValue({
			id: "story-1",
			title: "A story",
			externalId: "123",
			tasks: [],
		} as never);
		mockSyncStoryToPM.mockResolvedValue({ success: true });
	}

	it.each([
		["pull", "roadmap.pull-from-pm"],
		["push", "roadmap.sync-to-pm"],
	] as const)(
		"asserts a %s against %s with the project's organization",
		async (direction, capabilityKey) => {
			mockMcpProject();

			const handler = await loadProcedureHandler();
			await handler({
				input: { projectId: "proj-1", storyId: "story-1", direction },
				context: baseCtx,
			});

			expect(mockAssertCapabilityAvailable).toHaveBeenCalledWith({
				capabilityKey,
				projectId: "proj-1",
				userId: "user-1",
				organizationId: "org-1",
			});
		},
	);

	it("throws the read-only push CONFLICT before the assert", async () => {
		mockMcpProject({ readOnlyMode: true });

		const handler = await loadProcedureHandler();
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					direction: "push",
				},
				context: baseCtx,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(mockAssertCapabilityAvailable).not.toHaveBeenCalled();
	});

	it("stops the sync when the gate refuses", async () => {
		mockMcpProject();
		mockAssertCapabilityAvailable.mockRejectedValueOnce(
			new Error("gate refused"),
		);

		const handler = await loadProcedureHandler();
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					direction: "pull",
				},
				context: baseCtx,
			}),
		).rejects.toThrow("gate refused");

		expect(mockSyncStoryToPM).not.toHaveBeenCalled();
	});
});

describe("stable PM container identity", () => {
	it("forwards the ADO project GUID into a direct story sync", async () => {
		vi.clearAllMocks();
		vi.resetModules();
		const containerId = "11111111-1111-4111-8111-111111111111";
		vi.mocked(hasProjectAccess).mockResolvedValue(true as never);
		vi.mocked(db.project.findUnique).mockResolvedValue({
			id: "example-project",
			organizationId: null,
			projectManagementMcpServerId: "example-server",
			projectManagementMcpConfigId: "example-config",
			projectManagementContainerId: containerId,
			projectManagementContainerName: "Example Project",
			projectManagementAdditionalContext: {},
		} as never);
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "example-config",
			enabled: true,
			mcpServerId: "example-server",
			commandArgs: ["example-org"],
			mcpServer: { key: "azure-devops" },
		} as never);
		vi.mocked(getStoryById).mockResolvedValue({
			id: "example-story",
			title: "Example",
			tasks: [],
		} as never);
		mockSyncStoryToPM.mockResolvedValue({
			success: true,
			externalId: "42",
		});
		const handler = await loadProcedureHandler();
		await handler({
			input: {
				projectId: "example-project",
				storyId: "example-story",
				direction: "push",
			},
			context: baseCtx,
		});
		expect(mockSyncStoryToPM).toHaveBeenCalledWith(
			expect.objectContaining({
				containerId,
				stableContainerId: containerId,
			}),
		);
	});
});
