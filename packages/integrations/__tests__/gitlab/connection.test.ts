/**
 * The GitLab personal connection service, exercised through the entry points
 * every caller uses (`getGitLabAccessToken`, `getFreshGitLabAccessToken`,
 * `executeGitLabTool`) and the service's own lifecycle functions, against an
 * in-memory database that applies `where` clauses the way Prisma does and a
 * real per-key lock (`helpers/gitlab-fake-db`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
	readCredential,
} from "./helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("./helpers/gitlab-fake-db").createGitLabFakeDb
	>,
}));

vi.mock("@repo/database", () => ({
	get db() {
		return state.fake.db;
	},
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
	const helpers = await import("./helpers/gitlab-fake-db");
	return {
		...(await importOriginal<object>()),
		decryptApiKey: helpers.fakeDecrypt,
		encryptApiKey: helpers.fakeEncrypt,
	};
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
	connectGitLab,
	disconnectGitLabConnection,
	executeGitLabTool,
	findUsableGitLabConnection,
	getFreshGitLabAccessToken,
	getGitLabAccessToken,
	getGitLabApiCredential,
	getGitLabConnectionGeneration,
	getGitLabConnectionStatus,
	getGitLabConnectionToken,
	identifyGitLabIssuer,
	patchGitLabConnectionSettings,
	refreshGitLabConnection,
	resetGitLabConnectionDepsForTests,
} from "../../src/gitlab/index";

const USER = "user-1";
const ORG = "org-1";
const HOUR = 60 * 60 * 1000;

const officialServer = {
	id: "srv-official",
	key: "gitlab-official",
	defaultUrl: "https://gitlab.com/api/v4/mcp",
};
const legacyServer = {
	id: "srv-gitlab",
	key: "gitlab",
	defaultUrl: "https://app.example.com/api/mcp/gitlab",
};

function wiRow(
	credential: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) {
	return {
		id: "wi-1",
		userId: USER,
		organizationId: ORG,
		provider: "GITLAB",
		name: "GitLab: dev",
		workflowId: null,
		credentials: encryptedCredential(credential),
		settings: {},
		isActive: true,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		...extra,
	};
}

function officialRow(extra: Record<string, unknown> = {}) {
	return {
		id: "cfg-official",
		userId: USER,
		organizationId: ORG,
		mcpServerId: officialServer.id,
		baseUrl: null,
		oauthClientId: "dcr-client",
		encryptedOauthClientSecret: null,
		dcrClientMetadata: { token_endpoint_auth_method: "none" },
		encryptedAccessToken: "enc:mcp-access",
		encryptedRefreshToken: "enc:mcp-refresh",
		tokenExpiresAt: new Date(Date.now() + HOUR),
		needsReauth: false,
		enabled: true,
		authType: "OAUTH2",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-02-01T00:00:00Z"),
		...extra,
	};
}

/** An OAuth credential whose access token expired an hour ago. */
function expiredOAuth(extra: Record<string, unknown> = {}) {
	return {
		access_token: "old-access",
		refresh_token: "old-refresh",
		expires_in: 7200,
		token_obtained_at: new Date(Date.now() - 3 * HOUR).toISOString(),
		...extra,
	};
}

function tokenResponse(access: string, refresh: string) {
	return {
		ok: true,
		status: 200,
		json: async () => ({
			access_token: access,
			refresh_token: refresh,
			token_type: "bearer",
			expires_in: 7200,
			created_at: Math.floor(Date.now() / 1000),
		}),
	};
}

function tokenCalls() {
	return fetchMock.mock.calls.filter(([url]) =>
		String(url).endsWith("/oauth/token"),
	);
}

function bodyOf(call: unknown[]) {
	return new URLSearchParams(String((call[1] as RequestInit).body));
}

