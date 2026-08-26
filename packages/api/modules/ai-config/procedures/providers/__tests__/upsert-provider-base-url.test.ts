/**
 * Tests for upsertUserProviderProcedure — server-side `requiresBaseUrl`
 * enforcement.
 *
 * Providers whose metadata declares `requiresBaseUrl` (Databricks, Azure AI
 * Foundry, AWS Bedrock, Cloudflare AI, ...) cannot function without a
 * tenant-supplied base URL. The client forms already block an empty base URL,
 * but a direct oRPC call could otherwise persist such a config with no base
 * URL — a bad state that downstream misroutes the tenant's provider key to
 * OpenRouter's host (see apps/web/app/api/agents/ai-config/route.ts). These
 * tests verify the handler rejects that input at the persistence boundary
 * (fail-fast, before any DB work or org-membership check) and still allows the
 * happy path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDb,
	mockCreate,
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
	const mockDb = {
		$transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
			cb({ userCloudProviderConfig: txUser }),
		),
	};
	return {
		mockDb,
		mockCreate,
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
	getProviderMetadata: (...args: unknown[]) =>
		mockGetProviderMetadata(...args),
	// Named imports used by sibling procedures in the module (must resolve since
	// the whole module is imported for side effects).
	getProviderDisplayName: vi.fn((p: string) => p),
	getEmbeddingProviderConfig: vi.fn(),
	ALL_EMBEDDING_CAPABLE_PROVIDERS: [],
	canProviderSupportEmbeddings: vi.fn(() => true),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
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

describe("upsertUserProviderProcedure — requiresBaseUrl enforcement", () => {
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

	describe("allows valid input", () => {
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
