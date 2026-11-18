import { assertSafeOutboundUrlResolved } from "@repo/utils/url-security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	listWorkflowIntegrations: vi.fn(),
	fetch: vi.fn(),
	send: vi.fn(),
	lookup: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<object>()),
	listWorkflowIntegrations: h.listWorkflowIntegrations,
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<object>()),
	decryptApiKey: (value: string) => value,
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ role: "member" }),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		protectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
	};
});

vi.mock("node:dns", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:dns")>()),
	lookup: (...args: unknown[]) => h.lookup(...args),
}));

const { testIntegrationConnectionProcedure } = await import(
	"../test-connection"
);
const { testSavedConnectionProcedure } = await import(
	"../test-saved-connection"
);

type Result = { success: boolean; error?: string; message?: string };
const testEntered = (
	testIntegrationConnectionProcedure as unknown as {
		handler: (args: {
			input: { type: string; credentials: Record<string, string> };
		}) => Promise<Result>;
	}
).handler;
const testSaved = (
	testSavedConnectionProcedure as unknown as {
		handler: (args: {
			input: { type: string; organizationId?: string | null };
			context: {
				user: { id: string };
				session: { activeOrganizationId: string | null };
			};
		}) => Promise<Result>;
	}
).handler;

const blocked = {
	success: false,
	error: "Request blocked: destination is not allowed.",
};
const auth = { email: "dev@example.com", apiToken: "example-token" };
const machine = { clientId: "example-id", clientSecret: "example-secret" };