beforeEach(() => {
	fetchMock.mockReset();
	resetGitLabConnectionDepsForTests();
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "app-secret");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("issuer identity", () => {
	it("refreshes a DCR-issued token with its DCR client, not the integration app", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [officialRow()],
			workflowIntegration: [
				wiRow(
					expiredOAuth({
						issuer: {
							kind: "mcp-dcr",
							mcpConfigId: "cfg-official",
							serverKey: "gitlab-official",
							clientId: "dcr-client",
							origin: "https://gitlab.com",
						},
						connectionGeneration: 1,
					}),
				),
			],
		});
		fetchMock.mockResolvedValueOnce(
			tokenResponse("new-access", "new-refresh"),
		);

		const token = await getGitLabAccessToken(USER, ORG);

		expect(token).toBe("new-access");
		const calls = tokenCalls();
		expect(calls).toHaveLength(1);
		expect(bodyOf(calls[0]).get("client_id")).toBe("dcr-client");
		expect(bodyOf(calls[0]).get("client_secret")).toBeNull();
		const stored = readCredential(state.fake.tables.workflowIntegration[0]);
		expect(stored.refresh_token).toBe("new-refresh");
		expect(stored.issuer).toMatchObject({
			kind: "mcp-dcr",
			clientId: "dcr-client",
		});
	});

	it("reports client-unavailable — never a dead grant — when the app that issued the token was replaced", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				wiRow(
					expiredOAuth({
						issuer: {
							kind: "app",
							clientId: "previous-app-client",
							origin: "https://gitlab.com",
						},
						connectionGeneration: 1,
					}),
				),
			],
		});

		const result = await getFreshGitLabAccessToken(USER, ORG);

		expect(result).toEqual({
			ok: false,
			reason: "the OAuth client that issued the GitLab token is not available",
		});
		// The grant was never spent with a different client …
		expect(tokenCalls()).toHaveLength(0);
		// … and nothing condemned it.
		const row = state.fake.tables.workflowIntegration[0];
		expect((row.settings as Record<string, unknown>).needsReauth).not.toBe(
			true,
		);
		expect(readCredential(row).refresh_token).toBe("old-refresh");
	});

	it("refreshes a self-hosted credential at its own instance and sends REST calls only there", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				wiRow(
					expiredOAuth({
						issuer: {
							kind: "app",
							clientId: "app-client",
							origin: "https://gitlab.example.com",
						},
						connectionGeneration: 1,
					}),
				),
			],
		});
		fetchMock
			.mockResolvedValueOnce(tokenResponse("new-access", "new-refresh"))
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => [],
			});

		await executeGitLabTool("list_projects", {}, USER, ORG);

		const urls = fetchMock.mock.calls.map(([url]) => String(url));
		expect(urls[0]).toBe("https://gitlab.example.com/oauth/token");
		expect(urls[1]).toMatch(
			/^https:\/\/gitlab\.example\.com\/api\/v4\/projects\?/,
		);
		expect(
			(fetchMock.mock.calls[1][1] as RequestInit).headers as Record<
				string,
				string
			>,
		).toMatchObject({ Authorization: "Bearer new-access" });
		expect(urls.some((url) => url.includes("://gitlab.com"))).toBe(false);
	});
});

