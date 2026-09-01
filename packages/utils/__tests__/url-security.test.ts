import type { LookupAddress } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSafeOutboundLookup,
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
