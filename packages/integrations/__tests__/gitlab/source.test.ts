/**
 * `resolveGitLabSource` chooses the TRANSPORT (official MCP or the REST
 * adapter) for a person's GitLab calls. Both carry the same credential: the
 * person's GitLab connection. The `gitlab-official` MCPConfig contributes only
 * its endpoint URL, and only when that endpoint is on the GitLab instance the
 * credential was issued by.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "./helpers/gitlab-fake-db";

vi.mock("@repo/utils", async (importOriginal) => {
	const helpers = await import("./helpers/gitlab-fake-db");
	return {
		...(await importOriginal<object>()),
		decryptApiKey: helpers.fakeDecrypt,
		encryptApiKey: helpers.fakeEncrypt,
	};
});

import {
	GitLabMcpError,
	GitLabMcpMethodNotFoundError,
} from "../../src/gitlab/mcp-client";
import {
	callMcpWithRestFallback,
	type GitLabSource,
	resolveGitLabSource,
} from "../../src/gitlab/source";

const USER = "user-1";
const ORG = "org-1";
const officialServer = {
	id: "srv-official",
	key: "gitlab-official",
	defaultUrl: "https://gitlab.com/api/v4/mcp",
};

function connection(
	credential: Record<string, unknown>,
	settings: Record<string, unknown> = {},
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
		settings,
		isActive: true,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		...extra,
	};
}

const liveCredential = {
	access_token: "connection-token",
	refresh_token: "connection-refresh",
	expires_in: 7200,
	token_obtained_at: new Date().toISOString(),
	issuer: {
		kind: "app",
		clientId: "app-client",
		origin: "https://gitlab.com",
	},
	connectionGeneration: 1,
};

function officialConfig(extra: Record<string, unknown> = {}) {
	return {
		id: "cfg-official",
		userId: USER,
		organizationId: ORG,
		mcpServerId: officialServer.id,
		baseUrl: null,
		oauthClientId: "dcr-client",
		encryptedOauthClientSecret: null,
		dcrClientMetadata: null,
		// The MCP copy is never what a transport sends.
		encryptedAccessToken: "enc:mcp-copy-token",
		encryptedRefreshToken: "enc:mcp-copy-refresh",
		tokenExpiresAt: new Date(Date.now() + 3_600_000),
		needsReauth: false,
		enabled: true,
		authType: "OAUTH2",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		...extra,
	};
}

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

function depsFor(fake: ReturnType<typeof createGitLabFakeDb>) {
	return {
		db: fake.db as never,
		withLock: fake.withLock as never,
		fetchImpl: fetchMock as never,
	};
}

/** The bearer token an official-MCP source actually sends. */
async function bearerSentBy(source: GitLabSource | null) {
	expect(source?.kind).toBe("official-mcp");
	fetchMock.mockResolvedValueOnce({
		ok: true,
		status: 200,
		headers: new Headers({ "content-type": "application/json" }),
		json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
		text: async () =>
			JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
	});
	await (source as Extract<GitLabSource, { kind: "official-mcp" }>)
		.callTool("list_projects", {})
		.catch(() => undefined);
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	const headers = new Headers(init.headers);
	return { url, authorization: headers.get("authorization") };
}

