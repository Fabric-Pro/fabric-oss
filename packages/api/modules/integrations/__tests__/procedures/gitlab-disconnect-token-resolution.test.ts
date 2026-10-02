/**
 * After `integrations.gitlab.disconnect`, nothing may resolve a GitLab token
 * for that user and organization, and `integrations.gitlab.status` must report
 * the right state on both sides of it.
 *
 * `disconnect` deactivates the WorkflowIntegration connection rows but leaves
 * their credentials in place, and it nulls the MCPConfig token. A reader that
 * falls back to a WorkflowIntegration without requiring `isActive` therefore
 * resolves the deactivated row's OAuth token straight back, which made the
 * disconnect cosmetic: `loadGitLabToken` (used by token refresh, reconcile and
 * recheck) did exactly that.
 *
 * The stores apply the real `where` clauses to real rows, and the token readers
 * under test are the real ones (`loadGitLabToken` here, `getGitLabToken` from
 * `@repo/integrations/gitlab`), run against the same stores the disconnect
 * handler wrote.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, mcp } = await vi.hoisted(async () => {
	const { createWorkflowIntegrationStore } = await import(
		"./workflow-integration-store"
	);

	type McpRow = {
		id: string;
		userId: string;
		organizationId: string | null;
		serverKey: string;
		mcpServerId: string;
		enabled: boolean;
		displayName: string;
		scopes: string[];
		baseUrl: string | null;
		encryptedAccessToken: string | null;
		encryptedRefreshToken: string | null;
		accessTokenHash: string | null;
		tokenExpiresAt: Date | null;
		needsReauth: boolean;
		oauthClientId: string | null;
		encryptedOauthClientSecret: string | null;
		dcrRegisteredAt: Date | null;
	};
	type Where = Record<string, unknown> & { mcpServer?: { key: string } };
	const rows: McpRow[] = [];
	// Applies the equality, `{ not: null }`, `{ in: [...] }` and
	// `mcpServer.key` operators the readers under test use. Anything else
	// throws, so an unmodelled clause fails the suite instead of matching.
	const matches = (row: McpRow, where: Where) =>
		Object.entries(where).every(([key, condition]) => {
			if (key === "mcpServer") {
				const k = (condition as { key: unknown }).key;
				if (typeof k === "string") {
					return row.serverKey === k;
				}
				return (k as { in: string[] }).in.includes(row.serverKey);
			}
			const value = row[key as keyof McpRow];
			if (condition === null || typeof condition !== "object") {
				return value === condition;
			}
			const ops = Object.keys(condition);
			if (ops.length === 1 && ops[0] === "not") {
				return value !== (condition as { not: unknown }).not;
			}
			throw new Error(`unsupported mcp filter on ${key}`);
		});
	const present = (row: McpRow) => ({
		...row,
		mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
	});

	return {
		store: createWorkflowIntegrationStore(),
		mcp: {
			rows,
			delegate: {
				findFirst: async ({ where }: { where: Where }) => {
					const found = rows.find((row) => matches(row, where));
					return found ? present(found) : null;
				},
				update: async ({
					where,
					data,
				}: {
					where: { id: string };
					data: Partial<McpRow>;
				}) => {
					const row = rows.find((r) => r.id === where.id);
					if (!row) {
						throw new Error(`mcp update: ${where.id} missing`);
					}
					Object.assign(row, data);
					return present(row);
				},
				updateMany: async ({
					where,
					data,
				}: {
					where: Where;
					data: Partial<McpRow>;
				}) => {
					const hit = rows.filter((row) => matches(row, where));
					for (const row of hit) {
						Object.assign(row, data);
					}
					return { count: hit.length };
				},
			},
		},
	};
});

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: store.delegate,
		dataConnection: { updateMany: vi.fn() },
		mCPConfig: mcp.delegate,
	},
	createDataConnection: vi.fn(),
	getDataConnectionByProvider: vi.fn(),
	updateDataConnection: vi.fn(),
	getOrganizationMembership: vi.fn(),
	getProjectMemberRole: vi.fn(),
	createProjectRepoIntegration: vi.fn(),
	logRepoIntegrationActivity: vi.fn(),
	syncLegacyProjectRepoOnConnect: vi.fn(),
}));

// The refresh lock only serialises concurrent refreshes; run the body.
vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: async (_key: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@repo/connectors", () => ({
	integrationStatusForRepoAccess: vi.fn(),
	resolveDefaultBranch: vi.fn(),
	verifyRepositoryAccess: vi.fn(),
}));

vi.mock("@repo/integrations", () => ({ getGitHubToken: vi.fn() }));

vi.mock("@repo/permissions", () => ({
	hasPermission: vi.fn().mockReturnValue(true),
	Permissions: {},
	resolveOrgPermissions: vi.fn().mockReturnValue([]),
	resolveProjectPermissions: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
	triggerOAuthServerIngestion: vi.fn(),
	triggerOAuthToolIngestion: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	hashApiKey: (v: string) => `hash_${v}`,
	decryptApiKey: (v: string) => {
		if (!v.startsWith("enc_")) {
			throw new Error("unsupported state or unable to authenticate data");
		}
		return v.slice("enc_".length);
	},
}));

vi.mock("../../../../lib/project-permissions", () => ({
	userHasProjectPermission: vi.fn(),
}));
vi.mock("../../../../lib/redis-client", () => ({ getRedisClient: () => null }));
vi.mock("../../../../lib/mcp-registry-cache", () => ({
	invalidateSystemServersCache: vi.fn(),
}));
vi.mock("../../../projects/lib/code-indexing-trigger", () => ({
	startCodeIndexingForProject: vi.fn(),
}));
vi.mock("../../lib/enable-gitlab-pm-for-project", () => ({
	enableGitLabPMForProject: vi.fn(),
}));
vi.mock("../../lib/gitlab-oauth", () => ({
	exchangeCodeForToken: vi.fn(),
	generatePkce: vi.fn(),
	getGitLabOAuthUrl: vi.fn(),
	getGitLabUser: vi.fn(),
	listGitLabBranches: vi.fn(),
	listGitLabProjects: vi.fn(),
	recordToolIngestError: vi.fn(),
	refreshGitLabToken: vi.fn(),
	resolveOrgIdForQuery: vi.fn(),
}));
vi.mock("../../lib/gitlab-recheck", () => ({
	recheckGitlabCapabilities: vi.fn(),
	GitLabIntegrationNotConnectedError: class extends Error {},
}));
vi.mock("../../lib/oauth-providers", () => ({
	exchangeCodeForTokens: vi.fn(),
	generateAuthorizationUrl: vi.fn(),
	getOAuthCredentials: vi.fn(),
	getOAuthCredentialsWithDb: async () => ({
		clientId: "gl-client-id",
		clientSecret: "gl-client-secret",
	}),
	getOAuthProvider: (type: string) => ({ type, name: type }),
	mapOAuthToWorkflowProvider: (type: string) => type,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	});
	return {
		tenantProtectedProcedure: chain,
		protectedProcedure: chain,
		publicProcedure: chain,
		requirePermission: () => ({}),
		requireInputOrgPermission: () => ({}),
		requireOrganizationMembership: vi.fn(),
		resolveOrganizationId: vi.fn(),
		resolveOrganizationIdForCaller: vi.fn(),
		Permissions: {
			INTEGRATION_USE: "integration:use",
			INTEGRATION_READ: "integration:read",
			INTEGRATION_CONNECT: "integration:connect",
			INTEGRATION_DISCONNECT: "integration:disconnect",
			PROJECT_SETTINGS_EDIT: "project:settings:edit",
		},
	};
});

import {
	getGitLabAccessToken,
	getGitLabToken,
	resolveGitLabSource,
} from "@repo/integrations/gitlab";
import { loadGitLabToken } from "../../lib/gitlab-token";
import { gitlabOAuthProcedures } from "../../procedures/gitlab-oauth";

type Handler<I, O> = {
	handler: (args: {
		input: I;
		context: {
			user: { id: string };
			session: { id: string; activeOrganizationId: string | null };
		};
	}) => Promise<O>;
};

const USER = "user-1";
const ORG = "example-org";

const ctx = (organizationId: string | null) => ({
	user: { id: USER },
	session: { id: "session-1", activeOrganizationId: organizationId },
});

const disconnect = (organizationId: string | null) =>
	(
		gitlabOAuthProcedures.disconnect as unknown as Handler<
			{ organizationId: string | null },
			{ success: boolean }
		>
	).handler({ input: { organizationId }, context: ctx(organizationId) });

const status = (organizationId: string | null) =>
	(
		gitlabOAuthProcedures.status as unknown as Handler<
			{ organizationId: string | null },
			{
				connected: boolean;
				partialConnection?: boolean;
				needsReauth?: boolean;
			}
		>
	).handler({ input: { organizationId }, context: ctx(organizationId) });

function seedWorkflowIntegration(
	organizationId: string | null,
	name = "GitLab: example-user",
) {
	store.rows.push({
		id: "gl-wi",
		userId: USER,
		organizationId,
		provider: "GITLAB",
		name,
		isActive: true,
		credentials: `enc_${JSON.stringify({
			access_token: "wi-token",
			refresh_token: "wi-refresh",
		})}`,
		settings: {},
	});
}

function seedMcpConfig(
	organizationId: string | null,
	overrides: Partial<(typeof mcp.rows)[number]> = {},
) {
	const serverKey = overrides.serverKey ?? "gitlab";
	mcp.rows.push({
		id: `${serverKey}-${overrides.userId ?? USER}-${organizationId ?? "personal"}`,
		userId: USER,
		organizationId,
		serverKey,
		mcpServerId: `srv-${serverKey}`,
		enabled: true,
		displayName: "GitLab",
		scopes: ["api"],
		baseUrl: null,
		encryptedAccessToken: "enc_mcp-token",
		encryptedRefreshToken: "enc_mcp-refresh",
		accessTokenHash: "hash_mcp-token",
		tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
		needsReauth: false,
		oauthClientId: null,
		encryptedOauthClientSecret: null,
		dcrRegisteredAt: null,
		...overrides,
	});
}

/** The `gitlab-official` config, with the DCR registration a reconnect reuses. */
function seedOfficialConfig(
	organizationId: string | null,
	overrides: Partial<(typeof mcp.rows)[number]> = {},
) {
	seedMcpConfig(organizationId, {
		serverKey: "gitlab-official",
		displayName: "GitLab (Official)",
		oauthClientId: "dcr-client-id",
		encryptedOauthClientSecret: "enc_dcr-client-secret",
		dcrRegisteredAt: new Date("2026-01-01T00:00:00Z"),
		accessTokenHash: "hash_official-token",
		encryptedAccessToken: "enc_official-token",
		encryptedRefreshToken: "enc_official-refresh",
		...overrides,
	});
}

