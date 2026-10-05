/**
 * Unit tests for `resolvePmSource` and `PMSourceNotFound`.
 *
 * The helper is called per-activity (not at workflow level) to rehydrate
 * a discriminated PM source descriptor from primitive workflow args.
 * Tokens never cross the Temporal serialization boundary — they live only
 * inside the activity that resolved them.
 *
 * The GitLab REST path runs against the REAL GitLab connection service and
 * an in-memory database that applies `where` clauses (the integrations
 * package's GitLab fake); only GitLab's token endpoint is a double. That is
 * what makes the production case observable: a connection issued by the
 * `gitlab-official` dynamic client registration resolves from its connection
 * row, while a legacy MCP token copy with no row behind it is not a
 * connection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db").createGitLabFakeDb
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
		"../../../../integrations/__tests__/gitlab/helpers/gitlab-fake-db"
	);
	return {
		...(await importOriginal<object>()),
		encryptApiKey: helpers.fakeEncrypt,
		decryptApiKey: helpers.fakeDecrypt,
	};
});

import { resolvePMConfigForUser } from "@repo/database";
import { resetGitLabConnectionDepsForTests } from "@repo/integrations/gitlab";
import {
	PMSourceNotFound,
	resolvePmServerKey,
	resolvePmSource,
} from "../pm-source";

const HOUR = 3_600_000;
const officialServer = {
	id: "srv-official",
	key: "gitlab-official",
	defaultUrl: "https://gitlab.com/api/v4/mcp",
};
const fizzyServer = { id: "srv-fz", key: "fizzy", defaultUrl: null };
const appIssuer = {
	kind: "app",
	clientId: "app-client",
	origin: "https://gitlab.com",
};

function personalRow(
	id: string,
	userId: string,
	organizationId: string | null,
	credential: Record<string, unknown>,
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
		credentials: encryptedCredential(credential),
		settings: {},
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		...extra,
	};
}

/** A live app-issued credential (not due for refresh). */
function liveCredential(token: string) {
	return {
		access_token: token,
		refresh_token: `${token}-refresh`,
		expires_in: 7200,
		token_obtained_at: new Date().toISOString(),
		issuer: appIssuer,
		connectionGeneration: 1,
	};
}

/** A credential whose access token expired an hour ago. */
function expiredCredential(extra: Record<string, unknown> = {}) {
	return {
		access_token: "dead-access",
		refresh_token: "dead-refresh",
		expires_in: 7200,
		token_obtained_at: new Date(Date.now() - 3 * HOUR).toISOString(),
		issuer: appIssuer,
		connectionGeneration: 1,
		...extra,
	};
}

/** A legacy DCR `gitlab-official` MCP config still holding a token copy. */
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
		tokenExpiresAt: new Date(Date.now() + HOUR),
		needsReauth: false,
		enabled: true,
		authType: "OAUTH2",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	};
}

function seed(tables: Parameters<typeof createGitLabFakeDb>[0] = {}) {
	state.fake = createGitLabFakeDb({
		mCPServer: [officialServer, fizzyServer],
		...tables,
	});
}

const fetchMock = vi.fn();
const tokenCalls = () =>
	fetchMock.mock.calls.filter(([url]) =>
		String(url).endsWith("/oauth/token"),
	);
const answerTokenEndpoint = (status: number, body: unknown) =>
	fetchMock.mockImplementation(async (url: string) =>
		String(url).endsWith("/oauth/token")
			? new Response(JSON.stringify(body), { status })
			: new Response("unexpected", { status: 599 }),
	);

