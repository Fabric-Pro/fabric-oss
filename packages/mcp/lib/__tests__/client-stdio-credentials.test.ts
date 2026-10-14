/**
 * The Google Drive STDIO server cannot refresh (it builds its Google client
 * with no client id or secret), so Fabric is the only refresher of its
 * grant. On every wrapper call the client re-reads the config, refuses it
 * when the grant changed, is flagged for reconnect or carries a credential
 * set its binding was not written with, refreshes a token near expiry
 * through the shared refresh service, and hands the child the access token
 * alone: the client secret and refresh token are always empty.
 */
import {
	buildMcpOAuthBinding,
	credentialFingerprintMatches,
	parseMcpOAuthBinding,
	withCredentialFingerprint,
} from "@repo/database/prisma/queries/lib/mcp-oauth-binding";
import {
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetMcpConfigById = vi.fn();
const mockMarkReconnectRequired = vi.fn();
const mockRefresh = vi.fn();
const mockGetGrantGeneration = vi.fn();
const mockGetEncryptedApiKey = vi.fn();

vi.mock("@repo/database", async () => {
	const binding = await import(
		"@repo/database/prisma/queries/lib/mcp-oauth-binding"
	);
	return {
		isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
			key === "gitlab" || key === "gitlab-official",
		getMcpConfigById: (...args: unknown[]) => mockGetMcpConfigById(...args),
		getValidAccessToken: vi.fn(),
		getMcpOAuthGrantGeneration: (...args: unknown[]) =>
			mockGetGrantGeneration(...args),
		getMcpConfigEncryptedApiKey: (...args: unknown[]) =>
			mockGetEncryptedApiKey(...args),
		markMcpOAuthReconnectRequired: (...args: unknown[]) =>
			mockMarkReconnectRequired(...args),
		refreshMcpOAuthAccessToken: (...args: unknown[]) =>
			mockRefresh(...args),
		parseMcpOAuthBinding: binding.parseMcpOAuthBinding,
		credentialFingerprintMatches: binding.credentialFingerprintMatches,
		sameAuthorizationServer: binding.sameAuthorizationServer,
		canConnectOrganizationMcpConfigs: async () => true,
		canReadOrganizationMcpConfigs: async () => true,
		isOrganizationMember: async () => true,
	};
});

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value.replace(/^ENC:/, ""),
	encryptApiKey: (value: string) => `ENC:${value}`,
	hashApiKey: (value: string) => `HASH:${value}`,
}));

import {
	clearMcpClientCache,
	createMcpClientForConfig,
	getCachedMcpClientForConfig,
} from "../client";

const CREDENTIALS = {
	oauthClientId: "gdrive-client",
	encryptedOauthClientSecret: "ENC:gdrive-secret",
	encryptedRefreshToken: "ENC:gdrive-refresh",
};

const GOOGLE_BINDING = withCredentialFingerprint(
	buildMcpOAuthBinding({
		authorizationServerUrl: "https://accounts.google.com",
		tokenEndpoint: "https://oauth2.googleapis.com/token",
		source: "backfill",
	}),
	CREDENTIALS,
);

function gdriveConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "config_gd",
		enabled: true,
		needsReauth: false,
		displayName: "Google Drive",
		transport: "STDIO",
		authType: "OAUTH2",
		...CREDENTIALS,
		encryptedAccessToken: "ENC:gdrive-access",
		tokenExpiresAt: new Date(Date.now() + 3_600_000),
		oauthBinding: GOOGLE_BINDING,
		oauthGrantGeneration: 4,
		mcpServer: {
			name: "Google Drive",
			transport: "STDIO",
			command: "npx -y @modelcontextprotocol/server-gdrive",
		},
		...overrides,
	};
}

type WrapperBody = {
	credentials: Record<string, string>;
	credentialsVersion?: number[];
};
let wrapperBodies: WrapperBody[] = [];
/** Refresh calls and wrapper POSTs, in the order they happened. */
let events: string[] = [];

