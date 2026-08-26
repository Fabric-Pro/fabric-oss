/**
 * Tests for upsertUserProviderProcedure — Databricks service-principal
 * (OAuth M2M) credentials.
 *
 * A provider config authenticates one of two ways, never both: a static API
 * key/PAT, or a service principal (client ID + client secret). These tests
 * pin the XOR at the input boundary and the persistence behaviour that makes
 * it hold at rest — switching modes must NULL the credential no longer in use,
 * or a read path could pick up a stale key that the user believes they removed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDb,
	mockCreate,
	mockUpdate,
	mockFindUnique,
	mockGetProviderMetadata,
	mockResolveOrganizationId,
} = vi.hoisted(() => {
	const mockCreate = vi.fn();
	const mockUpdate = vi.fn();
	const mockFindUnique = vi.fn();
	const txUser = {
		findUnique: mockFindUnique,
		findFirst: vi.fn(),
		updateMany: vi.fn().mockResolvedValue({ count: 0 }),
		create: mockCreate,
		update: mockUpdate,
	};
	const mockDb = {
		$transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
			cb({ userCloudProviderConfig: txUser }),
		),
	};
	return {
		mockDb,
		mockCreate,
		mockUpdate,
		mockFindUnique,
		mockGetProviderMetadata: vi.fn(),
		mockResolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

vi.mock("@repo/database", () => ({
	db: mockDb,
	getProviderMetadata: (...args: unknown[]) =>
		mockGetProviderMetadata(...args),
	getProviderDisplayName: vi.fn((p: string) => p),
	getEmbeddingProviderConfig: vi.fn(),
	ALL_EMBEDDING_CAPABLE_PROVIDERS: [],
	canProviderSupportEmbeddings: vi.fn(() => true),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: vi.fn().mockResolvedValue({ role: "admin" }),
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
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			mockResolveOrganizationId(organizationId),
		requirePermission: vi.fn(() => ({})),
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

import { upsertUserProviderProcedure } from "../upsert";

type UpsertResult = {
	success: boolean;
	id: string;
	provider: string;
	displayName: string | null;
	isDefault: boolean;
};
const upsert = upsertUserProviderProcedure as unknown as {
	_handler: (args: {
		input: unknown;
		context: unknown;
	}) => Promise<UpsertResult>;
	_input: {
		safeParse: (input: unknown) => { success: boolean; error?: any };
	};
};

const personalContext = {
	user: { id: "user-1" },
	session: { id: "s1", activeOrganizationId: null },
};

const WORKSPACE = "https://example-workspace.cloud.databricks.com";

const PROVIDER_METADATA: Record<string, Record<string, unknown>> = {
	DATABRICKS: {
		displayName: "Databricks",
		requiresBaseUrl: true,
		supportsServicePrincipal: true,
	},
	OPENAI_DIRECT: {
		displayName: "OpenAI",
		requiresBaseUrl: false,
		supportsServicePrincipal: false,
	},
	AZURE_AI_FOUNDRY: {
		displayName: "Azure AI Foundry",
		requiresBaseUrl: true,
		supportsServicePrincipal: false,
	},
};

/** Collect the validation error messages for an input, or [] when valid. */
function validationErrors(input: Record<string, unknown>): string[] {
	const result = upsert._input.safeParse(input);
	if (result.success) {
		return [];
	}
	return (result.error.issues as Array<{ message: string }>).map(
		(issue) => issue.message,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetProviderMetadata.mockImplementation(
		(p: string) => PROVIDER_METADATA[p],
	);
	mockFindUnique.mockResolvedValue(null);
	mockCreate.mockResolvedValue({
		id: "ucpc_1",
		provider: "DATABRICKS",
		displayName: "Databricks",
		isDefault: true,
	});
	mockUpdate.mockResolvedValue({
		id: "ucpc_1",
		provider: "DATABRICKS",
		displayName: "Databricks",
		isDefault: true,
	});
});