const restArgs = {
	mcpServerId: "srv-official",
	mcpConfigId: null,
	userId: "user-2",
	organizationId: "org-example",
	containerId: "100",
	// A selection recorded before origins were: it lives on gitlab.com.
	additionalContext: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "app-secret");
	resetGitLabConnectionDepsForTests();
	seed();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("resolvePmSource — MCP path", () => {
	it("returns kind=mcp when configId resolves to an enabled config", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg1",
			enabled: true,
		} as never);

		const source = await resolvePmSource({
			...restArgs,
			mcpServerId: "srv-x",
			mcpConfigId: "cfg1",
		});

		expect(source).toMatchObject({ kind: "mcp" });
	});

	it("refuses the caller's own GitLab MCP config when it is on another instance than the container", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg-own",
			enabled: true,
			baseUrl: "https://gitlab.example.com/api/v4/mcp",
			mcpServer: officialServer,
		} as never);

		await expect(
			resolvePmSource({ ...restArgs, mcpConfigId: "cfg-pinned" }),
		).rejects.toMatchObject({ reason: "origin-mismatch" });
	});

	it("accepts a GitLab MCP config on the container's recorded instance", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg-own",
			enabled: true,
			baseUrl: "https://gitlab.example.com/api/v4/mcp",
			mcpServer: officialServer,
		} as never);

		expect(
			await resolvePmSource({
				...restArgs,
				mcpConfigId: "cfg-pinned",
				additionalContext: {
					gitlabOrigin: "https://gitlab.example.com",
				},
			}),
		).toMatchObject({ kind: "mcp" });
	});

	it("throws no-config when configId resolves to a disabled config", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg1",
			enabled: false,
		} as never);

		await expect(
			resolvePmSource({ ...restArgs, mcpConfigId: "cfg1" }),
		).rejects.toMatchObject({ reason: "no-config" });
	});

	it("throws no-config when configId does not resolve", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);

		await expect(
			resolvePmSource({ ...restArgs, mcpConfigId: "cfg-missing" }),
		).rejects.toMatchObject({ reason: "no-config" });
	});

	it("throws no-config when configId is null and the server is not gitlab-official", async () => {
		await expect(
			resolvePmSource({ ...restArgs, mcpServerId: "srv-fz" }),
		).rejects.toMatchObject({ reason: "no-config" });
	});
});

