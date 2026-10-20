/**
 * Tests for upsertUserProviderProcedure — server-side base URL validation.
 *
 * Providers whose metadata declares `requiresBaseUrl` (Databricks, Azure AI
 * Foundry, AWS Bedrock, Cloudflare AI, ...) cannot function without a
 * tenant-supplied base URL. The client forms already block an empty base URL,
 * but a direct oRPC call could otherwise persist such a config with no base
 * URL — a bad state that downstream misroutes the tenant's provider key to
 * OpenRouter's host (see apps/web/app/api/agents/ai-config/route.ts). These
 * tests verify the handler rejects that input at the persistence boundary
 * (fail-fast, before any DB work or org-membership check) and still allows the
 * happy path. Azure endpoint validation also runs before credential encryption.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDb,
	mockCreate,
	mockOrgCreate,
	mockEncryptApiKey,
	mockGetProviderMetadata,
	mockRequireOrgMembership,
	mockResolveOrganizationId,
} = vi.hoisted(() => {
	const mockCreate = vi.fn();
	const txUser = {
		findUnique: vi.fn(),
		findFirst: vi.fn(),
		updateMany: vi.fn().mockResolvedValue({ count: 0 }),
		create: mockCreate,
	};
	const mockOrgCreate = vi.fn();
	const txOrg = {
		findUnique: vi.fn(),
		findFirst: vi.fn(),
		updateMany: vi.fn().mockResolvedValue({ count: 0 }),
		create: mockOrgCreate,
	};
	const mockDb = {
		$transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
			cb({ userCloudProviderConfig: txUser, cloudProviderConfig: txOrg }),
		),
	};
	return {
		mockDb,
		mockCreate,
		mockOrgCreate,
		mockEncryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
		mockGetProviderMetadata: vi.fn(),
		mockRequireOrgMembership: vi.fn(),
		mockResolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

vi.mock("@repo/database", () => ({
	db: mockDb,
	LLM_PROVIDER_PURPOSE_FILTER: { purpose: { not: "EMBEDDINGS_ONLY" } },
	getProviderMetadata: (...args: unknown[]) =>
		mockGetProviderMetadata(...args),
	// Named imports used by sibling procedures in the module (must resolve since
	// the whole module is imported for side effects).
	getProviderDisplayName: vi.fn((p: string) => p),
	getEmbeddingProviderConfig: vi.fn(),
	ALL_EMBEDDING_CAPABLE_PROVIDERS: [],
	canProviderSupportEmbeddings: vi.fn(() => true),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: mockEncryptApiKey,
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: (...args: unknown[]) =>
		mockRequireOrgMembership(...args),
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

// Side-effect import registers the handler on the exported procedure object.
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
};

const personalContext = {
	user: { id: "user-1" },
	session: { id: "s1", activeOrganizationId: null },
};

const orgContext = {
	user: { id: "user-1" },
	session: { id: "s1", activeOrganizationId: "org-1" },
};

const REQUIRES_BASE_URL: Record<
	string,
	{ requiresBaseUrl: boolean; displayName: string }
> = {
	DATABRICKS: { requiresBaseUrl: true, displayName: "Databricks" },
	AZURE_AI_FOUNDRY: {
		requiresBaseUrl: true,
		displayName: "Azure AI Foundry",
	},
	AWS_BEDROCK: { requiresBaseUrl: true, displayName: "AWS Bedrock" },
	CLOUDFLARE_AI: { requiresBaseUrl: true, displayName: "Cloudflare AI" },
	OPENROUTER: { requiresBaseUrl: false, displayName: "OpenRouter" },
};

describe("upsertUserProviderProcedure — base URL validation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetProviderMetadata.mockImplementation(
			(p: string) => REQUIRES_BASE_URL[p],
		);
		mockRequireOrgMembership.mockResolvedValue({ role: "admin" });
		mockCreate.mockResolvedValue({
			id: "ucpc_1",
			provider: "DATABRICKS",
			displayName: "Databricks",
			isDefault: true,
		});
	});

	describe("rejects providers that require a base URL", () => {
		it("rejects a Databricks config with no base URL", async () => {
			await expect(
				upsert._handler({
					input: {
						provider: "DATABRICKS",
						apiKey: "dapi-secret",
						organizationId: null,
					},
					context: personalContext,
				}),
			).rejects.toThrow(/requires a base URL/i);

			// Fail-fast: never touches the database.
			expect(mockDb.$transaction).not.toHaveBeenCalled();
		});

		it("rejects an empty-string base URL", async () => {
			await expect(
				upsert._handler({
					input: {
						provider: "DATABRICKS",
						apiKey: "dapi-secret",
						baseUrl: "",
						organizationId: null,
					},
					context: personalContext,
				}),
			).rejects.toThrow(/requires a base URL/i);
			expect(mockDb.$transaction).not.toHaveBeenCalled();
		});

		it("rejects a whitespace-only base URL", async () => {
			await expect(
				upsert._handler({
					input: {
						provider: "DATABRICKS",
						apiKey: "dapi-secret",
						baseUrl: "   ",
						organizationId: null,
					},
					context: personalContext,
				}),
			).rejects.toThrow(/requires a base URL/i);
			expect(mockDb.$transaction).not.toHaveBeenCalled();
		});

		it("rejects Azure AI Foundry with no base URL (message names the provider)", async () => {
			await expect(
				upsert._handler({
					input: {
						provider: "AZURE_AI_FOUNDRY",
						apiKey: "azure-secret",
						organizationId: null,
					},
					context: personalContext,
				}),
			).rejects.toThrow(/Azure AI Foundry requires a base URL/i);
		});

		it("rejects an org-level config before checking org membership (fail-fast)", async () => {
			await expect(
				upsert._handler({
					input: {
						provider: "DATABRICKS",
						apiKey: "dapi-secret",
						organizationId: "org-1",
					},
					context: {
						user: { id: "user-1" },
						session: { id: "s1", activeOrganizationId: "org-1" },
					},
				}),
			).rejects.toThrow(/requires a base URL/i);

			expect(mockRequireOrgMembership).not.toHaveBeenCalled();
			expect(mockDb.$transaction).not.toHaveBeenCalled();
		});
	});

	describe("rejects unsafe Azure AI Foundry endpoints", () => {
		it.each([
			["malformed URL", "not-a-url"],
			["metadata endpoint", "https://169.254.169.254/metadata"],
			["private endpoint", "https://10.0.0.1"],
			["localhost", "https://localhost"],
			["unrecognized host", "https://example.com"],
			[
				"lookalike suffix",
				"https://example.openai.azure.com.example.com",
			],
			["lookalike prefix", "https://exampleopenai.azure.com"],
			["non-HTTPS endpoint", "http://example.openai.azure.com"],
		])(
			"rejects %s before encryption or persistence",
			async (_, baseUrl) => {
				await expect(
					upsert._handler({
						input: {
							provider: "AZURE_AI_FOUNDRY",
							apiKey: "azure-secret",
							baseUrl,
							organizationId: "org-1",
						},
						context: orgContext,
					}),
				).rejects.toMatchObject({
					code: "BAD_REQUEST",
					message: expect.stringContaining(
						"Invalid Azure AI Foundry URL:",
					),
				});

				expect(mockEncryptApiKey).not.toHaveBeenCalled();
				expect(mockRequireOrgMembership).not.toHaveBeenCalled();
				expect(mockDb.$transaction).not.toHaveBeenCalled();
				expect(mockOrgCreate).not.toHaveBeenCalled();
				expect(mockCreate).not.toHaveBeenCalled();
			},
		);
	});

	describe("allows valid input", () => {
		it.each([
			"https://example.openai.azure.com",
			"https://example.cognitiveservices.azure.com",
			"https://example.services.ai.azure.com/api/projects/example-project",
		])("persists the recognized Azure endpoint %s", async (baseUrl) => {
			mockOrgCreate.mockResolvedValueOnce({
				id: "cpc_azure",
				provider: "AZURE_AI_FOUNDRY",
				displayName: "Azure AI Foundry",
				isDefault: true,
				purpose: "ALL",
				config: { baseUrl, deploymentName: "example-deployment" },
			});

			const res = await upsert._handler({
				input: {
					provider: "AZURE_AI_FOUNDRY",
					apiKey: "azure-secret",
					baseUrl,
					deploymentName: "example-deployment",
					organizationId: "org-1",
				},
				context: orgContext,
			});

			expect(res).toMatchObject({
				success: true,
				provider: "AZURE_AI_FOUNDRY",
			});
			expect(mockRequireOrgMembership).toHaveBeenCalledWith(
				"user-1",
				"org-1",
				["owner", "admin"],
			);
			expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
			expect(mockEncryptApiKey).toHaveBeenCalledWith("azure-secret");
			expect(mockOrgCreate).toHaveBeenCalledTimes(1);
			expect(mockOrgCreate).toHaveBeenCalledWith({
				data: expect.objectContaining({
					organizationId: "org-1",
					provider: "AZURE_AI_FOUNDRY",
					encryptedApiKey: "encrypted:azure-secret",
					config: { baseUrl, deploymentName: "example-deployment" },
				}),
			});
			expect(mockCreate).not.toHaveBeenCalled();
		});

		it("persists a Databricks config when a base URL is provided", async () => {
			const res = await upsert._handler({
				input: {
					provider: "DATABRICKS",
					apiKey: "dapi-secret",
					baseUrl: "https://xyz.cloud.databricks.com",
					organizationId: null,
				},
				context: personalContext,
			});

			expect(res.success).toBe(true);
			expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
			// The base URL is written into the stored JSON config.
			expect(mockCreate).toHaveBeenCalledTimes(1);
			expect(mockCreate.mock.calls[0][0].data.config).toMatchObject({
				baseUrl: "https://xyz.cloud.databricks.com",
			});
		});

		it("allows a provider that does not require a base URL (no base URL supplied)", async () => {
			mockCreate.mockResolvedValueOnce({
				id: "ucpc_2",
				provider: "OPENROUTER",
				displayName: "OpenRouter",
				isDefault: true,
			});

			const res = await upsert._handler({
				input: {
					provider: "OPENROUTER",
					apiKey: "sk-or-secret",
					organizationId: null,
				},
				context: personalContext,
			});

			expect(res.success).toBe(true);
			expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
		});
	});
});