describe("credential origin", () => {
	const selfHostedPat = () =>
		wiRow({
			GITLAB_ACCESS_TOKEN: "instance-private-token",
			GITLAB_URL: "https://gitlab.example.com",
			access_token: "instance-private-token",
			issuer: { kind: "pat", origin: "https://gitlab.example.com" },
			connectionGeneration: 1,
		});
	const ok = (body: unknown) => ({
		ok: true,
		status: 200,
		json: async () => body,
	});

	it("executeGitLabTool sends a self-hosted token to its own instance, never to gitlab.com", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [selfHostedPat()],
		});
		fetchMock.mockResolvedValueOnce(ok([]));

		await executeGitLabTool("list_projects", {}, USER, ORG);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toMatch(
			/^https:\/\/gitlab\.example\.com\/api\/v4\/projects\?/,
		);
		expect(init.headers as Record<string, string>).toMatchObject({
			Authorization: "Bearer instance-private-token",
		});
	});

	it("builds file links on the credential's own instance", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [selfHostedPat()],
		});
		fetchMock.mockResolvedValueOnce(
			ok({
				content: Buffer.from("hello").toString("base64"),
				encoding: "base64",
				file_path: "README.md",
				blob_id: "b1",
				size: 5,
			}),
		);

		const file = (await executeGitLabTool(
			"get_file_contents",
			{ project_id: "group/app", path: "README.md" },
			USER,
			ORG,
		)) as { url: string };

		expect(String(fetchMock.mock.calls[0][0])).toMatch(
			/^https:\/\/gitlab\.example\.com\/api\/v4\//,
		);
		expect(file.url).toMatch(/^https:\/\/gitlab\.example\.com\/api\/v4\//);
	});

	it("hands the REST base of the credential's instance to callers that ask for it", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [selfHostedPat()],
		});

		expect(await getGitLabApiCredential(USER, ORG)).toEqual({
			token: "instance-private-token",
			apiBase: "https://gitlab.example.com/api/v4",
		});
	});

	it("refuses a self-hosted token to callers that only know gitlab.com, before any request", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [selfHostedPat()],
		});

		expect(await getGitLabAccessToken(USER, ORG)).toBeNull();
		expect(await getFreshGitLabAccessToken(USER, ORG)).toEqual({
			ok: false,
			reason: "the GitLab connection belongs to a GitLab instance this feature does not support",
		});
		expect(
			await getGitLabConnectionToken({
				userId: USER,
				organizationId: ORG,
			}),
		).toMatchObject({ ok: false, reason: "unsupported-origin" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("still hands a gitlab.com credential to those callers", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				wiRow({
					GITLAB_ACCESS_TOKEN: "dotcom-token",
					access_token: "dotcom-token",
					issuer: { kind: "pat", origin: "https://gitlab.com" },
					connectionGeneration: 1,
				}),
			],
		});

		expect(await getGitLabAccessToken(USER, ORG)).toBe("dotcom-token");
	});
});