describe("resolvePmSource — GitLab REST path", () => {
	it("resolves the person's connection issued by the gitlab-official DCR client (production)", async () => {
		// After migration 20261004120000 the MCP config keeps only its client
		// registration; the credential lives on the connection row.
		seed({
			mCPConfig: [
				{
					...officialCopy("user-2", "org-example"),
					encryptedAccessToken: null,
					encryptedRefreshToken: null,
					tokenExpiresAt: null,
				},
			],
			workflowIntegration: [
				personalRow("wi-2", "user-2", "org-example", {
					...liveCredential("dcr-access"),
					issuer: {
						kind: "mcp-dcr",
						mcpConfigId: "cfg-official-user-2",
						serverKey: "gitlab-official",
						clientId: "dcr-client",
						origin: "https://gitlab.com",
					},
				}),
			],
		});

		for (const requireFreshToken of [false, true]) {
			expect(
				await resolvePmSource({ ...restArgs, requireFreshToken }),
			).toMatchObject({
				kind: "rest-gitlab",
				token: "dcr-access",
				projectId: "100",
			});
		}
		expect(tokenCalls()).toHaveLength(0);
	});

	it("a legacy gitlab-official MCP token copy alone is not a connection, and nothing adopts it", async () => {
		seed({ mCPConfig: [officialCopy("user-2", "org-example")] });

		for (const requireFreshToken of [false, true]) {
			await expect(
				resolvePmSource({ ...restArgs, requireFreshToken }),
			).rejects.toMatchObject({ reason: "no-integration" });
		}
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
		expect(tokenCalls()).toHaveLength(0);
	});

	it("returns the caller's token for the key:gitlab-official sentinel without touching the catalog", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-2",
					"user-2",
					"org-example",
					liveCredential("TOK"),
				),
			],
		});
		const catalog = vi.spyOn(state.fake.db.mCPServer, "findUnique");

		const source = await resolvePmSource({
			...restArgs,
			mcpServerId: "key:gitlab-official",
		});

		expect(catalog).not.toHaveBeenCalled();
		expect(source).toMatchObject({ kind: "rest-gitlab", token: "TOK" });
	});

	it("points the REST source at gitlab.com for a gitlab.com credential", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-2",
					"user-2",
					"org-example",
					liveCredential("TOK"),
				),
			],
		});

		expect(await resolvePmSource(restArgs)).toMatchObject({
			kind: "rest-gitlab",
			token: "TOK",
			baseUrl: "https://gitlab.com/api/v4",
		});
	});

	function selfHostedConnection() {
		seed({
			workflowIntegration: [
				personalRow("wi-2", "user-2", "org-example", {
					...liveCredential("INSTANCE-TOK"),
					issuer: {
						kind: "app",
						clientId: "app-client",
						origin: "https://gitlab.example.com",
					},
				}),
			],
		});
	}

	it("points the REST source at the instance that issued a self-hosted credential", async () => {
		selfHostedConnection();

		expect(
			await resolvePmSource({
				...restArgs,
				additionalContext: {
					gitlabOrigin: "https://gitlab.example.com",
				},
			}),
		).toMatchObject({
			kind: "rest-gitlab",
			token: "INSTANCE-TOK",
			baseUrl: "https://gitlab.example.com/api/v4",
		});
	});

	it("refuses a self-hosted connection for a container chosen on gitlab.com (no recorded origin)", async () => {
		selfHostedConnection();

		await expect(resolvePmSource(restArgs)).rejects.toMatchObject({
			reason: "origin-mismatch",
		});
		// Nothing was sent anywhere with the token.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses a gitlab.com connection for a container recorded on a self-hosted instance", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-2",
					"user-2",
					"org-example",
					liveCredential("TOK"),
				),
			],
		});

		await expect(
			resolvePmSource({
				...restArgs,
				additionalContext: {
					gitlabOrigin: "https://gitlab.example.com",
				},
			}),
		).rejects.toMatchObject({ reason: "origin-mismatch" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses a recorded origin that is not an allowed GitLab address", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-2",
					"user-2",
					"org-example",
					liveCredential("TOK"),
				),
			],
		});

		await expect(
			resolvePmSource({
				...restArgs,
				additionalContext: { gitlabOrigin: "http://gitlab.com" },
			}),
		).rejects.toMatchObject({ reason: "origin-mismatch" });
	});

	it("throws no-integration when the caller has no GitLab connection", async () => {
		await expect(resolvePmSource(restArgs)).rejects.toMatchObject({
			reason: "no-integration",
		});
	});

	// --- Connection owner ---------------------------------------------------
	// A GitLab connection is personal. In org context the REST path acts
	// through the CALLER's own connection and never a teammate's, so a member
	// who never connected (or disconnected) cannot read or write tickets
	// through someone else's account.

	it("org context: never borrows a teammate's GitLab connection (or MCP copy) when the caller has none", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-1",
					"user-1",
					"org-example",
					liveCredential("TEAMMATE"),
				),
			],
			mCPConfig: [officialCopy("user-1", "org-example")],
		});

		await expect(resolvePmSource(restArgs)).rejects.toMatchObject({
			reason: "no-integration",
		});
		expect(
			state.fake.tables.workflowIntegration.map((row) => row.userId),
		).toEqual(["user-1"]);
	});

	it("org context: uses the caller's own GitLab connection, not a teammate's", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-1",
					"user-1",
					"org-example",
					liveCredential("TEAMMATE"),
				),
				personalRow(
					"wi-2",
					"user-2",
					"org-example",
					liveCredential("CALLER"),
				),
			],
		});

		expect(await resolvePmSource(restArgs)).toMatchObject({
			kind: "rest-gitlab",
			token: "CALLER",
		});
	});

	it("the hourly poll (requireFreshToken) acts as the project owner, never a teammate", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-1",
					"user-1",
					"org-example",
					liveCredential("TEAMMATE"),
				),
			],
		});

		await expect(
			resolvePmSource({ ...restArgs, requireFreshToken: true }),
		).rejects.toMatchObject({ reason: "no-integration" });
	});

	it("keeps the tenant filter exclusive: a personal-context connection does not serve an org context", async () => {
		seed({
			workflowIntegration: [
				personalRow("wi-p", "user-2", null, liveCredential("PERSONAL")),
			],
		});

		await expect(resolvePmSource(restArgs)).rejects.toMatchObject({
			reason: "no-integration",
		});
		expect(
			await resolvePmSource({ ...restArgs, organizationId: null }),
		).toMatchObject({ token: "PERSONAL" });
	});

	// --- Connection state ---------------------------------------------------

	it("treats a reconnect-required connection as not connected", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-2",
					"user-2",
					"org-example",
					liveCredential("TOK"),
					{
						settings: {
							needsReauth: true,
							reauthReason: "invalid_grant",
						},
					},
				),
			],
		});

		await expect(resolvePmSource(restArgs)).rejects.toMatchObject({
			reason: "no-integration",
		});
		await expect(
			resolvePmSource({ ...restArgs, requireFreshToken: true }),
		).rejects.toMatchObject({ reason: "no-integration" });
		expect(tokenCalls()).toHaveLength(0);
	});

	it("treats a grant GitLab rejects during the poll's refresh as not connected", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-2",
					"user-2",
					"org-example",
					expiredCredential(),
				),
			],
		});
		answerTokenEndpoint(400, { error: "invalid_grant" });

		await expect(
			resolvePmSource({ ...restArgs, requireFreshToken: true }),
		).rejects.toMatchObject({ reason: "no-integration" });
	});

	it("reports token-failed WITH the fixed reason when the issuing client is unavailable", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-2",
					"user-2",
					"org-example",
					expiredCredential({
						issuer: { ...appIssuer, clientId: "replaced-client" },
					}),
				),
			],
		});

		const err = await resolvePmSource({
			...restArgs,
			requireFreshToken: true,
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(PMSourceNotFound);
		expect(err).toMatchObject({
			reason: "token-failed",
			detail: "the OAuth client that issued the GitLab token is not available",
		});
		expect(tokenCalls()).toHaveLength(0);
	});

	it("reports token-failed WITH the fixed reason when the poll's refresh fails transiently", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-2",
					"user-2",
					"org-example",
					expiredCredential(),
				),
			],
		});
		answerTokenEndpoint(503, { message: "unavailable" });

		await expect(
			resolvePmSource({ ...restArgs, requireFreshToken: true }),
		).rejects.toMatchObject({
			reason: "token-failed",
			detail: expect.any(String),
		});
	});

	it("without requireFreshToken a transient refresh failure still hands back the current token", async () => {
		seed({
			workflowIntegration: [
				personalRow(
					"wi-2",
					"user-2",
					"org-example",
					expiredCredential(),
				),
			],
		});
		answerTokenEndpoint(503, { message: "unavailable" });

		expect(await resolvePmSource(restArgs)).toMatchObject({
			token: "dead-access",
		});
	});

	it("reports token-failed without detail when the lookup itself throws", async () => {
		vi.spyOn(
			state.fake.db.workflowIntegration,
			"findMany",
		).mockRejectedValue(new Error("db down"));

		await expect(
			resolvePmSource({ ...restArgs, requireFreshToken: true }),
		).rejects.toMatchObject({ reason: "token-failed", detail: undefined });
	});
});

describe("resolvePmServerKey", () => {
	it("reads the sentinel form without a DB lookup", async () => {
		expect(await resolvePmServerKey("key:gitlab-official")).toBe(
			"gitlab-official",
		);
	});

	it("looks up the MCPServer.key by id", async () => {
		expect(await resolvePmServerKey("srv-fz")).toBe("fizzy");
	});

	it("returns null when the server row is missing", async () => {
		expect(await resolvePmServerKey("missing-id")).toBeNull();
	});
});