const officialRow = (organizationId: string | null, userId = USER) => {
	const row = mcp.rows.find(
		(r) =>
			r.serverKey === "gitlab-official" &&
			r.userId === userId &&
			r.organizationId === organizationId,
	);
	if (!row) {
		throw new Error("official config missing");
	}
	return row;
};

/** Every reader of "the GitLab token for this tenant" that this repo has. */
async function resolveToken(organizationId: string | null) {
	return {
		loadGitLabToken: await loadGitLabToken(
			{
				mCPConfig: { findFirst: mcp.delegate.findFirst as never },
				workflowIntegration: { findFirst: store.delegate.findFirst },
			},
			{ userId: USER, organizationId },
		),
		integrationsGetter: await getGitLabToken({
			userId: USER,
			organizationId: organizationId ?? undefined,
		}),
	};
}

beforeEach(() => {
	store.reset();
	mcp.rows.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
	);
});

describe.each([
	{ scope: "organization", organizationId: ORG },
	{ scope: "personal", organizationId: null },
])(
	"GitLab token resolution around disconnect ($scope)",
	({ organizationId }) => {
		it("resolves the token from both stores before disconnect (the test can see a live token)", async () => {
			seedWorkflowIntegration(organizationId);
			seedMcpConfig(organizationId);

			const before = await resolveToken(organizationId);

			expect(before.loadGitLabToken).toMatchObject({
				source: "mcp",
				accessToken: "mcp-token",
			});
			expect(before.integrationsGetter).toBe("wi-token");
		});

		it("resolves no token after disconnect when both stores held one", async () => {
			seedWorkflowIntegration(organizationId);
			seedMcpConfig(organizationId);

			await disconnect(organizationId);

			expect(await resolveToken(organizationId)).toEqual({
				loadGitLabToken: null,
				integrationsGetter: null,
			});
		});

		it("resolves no token after disconnect when only the WorkflowIntegration held one", async () => {
			seedWorkflowIntegration(organizationId);

			await disconnect(organizationId);

			expect(await resolveToken(organizationId)).toEqual({
				loadGitLabToken: null,
				integrationsGetter: null,
			});
		});

		it("resolves no token after disconnect when only the MCPConfig held one", async () => {
			seedMcpConfig(organizationId);

			await disconnect(organizationId);

			expect(await resolveToken(organizationId)).toEqual({
				loadGitLabToken: null,
				integrationsGetter: null,
			});
		});

		it("does not treat the stored OAuth app credentials as a token", async () => {
			store.rows.push({
				id: "gl-app",
				userId: USER,
				organizationId,
				provider: "GITLAB",
				name: "GITLAB_OAUTH_APP",
				isActive: true,
				credentials: `enc_${JSON.stringify({ client_id: "c", client_secret: "s" })}`,
			});

			expect(await resolveToken(organizationId)).toEqual({
				loadGitLabToken: null,
				integrationsGetter: null,
			});
		});
	},
);

