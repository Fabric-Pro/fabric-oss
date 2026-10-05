/**
 * Unit tests for `resolvePmTarget`.
 *
 * Returns a discriminated descriptor of how a project's PM tool is configured:
 *   - { kind: "mcp", mcpConfigId, mcpConfig } — usable MCPConfig pinned
 *   - { kind: "rest-gitlab", mcpConfigId: null } — gitlab-official server +
 *     the caller's usable personal GitLab connection (REST fallback path)
 *   - null — nothing resolves
 *
 * The GitLab branch runs against the REAL GitLab connection service and an
 * in-memory database that applies `where` clauses (the integrations
 * package's GitLab fake). A legacy token copy on a `gitlab-official` MCP
 * config with no WorkflowIntegration row behind it is not a connection, and
 * nothing adopts it on read. Mirrors temporal `pm-source`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db").createGitLabFakeDb
	>,
}));

vi.mock("@repo/database", () => ({
	get db() {
		return state.fake.db;
	},
	resolvePMConfigForUser: vi.fn(),
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
}));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (
		keys: string | readonly string[],
		fn: (
			tx: unknown,
			assertBudget: (ms: number) => void,
		) => Promise<unknown>,
	) => state.fake.withLock(keys, fn as never),
}));

vi.mock("@repo/utils", async (importOriginal) => {
	const helpers = await import(
		"../../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db"
	);
	return {
		...(await importOriginal<object>()),
		encryptApiKey: helpers.fakeEncrypt,
		decryptApiKey: helpers.fakeDecrypt,
	};
});

import { resolvePMConfigForUser } from "@repo/database";
import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";
import { resolvePmTarget } from "../resolve-pm-target";

const officialServer = {
	id: "srv-gl",
	key: "gitlab-official",
	defaultUrl: "https://gitlab.com/api/v4/mcp",
};

function personalRow(
	id: string,
	userId: string,
	organizationId: string | null,
	extra: Record<string, unknown> = {},
) {
	return {
		id,
		userId,
		organizationId,
		provider: "GITLAB",
		name: "GitLab: dev",
		workflowId: null,
		isActive: true,
		credentials: encryptedCredential({
			access_token: `${id}-access`,
			refresh_token: `${id}-refresh`,
			expires_in: 7200,
			token_obtained_at: new Date().toISOString(),
			issuer: {
				kind: "app",
				clientId: "app-client",
				origin: "https://gitlab.com",
			},
			connectionGeneration: 1,
		}),
		settings: {},
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		...extra,
	};
}

function officialCopy(userId: string, organizationId: string | null) {
	return {
		id: `cfg-official-${userId}`,
		userId,
		organizationId,
		mcpServerId: officialServer.id,
		baseUrl: null,
		oauthClientId: "dcr-client",
		encryptedOauthClientSecret: null,
		dcrClientMetadata: { token_endpoint_auth_method: "none" },
		encryptedAccessToken: "enc:dcr-access",
		encryptedRefreshToken: "enc:dcr-refresh",
		tokenExpiresAt: new Date(Date.now() + 3_600_000),
		needsReauth: false,
		enabled: true,
		authType: "OAUTH2",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	};
}

function seed(tables: Parameters<typeof createGitLabFakeDb>[0] = {}) {
	state.fake = createGitLabFakeDb({
		mCPServer: [
			officialServer,
			{ id: "srv-fz", key: "fizzy", defaultUrl: null },
		],
		...tables,
	});
}

const gitlabProject = (organizationId: string | null) => ({
	projectManagementMcpServerId: "key:gitlab-official",
	projectManagementMcpConfigId: null,
	organizationId,
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", vi.fn());
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	resetGitLabConnectionDepsForTests();
	seed();
});

describe("resolvePmTarget — MCP path", () => {
	it("returns kind=mcp when mcpConfigId resolves to an enabled config", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg1",
			enabled: true,
		} as never);

		const result = await resolvePmTarget({
			project: {
				projectManagementMcpServerId: "srv-x",
				projectManagementMcpConfigId: "cfg1",
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		});

		expect(result).toMatchObject({ kind: "mcp", mcpConfigId: "cfg1" });
	});

	it("returns null when mcpConfigId resolves to a disabled or missing config", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValueOnce({
			id: "cfg1",
			enabled: false,
		} as never);
		vi.mocked(resolvePMConfigForUser).mockResolvedValueOnce(null);
		const args = {
			project: {
				projectManagementMcpServerId: "srv-x",
				projectManagementMcpConfigId: "cfg1",
				organizationId: null,
			},
			userId: "u1",
			organizationId: null,
		};

		expect(await resolvePmTarget(args)).toBeNull();
		expect(await resolvePmTarget(args)).toBeNull();
	});

	it("returns null when the server is not gitlab-official, or there is no server", async () => {
		seed({ workflowIntegration: [personalRow("wi-1", "u1", null)] });

		expect(
			await resolvePmTarget({
				project: {
					projectManagementMcpServerId: "srv-fz",
					projectManagementMcpConfigId: null,
					organizationId: null,
				},
				userId: "u1",
				organizationId: null,
			}),
		).toBeNull();
		expect(
			await resolvePmTarget({
				project: {
					projectManagementMcpServerId: null,
					projectManagementMcpConfigId: null,
					organizationId: null,
				},
				userId: "u1",
				organizationId: null,
			}),
		).toBeNull();
	});
});

describe("resolvePmTarget — GitLab REST path", () => {
	it("does not resolve a legacy gitlab-official MCP token copy with no connection behind it", async () => {
		seed({ mCPConfig: [officialCopy("user-2", "org-example")] });

		const result = await resolvePmTarget({
			project: gitlabProject("org-example"),
			userId: "user-2",
			organizationId: "org-example",
		});

		expect(result).toBeNull();
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
	});

	it("resolves through the catalog id as well as the sentinel, without touching the catalog for the sentinel", async () => {
		seed({ workflowIntegration: [personalRow("wi-1", "u1", null)] });
		const catalog = vi.spyOn(state.fake.db.mCPServer, "findUnique");

		expect(
			await resolvePmTarget({
				project: gitlabProject(null),
				userId: "u1",
				organizationId: null,
			}),
		).toEqual({ kind: "rest-gitlab", mcpConfigId: null });
		expect(catalog).not.toHaveBeenCalled();

		expect(
			await resolvePmTarget({
				project: {
					projectManagementMcpServerId: "srv-gl",
					projectManagementMcpConfigId: null,
					organizationId: null,
				},
				userId: "u1",
				organizationId: null,
			}),
		).toEqual({ kind: "rest-gitlab", mcpConfigId: null });
	});

	it("returns null when the caller has no GitLab connection", async () => {
		expect(
			await resolvePmTarget({
				project: gitlabProject(null),
				userId: "u1",
				organizationId: null,
			}),
		).toBeNull();
	});

	it("returns null for a reconnect-required connection", async () => {
		seed({
			workflowIntegration: [
				personalRow("wi-2", "user-2", "org-example", {
					settings: { needsReauth: true },
				}),
			],
		});

		expect(
			await resolvePmTarget({
				project: gitlabProject("org-example"),
				userId: "user-2",
				organizationId: "org-example",
			}),
		).toBeNull();
	});

	// --- Connection owner (mirrors temporal pm-source.ts) -------------------

	it("org context: returns null when only a teammate has GitLab connected (WI or MCP copy)", async () => {
		seed({
			workflowIntegration: [personalRow("wi-1", "user-1", "org-example")],
			mCPConfig: [officialCopy("user-1", "org-example")],
		});

		expect(
			await resolvePmTarget({
				project: gitlabProject("org-example"),
				userId: "user-2",
				organizationId: "org-example",
			}),
		).toBeNull();
	});

	it("org context: resolves from the caller's own connection", async () => {
		seed({
			workflowIntegration: [
				personalRow("wi-1", "user-1", "org-example"),
				personalRow("wi-2", "user-2", "org-example"),
			],
		});

		expect(
			await resolvePmTarget({
				project: gitlabProject("org-example"),
				userId: "user-2",
				organizationId: "org-example",
			}),
		).toEqual({ kind: "rest-gitlab", mcpConfigId: null });
	});

	it("keeps the tenant filter exclusive between personal and org context", async () => {
		seed({ workflowIntegration: [personalRow("wi-p", "u1", null)] });

		expect(
			await resolvePmTarget({
				project: gitlabProject("org-example"),
				userId: "u1",
				organizationId: "org-example",
			}),
		).toBeNull();
		expect(
			await resolvePmTarget({
				project: gitlabProject(null),
				userId: "u1",
				organizationId: null,
			}),
		).toEqual({ kind: "rest-gitlab", mcpConfigId: null });
	});
});

describe("resolvePmTarget — the container's GitLab instance", () => {
	function selfHostedRow() {
		const row = personalRow("wi-1", "u1", null);
		return {
			...row,
			credentials: encryptedCredential({
				access_token: "wi-1-access",
				refresh_token: "wi-1-refresh",
				expires_in: 7200,
				token_obtained_at: new Date().toISOString(),
				issuer: {
					kind: "app",
					clientId: "app-client",
					origin: "https://gitlab.example.com",
				},
				connectionGeneration: 1,
			}),
		};
	}

	it("refuses a self-hosted connection for a container chosen on gitlab.com (none recorded)", async () => {
		seed({ workflowIntegration: [selfHostedRow()] });

		expect(
			await resolvePmTarget({
				project: {
					...gitlabProject(null),
					projectManagementAdditionalContext: null,
				},
				userId: "u1",
				organizationId: null,
			}),
		).toBeNull();
	});

	it("refuses a gitlab.com connection for a container recorded on a self-hosted instance", async () => {
		seed({ workflowIntegration: [personalRow("wi-1", "u1", null)] });

		expect(
			await resolvePmTarget({
				project: {
					...gitlabProject(null),
					projectManagementAdditionalContext: {
						gitlabOrigin: "https://gitlab.example.com",
					},
				},
				userId: "u1",
				organizationId: null,
			}),
		).toBeNull();
	});

	it("resolves a connection on the container's recorded instance", async () => {
		seed({ workflowIntegration: [selfHostedRow()] });

		expect(
			await resolvePmTarget({
				project: {
					...gitlabProject(null),
					projectManagementAdditionalContext: {
						gitlabOrigin: "https://gitlab.example.com",
					},
				},
				userId: "u1",
				organizationId: null,
			}),
		).toEqual({ kind: "rest-gitlab", mcpConfigId: null });
	});

	it("refuses the caller's own GitLab MCP config on another instance than the container", async () => {
		seed();
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg-own",
			enabled: true,
			baseUrl: "https://gitlab.example.com/api/v4/mcp",
			mcpServer: officialServer,
		} as never);

		expect(
			await resolvePmTarget({
				project: {
					projectManagementMcpServerId: officialServer.id,
					projectManagementMcpConfigId: "cfg-pinned",
					projectManagementAdditionalContext: null,
					organizationId: null,
				},
				userId: "u1",
				organizationId: null,
			}),
		).toBeNull();
	});
});