describe("upsert input validation — credential XOR", () => {
	it("accepts an API key alone for a service-principal-capable provider", () => {
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

	it("rejects supplying BOTH an API key and a service principal", () => {
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

	it("rejects a client ID with no client secret", () => {
		const errors = validationErrors({
			provider: "DATABRICKS",
			clientId: "client-abc",
			baseUrl: WORKSPACE,
		});

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/both a client ID and a client secret/i);
	});

	it("rejects a client secret with no client ID", () => {
		const errors = validationErrors({
			provider: "DATABRICKS",
			clientSecret: "secret-xyz",
			baseUrl: WORKSPACE,
		});

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/both a client ID and a client secret/i);
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

	it("rejects a service principal with no workspace URL", () => {
		// The OAuth token endpoint lives at the workspace root, so the base URL
		// is load-bearing for this auth mode specifically.
		const errors = validationErrors({
			provider: "DATABRICKS",
			clientId: "client-abc",
			clientSecret: "secret-xyz",
		});

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/requires the workspace URL/i);
	});

	it("treats whitespace-only credentials as absent", () => {
		const errors = validationErrors({
			provider: "DATABRICKS",
			apiKey: "   ",
			baseUrl: WORKSPACE,
		});

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(
			/Provide an API key, or a service principal/i,
		);
	});
});

describe("upsert input validation — non-service-principal providers", () => {
	it("still requires an API key for a direct provider", () => {
		const errors = validationErrors({ provider: "OPENAI_DIRECT" });

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/An API key is required/i);
	});

	it("accepts an API key for a direct provider", () => {
		expect(
			validationErrors({ provider: "OPENAI_DIRECT", apiKey: "sk-test" }),
		).toEqual([]);
	});

	it("rejects service-principal fields for a provider that does not support them", () => {
		const errors = validationErrors({
			provider: "AZURE_AI_FOUNDRY",
			apiKey: "azure-key",
			clientId: "client-abc",
			clientSecret: "secret-xyz",
			baseUrl: "https://example.openai.azure.com",
		});

		expect(
			errors.some((m) => /does not support service-principal/i.test(m)),
		).toBe(true);
	});
});

describe("upsert — SSRF guard on the stored workspace URL", () => {
	// The stored base URL is not just a request target: for a service principal
	// the server POSTs the CLIENT SECRET to `<origin>/oidc/v1/token` during
	// model resolution, so a config naming an internal host would exfiltrate it.
	const REJECTED = [
		[
			"link-local metadata service",
			"http://169.254.169.254/latest/meta-data",
		],
		["plaintext HTTP", "http://example-workspace.cloud.databricks.com"],
		["an arbitrary external host", "https://attacker.example.com"],
		["an intranet host", "https://internal-jenkins.corp"],
		["a malformed URL", "not-a-url"],
	] as const;

	for (const [label, baseUrl] of REJECTED) {
		it(`rejects ${label} in service-principal mode`, async () => {
			await expect(
				upsert._handler({
					input: {
						provider: "DATABRICKS",
						clientId: "client-abc",
						clientSecret: "secret-xyz",
						baseUrl,
					},
					context: personalContext,
				}),
			).rejects.toThrow(/Invalid Databricks workspace URL/i);
			expect(mockCreate).not.toHaveBeenCalled();
		});

		it(`rejects ${label} in API-key mode too`, async () => {
			// A PAT is a bearer credential on the same outbound path.
			await expect(
				upsert._handler({
					input: {
						provider: "DATABRICKS",
						apiKey: "dapi-token",
						baseUrl,
					},
					context: personalContext,
				}),
			).rejects.toThrow(/Invalid Databricks workspace URL/i);
			expect(mockCreate).not.toHaveBeenCalled();
		});
	}

	it("accepts the documented Databricks workspace hosts", async () => {
		for (const host of [
			"https://example-workspace.cloud.databricks.com",
			"https://example-workspace.azuredatabricks.net",
			"https://example-workspace.gcp.databricks.com",
		]) {
			mockCreate.mockClear();
			await upsert._handler({
				input: {
					provider: "DATABRICKS",
					clientId: "client-abc",
					clientSecret: "secret-xyz",
					baseUrl: host,
				},
				context: personalContext,
			});
			expect(mockCreate).toHaveBeenCalledTimes(1);
		}
	});

	it("accepts a workspace host carrying an explicit inference path", async () => {
		await upsert._handler({
			input: {
				provider: "DATABRICKS",
				clientId: "client-abc",
				clientSecret: "secret-xyz",
				baseUrl: `${WORKSPACE}/ai-gateway/mlflow/v1`,
			},
			context: personalContext,
		});

		expect(mockCreate).toHaveBeenCalledTimes(1);
	});
});

describe("upsert persistence — credential columns", () => {
	it("stores an encrypted client secret and NULLs the API key in OAuth mode", async () => {
		await upsert._handler({
			input: {
				provider: "DATABRICKS",
				clientId: "client-abc",
				clientSecret: "secret-xyz",
				baseUrl: WORKSPACE,
			},
			context: personalContext,
		});

		expect(mockCreate).toHaveBeenCalledTimes(1);
		const data = mockCreate.mock.calls[0][0].data;
		expect(data.clientId).toBe("client-abc");
		expect(data.encryptedClientSecret).toBe("encrypted:secret-xyz");
		// The plaintext secret must never reach the database.
		expect(data.encryptedClientSecret).not.toBe("secret-xyz");
		expect(data.encryptedApiKey).toBeNull();
	});

	it("stores an encrypted API key and NULLs the service principal in key mode", async () => {
		await upsert._handler({
			input: {
				provider: "DATABRICKS",
				apiKey: "dapi-token",
				baseUrl: WORKSPACE,
			},
			context: personalContext,
		});

		const data = mockCreate.mock.calls[0][0].data;
		expect(data.encryptedApiKey).toBe("encrypted:dapi-token");
		expect(data.clientId).toBeNull();
		expect(data.encryptedClientSecret).toBeNull();
	});

	it("clears the stored API key when an existing config switches to a service principal", async () => {
		// A config that previously authenticated with a PAT.
		mockFindUnique.mockResolvedValue({
			id: "ucpc_1",
			config: { baseUrl: WORKSPACE },
			encryptedApiKey: "encrypted:dapi-old",
			clientId: null,
			encryptedClientSecret: null,
		});

		await upsert._handler({
			input: {
				provider: "DATABRICKS",
				clientId: "client-abc",
				clientSecret: "secret-xyz",
				baseUrl: WORKSPACE,
			},
			context: personalContext,
		});

		expect(mockUpdate).toHaveBeenCalledTimes(1);
		const data = mockUpdate.mock.calls[0][0].data;
		// The stale PAT must be nulled, not left behind for a read path to find.
		expect(data.encryptedApiKey).toBeNull();
		expect(data.clientId).toBe("client-abc");
		expect(data.encryptedClientSecret).toBe("encrypted:secret-xyz");
	});

	it("clears the stored service principal when an existing config switches back to a key", async () => {
		mockFindUnique.mockResolvedValue({
			id: "ucpc_1",
			config: { baseUrl: WORKSPACE },
			encryptedApiKey: null,
			clientId: "client-abc",
			encryptedClientSecret: "encrypted:secret-xyz",
		});

		await upsert._handler({
			input: {
				provider: "DATABRICKS",
				apiKey: "dapi-token",
				baseUrl: WORKSPACE,
			},
			context: personalContext,
		});

		const data = mockUpdate.mock.calls[0][0].data;
		expect(data.encryptedApiKey).toBe("encrypted:dapi-token");
		expect(data.clientId).toBeNull();
		expect(data.encryptedClientSecret).toBeNull();
	});
});
