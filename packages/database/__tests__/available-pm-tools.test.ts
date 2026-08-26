/**
 * Unit tests for the `listAvailablePmTools` query.
 *
 * Mocks at the Prisma client boundary; covers default-stub emission,
 * tenant-config dedupe by key, XOR tenant isolation, display-name and
 * icon-key overrides, and the "no frontend changes to add a tool"
 * extensibility guarantee.
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

import { listAvailablePmTools } from "../prisma/queries/mcp";

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
		});
		const jira = result.find((o) => o.key === "atlassian");
		expect(jira?.displayName).toBe("Jira");
		expect(jira?.iconKey).toBe("jira");
	});

	it("applies the gitlab-official → GitLab display + icon overrides", async () => {
		const result = await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
		});
		const gitlab = result.find((o) => o.key === "gitlab-official");
		expect(gitlab?.displayName).toBe("GitLab");
		expect(gitlab?.iconKey).toBe("gitlab");
	});

	it("uses XOR tenant filter for personal context (organizationId: null)", async () => {
		await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
		});
		const call = findManyConfig.mock.calls[0]?.[0];
		expect(call.where.userId).toBe("u_1");
		expect(call.where.organizationId).toBeNull();
	});

	it("uses XOR tenant filter for org context", async () => {
		await listAvailablePmTools({
			userId: "u_1",
			organizationId: "org_x",
		});
		const call = findManyConfig.mock.calls[0]?.[0];
		expect(call.where.userId).toBe("u_1");
		expect(call.where.organizationId).toBe("org_x");
	});

	it("filters configs to enabled + PM category/tag", async () => {
		await listAvailablePmTools({
			userId: "u_1",
			organizationId: null,
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
		});

		// Only the defaults survive
		expect(result.map((o) => o.key)).toEqual([
			"fizzy",
			"azure-devops",
			"atlassian",
			"gitlab-official",
		]);
	});

	describe("GitLab REST-mode synthesis", () => {
		it("synthesizes gitlab-official REST entry when WorkflowIntegration exists and no MCPConfig", async () => {
			findManyWorkflowIntegration.mockResolvedValue([
				{ id: "wi_1", provider: "GITLAB", isActive: true },
			]);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toMatchObject({
				key: "gitlab-official",
				isDefault: true,
				isConfigured: true,
				transport: "rest",
				mcpConfigId: null,
				mcpServerId: "srv_gitlab_official",
				configDisplayName: "GitLab (REST)",
			});
			expect(
				result.filter((o) => o.key === "gitlab-official"),
			).toHaveLength(1);
		});

		it("MCPConfig wins over WorkflowIntegration when both present", async () => {
			findManyConfig.mockResolvedValue([
				tenantConfigStub({
					id: "cfg_gitlab",
					displayName: "GitLab Premium",
					mcpServer: {
						id: "srv_gitlab_official",
						key: "gitlab-official",
						name: "GitLab (Official)",
					},
				}),
			]);
			findManyWorkflowIntegration.mockResolvedValue([
				{ id: "wi_1", provider: "GITLAB", isActive: true },
			]);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
			});

			const gitlabRows = result.filter(
				(o) => o.key === "gitlab-official",
			);
			expect(gitlabRows).toHaveLength(1);
			expect(gitlabRows[0]).toMatchObject({
				transport: "mcp",
				isConfigured: true,
				mcpConfigId: "cfg_gitlab",
			});
		});

		it("inactive WorkflowIntegration falls through to Not configured stub", async () => {
			// When isActive=false at the row level, the Prisma filter (provider=GITLAB AND
			// isActive=true) returns no rows, so the synthesis path is skipped.
			findManyWorkflowIntegration.mockResolvedValue([]);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toMatchObject({
				isConfigured: false,
				transport: null,
			});
		});

		it("queries WorkflowIntegration with provider=GITLAB and isActive=true (personal)", async () => {
			await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
			});
			const call = findManyWorkflowIntegration.mock.calls[0]?.[0];
			expect(call.where).toMatchObject({
				provider: "GITLAB",
				isActive: true,
				userId: "u_1",
				organizationId: null,
			});
		});

		it("queries WorkflowIntegration with org XOR tenant filter", async () => {
			await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_x",
			});
			const call = findManyWorkflowIntegration.mock.calls[0]?.[0];
			expect(call.where).toMatchObject({
				provider: "GITLAB",
				isActive: true,
				userId: "u_1",
				organizationId: "org_x",
			});
		});
	});

	describe("personal-scope GitLab fallback in org context", () => {
		it("emits gitlab-official with connectedInPersonalScope=true when user has personal GitLab but org wizard call", async () => {
			// Default: no org-scoped WorkflowIntegration, no MCPConfig. The fallback
			// query for personal-scope GitLab returns one row.
			findManyWorkflowIntegration.mockImplementation(
				(args: { where: { organizationId: string | null } }) => {
					// Org query (org-scoped): returns no rows.
					if (args.where.organizationId === "org_1") {
						return Promise.resolve([]);
					}
					// Personal-fallback query: returns one active personal row.
					if (args.where.organizationId === null) {
						return Promise.resolve([{ id: "wi_personal_gitlab" }]);
					}
					return Promise.resolve([]);
				},
			);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toBeDefined();
			expect(gitlab).toMatchObject({
				key: "gitlab-official",
				isConfigured: false,
				connectedInPersonalScope: true,
				mcpServerId: "srv_gitlab_official",
				mcpConfigId: null,
				transport: null,
			});
		});

		it("emits org-scoped GitLab via REST synthesis when both org and personal GitLab rows exist", async () => {
			findManyWorkflowIntegration.mockImplementation(
				(args: { where: { organizationId: string | null } }) => {
					if (args.where.organizationId === "org_1") {
						return Promise.resolve([{ id: "wi_org_gitlab" }]);
					}
					if (args.where.organizationId === null) {
						return Promise.resolve([{ id: "wi_personal_gitlab" }]);
					}
					return Promise.resolve([]);
				},
			);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toMatchObject({
				key: "gitlab-official",
				isConfigured: true,
				transport: "rest",
				configDisplayName: "GitLab (REST)",
			});
			expect(gitlab?.connectedInPersonalScope).toBeFalsy();
		});

		it("does NOT run the personal-fallback query in personal context (organizationId=null)", async () => {
			findManyWorkflowIntegration.mockResolvedValue([]);

			await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
			});

			// Exactly one workflowIntegration query (the org/null one); no second
			// personal-fallback query when already in personal context.
			expect(findManyWorkflowIntegration).toHaveBeenCalledTimes(1);
		});

		it("emits default gitlab-official stub (no connectedInPersonalScope) when neither org nor personal GitLab exists", async () => {
			findManyWorkflowIntegration.mockResolvedValue([]);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toMatchObject({
				key: "gitlab-official",
				isConfigured: false,
				mcpConfigId: null,
				transport: null,
			});
			expect(gitlab?.connectedInPersonalScope).toBeFalsy();
		});

		it("ignores a personal GitLab whose settings.needsReauth is true", async () => {
			findManyWorkflowIntegration.mockImplementation(
				(args: {
					where: {
						organizationId: string | null;
						settings?: unknown;
					};
				}) => {
					if (args.where.organizationId === "org_1") {
						return Promise.resolve([]);
					}
					// Personal-fallback query MUST filter out needsReauth rows.
					// The query's `where` should include a needsReauth=false guard;
					// we assert it does by returning [] when the guard is present
					// and would not return the reauth-flagged row.
					if (args.where.organizationId === null) {
						// Implementation note: the query filters needsReauth at the
						// Prisma layer. This mock returns [] to simulate the row
						// being filtered. If the implementation post-filters in JS
						// instead, return the row here and let the production code
						// reject it.
						return Promise.resolve([]);
					}
					return Promise.resolve([]);
				},
			);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab?.connectedInPersonalScope).toBeFalsy();

			// Pin the filter shape so a future refactor can't silently drop
			// the OR/path guards that make this NULL-safe.
			expect(findManyWorkflowIntegration).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						organizationId: null,
						userId: "u_1",
						provider: "GITLAB",
						isActive: true,
						OR: expect.arrayContaining([
							expect.objectContaining({
								settings: expect.objectContaining({
									path: ["needsReauth"],
									equals: false,
								}),
							}),
						]),
					}),
				}),
			);
		});
	});

	// Regression: staging hit a case where the `gitlab-official` MCPServer
	// catalog row was missing / not marked `isSystemProvided=true`. The
	// silent `if (gitlabServer)` gates in the REST-synthesis branch and the
	// default-stub loop dropped GitLab from the picker entirely, even when
	// a working WorkflowIntegration existed. The picker must treat the
	// WorkflowIntegration as ground truth for "GitLab is available via
	// REST" — the catalog row is a UI label, not a gate.
	describe("resilience when gitlab-official MCPServer catalog row is missing", () => {
		const SERVERS_WITHOUT_GITLAB = DEFAULT_FIXTURE_SERVERS.filter(
			(s) => s.key !== "gitlab-official",
		);

		let warnSpy: ReturnType<typeof vi.spyOn>;
		beforeEach(() => {
			findManyServer.mockResolvedValue(SERVERS_WITHOUT_GITLAB);
			warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		});

		it("still emits REST-synthesized GitLab when WorkflowIntegration exists (org context)", async () => {
			findManyWorkflowIntegration.mockImplementation(
				(args: { where: { organizationId: string | null } }) => {
					if (args.where.organizationId === "org_1") {
						return Promise.resolve([{ id: "wi_org_gitlab" }]);
					}
					return Promise.resolve([]);
				},
			);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: "org_1",
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

		it("still emits REST-synthesized GitLab when WorkflowIntegration exists (personal context)", async () => {
			findManyWorkflowIntegration.mockResolvedValue([
				{ id: "wi_personal_gitlab" },
			]);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
			});

			const gitlab = result.find((o) => o.key === "gitlab-official");
			expect(gitlab).toMatchObject({
				key: "gitlab-official",
				isConfigured: true,
				transport: "rest",
				configDisplayName: "GitLab (REST)",
			});
		});

		it("still emits the GitLab default stub when no WorkflowIntegration exists", async () => {
			findManyWorkflowIntegration.mockResolvedValue([]);

			const result = await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
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
			findManyWorkflowIntegration.mockResolvedValue([]);

			await listAvailablePmTools({
				userId: "u_1",
				organizationId: null,
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