describe("lifecycle lock and generation fence", () => {
	it("a refresh that read the connection before a disconnect does not write it back", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				wiRow(
					expiredOAuth({
						issuer: {
							kind: "app",
							clientId: "app-client",
							origin: "https://gitlab.com",
						},
						connectionGeneration: 1,
					}),
				),
			],
		});
		fetchMock.mockResolvedValue(tokenResponse("new-access", "new-refresh"));
		// The person disconnects at the exact moment the refresh — having
		// already read the row — reaches for the lock. Written the way the
		// disconnect route has always written it: rows deactivated.
		let landed = false;
		state.fake.hooks.beforeAcquire = () => {
			if (landed) {
				return;
			}
			landed = true;
			for (const row of state.fake.tables.workflowIntegration) {
				row.isActive = false;
			}
		};

		const token = await getGitLabAccessToken(USER, ORG);

		expect(token).toBeNull();
		expect(tokenCalls()).toHaveLength(0);
		const row = state.fake.tables.workflowIntegration[0];
		expect(row.isActive).toBe(false);
		expect(readCredential(row).access_token).toBe("old-access");
	});

	it("drops a refresh queued behind a disconnect + reconnect (stale generation)", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				wiRow(
					expiredOAuth({
						issuer: {
							kind: "app",
							clientId: "app-client",
							origin: "https://gitlab.com",
						},
						connectionGeneration: 4,
					}),
				),
			],
		});
		const { refreshGitLabConnection } = await import(
			"../../src/gitlab/connection"
		);
		// The caller read generation 4; by the time it holds the lock the
		// connection is at 6 (a disconnect and a reconnect landed).
		const row = state.fake.tables.workflowIntegration[0];
		row.credentials = encryptedCredential(
			expiredOAuth({
				access_token: "reconnected-access",
				refresh_token: "reconnected-refresh",
				issuer: {
					kind: "app",
					clientId: "app-client",
					origin: "https://gitlab.com",
				},
				connectionGeneration: 6,
			}),
		);

		const outcome = await refreshGitLabConnection(
			{ userId: USER, organizationId: ORG },
			{ expectedGeneration: 4 },
		);

		expect(outcome).toMatchObject({ ok: false, reason: "stale" });
		expect(tokenCalls()).toHaveLength(0);
		expect(readCredential(row).refresh_token).toBe("reconnected-refresh");
	});

	it("a disconnect empties the credential, bumps the generation and keeps the MCP rows and their registration", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [
				officialServer,
				legacyServer,
				{ id: "srv-linear", key: "linear", defaultUrl: null },
			],
			mCPConfig: [
				officialRow(),
				{
					...officialRow({
						id: "cfg-legacy",
						mcpServerId: legacyServer.id,
					}),
					oauthClientId: "legacy-client",
					// A personal access token an older release let the API
					// save on a GitLab config: the disconnect removes it too.
					encryptedApiKey: "enc:glpat-on-config",
				},
				// Another server's API key is not GitLab's to clear.
				officialRow({
					id: "cfg-linear",
					mcpServerId: "srv-linear",
					oauthClientId: null,
					encryptedAccessToken: null,
					encryptedRefreshToken: null,
					encryptedApiKey: "enc:linear-key",
				}),
			],
			workflowIntegration: [
				wiRow({
					access_token: "live-access",
					refresh_token: "live-refresh",
					expires_in: 7200,
					token_obtained_at: new Date().toISOString(),
					issuer: {
						kind: "mcp-dcr",
						mcpConfigId: "cfg-official",
						serverKey: "gitlab-official",
						clientId: "dcr-client",
						origin: "https://gitlab.com",
					},
					connectionGeneration: 2,
				}),
			],
		});
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({}),
		});

		const result = await disconnectGitLabConnection({
			userId: USER,
			organizationId: ORG,
		});

		expect(result.revocationWarning).toBeNull();
		const row = state.fake.tables.workflowIntegration[0];
		expect(row.isActive).toBe(false);
		const credential = readCredential(row);
		expect(credential).toEqual({
			connectionGeneration: 3,
			disconnectedAt: expect.any(String),
		});
		const configs = state.fake.tables.mCPConfig;
		for (const cfg of configs.filter((c) => c.id !== "cfg-linear")) {
			expect(cfg.encryptedAccessToken).toBeNull();
			expect(cfg.encryptedRefreshToken).toBeNull();
			expect(cfg.encryptedApiKey ?? null).toBeNull();
			expect(cfg.enabled).toBe(true);
			expect(cfg.oauthClientId).not.toBeNull();
		}
		expect(
			configs.find((c) => c.id === "cfg-linear")?.encryptedApiKey,
		).toBe("enc:linear-key");
		// Revoked with the client that issued it.
		const revoke = fetchMock.mock.calls.find(([url]) =>
			String(url).endsWith("/oauth/revoke"),
		);
		expect(revoke).toBeDefined();
		expect(bodyOf(revoke as unknown[]).get("client_id")).toBe("dcr-client");
		expect(await getGitLabAccessToken(USER, ORG)).toBeNull();
	});
});