beforeEach(async () => {
	await clearMcpClientCache();
	mockGetMcpConfigById.mockReset();
	mockMarkReconnectRequired.mockReset();
	mockRefresh.mockReset();
	mockGetGrantGeneration.mockReset();
	mockGetEncryptedApiKey.mockReset();
	mockRefresh.mockImplementation(async () => {
		events.push("refresh");
		return { status: "failed", errorCode: "x", errorMessage: "x" };
	});
	wrapperBodies = [];
	events = [];
	vi.stubEnv("MCP_STDIO_WRAPPER_URL", "http://localhost:3100");
	vi.spyOn(global, "fetch").mockImplementation(async (_input, init) => {
		events.push("post");
		wrapperBodies.push(JSON.parse(String(init?.body)));
		return new Response(
			JSON.stringify({ success: true, result: { tools: [] } }),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

type ToolsClient = { tools(): Promise<unknown> };

async function buildClient(): Promise<ToolsClient> {
	const { client } = await createMcpClientForConfig({
		configId: "config_gd",
		userId: "user_a",
		organizationId: "org_a",
	});
	return client as unknown as ToolsClient;
}

function parse(body: WrapperBody | undefined) {
	const credentials = body?.credentials ?? {};
	return {
		keys: JSON.parse(credentials.__GDRIVE_OAUTH_KEYS_JSON ?? "{}"),
		tokens: JSON.parse(credentials.__GDRIVE_CREDENTIALS_JSON ?? "{}"),
	};
}

async function handedCredentials() {
	const client = await buildClient();
	await client.tools();
	return parse(wrapperBodies[0]);
}

function refreshed(
	accessToken: string,
	expiresIn: number | null = 3600,
	/** The `tokenExpiresAt` the service reports it wrote. */
	tokenExpiresAt: Date | null = expiresIn === null
		? null
		: new Date(Date.now() + expiresIn * 1000 + 1234),
) {
	return async () => {
		events.push("refresh");
		return {
			status: "refreshed",
			accessToken,
			refreshToken: "gdrive-refresh",
			encryptedRefreshToken: "ENC:gdrive-refresh",
			expiresIn,
			tokenExpiresAt,
			tokenType: "Bearer",
			scope: null,
			generation: 4,
			binding: GOOGLE_BINDING,
		};
	};
}

describe("Google Drive STDIO credentials", () => {
	it("hands an intact bound grant the access token alone, never the client secret or refresh token", async () => {
		const row = gdriveConfig();
		mockGetMcpConfigById.mockResolvedValue(row);

		const { keys, tokens } = await handedCredentials();

		expect(keys.web).toEqual({
			client_id: "gdrive-client",
			client_secret: "",
			redirect_uris: ["http://localhost"],
		});
		expect(tokens).toEqual({
			access_token: "gdrive-access",
			refresh_token: "",
			token_type: "Bearer",
			expiry_date: row.tokenExpiresAt.getTime(),
		});
		expect(JSON.stringify(wrapperBodies)).not.toContain("gdrive-secret");
		expect(JSON.stringify(wrapperBodies)).not.toContain("gdrive-refresh");
		// Not near expiry: no refresh.
		expect(mockRefresh).not.toHaveBeenCalled();
		// Every read is scoped to the caller's tenant.
		for (const call of mockGetMcpConfigById.mock.calls) {
			expect(call).toEqual([
				"config_gd",
				{ userId: "user_a", organizationId: "org_a" },
			]);
		}
	});

	it.each([
		["the client id", { oauthClientId: "client-from-another-as" }],
		[
			"the client secret",
			{ encryptedOauthClientSecret: "ENC:secret-from-another-as" },
		],
		[
			"the refresh token",
			{ encryptedRefreshToken: "ENC:refresh-from-another-as" },
		],
	])(
		"sends nothing after a legacy write of %s, and flags the config for reconnect",
		async (_label, legacyWrite) => {
			const row = gdriveConfig(legacyWrite);
			// The fixture really is a mismatch.
			const binding = parseMcpOAuthBinding(row.oauthBinding);
			expect(binding && credentialFingerprintMatches(binding, row)).toBe(
				false,
			);
			mockGetMcpConfigById.mockResolvedValue(row);

			await expect(buildClient()).rejects.toMatchObject({
				code: "OAUTH_AUTH_REQUIRED",
			});
			expect(fetch).not.toHaveBeenCalled();
			expect(mockRefresh).not.toHaveBeenCalled();
			expect(mockMarkReconnectRequired).toHaveBeenCalledWith(
				expect.objectContaining({
					configId: "config_gd",
					expectedGeneration: 4,
				}),
			);
		},
	);

	it.each([
		[
			"an intact grant bound to another authorization server",
			withCredentialFingerprint(
				buildMcpOAuthBinding({
					authorizationServerUrl: "https://as.example.com",
					tokenEndpoint: "https://as.example.com/token",
					source: "discovery",
				}),
				CREDENTIALS,
			),
		],
		["an unbound grant", null],
		[
			"a bearer-only import",
			{ mode: "bearer-only", importedAt: "2026-10-06T00:00:00.000Z" },
		],
	])("hands %s the access token alone", async (_label, oauthBinding) => {
		mockGetMcpConfigById.mockResolvedValue(gdriveConfig({ oauthBinding }));

		const { keys, tokens } = await handedCredentials();

		expect(keys.web.client_secret).toBe("");
		expect(tokens.access_token).toBe("gdrive-access");
		expect(tokens.refresh_token).toBe("");
		expect(JSON.stringify(wrapperBodies)).not.toContain("gdrive-secret");
		expect(JSON.stringify(wrapperBodies)).not.toContain("gdrive-refresh");
	});
});

describe("Google Drive STDIO refresh", () => {
	it("refreshes a token near expiry through the refresh service before the POST", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({ tokenExpiresAt: new Date(Date.now() + 3 * 60_000) }),
		);
		mockRefresh.mockImplementation(refreshed("gdrive-access-new"));

		const written = new Date(Date.now() + 3_600_000 + 1234);
		mockRefresh.mockImplementation(
			refreshed("gdrive-access-new", 3600, written),
		);
		const { tokens } = await handedCredentials();

		expect(events[0]).toBe("refresh");
		expect(events.indexOf("refresh")).toBeLessThan(events.indexOf("post"));
		// Still valid: a failed early refresh would not count a strike.
		expect(mockRefresh).toHaveBeenCalledWith("config_gd", {
			recordFailures: false,
			expectedGeneration: 4,
		});
		expect(tokens.access_token).toBe("gdrive-access-new");
		expect(tokens.refresh_token).toBe("");
		// The expiry the service wrote, not one computed from expiresIn here.
		expect(tokens.expiry_date).toBe(written.getTime());
	});

	it("sends byte-identical credentials on the refreshing call, a call sharing its refresh, and the next call reading the row", async () => {
		// The wrapper respawns the child whenever the credentials differ, so
		// a refresh must not make the calls around it disagree on expiry_date.
		let row = gdriveConfig();
		mockGetMcpConfigById.mockImplementation(async () => row);
		const written = new Date(Date.now() + 3_600_000 + 1234);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let refreshStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			refreshStarted = resolve;
		});
		let pendingRefresh: Promise<unknown> | null = null;
		mockRefresh.mockImplementation(() => {
			// The service dedups concurrent refreshes in one process: every
			// caller gets the same outcome. It writes the row as it returns.
			pendingRefresh ??= (async () => {
				refreshStarted();
				await gate;
				const outcome = await refreshed(
					"gdrive-access-new",
					3600,
					written,
				)();
				row = gdriveConfig({
					encryptedAccessToken: "ENC:gdrive-access-new",
					tokenExpiresAt: written,
				});
				return outcome;
			})();
			return pendingRefresh;
		});

		// Built while the token is still far from expiry; it then nears it.
		const client = await buildClient();
		row = gdriveConfig({
			tokenExpiresAt: new Date(Date.now() + 3 * 60_000),
		});
		const first = client.tools();
		// The second call starts while the first one's refresh is in flight,
		// so it reads the near-expiry row and joins the same refresh.
		await started;
		const second = client.tools();
		await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(2));
		release();
		await Promise.all([first, second]);
		await client.tools();

		expect(wrapperBodies).toHaveLength(3);
		const sent = wrapperBodies.map((body) =>
			JSON.stringify(body.credentials),
		);
		expect(new Set(sent).size).toBe(1);
		expect(parse(wrapperBodies[2]).tokens.expiry_date).toBe(
			written.getTime(),
		);
	});

	it("refuses an expired token whose refresh failed, counting the strike and sending nothing", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({ tokenExpiresAt: new Date(Date.now() - 1000) }),
		);

		await expect(buildClient()).rejects.toMatchObject({
			code: "OAUTH_AUTH_REQUIRED",
		});
		expect(mockRefresh).toHaveBeenCalledWith("config_gd", {
			recordFailures: true,
			expectedGeneration: 4,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("sends the still-valid token when an early refresh fails", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({ tokenExpiresAt: new Date(Date.now() + 8 * 60_000) }),
		);

		const { tokens } = await handedCredentials();

		expect(mockRefresh).toHaveBeenCalled();
		expect(tokens.access_token).toBe("gdrive-access");
	});

	it("uses the token another refresh wrote when its own refresh is superseded", async () => {
		const near = gdriveConfig({
			tokenExpiresAt: new Date(Date.now() + 3 * 60_000),
		});
		const fresh = gdriveConfig({
			encryptedAccessToken: "ENC:gdrive-access-other-replica",
			tokenExpiresAt: new Date(Date.now() + 3_600_000),
		});
		// Build reads the row, then the build-time resolve reads it (near
		// expiry), is superseded, and reads again.
		mockGetMcpConfigById
			.mockResolvedValueOnce(near)
			.mockResolvedValueOnce(near)
			.mockResolvedValue(fresh);
		mockRefresh.mockImplementation(async () => {
			events.push("refresh");
			return { status: "superseded" };
		});

		const { tokens } = await handedCredentials();

		expect(mockRefresh).toHaveBeenCalledTimes(1);
		expect(tokens.access_token).toBe("gdrive-access-other-replica");
	});

	it("refuses an expired unbound token without a refresh", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({
				oauthBinding: null,
				tokenExpiresAt: new Date(Date.now() - 1000),
			}),
		);

		await expect(buildClient()).rejects.toMatchObject({
			code: "OAUTH_AUTH_REQUIRED",
		});
		expect(mockRefresh).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("sends each call the token stored now, not the one the client was built with", async () => {
		mockGetMcpConfigById.mockResolvedValue(gdriveConfig());
		const client = await buildClient();
		await client.tools();

		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({ encryptedAccessToken: "ENC:gdrive-access-later" }),
		);
		await client.tools();

		expect(parse(wrapperBodies[0]).tokens.access_token).toBe(
			"gdrive-access",
		);
		expect(parse(wrapperBodies[1]).tokens.access_token).toBe(
			"gdrive-access-later",
		);
	});
});