describe("resolveGitLabSource", () => {
	it("returns null when the person has no GitLab connection", async () => {
		const fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			// A tokenless registration row is not a connection.
			mCPConfig: [
				officialConfig({
					encryptedAccessToken: null,
					encryptedRefreshToken: null,
				}),
			],
		});
		expect(
			await resolveGitLabSource({
				userId: USER,
				organizationId: ORG,
				deps: depsFor(fake),
			}),
		).toBeNull();
	});

	it("uses the REST adapter with the connection's token when no official MCP row exists", async () => {
		const fake = createGitLabFakeDb({
			workflowIntegration: [connection(liveCredential)],
		});
		expect(
			await resolveGitLabSource({
				userId: USER,
				organizationId: ORG,
				deps: depsFor(fake),
			}),
		).toEqual({
			kind: "rest-adapter",
			credential: {
				token: "connection-token",
				apiBase: "https://gitlab.com/api/v4",
			},
		});
	});

	it("routes through the official MCP endpoint with the CONNECTION's token, never the MCP copy", async () => {
		const fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [officialConfig()],
			workflowIntegration: [
				connection(liveCredential, { useOfficialMcp: true }),
			],
		});
		const source = await resolveGitLabSource({
			userId: USER,
			organizationId: ORG,
			deps: depsFor(fake),
		});
		const sent = await bearerSentBy(source);
		expect(sent.url).toBe("https://gitlab.com/api/v4/mcp");
		expect(sent.authorization).toBe("Bearer connection-token");
	});

	it("uses the row's baseUrl over the server default", async () => {
		const fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				officialConfig({
					baseUrl: "https://gitlab.com/api/v4/mcp-beta",
				}),
			],
			workflowIntegration: [connection(liveCredential)],
		});
		const source = await resolveGitLabSource({
			userId: USER,
			organizationId: ORG,
			deps: depsFor(fake),
		});
		expect((await bearerSentBy(source)).url).toBe(
			"https://gitlab.com/api/v4/mcp-beta",
		);
	});

	it("never sends the token to an MCP endpoint on a different GitLab instance", async () => {
		const fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				officialConfig({
					baseUrl: "https://gitlab.example.com/api/v4/mcp",
				}),
			],
			workflowIntegration: [
				connection(liveCredential, { useOfficialMcp: true }),
			],
		});
		const source = await resolveGitLabSource({
			userId: USER,
			organizationId: ORG,
			deps: depsFor(fake),
		});
		expect(source).toEqual({
			kind: "rest-adapter",
			credential: {
				token: "connection-token",
				apiBase: "https://gitlab.com/api/v4",
			},
		});
	});

	it("ignores a disabled official row, and another person's or another context's row", async () => {
		const fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				officialConfig({ id: "cfg-disabled", enabled: false }),
				officialConfig({ id: "cfg-teammate", userId: "user-2" }),
				officialConfig({
					id: "cfg-other-org",
					organizationId: "org-2",
				}),
			],
			workflowIntegration: [connection(liveCredential)],
		});
		expect(
			await resolveGitLabSource({
				userId: USER,
				organizationId: ORG,
				deps: depsFor(fake),
			}),
		).toEqual({
			kind: "rest-adapter",
			credential: {
				token: "connection-token",
				apiBase: "https://gitlab.com/api/v4",
			},
		});
	});

	it("returns null when the connection needs reconnecting, even with an official row", async () => {
		const fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [officialConfig()],
			workflowIntegration: [
				connection(liveCredential, { needsReauth: true }),
			],
		});
		expect(
			await resolveGitLabSource({
				userId: USER,
				organizationId: ORG,
				deps: depsFor(fake),
			}),
		).toBeNull();
	});
});

describe("resolveGitLabSource — useOfficialMcp flag", () => {
	it("returns rest-adapter when settings.useOfficialMcp === false", async () => {
		const fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [officialConfig()],
			workflowIntegration: [
				connection(liveCredential, { useOfficialMcp: false }),
			],
		});
		expect(
			await resolveGitLabSource({
				userId: USER,
				organizationId: ORG,
				deps: depsFor(fake),
			}),
		).toEqual({
			kind: "rest-adapter",
			credential: {
				token: "connection-token",
				apiBase: "https://gitlab.com/api/v4",
			},
		});
	});

	it("falls through to REST when settings.useOfficialMcp === true but the official row is missing", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const fake = createGitLabFakeDb({
			workflowIntegration: [
				connection(liveCredential, { useOfficialMcp: true }),
			],
		});
		expect(
			await resolveGitLabSource({
				userId: USER,
				organizationId: ORG,
				deps: depsFor(fake),
			}),
		).toEqual({
			kind: "rest-adapter",
			credential: {
				token: "connection-token",
				apiBase: "https://gitlab.com/api/v4",
			},
		});
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("keeps the legacy choice (official MCP when its row exists) when the flag is unset", async () => {
		const fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [officialConfig()],
			workflowIntegration: [connection(liveCredential)],
		});
		const source = await resolveGitLabSource({
			userId: USER,
			organizationId: ORG,
			deps: depsFor(fake),
		});
		expect(source?.kind).toBe("official-mcp");
	});
});

describe("callMcpWithRestFallback", () => {
	function officialMcpSource(
		callTool: (
			name: string,
			args: Record<string, unknown>,
		) => Promise<unknown>,
	): GitLabSource {
		return { kind: "official-mcp", callTool };
	}

	it("read (no idempotent flag) + network Error falls back to REST", async () => {
		const callTool = vi.fn().mockRejectedValue(new Error("network down"));
		const restFallback = vi.fn().mockResolvedValue("rest-value");

		const result = await callMcpWithRestFallback({
			source: officialMcpSource(callTool),
			method: "list_issues",
			args: {},
			restFallback,
		});

		expect(result).toBe("rest-value");
		expect(restFallback).toHaveBeenCalledOnce();
	});

	it("write (idempotent: false) + network Error rethrows and does NOT fall back", async () => {
		const networkErr = new Error("network down");
		const callTool = vi.fn().mockRejectedValue(networkErr);
		const restFallback = vi.fn().mockResolvedValue("rest-value");

		await expect(
			callMcpWithRestFallback({
				source: officialMcpSource(callTool),
				method: "create_issue",
				args: {},
				restFallback,
				idempotent: false,
			}),
		).rejects.toBe(networkErr);
		expect(restFallback).not.toHaveBeenCalled();
	});

	it("write (idempotent: false) + GitLabMcpMethodNotFoundError still falls back to REST", async () => {
		const callTool = vi
			.fn()
			.mockRejectedValue(new GitLabMcpMethodNotFoundError("no method"));
		const restFallback = vi.fn().mockResolvedValue("rest-value");

		const result = await callMcpWithRestFallback({
			source: officialMcpSource(callTool),
			method: "create_issue",
			args: {},
			restFallback,
			idempotent: false,
		});

		expect(result).toBe("rest-value");
		expect(restFallback).toHaveBeenCalledOnce();
	});

	it("GitLabMcpError always rethrows and never falls back", async () => {
		const mcpErr = new GitLabMcpError("boom", 500);
		const callTool = vi.fn().mockRejectedValue(mcpErr);
		const restFallback = vi.fn().mockResolvedValue("rest-value");

		await expect(
			callMcpWithRestFallback({
				source: officialMcpSource(callTool),
				method: "list_issues",
				args: {},
				restFallback,
			}),
		).rejects.toBe(mcpErr);
		expect(restFallback).not.toHaveBeenCalled();
	});
});

