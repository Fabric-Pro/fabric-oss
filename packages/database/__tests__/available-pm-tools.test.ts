/**
 * Unit tests for the `listAvailablePmTools` query.
 *
 * Mocks at the Prisma client boundary; covers default-stub emission,
 * tenant-config dedupe by key, XOR tenant isolation, display-name and
 * icon-key overrides, the "no frontend changes to add a tool"
 * extensibility guarantee, and GitLab: the caller's connection status (read
 * by the API layer from the GitLab connection service) alone decides whether
 * GitLab is offered.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyServer, findManyConfig, findManyWorkflowIntegration } =
	vi.hoisted(() => ({
		findManyServer: vi.fn(),
		findManyConfig: vi.fn(),
		findManyWorkflowIntegration: vi.fn(),
	}));

vi.mock("../prisma/client", () => ({
	db: {
		mCPServer: { findMany: findManyServer },
		mCPConfig: { findMany: findManyConfig },
		workflowIntegration: { findMany: findManyWorkflowIntegration },
	},
	Prisma: { DbNull: { __dbNull: true } },
}));

import {
	listAvailablePmTools,
	type PmToolGitLabStatus,
} from "../prisma/queries/mcp";

const CONNECTED: PmToolGitLabStatus = { state: "connected" };
const NEEDS_RECONNECT: PmToolGitLabStatus = { state: "needs-reconnect" };
const NOT_CONNECTED: PmToolGitLabStatus = { state: "not-connected" };

const DEFAULT_FIXTURE_SERVERS = [
	{ id: "srv_fizzy", key: "fizzy", name: "Fizzy" },
	{ id: "srv_ado", key: "azure-devops", name: "Azure DevOps" },
	{
		id: "srv_atlassian",
		key: "atlassian",
		name: "Atlassian (Jira & Confluence)",
	},
	{
		id: "srv_gitlab_official",
		key: "gitlab-official",
		name: "GitLab (Official)",
	},
];

function tenantConfigStub(overrides: {
	id: string;
	displayName?: string | null;
	mcpServer: {
		id: string;
		key: string;
		name: string;
		category?: string;
		tags?: string[];
	};
}) {
	return {
		id: overrides.id,
		displayName: overrides.displayName ?? null,
		mcpServer: {
			...overrides.mcpServer,
			category: overrides.mcpServer.category ?? "Project Management",
			tags: overrides.mcpServer.tags ?? [],
		},
	};
}

describe("listAvailablePmTools", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findManyServer.mockResolvedValue(DEFAULT_FIXTURE_SERVERS);
		findManyConfig.mockResolvedValue([]);
		findManyWorkflowIntegration.mockResolvedValue([]);
	});

	it("emits exactly the four defaults when no configs exist (personal context)", async () => {
		const result = await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
			gitlab: NOT_CONNECTED,
		});

		expect(result.map((o) => o.key)).toEqual([
			"fizzy",
			"azure-devops",
			"atlassian",
			"gitlab-official",
		]);
		expect(result.every((o) => o.isDefault)).toBe(true);
		expect(result.every((o) => !o.isConfigured)).toBe(true);
		expect(result.every((o) => o.mcpConfigId === null)).toBe(true);
		expect(result.every((o) => o.transport === null)).toBe(true);
	});

	it("applies the atlassian → Jira display + icon overrides", async () => {
		const result = await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
			gitlab: NOT_CONNECTED,
		});
		const jira = result.find((o) => o.key === "atlassian");
		expect(jira?.displayName).toBe("Jira");
		expect(jira?.iconKey).toBe("jira");
	});

	it("applies the gitlab-official → GitLab display + icon overrides", async () => {
		const result = await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
			gitlab: NOT_CONNECTED,
		});
		const gitlab = result.find((o) => o.key === "gitlab-official");
		expect(gitlab?.displayName).toBe("GitLab");
		expect(gitlab?.iconKey).toBe("gitlab");
	});

	it("uses XOR tenant filter for personal context (organizationId: null)", async () => {
		await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
			gitlab: NOT_CONNECTED,
		});
		const call = findManyConfig.mock.calls[0]?.[0];
		expect(call.where.userId).toBe("u_1");
		expect(call.where.organizationId).toBeNull();
	});

	it("uses XOR tenant filter for org context", async () => {
		await listAvailablePmTools({
			userId: "u_1",
			organizationId: "org_x",
			gitlab: NOT_CONNECTED,
		});
		const call = findManyConfig.mock.calls[0]?.[0];
		expect(call.where.userId).toBe("u_1");
		expect(call.where.organizationId).toBe("org_x");
	});

	it("filters configs to enabled + PM category/tag", async () => {
		await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
			gitlab: NOT_CONNECTED,
		});
		const call = findManyConfig.mock.calls[0]?.[0];
		expect(call.where.enabled).toBe(true);
		expect(call.where.OR).toEqual(
			expect.arrayContaining([
				{ mcpServer: { category: "Project Management" } },
				{ mcpServer: { tags: { has: "project-management" } } },
			]),
		);
	});

	it("includes Linear (configured) alongside three defaults — configured first alpha", async () => {
		findManyConfig.mockResolvedValue([
			tenantConfigStub({
				id: "cfg_linear",
				displayName: "Linear (work)",
				mcpServer: {
					id: "srv_linear",
					key: "linear-remote",
					name: "Linear",
				},
			}),
		]);

		const result = await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
			gitlab: NOT_CONNECTED,
		});

		expect(result.map((o) => o.key)).toEqual([
			"linear-remote",
			"fizzy",
			"azure-devops",
			"atlassian",
			"gitlab-official",
		]);
		expect(result[0]).toMatchObject({
			key: "linear-remote",
			isDefault: false,
			isConfigured: true,
			mcpConfigId: "cfg_linear",
			mcpServerId: "srv_linear",
			displayName: "Linear",
			configDisplayName: "Linear (work)",
		});
		expect(result[0].transport).toBe("mcp");
	});

	it("dedupes a default-key config — Fizzy configured suppresses the Fizzy default stub", async () => {
		findManyConfig.mockResolvedValue([
			tenantConfigStub({
				id: "cfg_fizzy",
				displayName: null,
				mcpServer: { id: "srv_fizzy", key: "fizzy", name: "Fizzy" },
			}),
		]);

		const result = await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
			gitlab: NOT_CONNECTED,
		});

		const fizzyRows = result.filter((o) => o.key === "fizzy");
		expect(fizzyRows).toHaveLength(1);
		expect(fizzyRows[0]).toMatchObject({
			isDefault: true,
			isConfigured: true,
			mcpConfigId: "cfg_fizzy",
		});
		// Other defaults remain
		expect(result.map((o) => o.key)).toEqual([
			"fizzy",
			"azure-devops",
			"atlassian",
			"gitlab-official",
		]);
	});

	it("emits Fizzy + Linear both configured (alpha) then ADO + Jira defaults", async () => {
		findManyConfig.mockResolvedValue([
			tenantConfigStub({
				id: "cfg_linear",
				displayName: "Linear (work)",
				mcpServer: {
					id: "srv_linear",
					key: "linear-remote",
					name: "Linear",
				},
			}),
			tenantConfigStub({
				id: "cfg_fizzy",
				mcpServer: { id: "srv_fizzy", key: "fizzy", name: "Fizzy" },
			}),
		]);

		const result = await listAvailablePmTools({
			userId: "u_1",
			organizationId: "org_a",
			gitlab: NOT_CONNECTED,
		});

		expect(result.map((o) => o.key)).toEqual([
			"fizzy",
			"linear-remote",
			"azure-devops",
			"atlassian",
			"gitlab-official",
		]);
	});

	it("surfaces a brand-new tool added only as a PM-categorised MCPConfig (AC-3)", async () => {
		// Brand-new tool ClickUp the team just seeded into MCPServer.
		// No code change to the wizard/procedure should be needed — the
		// query picks it up purely by category.
		findManyConfig.mockResolvedValue([
			tenantConfigStub({
				id: "cfg_clickup",
				displayName: "Acme ClickUp workspace",
				mcpServer: {
					id: "srv_clickup",
					key: "clickup",
					name: "ClickUp",
				},
			}),
		]);

		const result = await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
			gitlab: NOT_CONNECTED,
		});

		expect(result[0]).toMatchObject({
			key: "clickup",
			isDefault: false,
			isConfigured: true,
			displayName: "ClickUp",
		});
	});

	it("falls back to server.name as configDisplayName when MCPConfig has no displayName", async () => {
		findManyConfig.mockResolvedValue([
			tenantConfigStub({
				id: "cfg_fizzy",
				displayName: null,
				mcpServer: { id: "srv_fizzy", key: "fizzy", name: "Fizzy" },
			}),
		]);

		const result = await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
			gitlab: NOT_CONNECTED,
		});

		const fizzy = result.find((o) => o.key === "fizzy");
		expect(fizzy?.configDisplayName).toBe("Fizzy");
	});

	it("still emits a default stub when the catalog row is missing (degradation fallback)", async () => {
		// Previously this loop silently dropped any default whose MCPServer
		// row was absent — see the GitLab regression that motivated the
		// catalog-row-resilience block in `listAvailablePmTools`. We now
		// emit the default with a `key:`-prefixed sentinel mcpServerId so
		// the picker can still surface it; the misconfigured environment
		// is reported via console.error rather than hidden from users.
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		findManyServer.mockResolvedValue(
			DEFAULT_FIXTURE_SERVERS.filter((s) => s.key !== "atlassian"),
		);

		const result = await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
			gitlab: NOT_CONNECTED,
		});

		expect(result.map((o) => o.key)).toEqual([
			"fizzy",
			"azure-devops",
			"atlassian",
			"gitlab-official",
		]);
		const jira = result.find((o) => o.key === "atlassian");
		expect(jira?.mcpServerId).toBe("key:atlassian");
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("skips configs whose mcpServer is missing (defensive)", async () => {
		findManyConfig.mockResolvedValue([
			{ id: "cfg_orphan", displayName: "Orphan", mcpServer: null },
		]);

		const result = await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
			gitlab: NOT_CONNECTED,
		});

		// Only the defaults survive
		expect(result.map((o) => o.key)).toEqual([
			"fizzy",
			"azure-devops",
			"atlassian",
			"gitlab-official",
		]);
	});

	describe("GitLab — the caller's connection decides", () => {
		const officialConfig = () =>
			tenantConfigStub({
				id: "cfg_gitlab",
				displayName: "GitLab Premium",
				mcpServer: {
					id: "srv_gitlab_official",
					key: "gitlab-official",
					name: "GitLab (Official)",
				},
			});

		it("synthesizes the gitlab-official REST entry when connected and no MCPConfig exists", async () => {
			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
				gitlab: CONNECTED,
			});

			const gitlab = result.filter((o) => o.key === "gitlab-official");
			expect(gitlab).toHaveLength(1);
			expect(gitlab[0]).toMatchObject({
				isDefault: true,
				isConfigured: true,
				transport: "rest",
				mcpConfigId: null,
				mcpServerId: "srv_gitlab_official",
				configDisplayName: "GitLab (REST)",
			});
		});

		it("offers the enabled gitlab-official MCPConfig when connected", async () => {
			findManyConfig.mockResolvedValue([officialConfig()]);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
				gitlab: CONNECTED,
			});

			const gitlab = result.filter((o) => o.key === "gitlab-official");
			expect(gitlab).toHaveLength(1);
			expect(gitlab[0]).toMatchObject({
				transport: "mcp",
				isConfigured: true,
				mcpConfigId: "cfg_gitlab",
			});
		});

		it("does not offer GitLab after a disconnect, even with an enabled gitlab-official MCPConfig", async () => {
			// A disconnect keeps the MCPConfig row and `enabled` (only its
			// tokens are cleared), so the row alone must not make GitLab
			// configured.
			findManyConfig.mockResolvedValue([officialConfig()]);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
				gitlab: NOT_CONNECTED,
			});

			const gitlab = result.filter((o) => o.key === "gitlab-official");
			expect(gitlab).toHaveLength(1);
			expect(gitlab[0]).toMatchObject({
				isConfigured: false,
				mcpConfigId: null,
				transport: null,
			});
		});

		it("does not offer GitLab when the connection needs reconnecting", async () => {
			// The stored row is still active (the old picker counted it).
			findManyWorkflowIntegration.mockResolvedValue([{ id: "wi_1" }]);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
				gitlab: NEEDS_RECONNECT,
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toMatchObject({
				isConfigured: false,
				mcpConfigId: null,
				transport: null,
			});
		});

		it("does not offer a needs-reconnect GitLab through its MCPConfig either", async () => {
			findManyConfig.mockResolvedValue([officialConfig()]);
			findManyWorkflowIntegration.mockResolvedValue([{ id: "wi_1" }]);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
				gitlab: NEEDS_RECONNECT,
			});

			expect(
				result.filter(
					(o) => o.key === "gitlab-official" && o.isConfigured,
				),
			).toEqual([]);
		});

		it("never reads GitLab's status from WorkflowIntegration rows of its own", async () => {
			await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
				gitlab: CONNECTED,
			});
			expect(findManyWorkflowIntegration).not.toHaveBeenCalled();
		});
	});

	describe("personal-scope GitLab hint in org context", () => {
		it("flags the stub connectedInPersonalScope when only the personal-scope connection is usable", async () => {
			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
				gitlab: {
					state: "not-connected",
					personalScopeConnected: true,
				},
			});

			expect(
				result.find((o) => o.key === "gitlab-official"),
			).toMatchObject({
				isConfigured: false,
				connectedInPersonalScope: true,
				mcpServerId: "srv_gitlab_official",
				mcpConfigId: null,
				transport: null,
			});
		});

		it("offers the org connection (REST) without the hint when both are connected", async () => {
			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
				gitlab: { state: "connected", personalScopeConnected: true },
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toMatchObject({
				isConfigured: true,
				transport: "rest",
			});
			expect(gitlab?.connectedInPersonalScope).toBeFalsy();
		});

		it("ignores the personal-scope flag in personal context", async () => {
			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
				gitlab: {
					state: "not-connected",
					personalScopeConnected: true,
				},
			});

			expect(
				result.find((o) => o.key === "gitlab-official")
					?.connectedInPersonalScope,
			).toBeFalsy();
		});

		it("emits the plain stub when neither connection is usable", async () => {
			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
				gitlab: {
					state: "needs-reconnect",
					personalScopeConnected: false,
				},
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toMatchObject({
				isConfigured: false,
				transport: null,
			});
			expect(gitlab?.connectedInPersonalScope).toBeFalsy();
		});
	});

	// Regression: staging hit a case where the `gitlab-official` MCPServer
	// catalog row was missing / not marked `isSystemProvided=true`. The
	// silent `if (gitlabServer)` gates in the REST-synthesis branch and the
	// default-stub loop dropped GitLab from the picker entirely, even when
	// a working GitLab connection existed. The picker must treat the
	// connection as ground truth for "GitLab is available via REST" — the
	// catalog row is a UI label, not a gate.
	describe("resilience when gitlab-official MCPServer catalog row is missing", () => {
		const SERVERS_WITHOUT_GITLAB = DEFAULT_FIXTURE_SERVERS.filter(
			(s) => s.key !== "gitlab-official",
		);

		let warnSpy: ReturnType<typeof vi.spyOn>;
		beforeEach(() => {
			findManyServer.mockResolvedValue(SERVERS_WITHOUT_GITLAB);
			warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		});

		it("still emits REST-synthesized GitLab when the connection is usable (org context)", async () => {
			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
				gitlab: CONNECTED,
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toBeDefined();
			expect(gitlab).toMatchObject({
				key: "gitlab-official",
				displayName: "GitLab",
				iconKey: "gitlab",
				isConfigured: true,
				transport: "rest",
				configDisplayName: "GitLab (REST)",
				mcpConfigId: null,
			});
			expect(gitlab?.mcpServerId).toBeTruthy();
		});

		it("still emits REST-synthesized GitLab when the connection is usable (personal context)", async () => {
			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
				gitlab: CONNECTED,
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toMatchObject({
				key: "gitlab-official",
				isConfigured: true,
				transport: "rest",
				configDisplayName: "GitLab (REST)",
			});
		});

		it("still emits the GitLab default stub when GitLab is not connected", async () => {
			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
				gitlab: NOT_CONNECTED,
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toMatchObject({
				key: "gitlab-official",
				displayName: "GitLab",
				iconKey: "gitlab",
				isConfigured: false,
				isDefault: true,
				transport: null,
				mcpConfigId: null,
			});
		});

		it("logs a console.error so the missing catalog row is observable", async () => {
			await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
				gitlab: NOT_CONNECTED,
			});

			expect(warnSpy).toHaveBeenCalled();
			const messages = warnSpy.mock.calls
				.flat()
				.map((arg: unknown) => (typeof arg === "string" ? arg : ""))
				.join(" ");
			expect(messages).toMatch(/gitlab-official/i);
		});
	});
});