describe("canonical record", () => {
	const appIssuer = {
		kind: "app" as const,
		clientId: "app-client",
		origin: "https://gitlab.com",
	};

	it("serializes concurrent first connects into exactly one connection", async () => {
		state.fake = createGitLabFakeDb();
		const tenant = { userId: USER, organizationId: ORG };

		const results = await Promise.all(
			["a", "b", "c"].map((each) =>
				connectGitLab(tenant, {
					accessToken: `access-${each}`,
					refreshToken: `refresh-${each}`,
					expiresAt: new Date(Date.now() + HOUR),
					scopes: ["api"],
					issuer: appIssuer,
					freshGrant: true,
				}),
			),
		);

		expect(results.map((each) => each.written)).toEqual([true, true, true]);
		expect(state.fake.tables.workflowIntegration).toHaveLength(1);
		expect(
			readCredential(state.fake.tables.workflowIntegration[0])
				.connectionGeneration,
		).toBe(3);
	});

	it("a create that loses to a lock-free writer updates the row that won", async () => {
		state.fake = createGitLabFakeDb();
		const tenant = { userId: USER, organizationId: ORG };
		// An old replica that does not take the lifecycle lock inserts the
		// person's row in the gap between our locked re-read and our insert.
		let raced = false;
		state.fake.hooks.beforeCreate = (model) => {
			if (model !== "workflowIntegration" || raced) {
				return;
			}
			raced = true;
			state.fake.insertCommitted(
				"workflowIntegration",
				wiRow(
					{
						GITLAB_ACCESS_TOKEN: "racer-pat",
						connectionGeneration: 0,
					},
					{ id: "wi-racer" },
				),
			);
		};

		const result = await connectGitLab(tenant, {
			accessToken: "new-access",
			refreshToken: "new-refresh",
			expiresAt: new Date(Date.now() + HOUR),
			scopes: ["api"],
			issuer: appIssuer,
			freshGrant: true,
		});

		expect(result).toEqual({
			written: true,
			integrationId: "wi-racer",
			generation: 1,
		});
		const rows = state.fake.tables.workflowIntegration;
		expect(rows).toHaveLength(1);
		expect(readCredential(rows[0])).toMatchObject({
			access_token: "new-access",
			issuer: appIssuer,
		});
		expect(await getGitLabAccessToken(USER, ORG)).toBe("new-access");
	});

	it("a disconnect whose tombstone loses to a lock-free writer deactivates the row that won", async () => {
		state.fake = createGitLabFakeDb();
		const tenant = { userId: USER, organizationId: ORG };
		let raced = false;
		state.fake.hooks.beforeCreate = (model) => {
			if (model !== "workflowIntegration" || raced) {
				return;
			}
			raced = true;
			state.fake.insertCommitted(
				"workflowIntegration",
				wiRow(
					{
						GITLAB_ACCESS_TOKEN: "racer-pat",
						connectionGeneration: 4,
					},
					{ id: "wi-racer" },
				),
			);
		};

		const result = await disconnectGitLabConnection(tenant);

		expect(result.integrationIds).toEqual(["wi-racer"]);
		expect(result.generation).toBe(5);
		const rows = state.fake.tables.workflowIntegration;
		expect(rows).toHaveLength(1);
		expect(rows[0].isActive).toBe(false);
		expect(readCredential(rows[0])).toEqual({
			connectionGeneration: 5,
			disconnectedAt: expect.any(String),
		});
	});

	it("never selects a workflow-scoped row or the OAuth app row as the personal connection", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				wiRow(
					{ client_id: "app-client", client_secret: "app-secret" },
					{ id: "wi-app", name: "GITLAB_OAUTH_APP" },
				),
				wiRow(
					{ GITLAB_ACCESS_TOKEN: "workflow-pat" },
					{ id: "wi-flow", workflowId: "wf-1" },
				),
			],
		});

		expect(await getGitLabAccessToken(USER, ORG)).toBeNull();
	});
});

describe("shared grants", () => {
	it("marks a personal connection that shares its grant with a repository link reconnect-required, and never refreshes it", async () => {
		state.fake = createGitLabFakeDb({
			project: [{ id: "proj-1", organizationId: ORG }],
			projectRepositoryIntegration: [
				{
					id: "pri-1",
					projectId: "proj-1",
					provider: "GITLAB",
					encryptedAccessToken: "enc:old-access",
					encryptedRefreshToken: "enc:old-refresh",
				},
			],
			workflowIntegration: [wiRow(expiredOAuth())],
		});
		fetchMock.mockResolvedValue(tokenResponse("new-access", "new-refresh"));

		const result = await getFreshGitLabAccessToken(USER, ORG);

		expect(result).toEqual({
			ok: false,
			reason: "the GitLab connection needs to be reconnected",
		});
		expect(tokenCalls()).toHaveLength(0);
		const row = state.fake.tables.workflowIntegration[0];
		expect(row.settings).toMatchObject({
			needsReauth: true,
			reauthReason: "shared-with-repository",
		});
		// The repository link keeps its grant untouched.
		expect(
			state.fake.tables.projectRepositoryIntegration[0]
				.encryptedRefreshToken,
		).toBe("enc:old-refresh");
	});
});

