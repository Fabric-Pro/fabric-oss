/**
 * `fetchOpenIdConfiguration` takes a URL from the caller and makes the server
 * fetch it, returning the status and the parsed body. It shares the MCP
 * server allowlist: refused at the hostname before any request, refused
 * again at DNS-lookup time, redirects not followed.
 */

import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		requirePermission: () => (c: unknown) => c,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

const lookupMock = vi.fn();
vi.mock("node:dns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns")>();
	return {
		...actual,
		lookup: (...args: unknown[]) => lookupMock(...args),
	};
});

type Handler = (args: {
	input: { discoveryUrl: string };
	context: { user: { id: string } };
}) => Promise<{ issuer: string; tokenEndpoint?: string }>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../discovery");
	return (
		mod.discoveryProcedures.fetchOpenIdConfiguration as unknown as {
			handler: Handler;
		}
	).handler;
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOWED = process.env.MCP_SERVER_ALLOWED_HOSTS;
let userSeq = 0;

function setEnv(key: string, value: string | undefined) {
	if (value === undefined) {
		delete (process.env as Record<string, string | undefined>)[key];
	} else {
		(process.env as Record<string, string | undefined>)[key] = value;
	}
}

// The procedure rate-limits per user; a fresh user per call keeps tests
// independent of each other's timing.
function call(handler: Handler, discoveryUrl: string) {
	userSeq += 1;
	return handler({
		input: { discoveryUrl },
		context: { user: { id: `user-${userSeq}` } },
	});
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

async function expectBadRequest(promise: Promise<unknown>, pattern: RegExp) {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(ORPCError);
	expect((caught as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
	expect((caught as ORPCError<string, unknown>).message).toMatch(pattern);
}

beforeEach(() => {
	lookupMock.mockReset();
	setEnv("NODE_ENV", "production");
	setEnv("MCP_SERVER_ALLOWED_HOSTS", undefined);
});

afterEach(() => {
	setEnv("NODE_ENV", ORIGINAL_NODE_ENV);
	setEnv("MCP_SERVER_ALLOWED_HOSTS", ORIGINAL_ALLOWED);
	vi.unstubAllGlobals();
});

describe("fetchOpenIdConfiguration outbound guard", () => {
	it.each([
		"https://169.254.169.254/latest/meta-data/",
		"https://127.0.0.1:7233/.well-known/openid-configuration",
		"https://10.0.0.1/.well-known/openid-configuration",
		"https://[::1]/.well-known/openid-configuration",
	])("refuses %s before any request leaves", async (url) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const handler = await loadHandler();

		await expectBadRequest(
			call(handler, url),
			/Discovery URL rejected.*MCP_SERVER_ALLOWED_HOSTS/s,
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("refuses a public hostname that resolves to a private address, as the caller's error", async () => {
		resolveTo("10.0.0.1");
		const handler = await loadHandler();

		await expectBadRequest(
			call(
				handler,
				"https://idp.internal.example/.well-known/openid-configuration",
			),
			/Discovery URL rejected.*Blocked outbound connection.*MCP_SERVER_ALLOWED_HOSTS/s,
		);
	});

	it("fetches a public issuer with redirects refused and DNS pinned", async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						issuer: "https://idp.example.com",
						token_endpoint: "https://idp.example.com/token",
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const handler = await loadHandler();

		const result = await call(
			handler,
			"https://idp.example.com/.well-known/openid-configuration",
		);
		expect(result.issuer).toBe("https://idp.example.com");
		expect(result.tokenEndpoint).toBe("https://idp.example.com/token");

		const [, init] = fetchMock.mock.calls[0];
		expect(init).toMatchObject({ method: "GET", redirect: "error" });
		expect(
			Object.getOwnPropertyDescriptor(init, "dispatcher")?.value,
		).toBeDefined();
	});
});
