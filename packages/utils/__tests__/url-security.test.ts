import type { LookupAddress } from "node:dns";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createOutboundHostAllowlist,
	createSafeOutboundLookup,
	getBlockedOutboundReason,
	getUnsafeUrlReason,
	type ResolveAllAddresses,
	safeFetchOutbound,
} from "../lib/url-security";

function resolverFor(addresses: LookupAddress[]): ResolveAllAddresses {
	return (_hostname, _options, callback) => callback(null, addresses);
}

function lookupOne(addresses: LookupAddress[]) {
	const safeLookup = createSafeOutboundLookup(resolverFor(addresses));
	return new Promise<{
		error: NodeJS.ErrnoException | null;
		address: string | LookupAddress[];
		family: number | undefined;
	}>((resolve) => {
		safeLookup(
			"service.example.com",
			{ all: false },
			(error, address, family) => resolve({ error, address, family }),
		);
	});
}

describe("outbound URL validation", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		"http://[::ffff:169.254.169.254]/latest/meta-data/",
		"http://[::ffff:a9fe:a9fe]/latest/meta-data/",
		"http://metadata.google.internal./",
		"http://0.0.0.0/",
		"http://100.64.0.1/",
		"http://224.0.0.1/",
		"http://[64:ff9b::a9fe:a9fe]/",
		"http://[fec0::1]/",
		"http://[2002:a9fe:a9fe::1]/",
		"http://[2001:0000::1]/",
		"http://[2001:db8::1]/",
		"http://[3fff::1]/",
	])("blocks non-public literal target %s", (url) => {
		expect(getUnsafeUrlReason(url)).not.toBeNull();
	});

	it("rejects the whole DNS answer when any address is private", async () => {
		const result = await lookupOne([
			{ address: "93.184.216.34", family: 4 },
			{ address: "169.254.169.254", family: 4 },
		]);

		expect(result.error?.code).toBe("EACCES");
		expect(result.error?.message).toMatch(/link-local|blocked/i);
	});

	it("returns a validated public address to the socket connector", async () => {
		const result = await lookupOne([
			{ address: "93.184.216.34", family: 4 },
		]);

		expect(result).toEqual({
			error: null,
			address: "93.184.216.34",
			family: 4,
		});
	});

	it("preserves all validated addresses when the connector asks for all", async () => {
		const addresses = [
			{ address: "93.184.216.34", family: 4 },
			{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
		];
		const safeLookup = createSafeOutboundLookup(resolverFor(addresses));

		const result = await new Promise<{
			error: NodeJS.ErrnoException | null;
			address: string | LookupAddress[];
		}>((resolve) => {
			safeLookup("service.example.com", { all: true }, (error, address) =>
				resolve({ error, address }),
			);
		});

		expect(result).toEqual({ error: null, address: addresses });
	});

	it("passes the DNS-pinned dispatcher to Node fetch without weakening RequestInit types", async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL, _init?: RequestInit) =>
				new Response("ok"),
		);
		vi.stubGlobal("fetch", fetchMock);

		await safeFetchOutbound("https://93.184.216.34/resource", {
			headers: { accept: "application/json" },
		});

		const [, init] = fetchMock.mock.calls[0];
		expect(init).toMatchObject({
			redirect: "error",
			headers: { accept: "application/json" },
		});
		expect(
			Object.getOwnPropertyDescriptor(init, "dispatcher")?.value,
		).toBeDefined();
	});

	it("preserves an explicit manual redirect policy for callers that validate redirects themselves", async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL, _init?: RequestInit) =>
				new Response(null, {
					status: 307,
					headers: { location: "/auth/login" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await safeFetchOutbound("https://93.184.216.34/app", {
			redirect: "manual",
		});

		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			redirect: "manual",
		});
	});

	it("keeps automatic redirects fail-closed even when a caller asks to follow them", async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL, _init?: RequestInit) =>
				new Response(null, {
					status: 307,
					headers: { location: "https://evil.example/" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await safeFetchOutbound("https://93.184.216.34/app", {
			redirect: "follow",
		});

		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			redirect: "error",
		});
	});
});