describe("integrations.gitlab.status", () => {
	it("keeps `connected` false for a token that exists only on the MCPConfig (no WorkflowIntegration row), and reports it as a partial connection", async () => {
		// Made through the MCP registry; `reconcile` has not backfilled the
		// WorkflowIntegration yet. The token is live, so the settings page needs
		// to offer Disconnect, but `connected` keeps its meaning for every other
		// screen: repository browsing and PM sync need the WorkflowIntegration,
		// so reporting `connected` here made them offer actions that then fail
		// with "GitLab not connected".
		seedMcpConfig(ORG);

		await expect(status(ORG)).resolves.toEqual({
			connected: false,
			partialConnection: true,
		});
	});

	it("reports a lone official GitLab MCP connection as partial too", async () => {
		seedOfficialConfig(ORG);

		await expect(status(ORG)).resolves.toEqual({
			connected: false,
			partialConnection: true,
		});
	});

	it("flags an MCP-only connection that needs re-authorisation", async () => {
		seedMcpConfig(ORG);
		mcp.rows[0].needsReauth = true;

		await expect(status(ORG)).resolves.toEqual({
			connected: false,
			partialConnection: true,
			needsReauth: true,
		});
	});

	it("reports neither connected nor partial for an MCPConfig whose token was cleared by disconnect", async () => {
		seedMcpConfig(ORG);
		await disconnect(ORG);

		await expect(status(ORG)).resolves.toEqual({ connected: false });
	});

	it("reports connected, and no partial flag, with an active WorkflowIntegration; neither after disconnect", async () => {
		seedWorkflowIntegration(ORG);
		seedMcpConfig(ORG);
		const before = await status(ORG);
		expect(before.connected).toBe(true);
		expect(before).not.toHaveProperty("partialConnection");

		await disconnect(ORG);

		await expect(status(ORG)).resolves.toEqual({ connected: false });
	});

	it("does not leak another user's or organization's MCPConfig", async () => {
		seedMcpConfig("other-org");
		seedMcpConfig(ORG, { userId: "user-2" });

		await expect(status(ORG)).resolves.toEqual({ connected: false });
	});
});

