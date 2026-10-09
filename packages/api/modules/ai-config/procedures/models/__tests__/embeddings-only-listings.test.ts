/**
 * Listings that offer LLM models or options must not treat an embeddings-only
 * key (Fizzy #2770 F11) as a source of them.
 *
 * - The gateway model list never reads an embeddings-only row.
 * - AI usage limit options keep such a key (its embedding spend can still be
 *   capped) but offer only its embedding models.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	orgFindFirst: vi.fn(),
	orgFindMany: vi.fn(),
	mappingFindMany: vi.fn(),
	getOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		cloudProviderConfig: {
			findFirst: mocks.orgFindFirst,
			findMany: mocks.orgFindMany,
		},
		userCloudProviderConfig: { findFirst: vi.fn(), findMany: vi.fn() },
		aiModelProviderMapping: { findMany: mocks.mappingFindMany },
	},
	getOrganizationMembership: mocks.getOrganizationMembership,
	getProviderDisplayName: (provider: string) => provider,
	LLM_PROVIDER_PURPOSE_FILTER: { purpose: { not: "EMBEDDINGS_ONLY" } },
}));

vi.mock("@repo/ai", () => ({ resolveProviderApiKey: vi.fn() }));

vi.mock("../../../lib/gateway-model-fetcher", () => ({
	fetchGatewayModels: vi.fn(),
	getProvidersFromGatewayModels: vi.fn(),
	groupModelsByProvider: vi.fn(),
	supportsModelFetching: vi.fn(() => false),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: { ORG_AI_CONFIG_READ: "org_ai_config_read" },
	};
});

import { providerOptions } from "../../../../payments/procedures/ai-usage-limits/provider-options";
import { listModelsFromGatewayProcedure } from "../list-from-gateway";

type Handler<T> = {
	_handler: (args: { input: unknown; context: unknown }) => Promise<T>;
};
const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.orgFindFirst.mockResolvedValue(null);
	mocks.getOrganizationMembership.mockResolvedValue({ role: "owner" });
});

describe("listModelsFromGateway", () => {
	it("never reads an embeddings-only row, default or fallback", async () => {
		await (
			listModelsFromGatewayProcedure as unknown as Handler<unknown>
		)._handler({ input: { organizationId: "org-1" }, context });

		expect(mocks.orgFindFirst).toHaveBeenCalledTimes(2);
		for (const [args] of mocks.orgFindFirst.mock.calls) {
			expect(args.where).toMatchObject({
				organizationId: "org-1",
				purpose: { not: "EMBEDDINGS_ONLY" },
			});
		}
	});
});

describe("AI usage limit provider options", () => {
	it("offers only embedding models on an embeddings-only key", async () => {
		mocks.orgFindMany.mockResolvedValue([
			{
				id: "cpc_embed",
				provider: "OPENAI_DIRECT",
				displayName: null,
				purpose: "EMBEDDINGS_ONLY",
			},
			{
				id: "cpc_all",
				provider: "ANTHROPIC_DIRECT",
				displayName: null,
				purpose: "ALL",
			},
		]);
		mocks.mappingFindMany.mockResolvedValue([
			{
				provider: "OPENAI_DIRECT",
				model: {
					canonicalName: "gpt-chat",
					displayName: "GPT chat",
					capabilities: ["TEXT"],
				},
			},
			{
				provider: "OPENAI_DIRECT",
				model: {
					canonicalName: "text-embedding",
					displayName: "Text embedding",
					capabilities: ["EMBEDDING"],
				},
			},
			{
				provider: "ANTHROPIC_DIRECT",
				model: {
					canonicalName: "claude-chat",
					displayName: "Claude chat",
					capabilities: ["TEXT"],
				},
			},
		]);

		const result = await (
			providerOptions as unknown as Handler<{
				providers: Array<{
					provider: string;
					models: Array<{ canonicalName: string }>;
				}>;
			}>
		)._handler({ input: { organizationId: "org-1" }, context });

		expect(
			result.providers.map((p) => [
				p.provider,
				p.models.map((m) => m.canonicalName),
			]),
		).toEqual([
			["OPENAI_DIRECT", ["text-embedding"]],
			["ANTHROPIC_DIRECT", ["claude-chat"]],
		]);
	});
});