/**
 * The operator host allowlist: unconditional block, one explicit exception
 * that lives in the environment. These pin the exception's shape, since the
 * guards in @repo/mcp, @repo/search, @repo/temporal and the agent registry
 * all build on this and none of them should have to re-test it.
 */
describe("operator host allowlist", () => {
	const ENV = "TEST_OUTBOUND_ALLOWED_HOSTS";
	const originalEnv = process.env[ENV];
	const originalNodeEnv = process.env.NODE_ENV;

	function setEnv(key: string, value: string | undefined) {
		if (value === undefined) {
			delete (process.env as Record<string, string | undefined>)[key];
		} else {
			(process.env as Record<string, string | undefined>)[key] = value;
		}
	}

	const publicResolver = resolverFor([
		{ address: "93.184.216.34", family: 4 },
	]);
	const privateResolver = resolverFor([{ address: "10.0.0.1", family: 4 }]);

	beforeEach(() => {
		setEnv(ENV, undefined);
		setEnv("NODE_ENV", "production");
	});

	afterEach(() => {
		setEnv(ENV, originalEnv);
		setEnv("NODE_ENV", originalNodeEnv);
		vi.unstubAllGlobals();
	});

	it.each([
		"http://169.254.169.254/latest/meta-data/",
		"http://127.0.0.1:7233/",
		"http://10.0.0.1/",
		"http://[::1]/",
		"http://localhost:3000/",
		"http://metadata.google.internal/",
	])("refuses %s and names the variable that would permit it", (url) => {
		const guard = createOutboundHostAllowlist({ envVar: ENV });
		const reason = guard.getUnsafeReason(url);
		expect(reason).not.toBeNull();
		expect(reason).toContain(ENV);
		expect(() => guard.assert(url)).toThrow(new RegExp(ENV));
	});

	it("allows an ordinary public address", async () => {
		const guard = createOutboundHostAllowlist({
			envVar: ENV,
			resolve: publicResolver,
		});
		expect(guard.getUnsafeReason("https://api.example.com/v1")).toBeNull();
		await expect(
			guard.assertResolved("https://api.example.com/v1"),
		).resolves.toBeUndefined();
	});

	it("refuses a public name that resolves to a private address", async () => {
		const guard = createOutboundHostAllowlist({
			envVar: ENV,
			resolve: privateResolver,
		});
		expect(
			guard.getUnsafeReason("https://internal.example.com/"),
		).toBeNull();
		await expect(
			guard.assertResolved("https://internal.example.com/"),
		).rejects.toThrow(
			/Private network access[\s\S]*TEST_OUTBOUND_ALLOWED_HOSTS/,
		);
	});

	it("permits a host the deployment declared, on any port", () => {
		setEnv(ENV, "localhost, Host.Docker.Internal");
		const guard = createOutboundHostAllowlist({ envVar: ENV });
		expect(guard.hosts()).toEqual(["localhost", "host.docker.internal"]);
		expect(guard.getUnsafeReason("http://localhost:5432/")).toBeNull();
		expect(
			guard.getUnsafeReason("http://host.docker.internal:8000/"),
		).toBeNull();
	});

	it("does not let a declared host widen to other private addresses", () => {
		setEnv(ENV, "localhost");
		const guard = createOutboundHostAllowlist({ envVar: ENV });
		expect(guard.getUnsafeReason("http://169.254.169.254/")).not.toBeNull();
		expect(guard.getUnsafeReason("http://127.0.0.1/")).not.toBeNull();
	});

	it("still refuses non-HTTP schemes on a declared host", () => {
		// The operator permitted a host, not file: on that host — this is the
		// case that matters when the consumer is a browser rather than fetch.
		setEnv(ENV, "localhost");
		const guard = createOutboundHostAllowlist({ envVar: ENV });
		expect(guard.getUnsafeReason("file://localhost/etc/passwd")).toMatch(
			/Protocol file:/,
		);
	});

	it("has no default exception in production, loopback outside it", () => {
		const guard = createOutboundHostAllowlist({ envVar: ENV });
		expect(guard.getUnsafeReason("http://localhost:8125/")).not.toBeNull();

		setEnv("NODE_ENV", "development");
		expect(guard.getUnsafeReason("http://localhost:8125/")).toBeNull();
		expect(guard.getUnsafeReason("http://[::1]:8125/")).toBeNull();
		// The dev default is loopback, not "anything private".
		expect(guard.getUnsafeReason("http://169.254.169.254/")).not.toBeNull();
		expect(guard.getUnsafeReason("http://10.0.0.5/")).not.toBeNull();
	});

	it("treats an explicitly empty variable as no exceptions anywhere", () => {
		setEnv(ENV, "");
		setEnv("NODE_ENV", "development");
		const guard = createOutboundHostAllowlist({ envVar: ENV });
		expect(guard.getUnsafeReason("http://localhost:8125/")).not.toBeNull();
	});

	it("skips DNS pinning for a declared host and pins everything else", async () => {
		setEnv(ENV, "localhost");
		const fetchMock = vi.fn(
			async (_input: string | URL, _init?: RequestInit) =>
				new Response("ok"),
		);
		vi.stubGlobal("fetch", fetchMock);
		const guard = createOutboundHostAllowlist({ envVar: ENV });

		await guard.fetch("http://localhost:8125/health", {
			headers: { accept: "text/plain" },
		});
		const [, allowedInit] = fetchMock.mock.calls[0];
		expect(
			Object.getOwnPropertyDescriptor(allowedInit, "dispatcher"),
		).toBeUndefined();
		// Unpinned, but a redirect off the declared host is still refused.
		expect(allowedInit).toMatchObject({
			headers: { accept: "text/plain" },
			redirect: "error",
		});

		await guard.fetch("https://93.184.216.34/health");
		const [, pinnedInit] = fetchMock.mock.calls[1];
		expect(pinnedInit).toMatchObject({ redirect: "error" });
		expect(
			Object.getOwnPropertyDescriptor(pinnedInit, "dispatcher")?.value,
		).toBeDefined();

		await expect(guard.fetch("http://10.0.0.1/")).rejects.toThrow(
			new RegExp(ENV),
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("keeps a caller's manual redirect policy on a declared host", async () => {
		setEnv(ENV, "localhost");
		const fetchMock = vi.fn(
			async (_input: string | URL, _init?: RequestInit) =>
				new Response("ok"),
		);
		vi.stubGlobal("fetch", fetchMock);
		const guard = createOutboundHostAllowlist({ envVar: ENV });
		await guard.fetch("http://localhost:8125/", { redirect: "manual" });
		expect(fetchMock.mock.calls[0][1]).toMatchObject({
			redirect: "manual",
		});
	});

	it("does not let a declared host redirect the request to a destination nobody declared", async () => {
		setEnv(ENV, "127.0.0.1");
		const server = createServer((_request, response) => {
			response.statusCode = 302;
			response.setHeader("location", "http://169.254.169.254/latest/");
			response.end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		try {
			const guard = createOutboundHostAllowlist({ envVar: ENV });
			let caught: unknown;
			try {
				await guard.fetch(`http://127.0.0.1:${port}/health`);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			expect(String((caught as Error).cause ?? caught)).toMatch(
				/redirect/i,
			);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("recognises the dispatcher's DNS-time refusal inside fetch's error chain", () => {
		const blocked: NodeJS.ErrnoException = new Error(
			"Blocked outbound connection to internal.example.com: Private network access (10.x.x.x) is not allowed",
		);
		blocked.code = "EACCES";
		const fetchFailed = new TypeError("fetch failed", { cause: blocked });

		expect(getBlockedOutboundReason(fetchFailed)).toMatch(
			/Blocked outbound connection/,
		);
		expect(getBlockedOutboundReason(new Error("ECONNREFUSED"))).toBeNull();
		expect(getBlockedOutboundReason(null)).toBeNull();
	});
});
