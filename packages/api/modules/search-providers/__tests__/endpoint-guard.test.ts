/**
 * SSRF guard on custom search-provider endpoints.
 *
 * Tavily, Firecrawl and Parallel accept a self-hosted `endpoint`. It is set by
 * an ordinary member and every later search POSTs to it, including searches
 * run by an AI tool with no caller present. So the write refuses internal
 * destinations, the test-connection procedure refuses them, and the providers
 * themselves fetch through the guard so a stored endpoint cannot later point
 * inside.
 */

import { ORPCError } from "@orpc/server";
import {
	FirecrawlSearchProvider,
	ParallelSearchProvider,
	TavilySearchProvider,
} from "@repo/search";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upsertUser = vi.fn();
const upsertOrg = vi.fn();
const getOrganizationById = vi.fn();
const verifyMembership = vi.fn();

vi.mock("@repo/database", () => ({
	upsertUserSearchProvider: (...a: unknown[]) => upsertUser(...a),
	upsertOrganizationSearchProvider: (...a: unknown[]) => upsertOrg(...a),
	getOrganizationById: (...a: unknown[]) => getOrganizationById(...a),
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (key: string) => `encrypted:${key}`,
	isValidApiKeyFormat: () => true,
	maskApiKey: (key: string) => `${key.slice(0, 2)}***`,
}));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: (...a: unknown[]) => verifyMembership(...a),
}));
vi.mock("../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		protectedProcedure: builder,
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
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<unknown>;

function handlerOf(procedure: unknown): Handler {
	return (procedure as { handler: Handler }).handler;
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOWED = process.env.SEARCH_PROVIDER_ALLOWED_HOSTS;

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

async function expectBadRequest(promise: Promise<unknown>) {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(ORPCError);
	expect((caught as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
	expect((caught as ORPCError<string, unknown>).message).toMatch(
		/Provider endpoint rejected.*SEARCH_PROVIDER_ALLOWED_HOSTS/s,
	);
}

const BLOCKED_ENDPOINTS = [
	"http://169.254.169.254/latest/meta-data/",
	"http://127.0.0.1:7233/",
	"http://10.0.0.1/",
	"http://[::1]/",
];

beforeEach(() => {
	vi.clearAllMocks();
	lookupMock.mockReset();
	setEnv("NODE_ENV", "production");
	setEnv("SEARCH_PROVIDER_ALLOWED_HOSTS", undefined);
	getOrganizationById.mockResolvedValue({ id: "org-1" });
	verifyMembership.mockResolvedValue({ role: "admin" });
	upsertUser.mockResolvedValue({
		providerName: "tavily",
		encryptedApiKey: "encrypted:k",
		endpoint: null,
		isDefault: false,
		priority: 0,
		enabled: true,
	});
	upsertOrg.mockResolvedValue({
		providerName: "tavily",
		encryptedApiKey: "encrypted:k",
		endpoint: null,
		isDefault: false,
		priority: 0,
		enabled: true,
	});
});

afterEach(() => {
	setEnv("NODE_ENV", ORIGINAL_NODE_ENV);
	setEnv("SEARCH_PROVIDER_ALLOWED_HOSTS", ORIGINAL_ALLOWED);
	vi.unstubAllGlobals();
});

describe("procedures refuse an internal endpoint", () => {
	it.each(BLOCKED_ENDPOINTS)(
		"testProviderConnection refuses %s before creating a provider",
		async (endpoint) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			const { testProviderConnection } = await import(
				"../procedures/test-provider-connection"
			);
			await expectBadRequest(
				handlerOf(testProviderConnection)({
					input: {
						providerName: "tavily",
						apiKey: "tvly-x",
						endpoint,
					},
					context: { user: { id: "u1" } },
				}),
			);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each(BLOCKED_ENDPOINTS)(
		"updateUserProvider refuses %s and writes nothing",
		async (endpoint) => {
			const { updateUserProvider } = await import(
				"../procedures/update-user-provider"
			);
			await expectBadRequest(
				handlerOf(updateUserProvider)({
					input: {
						providerName: "tavily",
						apiKey: "tvly-x",
						endpoint,
					},
					context: { user: { id: "u1" } },
				}),
			);
			expect(upsertUser).not.toHaveBeenCalled();
		},
	);

	it.each(BLOCKED_ENDPOINTS)(
		"updateOrganizationProvider refuses %s and writes nothing",
		async (endpoint) => {
			const { updateOrganizationProvider } = await import(
				"../procedures/update-organization-provider"
			);
			await expectBadRequest(
				handlerOf(updateOrganizationProvider)({
					input: {
						organizationId: "org-1",
						providerName: "tavily",
						apiKey: "tvly-x",
						endpoint,
					},
					context: { user: { id: "u1" } },
				}),
			);
			expect(upsertOrg).not.toHaveBeenCalled();
		},
	);

	it("still stores a public endpoint, and no endpoint at all", async () => {
		const { updateUserProvider } = await import(
			"../procedures/update-user-provider"
		);
		await handlerOf(updateUserProvider)({
			input: {
				providerName: "tavily",
				apiKey: "tvly-x",
				endpoint: "https://tavily.proxy.example.com",
			},
			context: { user: { id: "u1" } },
		});
		await handlerOf(updateUserProvider)({
			input: { providerName: "tavily", apiKey: "tvly-x" },
			context: { user: { id: "u1" } },
		});
		expect(upsertUser).toHaveBeenCalledTimes(2);
	});

	it("permits a host the operator declared", async () => {
		setEnv("SEARCH_PROVIDER_ALLOWED_HOSTS", "firecrawl.internal");
		const { updateUserProvider } = await import(
			"../procedures/update-user-provider"
		);
		await handlerOf(updateUserProvider)({
			input: {
				providerName: "firecrawl",
				apiKey: "fc-x",
				endpoint: "http://firecrawl.internal:3002/v1",
			},
			context: { user: { id: "u1" } },
		});
		expect(upsertUser).toHaveBeenCalledTimes(1);
	});
});

describe("providers fetch through the guard, so a stored endpoint cannot point inside", () => {
	const providers = [
		["tavily", (e: string) => new TavilySearchProvider("tvly-x", e)],
		["firecrawl", (e: string) => new FirecrawlSearchProvider("fc-x", e)],
		["parallel", (e: string) => new ParallelSearchProvider("pl-x", e)],
	] as const;

	for (const [name, make] of providers) {
		it(`${name}: refuses a literal internal endpoint without a request`, async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			for (const endpoint of BLOCKED_ENDPOINTS) {
				const result = await make(endpoint).testConnection();
				expect(result.success).toBe(false);
				expect(result.error).toMatch(/SEARCH_PROVIDER_ALLOWED_HOSTS/);
			}
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it(`${name}: refuses an endpoint whose hostname resolves to a private address`, async () => {
			resolveTo("10.0.0.1");
			const result = await make(
				"https://search.internal.example",
			).testConnection();
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/fetch failed|Blocked outbound/);
			expect(lookupMock).toHaveBeenCalled();
		});
	}

	it("reaches the vendor's default public endpoint unchanged, with redirects refused", async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await new TavilySearchProvider(
			"tvly-x",
		).testConnection();
		expect(result.success).toBe(true);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("https://api.tavily.com/search");
		expect(init).toMatchObject({ method: "POST", redirect: "error" });
		expect(
			Object.getOwnPropertyDescriptor(init, "dispatcher")?.value,
		).toBeDefined();
	});
});