describe("a rejected grant is condemned; an MCP config is never a source of tokens", () => {
	const dcrIssuer = {
		kind: "mcp-dcr",
		mcpConfigId: "cfg-official",
		serverKey: "gitlab-official",
		clientId: "dcr-client",
		origin: "https://gitlab.com",
	};
	const invalidGrant = () =>
		new Response(JSON.stringify({ error: "invalid_grant" }), {
			status: 400,
		});

	it("condemns the connection even when its MCP config still holds a newer token copy", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			// A leftover copy with a different, later-expiring grant. Before
			// the copies were removed, a refresh rejected by GitLab took this
			// over; it must now be ignored.
			mCPConfig: [
				officialRow({ tokenExpiresAt: new Date(Date.now() + HOUR) }),
			],
			workflowIntegration: [
				wiRow(
					expiredOAuth({
						issuer: dcrIssuer,
						connectionGeneration: 1,
					}),
				),
			],
		});
		fetchMock.mockResolvedValueOnce(invalidGrant());

		expect(await getGitLabAccessToken(USER, ORG)).toBeNull();
		const row = state.fake.tables.workflowIntegration[0];
		expect(row.settings).toMatchObject({ needsReauth: true });
		const stored = readCredential(row);
		expect(stored.refresh_token).toBe("old-refresh");
		expect(stored.access_token).toBe("old-access");

		// Condemned once: the next read does not post the dead grant again.
		expect(await getGitLabAccessToken(USER, ORG)).toBeNull();
		expect(tokenCalls()).toHaveLength(1);
		// The copy is neither read into the connection nor written.
		expect(state.fake.tables.mCPConfig[0].encryptedRefreshToken).toBe(
			"enc:mcp-refresh",
		);
	});
});

describe("executeGitLabTool", () => {
	it("retries a 401 once with a refresh bound to the rejected token", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				wiRow({
					access_token: "stale-access",
					refresh_token: "live-refresh",
					expires_in: 7200,
					token_obtained_at: new Date().toISOString(),
					issuer: {
						kind: "app",
						clientId: "app-client",
						origin: "https://gitlab.com",
					},
					connectionGeneration: 1,
				}),
			],
		});
		fetchMock
			.mockResolvedValueOnce({
				ok: false,
				status: 401,
				json: async () => ({ message: "401 Unauthorized" }),
			})
			.mockResolvedValueOnce(
				tokenResponse("fresh-access", "fresh-refresh"),
			)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => [],
			});

		const result = await executeGitLabTool("list_projects", {}, USER, ORG);

		expect(result).toEqual([]);
		const calls = fetchMock.mock.calls;
		expect(String(calls[1][0])).toBe("https://gitlab.com/oauth/token");
		expect(
			(calls[2][1] as RequestInit).headers as Record<string, string>,
		).toMatchObject({ Authorization: "Bearer fresh-access" });
	});

	it("tells the person to connect GitLab when there is no connection", async () => {
		state.fake = createGitLabFakeDb();

		await expect(
			executeGitLabTool("list_projects", {}, USER, ORG),
		).rejects.toThrow("GitLab not connected");
	});
});

