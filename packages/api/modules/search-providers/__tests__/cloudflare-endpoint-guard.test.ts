/**
 * Cloudflare Browser Rendering keeps its account ID in the provider row's
 * `endpoint`, as `https://api.cloudflare.com/client/v4/accounts/<32 hex>`.
 * The organization write must refuse any other value for the endpoint the row
 * will hold afterwards (incoming, or the stored one when the update leaves it
 * out), and the connection test must refuse one before sending the token.
 */

import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upsertOrg = vi.fn();
const getOrgProvider = vi.fn();
const getOrganizationById = vi.fn();
const verifyMembership = vi.fn();

vi.mock("@repo/database", () => ({
	upsertOrganizationSearchProvider: (...a: unknown[]) => upsertOrg(...a),
	getOrganizationSearchProvider: (...a: unknown[]) => getOrgProvider(...a),
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

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<unknown>;

function handlerOf(procedure: unknown): Handler {
	return (procedure as { handler: Handler }).handler;
}

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const VALID_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

const INVALID_ENDPOINTS = [
	["wrong host", `https://api.example.com/client/v4/accounts/${ACCOUNT_ID}`],
	["short account id", VALID_ENDPOINT.slice(0, -1)],
	["long account id", `${VALID_ENDPOINT}0`],
	["extra path", `${VALID_ENDPOINT}/browser-rendering/markdown`],
] as const;

async function expectAccountRejected(promise: Promise<unknown>) {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(ORPCError);
	expect((caught as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
	expect((caught as ORPCError<string, unknown>).message).toMatch(
		/Cloudflare Browser Rendering needs a valid account ID/,
	);
}

async function updateOrg(input: Record<string, unknown>) {
	const { updateOrganizationProvider } = await import(
		"../procedures/update-organization-provider"
	);
	return handlerOf(updateOrganizationProvider)({
		input: {
			organizationId: "org-1",
			providerName: "cloudflare",
			...input,
		},
		context: { user: { id: "u1" } },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getOrganizationById.mockResolvedValue({ id: "org-1" });
	verifyMembership.mockResolvedValue({ role: "admin" });
	getOrgProvider.mockResolvedValue(null);
	upsertOrg.mockImplementation(async (args: Record<string, unknown>) => ({
		id: "row-1",
		providerName: "cloudflare",
		encryptedApiKey: "encrypted:k",
		endpoint: args.endpoint ?? VALID_ENDPOINT,
		isDefault: false,
		priority: 0,
		enabled: true,
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("updateOrganizationProvider — Cloudflare account endpoint", () => {
	it("stores a valid account endpoint", async () => {
		await updateOrg({ apiKey: "cf-token", endpoint: VALID_ENDPOINT });
		expect(upsertOrg).toHaveBeenCalledWith(
			expect.objectContaining({
				providerName: "cloudflare",
				endpoint: VALID_ENDPOINT,
				encryptedApiKey: "encrypted:cf-token",
			}),
		);
	});

	it("refuses a new row with no endpoint and writes nothing", async () => {
		await expectAccountRejected(updateOrg({ apiKey: "cf-token" }));
		expect(getOrgProvider).toHaveBeenCalledWith({
			organizationId: "org-1",
			providerName: "cloudflare",
		});
		expect(upsertOrg).not.toHaveBeenCalled();
	});

	it.each(INVALID_ENDPOINTS)(
		"refuses an endpoint with a %s and writes nothing",
		async (_label, endpoint) => {
			await expectAccountRejected(
				updateOrg({ apiKey: "cf-token", endpoint }),
			);
			expect(upsertOrg).not.toHaveBeenCalled();
		},
	);

	it("refuses an invalid incoming endpoint even when a valid one is stored", async () => {
		getOrgProvider.mockResolvedValue({ endpoint: VALID_ENDPOINT });
		await expectAccountRejected(
			updateOrg({
				apiKey: "cf-token",
				endpoint: INVALID_ENDPOINTS[0][1],
			}),
		);
		expect(upsertOrg).not.toHaveBeenCalled();
	});

	it("keeps a valid stored endpoint when the update omits it", async () => {
		getOrgProvider.mockResolvedValue({ endpoint: VALID_ENDPOINT });
		await updateOrg({ enabled: false });
		await updateOrg({ apiKey: "cf-token", endpoint: null });
		expect(upsertOrg).toHaveBeenCalledTimes(2);
		for (const [args] of upsertOrg.mock.calls) {
			// Undefined leaves the stored column untouched in the upsert.
			expect(args.endpoint).toBeUndefined();
		}
	});

	it("refuses an update that omits the endpoint when the stored one is invalid", async () => {
		getOrgProvider.mockResolvedValue({
			endpoint: "https://api.example.com",
		});
		await expectAccountRejected(updateOrg({ enabled: true }));
		expect(upsertOrg).not.toHaveBeenCalled();
	});

	it("does not apply the Cloudflare rule to other providers", async () => {
		await updateOrg({ providerName: "tavily", apiKey: "tvly-x" });
		expect(getOrgProvider).not.toHaveBeenCalled();
		expect(upsertOrg).toHaveBeenCalledTimes(1);
	});
});

describe("testProviderConnection — Cloudflare account endpoint", () => {
	async function testConnection(input: Record<string, unknown>) {
		const { testProviderConnection } = await import(
			"../procedures/test-provider-connection"
		);
		return handlerOf(testProviderConnection)({
			input: { providerName: "cloudflare", apiKey: "cf-token", ...input },
			context: { user: { id: "u1" } },
		}) as Promise<{ success: boolean; error?: string }>;
	}

	it.each([["no endpoint", undefined], ...INVALID_ENDPOINTS])(
		"refuses %s before any request",
		async (_label, endpoint) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			await expectAccountRejected(testConnection({ endpoint }));
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("POSTs the markdown endpoint for example.com with the token", async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						success: true,
						result: "# Example Domain",
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await testConnection({ endpoint: VALID_ENDPOINT });

		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			`${VALID_ENDPOINT}/browser-rendering/markdown`,
		);
		expect(init).toMatchObject({ method: "POST", redirect: "error" });
		expect(JSON.parse(String(init?.body))).toEqual({
			url: "https://example.com",
		});
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer cf-token",
		);
	});

	it("redacts a token echo that crosses the 300-character cap in Cloudflare's error text", async () => {
		const token = "cfTokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							success: false,
							errors: [
								// Starts at 295: cutting first would leave five
								// characters, too few for the prefix rule.
								{
									code: 1,
									message: `${"x".repeat(295)}${token} tail`,
								},
							],
						}),
						{ status: 400 },
					),
			),
		);
		const result = await testConnection({
			apiKey: token,
			endpoint: VALID_ENDPOINT,
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/^Connection failed \(400\)/);
		expect(result.error).not.toContain(token.slice(0, 5));
	});

	it("redacts the token from a network error returned to the caller", async () => {
		const token = "cfTokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError(`socket closed after Bearer ${token}`);
			}),
		);
		const result = await testConnection({
			apiKey: token,
			endpoint: VALID_ENDPOINT,
		});
		expect(result.success).toBe(false);
		expect(result.error).not.toContain(token.slice(0, 8));
	});

	it("reports a rejected token as a failed test", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							success: false,
							errors: [
								{
									code: 10000,
									message: "Authentication error",
								},
							],
						}),
						{ status: 401 },
					),
			),
		);
		const result = await testConnection({ endpoint: VALID_ENDPOINT });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/rejected the API token/);
		expect(result.error).not.toContain("cf-token");
	});
});
