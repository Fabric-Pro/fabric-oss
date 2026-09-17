/**
 * SSRF guard on MCP server URLs.
 *
 * The persisted `baseUrl` is tenant-supplied and connected to later on paths
 * with no caller present to refuse. What these pin is the shape of the
 * exception: a developer's MCP server on localhost is the normal case, so the
 * block must be escapable by the operator without being escapable by the
 * request — and Fabric's own /api/mcp/* routes on the deployment's own origin
 * are not a request's to declare either.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns")>();
	return {
		...actual,
		lookup: (...args: unknown[]) => lookupMock(...args),
	};
});

import {
	assertMcpServerUrlResolved,
	fetchMcpServer,
	getMcpServerBlockedReason,
	getMcpServerUrlBlockReason,
	MCP_SERVER_ALLOWED_HOSTS_ENV,
} from "../server-url-guard";

const ORIGINAL_ALLOWED = process.env[MCP_SERVER_ALLOWED_HOSTS_ENV];
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

function setEnv(key: string, value: string | undefined) {
	if (value === undefined) {
		delete (process.env as Record<string, string | undefined>)[key];
	} else {
		(process.env as Record<string, string | undefined>)[key] = value;
	}
}

function resolveTo(address: string) {
	lookupMock.mockImplementation(
		(
			_hostname: string,
			_options: unknown,
			callback: (
				error: Error | null,
				addresses: { address: string; family: number }[],
			) => void,
		) => callback(null, [{ address, family: 4 }]),
	);
}

/** A loopback server whose every response is a redirect to `location`. */
async function redirectingServer(location: string) {
	const server = createServer((_request, response) => {
		response.statusCode = 302;
		response.setHeader("location", location);
		response.end();
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const { port } = server.address() as AddressInfo;
	return {
		port,
		close: () =>
			new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

beforeEach(() => {
	lookupMock.mockReset();
	setEnv(MCP_SERVER_ALLOWED_HOSTS_ENV, undefined);
	setEnv("NEXT_PUBLIC_SITE_URL", undefined);
	setEnv("NODE_ENV", "production");
});

afterEach(() => {
	setEnv(MCP_SERVER_ALLOWED_HOSTS_ENV, ORIGINAL_ALLOWED);
	setEnv("NEXT_PUBLIC_SITE_URL", ORIGINAL_SITE_URL);
	setEnv("NODE_ENV", ORIGINAL_NODE_ENV);
	vi.unstubAllGlobals();
});

describe("addresses the server must not connect to", () => {
	it.each([
		"http://169.254.169.254/latest/meta-data/",
		"http://127.0.0.1:7233/",
		"http://10.0.0.1/",
		"http://[::1]/",
		"http://localhost:3000/mcp",
		"http://192.168.1.100/mcp",
		"http://myserver.local/mcp",
	])("refuses %s before any request", async (url) => {
		expect(getMcpServerUrlBlockReason(url)).toMatch(
			new RegExp(MCP_SERVER_ALLOWED_HOSTS_ENV),
		);
		await expect(assertMcpServerUrlResolved(url)).rejects.toThrow(
			new RegExp(MCP_SERVER_ALLOWED_HOSTS_ENV),
		);
		await expect(fetchMcpServer(url)).rejects.toThrow(/not allowed/);
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("refuses a public hostname that resolves to a private address", async () => {
		resolveTo("10.0.0.1");
		expect(
			getMcpServerUrlBlockReason("https://mcp.internal.example/mcp"),
		).toBeNull();
		await expect(
			assertMcpServerUrlResolved("https://mcp.internal.example/mcp"),
		).rejects.toThrow(/Private network access.*MCP_SERVER_ALLOWED_HOSTS/s);
	});

	it("refuses that hostname at fetch time too, and names the setting", async () => {
		resolveTo("10.0.0.1");
		let caught: unknown;
		try {
			await fetchMcpServer("https://mcp.internal.example/mcp");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(getMcpServerBlockedReason(caught)).toMatch(
			/Blocked outbound connection.*MCP_SERVER_ALLOWED_HOSTS/s,
		);
	});

	it("refuses at fetch time a name that answered a public address to the pre-connect check", async () => {
		// Split-horizon / rebinding: the check sees a public answer, the
		// connection gets a private one. The check is a courtesy; the fetch
		// is the guard.
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
						address: calls === 1 ? "93.184.216.34" : "10.0.0.1",
						family: 4,
					},
				]);
			},
		);
		await expect(
			assertMcpServerUrlResolved("https://mcp.rebind.example/mcp"),
		).resolves.toBeUndefined();
		const caught = await rejection(
			fetchMcpServer("https://mcp.rebind.example/mcp"),
		);
		expect(getMcpServerBlockedReason(caught)).toMatch(
			/Blocked outbound connection.*MCP_SERVER_ALLOWED_HOSTS/s,
		);
	});

	it("accepts an ordinary public server and pins its DNS", async () => {
		resolveTo("93.184.216.34");
		const fetchMock = vi.fn(
			async (_input: string | URL, _init?: RequestInit) =>
				new Response("ok"),
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(
			getMcpServerUrlBlockReason("https://mcp.example.com/mcp"),
		).toBeNull();
		await expect(
			assertMcpServerUrlResolved("https://mcp.example.com/mcp"),
		).resolves.toBeUndefined();

		await fetchMcpServer("https://mcp.example.com/mcp", { method: "POST" });
		const [, init] = fetchMock.mock.calls[0];
		expect(init).toMatchObject({ method: "POST", redirect: "error" });
		expect(
			Object.getOwnPropertyDescriptor(init, "dispatcher")?.value,
		).toBeDefined();
	});
});

describe("the operator's exceptions", () => {
	it("permits a declared host and fetches it without DNS pinning, but still refusing redirects", async () => {
		setEnv(MCP_SERVER_ALLOWED_HOSTS_ENV, "localhost");
		const fetchMock = vi.fn(
			async (_input: string | URL, _init?: RequestInit) =>
				new Response("ok"),
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(
			getMcpServerUrlBlockReason("http://localhost:3000/mcp"),
		).toBeNull();
		await expect(
			assertMcpServerUrlResolved("http://localhost:3000/mcp"),
		).resolves.toBeUndefined();
		await fetchMcpServer("http://localhost:3000/mcp", { method: "POST" });
		const [, init] = fetchMock.mock.calls[0];
		expect(init).toMatchObject({ method: "POST", redirect: "error" });
		expect(init).not.toHaveProperty("dispatcher");
		// Declaring one host widens nothing else.
		expect(
			getMcpServerUrlBlockReason("http://127.0.0.1:3000/mcp"),
		).not.toBeNull();
	});

	it("does not let a declared host redirect the request to a destination nobody declared", async () => {
		setEnv(MCP_SERVER_ALLOWED_HOSTS_ENV, "127.0.0.1");
		const server = await redirectingServer("http://10.0.0.1/latest/");
		try {
			const caught = await rejection(
				fetchMcpServer(`http://127.0.0.1:${server.port}/mcp`),
			);
			expect(caught).toBeInstanceOf(Error);
			expect(String((caught as Error).cause ?? caught)).toMatch(
				/redirect/i,
			);
		} finally {
			await server.close();
		}
	});

	it("does not let a Fabric-hosted route redirect the request off the deployment either", async () => {
		const server = await redirectingServer("http://169.254.169.254/");
		setEnv("NEXT_PUBLIC_SITE_URL", `http://127.0.0.1:${server.port}`);
		try {
			const url = `http://127.0.0.1:${server.port}/api/mcp/fabric`;
			expect(getMcpServerUrlBlockReason(url)).toBeNull();
			const caught = await rejection(fetchMcpServer(url));
			expect(String((caught as Error).cause ?? caught)).toMatch(
				/redirect/i,
			);
		} finally {
			await server.close();
		}
	});

	it("permits loopback outside production so a checkout works unconfigured", () => {
		setEnv("NODE_ENV", "development");
		expect(
			getMcpServerUrlBlockReason("http://localhost:3000/mcp"),
		).toBeNull();
		expect(
			getMcpServerUrlBlockReason("http://169.254.169.254/"),
		).not.toBeNull();
	});

	it("permits Fabric's own /api/mcp/* routes on the deployment's origin only", () => {
		setEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3001");
		expect(
			getMcpServerUrlBlockReason("http://localhost:3001/api/mcp/fabric"),
		).toBeNull();
		// Same host, different path: not a Fabric-hosted MCP route.
		expect(
			getMcpServerUrlBlockReason("http://localhost:3001/admin"),
		).not.toBeNull();
		// Same path, different port: not this deployment.
		expect(
			getMcpServerUrlBlockReason("http://localhost:3002/api/mcp/fabric"),
		).not.toBeNull();
	});

	it("is set by the operator, never by the request", () => {
		setEnv(MCP_SERVER_ALLOWED_HOSTS_ENV, "");
		setEnv("NODE_ENV", "development");
		expect(
			getMcpServerUrlBlockReason("http://localhost:3000/mcp"),
		).not.toBeNull();
	});
});
