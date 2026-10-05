/**
 * Where a personal GitLab connection's token may be sent.
 *
 * The instance comes from user-supplied data — a personal access token's
 * address (`GITLAB_URL`, or the older `domain` / `url`), a GitLab MCP
 * config's `baseUrl`, an OAuth token endpoint — so an internal address there
 * must be refused before any request carries the token: REST calls, the
 * refresh exchange and the revocation. A legacy credential naming its
 * instance under an older field is read from that field, never defaulted to
 * gitlab.com. A redirected answer from the official MCP endpoint is not
 * evidence the call never ran. And an unreadable client secret only skips
 * revocation; the local disconnect still commits.
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

import { adoptGitLabConnection } from "../../src/gitlab/connection-legacy-adoption";
import {
	callMcpWithRestFallback,
	connectGitLab,
	createGitLabMcpClient,
	disconnectGitLabConnection,
	executeGitLabTool,
	GitLabMcpError,
	GitLabOriginNotAllowedError,
	type GitLabSource,
	getGitLabAccessToken,
	getGitLabApiCredential,
	getGitLabConnectionToken,
	gitlabOutboundFetch,
	isGitLabMcpEndpointGone,
	parseGitLabOrigin,
	refreshGitLabConnection,
	resetGitLabConnectionDepsForTests,
} from "../../src/gitlab/index";

const USER = "user-1";
const ORG = "org-1";
const HOUR = 60 * 60 * 1000;
const tenant = { userId: USER, organizationId: ORG };

/** Internal addresses a user could type, one per class the guard refuses. */
const INTERNAL_ORIGINS = [
	"https://169.254.169.254", // cloud metadata (link-local)
	"https://127.0.0.1", // loopback
	"https://10.0.0.5", // RFC 1918 private
	"https://192.168.1.20", // RFC 1918 private
	"https://localhost", // loopback name
];

