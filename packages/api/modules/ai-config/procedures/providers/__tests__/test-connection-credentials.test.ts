/**
 * Tests for testProviderConnectionProcedure's credential-shape validation.
 *
 * The tester and the writer (`upsert`) must enforce IDENTICAL rules. Before
 * this was shared, sending an API key AND a service principal together passed
 * validation here and silently tested only the PAT — handing the user a green
 * check for a credential that was never exercised, which they could then save.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai/lib/anthropic-federation", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@repo/ai/lib/anthropic-federation")
	>()),
	getAnthropicFederatedToken: vi.fn(async () => ({
		kind: "bearer",
		token: "example-access",
		expiresAt: Date.now() + 600_000,
	})),
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: vi.fn(async () => ({ role: "admin" })),
}));

vi.mock("@repo/ai", () => ({
	DatabricksOAuthError: class extends Error {},
	getDatabricksOAuthToken: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		cloudProviderConfig: { findUnique: vi.fn() },
		userCloudProviderConfig: { findUnique: vi.fn() },
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((v: string) => v),
}));

vi.mock("../../../lib/databricks", () => ({
	listDatabricksModels: vi.fn(),
	validateDatabricksToken: vi.fn(),
}));

vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({
			_handler: fn,
			_input: (chainable as { _input?: unknown })._input,
		}),
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (o: string | null | undefined) => o ?? null,
		requirePermission: vi.fn(() => ({})),
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

import { testProviderConnectionProcedure } from "../test-connection";

const tester = testProviderConnectionProcedure as unknown as {
	_input: {
		safeParse: (input: unknown) => { success: boolean; error?: any };
	};
};

const WORKSPACE = "https://example-workspace.cloud.databricks.com";

function validationErrors(input: Record<string, unknown>): string[] {
	const result = tester._input.safeParse(input);
	if (result.success) {
		return [];
	}
	return (result.error.issues as Array<{ message: string }>).map(
		(i) => i.message,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("testConnection input — credential XOR", () => {
	it("accepts an API key alone", () => {
		expect(
			validationErrors({
				provider: "DATABRICKS",
				apiKey: "dapi-token",
				baseUrl: WORKSPACE,
			}),
		).toEqual([]);
	});

	it("accepts a complete service principal", () => {
		expect(
			validationErrors({
				provider: "DATABRICKS",
				clientId: "client-abc",
				clientSecret: "secret-xyz",
				baseUrl: WORKSPACE,
			}),
		).toEqual([]);
	});

	it("rejects an API key AND a service principal together", () => {
		// Previously accepted, silently testing only the PAT.
		const errors = validationErrors({
			provider: "DATABRICKS",
			apiKey: "dapi-token",
			clientId: "client-abc",
			clientSecret: "secret-xyz",
			baseUrl: WORKSPACE,
		});

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/not both/i);
	});

	it("rejects an API key plus a PARTIAL service principal", () => {
		const errors = validationErrors({
			provider: "DATABRICKS",
			apiKey: "dapi-token",
			clientId: "client-abc",
			baseUrl: WORKSPACE,
		});

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/not both/i);
	});

	it("rejects a half service principal", () => {
		const errors = validationErrors({
			provider: "DATABRICKS",
			clientId: "client-abc",
			baseUrl: WORKSPACE,
		});

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/both a client ID and a client secret/i);
	});

	it("rejects a service principal with no workspace URL", () => {
		const errors = validationErrors({
			provider: "DATABRICKS",
			clientId: "client-abc",
			clientSecret: "secret-xyz",
		});

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/requires the workspace URL/i);
	});

	it("rejects no credentials at all", () => {
		const errors = validationErrors({
			provider: "DATABRICKS",
			baseUrl: WORKSPACE,
		});

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(
			/Provide an API key, or a service principal/i,
		);
	});

	it("rejects service-principal fields for a non-capable provider", () => {
		const errors = validationErrors({
			provider: "OPENAI_DIRECT",
			apiKey: "sk-test",
			clientId: "client-abc",
			clientSecret: "secret-xyz",
		});

		expect(
			errors.some((m) => /does not support service-principal/i.test(m)),
		).toBe(true);
	});

	it("still requires an API key for a non-capable provider", () => {
		const errors = validationErrors({ provider: "OPENAI_DIRECT" });

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/An API key is required/i);
	});

	it("treats whitespace-only credentials as absent", () => {
		// `.min(1)` alone would let a single space through as a "credential".
		const errors = validationErrors({
			provider: "DATABRICKS",
			apiKey: "   ",
			baseUrl: WORKSPACE,
		});

		expect(errors.length).toBeGreaterThan(0);
	});
});

describe("federated credential shape", () => {
	const valid = { provider: "ANTHROPIC_DIRECT", authMode: "federated" };

	it("accepts direct Anthropic without a stored secret", () => {
		expect(validationErrors(valid)).toEqual([]);
	});

	it.each([
		{ provider: "OPENAI_DIRECT" },
		{ apiKey: "example-key" },
		{ clientId: "example-client" },
		{ clientSecret: "example-secret" },
	])("rejects a conflicting federation field: %o", (overrides) => {
		expect(validationErrors({ ...valid, ...overrides })).toEqual([
			"Federation requires direct Anthropic without an API key or service principal.",
		]);
	});
});

describe("Anthropic connection dispatch", () => {
	const connectedOrg = "example-org";
	const federated = {
		provider: "ANTHROPIC_DIRECT",
		authMode: "federated",
		organizationId: connectedOrg,
	};

	function testConnection(input: Record<string, unknown>) {
		return (
			testProviderConnectionProcedure as unknown as {
				_handler: (
					args: unknown,
				) => Promise<{ success: boolean; message: string }>;
			}
		)._handler({
			input,
			context: { user: { id: "example-user" }, session: {} },
		});
	}

	beforeEach(() => {
		vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "fdrl_example");
		vi.stubEnv(
			"ANTHROPIC_ORGANIZATION_ID",
			"00000000-0000-0000-0000-000000000000",
		);
		vi.stubEnv("ANTHROPIC_FEDERATION_AUDIENCE", "example-audience");
		vi.stubEnv(
			"ANTHROPIC_FEDERATION_ALLOWED_ORGANIZATION_IDS",
			connectedOrg,
		);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it.each([null, "different-org"])(
		"refuses federation for organization %s",
		async (organizationId) => {
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			await expect(
				testConnection({ ...federated, organizationId }),
			).resolves.toMatchObject({
				success: false,
				message:
					"Anthropic federation is unavailable for this organization.",
			});
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("does not treat a 400 Messages response as successful federation", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 400 })),
		);
		await expect(testConnection(federated)).resolves.toMatchObject({
			success: false,
		});
		await expect(
			testConnection({
				provider: "ANTHROPIC_DIRECT",
				apiKey: "example-key",
			}),
		).resolves.toMatchObject({ success: true });
	});

	it.each([false, true])(
		"uses the correct headers (bearer=%s)",
		async (bearer) => {
			const headers: Headers[] = [];
			const fetch = vi.fn(
				async (input: string | Request, options?: RequestInit) => {
					const request = new Request(input, options);
					headers.push(request.headers);
					return Response.json({});
				},
			);
			vi.stubGlobal("fetch", fetch);
			await expect(
				testConnection(
					bearer
						? federated
						: {
								provider: "ANTHROPIC_DIRECT",
								apiKey: "example-key",
							},
				),
			).resolves.toMatchObject({ success: true });
			expect(headers).toHaveLength(1);
			expect(headers[0].get("x-api-key")).toBe(
				bearer ? null : "example-key",
			);
			expect(headers[0].get("authorization")).toBe(
				bearer ? "Bearer example-access" : null,
			);
			// Anthropic answers an unknown version with a 400, which the
			// federated probe treats as a failure.
			expect(headers[0].get("anthropic-version")).toBe(
				bearer ? "2023-06-01" : "2024-01-01",
			);
		},
	);
});