describe("official MCP capability loss", () => {
	const notFound = () => ({
		ok: false,
		status: 404,
		text: async () => "404 Not Found",
	});

	async function officialSource(fake: ReturnType<typeof createGitLabFakeDb>) {
		const source = await resolveGitLabSource({
			userId: USER,
			organizationId: ORG,
			deps: depsFor(fake),
		});
		expect(source?.kind).toBe("official-mcp");
		return source as GitLabSource;
	}

	it("falls back to REST on a 404 from the endpoint — even for a write — and records the loss", async () => {
		const fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [officialConfig()],
			workflowIntegration: [
				connection(liveCredential, { useOfficialMcp: true }),
			],
		});
		const source = await officialSource(fake);
		fetchMock.mockResolvedValueOnce(notFound());
		const restFallback = vi.fn(async () => "rest-result");

		const result = await callMcpWithRestFallback({
			source,
			method: "create_issue",
			args: { project_id: "group/app", title: "t" },
			restFallback,
			idempotent: false,
		});

		expect(result).toBe("rest-result");
		expect(restFallback).toHaveBeenCalledTimes(1);
		expect(fake.tables.workflowIntegration[0].settings).toMatchObject({
			useOfficialMcp: false,
			mcpProbe: { status: "not-found", httpStatus: 404 },
		});
		// The issuer's registration is kept: only the routing flag moved.
		expect(fake.tables.mCPConfig).toHaveLength(1);
		expect(fake.tables.mCPConfig[0]).toMatchObject({
			oauthClientId: "dcr-client",
			enabled: true,
		});
		// Later calls go straight to REST.
		expect(
			(
				await resolveGitLabSource({
					userId: USER,
					organizationId: ORG,
					deps: depsFor(fake),
				})
			)?.kind,
		).toBe("rest-adapter");
	});

	it("does not record the loss over a connection that changed since the source was built", async () => {
		const fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [officialConfig()],
			workflowIntegration: [
				connection(liveCredential, { useOfficialMcp: true }),
			],
		});
		const source = await officialSource(fake);
		// A reconnect lands while the call is in flight.
		fake.tables.workflowIntegration[0].credentials = encryptedCredential({
			...liveCredential,
			access_token: "reconnected-token",
			connectionGeneration: 2,
		});
		fetchMock.mockResolvedValueOnce(notFound());

		const result = await callMcpWithRestFallback({
			source,
			method: "list_issues",
			args: {},
			restFallback: async () => "rest-result",
		});

		expect(result).toBe("rest-result");
		expect(fake.tables.workflowIntegration[0].settings).toEqual({
			useOfficialMcp: true,
		});
	});

	it("still rethrows an ambiguous MCP error on a write and leaves the routing flag alone", async () => {
		const fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [officialConfig()],
			workflowIntegration: [
				connection(liveCredential, { useOfficialMcp: true }),
			],
		});
		const source = await officialSource(fake);
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 500,
			text: async () => "boom",
		});
		const restFallback = vi.fn(async () => "rest-result");

		await expect(
			callMcpWithRestFallback({
				source,
				method: "create_issue",
				args: {},
				restFallback,
				idempotent: false,
			}),
		).rejects.toBeInstanceOf(GitLabMcpError);
		expect(restFallback).not.toHaveBeenCalled();
		expect(fake.tables.workflowIntegration[0].settings).toEqual({
			useOfficialMcp: true,
		});
	});
});

describe("REST source origin", () => {
	it("carries the REST base of the instance that issued the credential", async () => {
		const fake = createGitLabFakeDb({
			workflowIntegration: [
				connection({
					...liveCredential,
					issuer: {
						kind: "app",
						clientId: "app-client",
						origin: "https://gitlab.example.com",
					},
				}),
			],
		});

		expect(
			await resolveGitLabSource({
				userId: USER,
				organizationId: ORG,
				deps: depsFor(fake),
			}),
		).toEqual({
			kind: "rest-adapter",
			credential: {
				token: "connection-token",
				apiBase: "https://gitlab.example.com/api/v4",
			},
		});
	});
});