describe("Google Drive STDIO tokens the child would refuse", () => {
	it("refuses, without sending, a token with 3 minutes left whose refresh failed, as a retryable error", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({ tokenExpiresAt: new Date(Date.now() + 3 * 60_000) }),
		);

		await expect(buildClient()).rejects.toMatchObject({
			code: "OAUTH_REFRESH_FAILED",
			isAuthError: false,
		});
		// Still valid: the failed early refresh counts no strike.
		expect(mockRefresh).toHaveBeenCalledWith("config_gd", {
			recordFailures: false,
			expectedGeneration: 4,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses an unbound token with 3 minutes left without a refresh", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({
				oauthBinding: null,
				tokenExpiresAt: new Date(Date.now() + 3 * 60_000),
			}),
		);

		await expect(buildClient()).rejects.toMatchObject({
			code: "OAUTH_AUTH_REQUIRED",
		});
		expect(mockRefresh).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("Google Drive STDIO bound grant stored without an expiry", () => {
	it("refreshes a token older than Google's lifetime, counting a failure as a strike", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({
				tokenExpiresAt: null,
				updatedAt: new Date(Date.now() - 70 * 60_000),
			}),
		);
		const written = new Date(Date.now() + 3_600_000);
		mockRefresh.mockImplementation(
			refreshed("gdrive-access-new", 3600, written),
		);

		const { tokens } = await handedCredentials();

		expect(mockRefresh).toHaveBeenCalledWith("config_gd", {
			recordFailures: true,
			expectedGeneration: 4,
		});
		expect(tokens.access_token).toBe("gdrive-access-new");
		expect(tokens.expiry_date).toBe(written.getTime());
	});

	it("refuses an old token whose refresh failed, sending nothing", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({
				tokenExpiresAt: null,
				updatedAt: new Date(Date.now() - 70 * 60_000),
			}),
		);

		await expect(buildClient()).rejects.toMatchObject({
			code: "OAUTH_AUTH_REQUIRED",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("sends a recent token with the expiry dated from its last write", async () => {
		const updatedAt = new Date(Date.now() - 10 * 60_000);
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({ tokenExpiresAt: null, updatedAt }),
		);

		const { tokens } = await handedCredentials();

		expect(mockRefresh).not.toHaveBeenCalled();
		expect(tokens.access_token).toBe("gdrive-access");
		expect(tokens.expiry_date).toBe(updatedAt.getTime() + 3_600_000);
	});
});