describe("disconnect with no connection row", () => {
	it("persists a fence, so a first connect that read generation 0 before it is not written", async () => {
		state.fake = createGitLabFakeDb();
		const tenant = { userId: USER, organizationId: ORG };
		// An OAuth callback reads the generation before its code exchange …
		const before = await getGitLabConnectionGeneration(tenant);
		expect(before).toBe(0);

		// … the person disconnects while the exchange is in flight …
		const disconnected = await disconnectGitLabConnection(tenant);
		expect(disconnected.integrationIds).toEqual([]);
		expect(disconnected.generation).toBe(1);

		// … and the callback finishes.
		const late = await connectGitLab(tenant, {
			accessToken: "late-access",
			refreshToken: "late-refresh",
			expiresAt: new Date(Date.now() + HOUR),
			scopes: ["api"],
			issuer: {
				kind: "app",
				clientId: "app-client",
				origin: "https://gitlab.com",
			},
			freshGrant: true,
			expectedGeneration: before,
		});

		expect(late).toEqual({
			written: false,
			reason: "stale",
			generation: 1,
		});
		const rows = state.fake.tables.workflowIntegration;
		expect(rows).toHaveLength(1);
		expect(rows[0].isActive).toBe(false);
		expect(readCredential(rows[0])).toEqual({
			connectionGeneration: 1,
			disconnectedAt: expect.any(String),
		});
		expect(await getGitLabAccessToken(USER, ORG)).toBeNull();
	});

	it("lets a later connect that read the new generation reuse the tombstone", async () => {
		state.fake = createGitLabFakeDb();
		const tenant = { userId: USER, organizationId: ORG };
		await disconnectGitLabConnection(tenant);

		const generation = await getGitLabConnectionGeneration(tenant);
		const result = await connectGitLab(tenant, {
			accessToken: "new-access",
			refreshToken: "new-refresh",
			expiresAt: new Date(Date.now() + HOUR),
			scopes: ["api"],
			issuer: {
				kind: "app",
				clientId: "app-client",
				origin: "https://gitlab.com",
			},
			freshGrant: true,
			expectedGeneration: generation,
		});

		expect(result).toMatchObject({ written: true, generation: 2 });
		expect(state.fake.tables.workflowIntegration).toHaveLength(1);
		expect(await getGitLabAccessToken(USER, ORG)).toBe("new-access");
	});
});

describe("a person whose only GitLab credential is a legacy gitlab-official MCP copy is not connected", () => {
	const tenant = { userId: USER, organizationId: ORG };

	beforeEach(() => {
		// Production's shape before the backfill: a usable grant on the MCP
		// copy and no WorkflowIntegration row. Only the backfill script may
		// turn it into a connection; no read path does.
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer, legacyServer],
			mCPConfig: [
				officialRow(),
				officialRow({
					id: "cfg-gitlab",
					mcpServerId: legacyServer.id,
					oauthClientId: "legacy-client",
					encryptedAccessToken: "enc:legacy-access",
					encryptedRefreshToken: "enc:legacy-refresh",
				}),
			],
		});
	});

	function nothingAdopted() {
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
		expect(tokenCalls()).toHaveLength(0);
		// The copies are untouched by reads.
		expect(state.fake.tables.mCPConfig[0].encryptedAccessToken).toBe(
			"enc:mcp-access",
		);
	}

	it("getGitLabConnectionToken", async () => {
		expect(await getGitLabConnectionToken(tenant)).toMatchObject({
			ok: false,
			reason: "not-connected",
		});
		nothingAdopted();
	});

	it("getGitLabAccessToken and getGitLabApiCredential", async () => {
		expect(await getGitLabAccessToken(USER, ORG)).toBeNull();
		expect(await getGitLabApiCredential(USER, ORG)).toBeNull();
		nothingAdopted();
	});

	it("getGitLabConnectionStatus", async () => {
		expect(await getGitLabConnectionStatus(tenant)).toMatchObject({
			connected: false,
			needsReauth: false,
			generation: 0,
		});
		nothingAdopted();
	});

	it("getGitLabConnectionGeneration", async () => {
		expect(await getGitLabConnectionGeneration(tenant)).toBe(0);
		nothingAdopted();
	});

	it("findUsableGitLabConnection", async () => {
		expect(await findUsableGitLabConnection(tenant)).toBeNull();
		nothingAdopted();
	});

	it("refreshGitLabConnection (an explicit refresh, e.g. mcp.oauth.refresh)", async () => {
		const outcome = await refreshGitLabConnection(tenant, { force: true });

		expect(outcome).toMatchObject({ ok: false, reason: "not-connected" });
		nothingAdopted();
	});

	it("patchGitLabConnectionSettings", async () => {
		const written = await patchGitLabConnectionSettings(tenant, {
			expectedGeneration: 1,
			patch: { useOfficialMcp: true },
		});

		expect(written).toBe(false);
		nothingAdopted();
	});

	it("connectGitLab writes a fresh connection at generation 1, never the copy", async () => {
		const result = await connectGitLab(tenant, {
			accessToken: "pat-token",
			refreshToken: null,
			expiresAt: null,
			scopes: ["api"],
			issuer: { kind: "pat", origin: "https://gitlab.com" },
			freshGrant: true,
			expectedGeneration: 0,
		});

		expect(result).toMatchObject({ written: true, generation: 1 });
		const rows = state.fake.tables.workflowIntegration;
		expect(rows).toHaveLength(1);
		expect(readCredential(rows[0]).access_token).toBe("pat-token");
		expect(await getGitLabAccessToken(USER, ORG)).toBe("pat-token");
	});

	it("disconnectGitLabConnection records a tombstone and revokes nothing", async () => {
		const result = await disconnectGitLabConnection(tenant);

		expect(result.integrationIds).toEqual([]);
		expect(result.revocationWarning).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		const rows = state.fake.tables.workflowIntegration;
		expect(rows).toHaveLength(1);
		expect(rows[0].isActive).toBe(false);
		// The disconnect still clears whatever copy the config held.
		for (const config of state.fake.tables.mCPConfig) {
			expect(config.encryptedAccessToken).toBeNull();
			expect(config.encryptedRefreshToken).toBeNull();
		}
	});
});

