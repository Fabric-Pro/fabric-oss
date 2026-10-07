/**
 * `createMcpClient` refuses internal destinations before connecting and
 * hands the SDK transports a guarded fetch, so every request they make is
 * re-checked at DNS-lookup time and refuses redirects. The OAuth path uses
 * the same transports (with the provider attached) rather than the AI SDK
 * transport config, which would resolve and connect on its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMCPClientMock = vi.fn();
const streamableCtor = vi.fn();
const sseCtor = vi.fn();

vi.mock("@ai-sdk/mcp", () => ({
	createMCPClient: (...args: unknown[]) => createMCPClientMock(...args),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {
		constructor(...args: unknown[]) {
			streamableCtor(...args);
		}
	},
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: class {
		constructor(...args: unknown[]) {
			sseCtor(...args);
		}
	},
}));
vi.mock("@repo/database", () => ({
	getMcpConfigById: vi.fn(),
	getValidAccessToken: vi.fn(),
	getMcpConfigByIdInternal: vi.fn(),
	getMcpOAuthGrantGeneration: vi.fn(),
	// The config owner is a member whose role allows MCP read and connect
	// (the organization gate in ../organization-access).
	canConnectOrganizationMcpConfigs: async () => true,
	canReadOrganizationMcpConfigs: async () => true,
	isOrganizationMember: async () => true,
}));

const lookupMock = vi.fn();
vi.mock("node:dns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns")>();
	return {
		...actual,
		lookup: (...args: unknown[]) => lookupMock(...args),
	};
});

import {
	createMcpClient,
	McpClientError,
	oauthRequestsRefuseRedirects,
} from "../client";
import { fetchMcpServer, getMcpServerBlockedReason } from "../server-url-guard";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOWED = process.env.MCP_SERVER_ALLOWED_HOSTS;

function setEnv(key: string, value: string | undefined) {
	if (value === undefined) {
		delete (process.env as Record<string, string | undefined>)[key];
	} else {
		(process.env as Record<string, string | undefined>)[key] = value;
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	setEnv("NODE_ENV", "production");
	setEnv("MCP_SERVER_ALLOWED_HOSTS", undefined);
	createMCPClientMock.mockResolvedValue({ tools: vi.fn(), close: vi.fn() });
	lookupMock.mockImplementation(
		(
			_hostname: string,
			_options: unknown,
			callback: (
				error: Error | null,
				addresses: { address: string; family: number }[],
			) => void,
		) => callback(null, [{ address: "93.184.216.34", family: 4 }]),
	);
});

afterEach(() => {
	setEnv("NODE_ENV", ORIGINAL_NODE_ENV);
	setEnv("MCP_SERVER_ALLOWED_HOSTS", ORIGINAL_ALLOWED);
});

async function expectBlocked(promise: Promise<unknown>) {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(McpClientError);
	expect((caught as McpClientError).code).toBe("BLOCKED_URL");
	expect((caught as McpClientError).message).toMatch(
		/MCP_SERVER_ALLOWED_HOSTS/,
	);
}

describe("createMcpClient outbound guard", () => {
	it.each([
		"http://169.254.169.254/latest/meta-data/",
		"http://127.0.0.1:7233/",
		"http://10.0.0.1/",
		"http://[::1]/",
	])(
		"refuses %s on the direct transport path without connecting",
		async (url) => {
			await expectBlocked(
				createMcpClient({ serverUrl: url, transport: "HTTP" }),
			);
			expect(createMCPClientMock).not.toHaveBeenCalled();
			expect(streamableCtor).not.toHaveBeenCalled();
		},
	);

	it("refuses an internal address on the OAuth path too", async () => {
		await expectBlocked(
			createMcpClient({
				serverUrl: "http://10.0.0.1/mcp",
				transport: "HTTP",
				authProvider: {} as never,
			}),
		);
		expect(createMCPClientMock).not.toHaveBeenCalled();
	});

	it("refuses a public hostname that resolves to a private address", async () => {
		lookupMock.mockImplementation(
			(
				_hostname: string,
				_options: unknown,
				callback: (
					error: Error | null,
					addresses: { address: string; family: number }[],
				) => void,
			) => callback(null, [{ address: "169.254.169.254", family: 4 }]),
		);
		await expectBlocked(
			createMcpClient({
				serverUrl: "https://mcp.internal.example/mcp",
				transport: "HTTP",
			}),
		);
		expect(createMCPClientMock).not.toHaveBeenCalled();
	});

	it("connects to a public server through the guarded fetch on both transports", async () => {
		await createMcpClient({
			serverUrl: "https://mcp.example.com/mcp",
			transport: "HTTP",
			headers: { Authorization: "Bearer x" },
		});
		expect(streamableCtor).toHaveBeenCalledTimes(1);
		const [httpUrl, httpOptions] = streamableCtor.mock.calls[0] as [
			URL,
			{ fetch?: unknown; requestInit?: RequestInit },
		];
		expect(httpUrl.href).toBe("https://mcp.example.com/mcp");
		expect(httpOptions.fetch).toBe(fetchMcpServer);
		expect(httpOptions.requestInit?.headers).toEqual({
			Authorization: "Bearer x",
		});

		await createMcpClient({
			serverUrl: "https://mcp.example.com/sse",
			transport: "SSE",
		});
		expect(sseCtor).toHaveBeenCalledTimes(1);
		expect(
			(sseCtor.mock.calls[0] as [URL, { fetch?: unknown }])[1].fetch,
		).toBe(fetchMcpServer);
	});

	it("connects on the OAuth path through the SDK transport carrying the guarded fetch and the provider", async () => {
		const authProvider = { tokens: vi.fn() } as never;
		await createMcpClient({
			serverUrl: "https://mcp.example.com/mcp",
			transport: "HTTP",
			headers: { "X-Tenant": "t" },
			authProvider,
		});
		expect(streamableCtor).toHaveBeenCalledTimes(1);
		const [, httpOptions] = streamableCtor.mock.calls[0] as [
			URL,
			{
				fetch?: unknown;
				authProvider?: unknown;
				requestInit?: RequestInit;
			},
		];
		// The guarded fetch, wrapped so the SDK's OAuth requests refuse
		// redirects (see the `oauthRequestsRefuseRedirects` suite below).
		expect(typeof httpOptions.fetch).toBe("function");
		expect(httpOptions.authProvider).toBe(authProvider);
		expect(httpOptions.requestInit?.headers).toEqual({ "X-Tenant": "t" });
		// The client is created from that transport, never from a URL config
		// the SDK would connect to by itself.
		expect(createMCPClientMock).toHaveBeenCalledTimes(1);
		const [{ transport: given }] = createMCPClientMock.mock.calls[0] as [
			{ transport: unknown },
		];
		expect(given).not.toHaveProperty("url");
		expect(given).not.toHaveProperty("type");

		await createMcpClient({
			serverUrl: "https://mcp.example.com/sse",
			transport: "SSE",
			authProvider,
		});
		expect(sseCtor).toHaveBeenCalledTimes(1);
		const [, sseOptions] = sseCtor.mock.calls[0] as [
			URL,
			{ fetch?: unknown; authProvider?: unknown },
		];
		expect(typeof sseOptions.fetch).toBe("function");
		expect(sseOptions.authProvider).toBe(authProvider);
	});

	it("routes the OAuth path's requests through the guarded fetch it was given", async () => {
		const baseFetch = vi.fn(
			async (_url: string | URL, _init?: RequestInit) =>
				new Response("{}"),
		);
		await createMcpClient({
			serverUrl: "https://mcp.example.com/mcp",
			transport: "HTTP",
			authProvider: { tokens: vi.fn() } as never,
			fetch: baseFetch,
		});
		const [, httpOptions] = streamableCtor.mock.calls[0] as [
			URL,
			{ fetch: (url: string, init?: RequestInit) => Promise<Response> },
		];
		await httpOptions.fetch("https://mcp.example.com/mcp", {
			method: "POST",
			body: "{}",
		});
		expect(baseFetch).toHaveBeenCalledWith("https://mcp.example.com/mcp", {
			method: "POST",
			body: "{}",
		});
	});

	it("refuses the OAuth connection itself when the name answers a private address after passing the pre-connect check", async () => {
		let calls = 0;
		lookupMock.mockImplementation(
			(
				_hostname: string,
				_options: unknown,
				callback: (
					error: Error | null,
					addresses: { address: string; family: number }[],
				) => void,
			) => {
				calls += 1;
				callback(null, [
					{
						address:
							calls === 1 ? "93.184.216.34" : "169.254.169.254",
						family: 4,
					},
				]);
			},
		);
		await createMcpClient({
			serverUrl: "https://mcp.rebind.example/mcp",
			transport: "HTTP",
			authProvider: {} as never,
		});
		const [, httpOptions] = streamableCtor.mock.calls[0] as [
			URL,
			{ fetch: typeof fetch },
		];
		// What the transport will use for every request, including the
		// SDK's OAuth discovery and token exchange.
		let caught: unknown;
		try {
			await httpOptions.fetch("https://mcp.rebind.example/mcp", {
				method: "POST",
			});
		} catch (error) {
			caught = error;
		}
		expect(getMcpServerBlockedReason(caught)).toMatch(
			/Blocked outbound connection.*MCP_SERVER_ALLOWED_HOSTS/s,
		);
	});

	it("permits a declared host, so a self-hosted server on its own network still works", async () => {
		setEnv("MCP_SERVER_ALLOWED_HOSTS", "mcp.internal");
		lookupMock.mockImplementation(
			(
				_hostname: string,
				_options: unknown,
				callback: (
					error: Error | null,
					addresses: { address: string; family: number }[],
				) => void,
			) => callback(null, [{ address: "10.0.0.1", family: 4 }]),
		);
		await createMcpClient({
			serverUrl: "http://mcp.internal:8080/mcp",
			transport: "HTTP",
		});
		expect(createMCPClientMock).toHaveBeenCalledTimes(1);
	});
});

describe("oauthRequestsRefuseRedirects", () => {
	const serverUrl = new URL("https://mcp.example.com/mcp");

	it("refuses redirects for a token request, even on the MCP server's own origin", async () => {
		const baseFetch = vi.fn(
			async (_url: string | URL, _init?: RequestInit) =>
				new Response("{}"),
		);
		const wrapped = oauthRequestsRefuseRedirects(serverUrl, baseFetch);
		const body = new URLSearchParams({ grant_type: "refresh_token" });

		await wrapped("https://mcp.example.com/token", {
			method: "POST",
			body,
			redirect: "manual",
		});

		expect(baseFetch).toHaveBeenCalledWith(
			"https://mcp.example.com/token",
			{
				method: "POST",
				body,
				redirect: "error",
			},
		);
	});

	it("refuses redirects for anything sent off the MCP server's origin", async () => {
		const baseFetch = vi.fn(
			async (_url: string | URL, _init?: RequestInit) =>
				new Response("{}"),
		);
		const wrapped = oauthRequestsRefuseRedirects(serverUrl, baseFetch);

		await wrapped(
			new URL(
				"https://as.example.com/.well-known/oauth-authorization-server",
			),
			{ redirect: "manual" },
		);

		expect(baseFetch.mock.calls[0]?.[1]).toEqual({ redirect: "error" });
	});

	it("leaves the MCP server's own requests to the SDK's same-origin handling", async () => {
		const baseFetch = vi.fn(
			async (_url: string | URL, _init?: RequestInit) =>
				new Response("{}"),
		);
		const wrapped = oauthRequestsRefuseRedirects(serverUrl, baseFetch);
		const init = {
			method: "POST",
			body: "{}",
			redirect: "manual" as const,
		};

		await wrapped("https://mcp.example.com/mcp", init);

		expect(baseFetch).toHaveBeenCalledWith(
			"https://mcp.example.com/mcp",
			init,
		);
	});
});