describe("Google Drive STDIO credentials version", () => {
	it("tells the wrapper how fresh the credentials are: grant generation, then expiry", async () => {
		const row = gdriveConfig();
		mockGetMcpConfigById.mockResolvedValue(row);

		const client = await buildClient();
		await client.tools();

		expect(wrapperBodies[0]?.credentialsVersion).toEqual([
			4,
			row.tokenExpiresAt.getTime(),
		]);
	});
});

describe("Google Drive STDIO after a revoke or reconnect", () => {
	it.each([
		["the grant was revoked or reconnected", { oauthGrantGeneration: 5 }],
		["the config was flagged for reconnect", { needsReauth: true }],
		["the access token was removed", { encryptedAccessToken: null }],
	])("refuses a call on a built client once %s", async (_label, change) => {
		mockGetMcpConfigById.mockResolvedValue(gdriveConfig());
		const client = await buildClient();
		await client.tools();
		expect(wrapperBodies).toHaveLength(1);

		mockGetMcpConfigById.mockResolvedValue(gdriveConfig(change));

		await expect(client.tools()).rejects.toMatchObject({
			code: "OAUTH_AUTH_REQUIRED",
		});
		expect(wrapperBodies).toHaveLength(1);
		expect(mockRefresh).not.toHaveBeenCalled();
	});

	it("drops a cached client when the grant generation moves", async () => {
		const options = {
			configId: "config_gd",
			userId: "user_a",
			organizationId: "org_a",
		};
		mockGetMcpConfigById.mockResolvedValue(gdriveConfig());
		mockGetGrantGeneration.mockResolvedValue(4);

		const first = await getCachedMcpClientForConfig(options);
		expect(first.fromCache).toBe(false);
		const again = await getCachedMcpClientForConfig(options);
		expect(again.fromCache).toBe(true);
		expect(again.client).toBe(first.client);

		mockGetGrantGeneration.mockResolvedValue(5);
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({
				oauthGrantGeneration: 5,
				encryptedAccessToken: "ENC:gdrive-access-reconnected",
			}),
		);
		const rebuilt = await getCachedMcpClientForConfig(options);

		expect(rebuilt.fromCache).toBe(false);
		expect(rebuilt.client).not.toBe(first.client);
		await (rebuilt.client as unknown as ToolsClient).tools();
		expect(parse(wrapperBodies.at(-1)).tokens.access_token).toBe(
			"gdrive-access-reconnected",
		);
	});
});