function resolveTo(address: string) {
	h.lookup.mockImplementation((_host, _options, callback) =>
		callback(null, [{ address, family: 4 }]),
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	resolveTo("93.184.216.34");
	h.send.mockImplementation(async (url) =>
		Response.json(
			String(url).endsWith("/oidc/v1/token")
				? { access_token: "example-access-token", expires_in: 3600 }
				: {
						displayName: "Example",
						username: "example",
						user: { name: "Example" },
					},
		),
	);
	h.fetch.mockImplementation(async (url, init) => {
		// Model the dispatcher's lookup and fetch's redirect handling without sockets.
		if (init?.dispatcher) {
			try {
				await assertSafeOutboundUrlResolved(String(url));
			} catch (cause) {
				throw new TypeError("fetch failed", { cause });
			}
		}
		const response = await h.send(url, init);
		const location = response.headers.get("location");
		if (location && init?.redirect !== "manual") {
			if (init?.redirect === "error") {
				throw new TypeError("fetch failed");
			}
			return h.send(location, init);
		}
		return response;
	});
	vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const providers = [
	[
		"JIRA",
		{ ...auth, domain: "127.0.0.1" },
		{ ...auth, domain: "example.com" },
		"Connected as Example",
	],
	[
		"ZENDESK",
		{ subdomain: "example", email: auth.email, token: auth.apiToken },
		{ subdomain: "example", email: auth.email, token: auth.apiToken },
		"Connected as Example",
	],
	[
		"SALESFORCE",
		{ domain: "https://169.254.169.254", apiToken: auth.apiToken },
		{ domain: "https://example.com", apiToken: auth.apiToken },
		"Connected to Salesforce",
	],
	[
		"CONFLUENCE",
		{ ...auth, domain: "[::1]" },
		{ ...auth, domain: "example.com" },
		"Connected as Example",
	],
	[
		"FRESHSERVICE",
		{ domain: "10.0.0.1", apiKey: auth.apiToken },
		{ domain: "example.com", apiKey: auth.apiToken },
		"Freshservice connection successful",
	],
	[
		"GITLAB",
		{ domain: "gitlab.com", GITLAB_ACCESS_TOKEN: auth.apiToken },
		{ domain: "gitlab.com", GITLAB_ACCESS_TOKEN: auth.apiToken },
		"Connected as example",
	],
	[
		"DATABRICKS_SQL",
		{ ...machine, host: "https://example.cloud.databricks.com" },
		{ ...machine, host: "https://example.cloud.databricks.com" },
		"Connected — 0 SQL warehouses visible",
	],
	[
		"DATABRICKS_VECTOR_SEARCH",
		{ ...machine, host: "https://example.cloud.databricks.com" },
		{ ...machine, host: "https://example.cloud.databricks.com" },
		"Connected — 0 vector search endpoints visible",
	],
	[
		"DATABRICKS_PLATFORM",
		{ ...machine, host: "https://example.cloud.databricks.com" },
		{ ...machine, host: "https://example.cloud.databricks.com" },
		"Databricks machine authentication verified. Approve a job, experiment and isolated volume in the project's Quality settings.",
	],
] as const;

function testSavedCredentials(
	type: string,
	credentials: Record<string, string>,
) {
	h.listWorkflowIntegrations.mockResolvedValue([
		{ id: "example-connection", credentials: JSON.stringify(credentials) },
	]);
	return testSaved({
		input: { type, organizationId: "example-org" },
		context: {
			user: { id: "example-user" },
			session: { activeOrganizationId: "example-org" },
		},
	});
}

describe.each(["entered", "saved"])("%s credentials", (source) => {
	function test(type: string, credentials: Record<string, string>) {
		return source === "saved"
			? testSavedCredentials(type, credentials)
			: testEntered({ input: { type, credentials } });
	}

	it.each(providers)(
		"refuses a private destination for %s",
		async (type, credentials) => {
			resolveTo("10.0.0.1");
			expect(await test(type, credentials)).toEqual(blocked);
			expect(h.send).not.toHaveBeenCalled();
		},
	);

	it.each(providers)(
		"uses the guarded transport and preserves the public result for %s",
		async (type, _privateCredentials, credentials, message) => {
			expect(await test(type, credentials)).toEqual({
				success: true,
				message,
			});
			expect(h.send).toHaveBeenCalledTimes(
				type.startsWith("DATABRICKS_") ? 2 : 1,
			);
			expect(h.lookup).toHaveBeenCalledTimes(h.send.mock.calls.length);
		},
	);

	it("refuses a Salesforce HTTP address", async () => {
		expect(
			await test("SALESFORCE", {
				domain: "http://example.com",
				apiToken: auth.apiToken,
			}),
		).toEqual(blocked);
		expect(h.fetch).not.toHaveBeenCalled();
	});

	it.each([
		"example/team",
		"example.team",
		"example@team",
		"example?team",
		"example#team",
		"-example",
		"example-",
		"a".repeat(64),
		"example\n",
	])(
		"rejects an invalid Zendesk label %j before fetching",
		async (subdomain) => {
			expect(
				await test("ZENDESK", {
					subdomain,
					email: auth.email,
					token: auth.apiToken,
				}),
			).toEqual({
				success: false,
				error: "Zendesk subdomain must be a single DNS label.",
			});
			expect(h.fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["JIRA", "GITLAB"])(
		"refuses a redirect in the %s probe",
		async (type) => {
			h.send.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://127.0.0.1/" },
				}),
			);
			expect(
				await test(type, {
					...auth,
					domain: type === "GITLAB" ? "gitlab.com" : "example.com",
					GITLAB_ACCESS_TOKEN: auth.apiToken,
				}),
			).toEqual(blocked);
			expect(h.send).toHaveBeenCalledTimes(1);
		},
	);
});

describe("entered MCP credentials", () => {
	const endpoint = "https://example.com/mcp";

	function testMcp(baseUrl = endpoint, transport = "HTTP") {
		return testEntered({
			input: { type: "MCP", credentials: { baseUrl, transport } },
		});
	}

	beforeEach(() => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("MCP_SERVER_ALLOWED_HOSTS", undefined);
		vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
		h.send.mockImplementation(async (_url, init: RequestInit) => {
			const { id, method } = JSON.parse(String(init.body));
			if (method === "notifications/initialized") {
				return new Response(null);
			}
			return Response.json({
				jsonrpc: "2.0",
				id,
				result:
					method === "initialize"
						? {
								protocolVersion: "2025-11-25",
								capabilities: { tools: {} },
								serverInfo: {
									name: "example",
									version: "1.0.0",
								},
							}
						: { tools: [] },
			});
		});
	});
	afterEach(() => vi.unstubAllEnvs());

	const mcpRefused = {
		success: false,
		error: "MCP server address could not be resolved or is not allowed.",
	};

	it.each(["HTTP", "SSE"])(
		"refuses a private DNS answer before sending on %s",
		async (transport) => {
			resolveTo("10.0.0.1");
			expect(await testMcp(endpoint, transport)).toEqual(mcpRefused);
			expect(h.fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["https://127.0.0.1/mcp", "invalid-url"])(
		"refuses %s without sending",
		async (baseUrl) => {
			expect(await testMcp(baseUrl)).toEqual(mcpRefused);
			expect(h.fetch).not.toHaveBeenCalled();
		},
	);

	it("returns a fixed refusal when the HTTP request resolves to a private address after preflight", async () => {
		resolveTo("10.0.0.1");
		h.lookup.mockImplementationOnce((_host, _options, callback) =>
			callback(null, [{ address: "93.184.216.34", family: 4 }]),
		);
		expect(await testMcp()).toEqual(mcpRefused);
		expect(h.fetch).toHaveBeenCalled();
		expect(h.send).not.toHaveBeenCalled();
	});

	const connected = {
		success: true,
		message: "MCP connection successful. Found 0 tools.",
	};

	it("lists tools from an MCP server after checking its public address", async () => {
		expect(await testMcp()).toEqual(connected);
		expect(h.lookup).toHaveBeenCalledWith(
			"example.com",
			expect.anything(),
			expect.any(Function),
		);
	});

	it("lists tools after a same-origin 307 redirect", async () => {
		h.send.mockResolvedValueOnce(
			new Response(null, {
				status: 307,
				headers: { location: "/mcp/" },
			}),
		);
		expect(await testMcp()).toEqual(connected);
		expect(h.send).toHaveBeenNthCalledWith(
			2,
			`${endpoint}/`,
			expect.objectContaining({ method: "POST", redirect: "manual" }),
		);
	});

	it("lists tools from an operator-allowlisted host with a private address", async () => {
		vi.stubEnv("MCP_SERVER_ALLOWED_HOSTS", "example.com");
		resolveTo("10.0.0.1");
		expect(await testMcp()).toEqual(connected);
		expect(h.lookup).not.toHaveBeenCalled();
	});

	it("lists tools from a loopback server outside production", async () => {
		vi.stubEnv("NODE_ENV", "test");
		expect(await testMcp("http://127.0.0.1/mcp")).toEqual(connected);
	});
});