const officialServer = {
	id: "srv-official",
	key: "gitlab-official",
	defaultUrl: "https://gitlab.com/api/v4/mcp",
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

/** An adopted DCR credential, expired, issued by `origin`. */
function dcrCredential(origin: string) {
	return {
		access_token: "dcr-access",
		refresh_token: "dcr-refresh",
		expires_in: 7200,
		token_obtained_at: new Date(Date.now() - 3 * HOUR).toISOString(),
		issuer: {
			kind: "mcp-dcr",
			mcpConfigId: "cfg-official",
			serverKey: "gitlab-official",
			clientId: "dcr-client",
			origin,
		},
		connectionGeneration: 1,
	};
}

const ok = (body: unknown) => ({
	ok: true,
	status: 200,
	headers: new Headers({ "content-type": "application/json" }),
	json: async () => body,
});

beforeEach(() => {
	fetchMock.mockReset();
	resetGitLabConnectionDepsForTests();
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "app-secret");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("parseGitLabOrigin", () => {
	it("accepts an https instance and a bare host, normalised to its origin", () => {
		expect(
			parseGitLabOrigin("https://GitLab.Example.com/some/path/"),
		).toEqual({ ok: true, origin: "https://gitlab.example.com" });
		expect(parseGitLabOrigin("gitlab.example.com:8443")).toEqual({
			ok: true,
			origin: "https://gitlab.example.com:8443",
		});
	});

	it.each([
		...INTERNAL_ORIGINS,
		"http://gitlab.example.com",
		"https://user:pass@gitlab.example.com",
		"https://[::1]",
		"ftp://gitlab.example.com",
		"not a url ::",
	])("refuses %s", (raw) => {
		expect(parseGitLabOrigin(raw)).toMatchObject({ ok: false });
	});
});

describe("internal instance addresses are refused before any request", () => {
	describe.each(INTERNAL_ORIGINS)("%s", (origin) => {
		it("as a PAT's GITLAB_URL: no REST request carries the token", async () => {
			state.fake = createGitLabFakeDb({
				workflowIntegration: [
					wiRow({
						GITLAB_ACCESS_TOKEN: "pat-token",
						GITLAB_URL: origin,
						access_token: "pat-token",
						issuer: { kind: "pat", origin },
						connectionGeneration: 1,
					}),
				],
			});

			await expect(
				executeGitLabTool("list_projects", {}, USER, ORG),
			).rejects.toThrow();
			expect(await getGitLabApiCredential(USER, ORG)).toBeNull();
			expect(
				await getGitLabConnectionToken(tenant, { anyOrigin: true }),
			).toMatchObject({ ok: false, reason: "unsupported-origin" });
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("as a legacy PAT's address (no issuer yet): not classified, no request", async () => {
			state.fake = createGitLabFakeDb({
				workflowIntegration: [
					wiRow({ apiToken: "pat-token", domain: origin }),
				],
			});

			expect(await getGitLabApiCredential(USER, ORG)).toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
			const row = state.fake.tables.workflowIntegration[0];
			expect(readCredential(row).issuer).toBeUndefined();
			expect(row.settings).toMatchObject({
				needsReauth: true,
				reauthReason: "origin-refused",
			});
		});

		it("as a recorded issuer origin: the refresh exchange is not sent", async () => {
			state.fake = createGitLabFakeDb({
				mCPServer: [officialServer],
				mCPConfig: [officialRow()],
				workflowIntegration: [wiRow(dcrCredential(origin))],
			});

			const outcome = await refreshGitLabConnection(tenant, {
				force: true,
			});

			expect(outcome).toMatchObject({
				ok: false,
				reason: "client-unavailable",
			});
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("as a recorded issuer origin: revocation is skipped, the disconnect commits", async () => {
			state.fake = createGitLabFakeDb({
				mCPServer: [officialServer],
				mCPConfig: [officialRow()],
				workflowIntegration: [wiRow(dcrCredential(origin))],
			});

			const result = await disconnectGitLabConnection(tenant);

			expect(fetchMock).not.toHaveBeenCalled();
			expect(result.revocationWarning).toMatch(/revocation was skipped/);
			const row = state.fake.tables.workflowIntegration[0];
			expect(row.isActive).toBe(false);
			expect(readCredential(row).disconnectedAt).toEqual(
				expect.any(String),
			);
		});

		it("as a GitLab MCP config's baseUrl: the backfill does not adopt that copy, its token goes nowhere", async () => {
			state.fake = createGitLabFakeDb({
				mCPServer: [officialServer],
				mCPConfig: [officialRow({ baseUrl: `${origin}/api/v4/mcp` })],
			});

			await expect(
				executeGitLabTool("list_projects", {}, USER, ORG),
			).rejects.toThrow();
			expect(
				await refreshGitLabConnection(tenant, { force: true }),
			).toMatchObject({ ok: false, reason: "not-connected" });
			const adoption = await adoptGitLabConnection(tenant);
			expect(adoption.applied).toBe(false);
			expect(state.fake.tables.workflowIntegration).toHaveLength(0);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("as a connect's issuer origin: nothing is recorded", async () => {
			state.fake = createGitLabFakeDb();

			await expect(
				connectGitLab(tenant, {
					accessToken: "pat-token",
					refreshToken: null,
					expiresAt: null,
					scopes: [],
					issuer: { kind: "pat", origin },
					freshGrant: true,
				}),
			).rejects.toBeInstanceOf(GitLabOriginNotAllowedError);
			expect(state.fake.tables.workflowIntegration).toHaveLength(0);
		});
	});
});

describe("gitlabOutboundFetch", () => {
	it("keeps gitlab.com on the plain fetch, unchanged", async () => {
		fetchMock.mockResolvedValueOnce(ok({}));
		const init = { headers: { Authorization: "Bearer t" } };

		await gitlabOutboundFetch("https://gitlab.com/api/v4/user", init);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://gitlab.com/api/v4/user",
			init,
		);
	});

	it("sends any other instance through the outbound guard, redirects refused", async () => {
		fetchMock.mockResolvedValueOnce(ok({}));

		await gitlabOutboundFetch("https://gitlab.example.com/api/v4/user", {
			headers: { Authorization: "Bearer t" },
		});

		const [, init] = fetchMock.mock.calls[0] as [
			string,
			RequestInit & { dispatcher?: unknown },
		];
		// `safeFetchOutbound`'s dispatcher re-checks every resolved address.
		expect(init.dispatcher).toBeDefined();
		expect(init.redirect).toBe("error");
	});

	it.each([
		"https://169.254.169.254/latest/meta-data",
		"https://10.0.0.5/api/v4/user",
		"http://gitlab.example.com/api/v4/user",
	])("refuses %s before sending", async (url) => {
		await expect(gitlabOutboundFetch(url)).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("legacy PAT origin aliases", () => {
	it("reads `domain` as the instance: { apiToken, domain } is not a gitlab.com token", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				wiRow({
					apiToken: "legacy-token",
					domain: "https://gitlab.example.com",
				}),
			],
		});

		// A gitlab.com-only caller gets nothing …
		expect(await getGitLabAccessToken(USER, ORG)).toBeNull();
		// … and an origin-aware one gets the token with its own instance.
		expect(await getGitLabApiCredential(USER, ORG)).toEqual({
			token: "legacy-token",
			apiBase: "https://gitlab.example.com/api/v4",
		});
		expect(
			readCredential(state.fake.tables.workflowIntegration[0]).issuer,
		).toEqual({ kind: "pat", origin: "https://gitlab.example.com" });

		fetchMock.mockResolvedValueOnce(ok([]));
		await executeGitLabTool("list_projects", {}, USER, ORG);
		expect(String(fetchMock.mock.calls[0][0])).toMatch(
			/^https:\/\/gitlab\.example\.com\/api\/v4\/projects\?/,
		);
	});

	it.each([
		["url", "https://gitlab.example.com"],
		["GITLAB_URL", "gitlab.example.com"],
	])("reads `%s` too", async (field, value) => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				wiRow({ apiToken: "legacy-token", [field]: value }),
			],
		});

		expect(await getGitLabApiCredential(USER, ORG)).toEqual({
			token: "legacy-token",
			apiBase: "https://gitlab.example.com/api/v4",
		});
	});

	it("refuses a present but invalid address rather than defaulting to gitlab.com", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				wiRow({ apiToken: "legacy-token", domain: "not a url ::" }),
			],
		});

		expect(await getGitLabAccessToken(USER, ORG)).toBeNull();
		expect(await getGitLabApiCredential(USER, ORG)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("official MCP: a redirected 404 is not evidence a write never ran", () => {
	const SERVER = "https://gitlab.com/api/v4/mcp";
	const RESULT = "https://gitlab.com/-/result/1";

	/**
	 * A fetch that behaves like the platform's: with `redirect: "manual"` it
	 * hands back the 302; otherwise it follows it to a URL that answers 404.
	 * The endpoint runs the call (a mutation) either way.
	 */
	function endpointThatRunsThenRedirects(mutations: { count: number }) {
		fetchMock.mockImplementation(
			async (url: string, init?: RequestInit) => {
				if (url !== SERVER) {
					throw new Error(`unexpected request to ${url}`);
				}
				mutations.count++;
				if (init?.redirect === "manual") {
					return new Response(null, {
						status: 302,
						headers: { location: RESULT },
					});
				}
				return {
					ok: false,
					status: 404,
					redirected: true,
					url: RESULT,
					text: async () => "",
				};
			},
		);
	}

	it("does not replay the write over REST: one mutation, and the capability is not marked lost", async () => {
		const mutations = { count: 0 };
		endpointThatRunsThenRedirects(mutations);
		const onCapabilityLost = vi.fn(async () => {});
		const restFallback = vi.fn(async () => {
			mutations.count++;
			return "created over REST";
		});
		const source: GitLabSource = {
			kind: "official-mcp",
			callTool: createGitLabMcpClient({ serverUrl: SERVER, token: "t" })
				.callTool,
			onCapabilityLost,
			credential: { token: "t", apiBase: "https://gitlab.com/api/v4" },
		};

		await expect(
			callMcpWithRestFallback({
				source,
				method: "create_issue",
				args: { title: "x" },
				restFallback,
				idempotent: false,
			}),
		).rejects.toBeInstanceOf(GitLabMcpError);

		expect(mutations.count).toBe(1);
		expect(restFallback).not.toHaveBeenCalled();
		expect(onCapabilityLost).not.toHaveBeenCalled();
		expect(fetchMock.mock.calls[0][1]).toMatchObject({
			redirect: "manual",
		});
	});

	it("classifies only a 404 the endpoint itself answered as capability loss", () => {
		expect(
			isGitLabMcpEndpointGone(
				new GitLabMcpError("gone", undefined, 404, true),
			),
		).toBe(true);
		expect(
			isGitLabMcpEndpointGone(
				new GitLabMcpError("via redirect", undefined, 404, false),
			),
		).toBe(false);
	});

	it("still falls back on a 404 the endpoint answered directly", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response("not found", { status: 404 }),
		);
		const restFallback = vi.fn(async () => "created over REST");
		const source: GitLabSource = {
			kind: "official-mcp",
			callTool: createGitLabMcpClient({ serverUrl: SERVER, token: "t" })
				.callTool,
			onCapabilityLost: vi.fn(async () => {}),
			credential: { token: "t", apiBase: "https://gitlab.com/api/v4" },
		};

		await expect(
			callMcpWithRestFallback({
				source,
				method: "create_issue",
				args: { title: "x" },
				restFallback,
				idempotent: false,
			}),
		).resolves.toBe("created over REST");
	});
});

describe("disconnect with an unreadable DCR client secret", () => {
	it("commits the local cleanup and returns the revocation warning", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				officialRow({
					// A confidential registration whose secret was encrypted
					// under a retired key: decryption throws.
					dcrClientMetadata: {
						token_endpoint_auth_method: "client_secret_post",
					},
					encryptedOauthClientSecret: "corrupt-ciphertext",
				}),
			],
			workflowIntegration: [wiRow(dcrCredential("https://gitlab.com"))],
		});

		const result = await disconnectGitLabConnection(tenant);

		expect(result.revocationWarning).toMatch(/revocation was skipped/);
		expect(result.generation).toBe(2);
		const row = state.fake.tables.workflowIntegration[0];
		expect(row.isActive).toBe(false);
		expect(readCredential(row)).toEqual({
			connectionGeneration: 2,
			disconnectedAt: expect.any(String),
		});
		const mcp = state.fake.tables.mCPConfig[0];
		expect(mcp.encryptedAccessToken).toBeNull();
		expect(mcp.encryptedRefreshToken).toBeNull();
		// The registration itself is kept.
		expect(mcp.oauthClientId).toBe("dcr-client");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await getGitLabAccessToken(USER, ORG)).toBeNull();
	});
});