describe("Google Drive STDIO in a stopped chat turn", () => {
	const STOP = new Error("the chat turn stopped");
	function turnGuard(stopped: () => boolean): DispatchGuard {
		const check = () => {
			if (stopped()) {
				throw STOP;
			}
		};
		return {
			key: "turn-example-1",
			assertDispatchable: async () => undefined,
			abortSignal: () => undefined,
			rethrowIfStopped: check,
			throwIfStopped: check,
		};
	}

	it("makes no refresh and sends nothing once the turn has stopped", async () => {
		mockGetMcpConfigById.mockResolvedValue(gdriveConfig());
		const client = await buildClient();
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({ tokenExpiresAt: new Date(Date.now() + 3 * 60_000) }),
		);
		mockRefresh.mockImplementation(refreshed("gdrive-access-new"));

		await expect(
			runWithDispatchGuard(
				turnGuard(() => true),
				() => client.tools(),
			),
		).rejects.toBe(STOP);
		expect(mockRefresh).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("sends nothing when the turn stops during the refresh", async () => {
		mockGetMcpConfigById.mockResolvedValue(gdriveConfig());
		const client = await buildClient();
		mockGetMcpConfigById.mockResolvedValue(
			gdriveConfig({ tokenExpiresAt: new Date(Date.now() + 3 * 60_000) }),
		);
		let stopped = false;
		mockRefresh.mockImplementation(async () => {
			stopped = true;
			return refreshed("gdrive-access-new")();
		});

		await expect(
			runWithDispatchGuard(
				turnGuard(() => stopped),
				() => client.tools(),
			),
		).rejects.toBe(STOP);
		expect(mockRefresh).toHaveBeenCalledTimes(1);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("Slack STDIO credentials", () => {
	function slackConfig() {
		return {
			id: "config_gd",
			enabled: true,
			needsReauth: false,
			displayName: "Slack",
			transport: "STDIO",
			authType: "API_KEY",
			encryptedApiKey: "ENC:example-bot-token",
			mcpServer: {
				name: "Slack",
				transport: "STDIO",
				command: "npx -y @modelcontextprotocol/server-slack",
			},
		};
	}

	/** Slack's auth.test answers with `authTest`; the wrapper answers OK. */
	function stubFetch(authTest: () => Response | Promise<Response>) {
		vi.mocked(fetch).mockImplementation(async (input, init) => {
			if (String(input).startsWith("https://slack.com/api/auth.test")) {
				events.push("auth.test");
				return authTest();
			}
			events.push("post");
			wrapperBodies.push(JSON.parse(String(init?.body)));
			return new Response(
				JSON.stringify({ success: true, result: { tools: [] } }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});
	}

	const json = (body: unknown) =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});

	it("hands the wrapper the bot token and the team id", async () => {
		mockGetMcpConfigById.mockResolvedValue(slackConfig());
		stubFetch(() => json({ ok: true, team_id: "T-EXAMPLE" }));

		const client = await buildClient();
		await client.tools();

		expect(wrapperBodies[0]?.credentials).toEqual({
			SLACK_BOT_TOKEN: "example-bot-token",
			SLACK_TEAM_ID: "T-EXAMPLE",
		});
	});

	it.each([
		[
			"Slack refuses the lookup",
			() => json({ ok: false, error: "ratelimited" }),
		],
		[
			"the lookup fails",
			() => {
				throw new Error("network down");
			},
		],
	])(
		"builds no client and caches nothing when %s, so the next call looks the team id up again",
		async (_label, failure) => {
			mockGetMcpConfigById.mockResolvedValue(slackConfig());
			mockGetGrantGeneration.mockResolvedValue(0);
			stubFetch(failure);
			const options = {
				configId: "config_gd",
				userId: "user_a",
				organizationId: "org_a",
			};

			await expect(
				getCachedMcpClientForConfig(options),
			).rejects.toMatchObject({
				code: "SLACK_TEAM_ID_UNAVAILABLE",
				isAuthError: false,
			});
			expect(wrapperBodies).toHaveLength(0);

			stubFetch(() => json({ ok: true, team_id: "T-EXAMPLE" }));
			const next = await getCachedMcpClientForConfig(options);
			expect(next.fromCache).toBe(false);
			await (next.client as unknown as ToolsClient).tools();
			expect(wrapperBodies.at(-1)?.credentials.SLACK_TEAM_ID).toBe(
				"T-EXAMPLE",
			);
		},
	);

	it("reports a revoked bot token as an authentication failure", async () => {
		mockGetMcpConfigById.mockResolvedValue(slackConfig());
		stubFetch(() => json({ ok: false, error: "token_revoked" }));

		await expect(buildClient()).rejects.toMatchObject({
			code: "AUTH_FAILED",
			isAuthError: true,
		});
		expect(wrapperBodies).toHaveLength(0);
	});
});

describe("API-key STDIO clients in the client cache", () => {
	function azureDevOpsConfig(encryptedApiKey: string) {
		return {
			id: "config_ado",
			enabled: true,
			needsReauth: false,
			displayName: "Azure DevOps",
			transport: "STDIO",
			authType: "API_KEY",
			encryptedApiKey,
			commandArgs: ["example-org"],
			mcpServer: {
				name: "Azure DevOps",
				transport: "STDIO",
				command: "npx -y @azure-devops/mcp",
			},
		};
	}
	const options = {
		configId: "config_ado",
		userId: "user_a",
		organizationId: "org_a",
	};

	it("reuses a cached client while the key is unchanged, and builds a new one with the new key once it changes", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			azureDevOpsConfig("ENC:old-pat"),
		);
		mockGetEncryptedApiKey.mockResolvedValue("ENC:old-pat");

		const first = await getCachedMcpClientForConfig(options);
		const again = await getCachedMcpClientForConfig(options);
		expect(again.fromCache).toBe(true);
		expect(again.client).toBe(first.client);

		// The person saves a new PAT.
		mockGetMcpConfigById.mockResolvedValue(
			azureDevOpsConfig("ENC:new-pat"),
		);
		mockGetEncryptedApiKey.mockResolvedValue("ENC:new-pat");
		const rebuilt = await getCachedMcpClientForConfig(options);

		expect(rebuilt.fromCache).toBe(false);
		expect(rebuilt.client).not.toBe(first.client);
		await (rebuilt.client as unknown as ToolsClient).tools();
		expect(wrapperBodies.at(-1)?.credentials).toEqual({
			ADO_MCP_AUTH_TOKEN: "new-pat",
		});
	});

	it("drops a cached client when the key cannot be re-read", async () => {
		mockGetMcpConfigById.mockResolvedValue(
			azureDevOpsConfig("ENC:old-pat"),
		);
		const first = await getCachedMcpClientForConfig(options);
		mockGetEncryptedApiKey.mockRejectedValue(new Error("db down"));
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const next = await getCachedMcpClientForConfig(options);

		expect(next.fromCache).toBe(false);
		expect(next.client).not.toBe(first.client);
	});
});

describe("STDIO wrapper tool calls and the caller's abort signal", () => {
	type ExecTool = {
		execute: (
			args: unknown,
			options?: { abortSignal?: AbortSignal },
		) => Promise<unknown>;
	};
	let signals: (AbortSignal | undefined)[] = [];

	beforeEach(() => {
		signals = [];
		mockGetMcpConfigById.mockResolvedValue(gdriveConfig());
		vi.spyOn(global, "fetch").mockImplementation(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { method: string };
			signals.push(init?.signal ?? undefined);
			const result =
				body.method === "tools/list"
					? {
							tools: [
								{
									name: "create_card",
									inputSchema: {
										type: "object",
										properties: {},
									},
								},
							],
						}
					: { content: [{ type: "text", text: '{"id":"1"}' }] };
			return new Response(JSON.stringify({ success: true, result }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
	});

	async function createCardTool(): Promise<ExecTool> {
		const client = (await buildClient()) as unknown as {
			tools(): Promise<Record<string, ExecTool>>;
		};
		const tools = await client.tools();
		const tool = tools.create_card;
		if (!tool) {
			throw new Error("create_card was not listed");
		}
		return tool;
	}

	it("passes the tool call's abort signal to the wrapper request (a send ceiling tears it down)", async () => {
		const tool = await createCardTool();
		const controller = new AbortController();

		await tool.execute({}, { abortSignal: controller.signal });

		expect(signals.at(-1)).toBe(controller.signal);
	});

	it("sends nothing when the call's signal has already fired", async () => {
		const tool = await createCardTool();
		const posts = signals.length;

		await expect(
			tool.execute({}, { abortSignal: AbortSignal.abort() }),
		).rejects.toBeDefined();
		expect(signals.length).toBe(posts);
	});

	describe("past the send deadline of the code sending it (a PM create's)", () => {
		const NOW = 1_000_000;
		beforeEach(() => {
			vi.spyOn(performance, "now").mockReturnValue(NOW);
		});
		afterEach(() => {
			vi.mocked(performance.now).mockRestore();
		});

		it("a tool call is not sent, and fails as not sent; the tool list still is", async () => {
			const { isDispatchDeadlinePassedError, runWithDispatchDeadline } =
				await import("@repo/utils/dispatch-deadline");
			const outcome = await runWithDispatchDeadline(NOW, async () => {
				// The tool list is read inside the scope: not a tool call.
				const tool = await createCardTool();
				const posts = signals.length;
				const error = await tool
					.execute({}, { abortSignal: new AbortController().signal })
					.then(
						() => null,
						(e: unknown) => e,
					);
				return { error, sent: signals.length - posts };
			});

			expect(outcome.sent).toBe(0);
			expect(isDispatchDeadlinePassedError(outcome.error)).toBe(true);
		});

		it("a tool call is sent while the deadline is ahead", async () => {
			const { runWithDispatchDeadline } = await import(
				"@repo/utils/dispatch-deadline"
			);
			const tool = await createCardTool();
			const posts = signals.length;

			await runWithDispatchDeadline(NOW + 50_000, () =>
				tool.execute({}, { abortSignal: new AbortController().signal }),
			);

			expect(signals.length).toBe(posts + 1);
		});
	});
});