describe("integrations.gitlab.disconnect and the gitlab-official MCP config", () => {
	const DCR_FIELDS = [
		"oauthClientId",
		"encryptedOauthClientSecret",
		"dcrRegisteredAt",
	] as const;

	/** What a caller of `resolveGitLabSource` gets for this tenant. */
	const resolveSource = (organizationId: string | null) =>
		resolveGitLabSource({
			userId: USER,
			organizationId,
			db: {
				mCPConfig: { findFirst: mcp.delegate.findFirst },
				workflowIntegration: { findFirst: store.delegate.findFirst },
			} as never,
			decrypt: (v: string) => v.slice("enc_".length),
			refresh: async () => {
				throw new Error("refresh must not run");
			},
			getRestToken: async ({ userId, organizationId: o }) =>
				(await getGitLabAccessToken(userId, o ?? undefined)) ?? null,
			markRefreshFailure: async () => {},
		});

	it.each([
		{ scope: "organization", organizationId: ORG as string | null },
		{ scope: "personal", organizationId: null as string | null },
	])(
		"clears the official config's token and marks it needsReauth ($scope), keeping the row and its DCR registration",
		async ({ organizationId }) => {
			seedWorkflowIntegration(organizationId);
			seedMcpConfig(organizationId);
			seedOfficialConfig(organizationId);
			const before = { ...officialRow(organizationId) };

			await disconnect(organizationId);

			const after = officialRow(organizationId);
			expect(after).toMatchObject({
				encryptedAccessToken: null,
				accessTokenHash: null,
				encryptedRefreshToken: null,
				tokenExpiresAt: null,
				needsReauth: true,
			});
			// Kept so a reconnect updates in place and reuses the registration.
			expect(after.id).toBe(before.id);
			expect(after.enabled).toBe(true);
			expect(after.displayName).toBe("GitLab (Official)");
			expect(after.scopes).toEqual(["api"]);
			for (const field of DCR_FIELDS) {
				expect(after[field]).toEqual(before[field]);
				expect(after[field]).not.toBeNull();
			}
		},
	);

	it("clears an official config that exists without any `gitlab` row or WorkflowIntegration (connected only from the MCP Servers page)", async () => {
		seedOfficialConfig(ORG);

		await disconnect(ORG);

		expect(officialRow(ORG)).toMatchObject({
			encryptedAccessToken: null,
			needsReauth: true,
		});
	});

	it("leaves another user's and another organization's official config untouched", async () => {
		seedWorkflowIntegration(ORG);
		seedOfficialConfig(ORG);
		seedOfficialConfig(ORG, { userId: "user-2" });
		seedOfficialConfig("other-org");
		seedOfficialConfig(null);
		const untouched = [
			{ ...officialRow(ORG, "user-2") },
			{ ...officialRow("other-org") },
			{ ...officialRow(null) },
		];

		await disconnect(ORG);

		expect(officialRow(ORG).encryptedAccessToken).toBeNull();
		expect(officialRow(ORG, "user-2")).toEqual(untouched[0]);
		expect(officialRow("other-org")).toEqual(untouched[1]);
		expect(officialRow(null)).toEqual(untouched[2]);
	});

	it("stops resolveGitLabSource routing through the official MCP server", async () => {
		seedWorkflowIntegration(ORG);
		seedMcpConfig(ORG);
		seedOfficialConfig(ORG);

		await expect(resolveSource(ORG)).resolves.toMatchObject({
			kind: "official-mcp",
		});

		await disconnect(ORG);

		// No official MCP, and no REST token either: nothing is usable.
		await expect(resolveSource(ORG)).resolves.toBeNull();
	});

	it("stops resolveGitLabSource when only the official config existed", async () => {
		seedOfficialConfig(ORG);
		await expect(resolveSource(ORG)).resolves.toMatchObject({
			kind: "official-mcp",
		});

		await disconnect(ORG);

		await expect(resolveSource(ORG)).resolves.toBeNull();
	});

	it("a fresh grant repopulates and un-breakers the official config the disconnect cleared", async () => {
		const { syncGitlabOfficialMcpConfig } = await import(
			"../../lib/sync-gitlab-official-mcp"
		);
		seedOfficialConfig(ORG);
		await disconnect(ORG);
		const row = officialRow(ORG);
		expect(row.needsReauth).toBe(true);

		// What `persistGitLabToken` does for a reconnect on a capable server.
		const tx = {
			mCPServer: {
				findFirst: async () => ({ id: "srv-gitlab-official" }),
			},
			mCPConfig: {
				findFirst: mcp.delegate.findFirst,
				update: mcp.delegate.update,
				create: async () => {
					throw new Error("must update the kept row in place");
				},
				delete: async () => {
					throw new Error("must not delete");
				},
			},
		};
		const result = await syncGitlabOfficialMcpConfig(tx as never, {
			userId: USER,
			organizationId: ORG,
			capable: true,
			resetBreaker: true,
			tokenBundle: {
				encryptedAccessToken: "enc_new-token",
				accessTokenHash: "hash_new-token",
				encryptedRefreshToken: "enc_new-refresh",
				tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
			},
		});

		expect(result).toEqual({ ok: true, action: "updated" });
		expect(officialRow(ORG)).toMatchObject({
			id: row.id,
			encryptedAccessToken: "enc_new-token",
			needsReauth: false,
			oauthClientId: "dcr-client-id",
			encryptedOauthClientSecret: "enc_dcr-client-secret",
		});
	});
});