describe("failures inside the lifecycle lock (rollback-aware fake)", () => {
	it("rolls back a connect whose same-transaction write throws", async () => {
		state.fake = createGitLabFakeDb();

		await expect(
			connectGitLab(
				{ userId: USER, organizationId: ORG },
				{
					accessToken: "access",
					refreshToken: "refresh",
					expiresAt: new Date(Date.now() + HOUR),
					scopes: ["api"],
					issuer: {
						kind: "app",
						clientId: "app-client",
						origin: "https://gitlab.com",
					},
					freshGrant: true,
					alsoInTransaction: async () => {
						throw new Error("capability sync failed");
					},
				},
			),
		).rejects.toThrow("capability sync failed");

		expect(state.fake.rollbackCount()).toBe(1);
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
	});

	it("commits a dead-grant mark: the refresh reports it as a value, never by throwing out of the lock", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				wiRow(
					expiredOAuth({
						issuer: {
							kind: "app",
							clientId: "app-client",
							origin: "https://gitlab.com",
						},
						connectionGeneration: 1,
					}),
				),
			],
		});
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "invalid_grant" }), {
				status: 400,
			}),
		);

		const outcome = await refreshGitLabConnection(
			{ userId: USER, organizationId: ORG },
			{ force: true },
		);

		expect(outcome).toMatchObject({ ok: false, reason: "needs-reauth" });
		expect(state.fake.rollbackCount()).toBe(0);
		expect(state.fake.tables.workflowIntegration[0].settings).toMatchObject(
			{ needsReauth: true, reauthReason: "invalid_grant" },
		);
	});
});

describe("identifyGitLabIssuer — several configs under one key", () => {
	it("finds the registration that issued the grant on the second config, past a decoy read first", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				officialRow({
					id: "cfg-official-a-decoy",
					oauthClientId: "other-client",
				}),
				officialRow({
					id: "cfg-official-b-issuer",
					oauthClientId: "dcr-client",
				}),
			],
		});

		const issuer = await identifyGitLabIssuer(
			{ userId: USER, organizationId: ORG },
			{ clientId: "dcr-client" },
		);

		expect(issuer).toEqual({
			kind: "mcp-dcr",
			mcpConfigId: "cfg-official-b-issuer",
			serverKey: "gitlab-official",
			clientId: "dcr-client",
			origin: "https://gitlab.com",
		});
	});
});
