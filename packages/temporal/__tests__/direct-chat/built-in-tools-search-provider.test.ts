/**
 * Web-search provider selection in direct-chat built-in tools.
 *
 * Cloudflare Browser Rendering is a scrape-only provider: it can be an
 * organization's default search-provider row (that choice steers URL-source
 * scraping) but it cannot search. Selection must skip it at every step and
 * build `webSearch` on the next search-capable provider.
 *
 * `@repo/search` keeps its real `isWebSearchCapableProvider`, so the test
 * rests on the Cloudflare provider's actual metadata; only `createProvider`
 * is replaced to record which provider was built.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getMergedSearchProviderConfigs,
	getSearchProviderConfig,
	createProvider,
} = vi.hoisted(() => ({
	getMergedSearchProviderConfigs: vi.fn(),
	getSearchProviderConfig: vi.fn(),
	createProvider: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	tool: (def: unknown) => def,
}));

vi.mock("@repo/database", () => ({
	canCreateProjectStory: vi.fn(),
	db: {},
	getMergedSearchProviderConfigs,
	getSearchProviderConfig,
	incrementOrganizationSearchProviderUsage: vi.fn(),
	incrementUserSearchProviderUsage: vi.fn(),
}));

vi.mock("@repo/search", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/search")>()),
	createProvider,
}));

vi.mock("@repo/storage", () => ({ uploadFile: vi.fn() }));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	decryptApiKey: (value: string) => `decrypted:${value}`,
}));

vi.mock("../../src/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: vi.fn(),
}));

vi.mock("../../src/activities/orchestrator/utils", () => ({
	jsonSchemaToZod: () => ({}),
}));

vi.mock("../../src/activities/orchestrator/tools/fabric-ai-tools", () => ({
	getAllFabricAiTools: () => [],
}));

vi.mock("../../src/activities/shared/fabric-content-tools", () => ({
	getFabricToolDefinitionMap: () => new Map(),
}));

vi.mock("../../src/activities/shared/frame-service", () => ({
	createFirstClassFrame: vi.fn(),
	getFirstClassFrame: vi.fn(),
	listFirstClassFrames: vi.fn(),
	shareFirstClassFrame: vi.fn(),
	updateFirstClassFrame: vi.fn(),
}));

vi.mock("../../src/activities/direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: vi.fn(),
}));

import { createBuiltInTools } from "../../src/activities/direct-chat/built-in-tools";

function config(overrides: {
	providerName: string;
	isDefault?: boolean;
	priority?: number;
}) {
	return {
		providerName: overrides.providerName,
		encryptedApiKey: `enc-${overrides.providerName}`,
		endpoint: null,
		priority: overrides.priority ?? 0,
		isDefault: overrides.isDefault ?? false,
		enabled: true,
		source: "organization" as const,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	getSearchProviderConfig.mockResolvedValue(null);
	createProvider.mockReturnValue({ search: vi.fn() });
});

describe("getSearchProvider skips scrape-only providers", () => {
	it("falls through a Cloudflare default to the next search-capable row", async () => {
		getMergedSearchProviderConfigs.mockResolvedValue([
			config({ providerName: "cloudflare", isDefault: true }),
			config({ providerName: "tavily", priority: 10 }),
		]);

		const tools = await createBuiltInTools({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(tools).toHaveProperty("webSearch");
		expect(createProvider).toHaveBeenCalledTimes(1);
		expect(createProvider).toHaveBeenCalledWith(
			"tavily",
			"decrypted:enc-tavily",
		);
	});

	it("builds no web search when Cloudflare is the only provider", async () => {
		getMergedSearchProviderConfigs.mockResolvedValue([
			config({ providerName: "cloudflare", isDefault: true }),
		]);

		const tools = await createBuiltInTools({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(tools).not.toHaveProperty("webSearch");
		expect(createProvider).not.toHaveBeenCalled();
		// The fallback lookups still ran, and none of them asked for Cloudflare.
		expect(getSearchProviderConfig).toHaveBeenCalled();
		for (const [args] of getSearchProviderConfig.mock.calls) {
			expect(args.providerName).not.toBe("cloudflare");
		}
	});

	it("skips a better-ranked row createProvider cannot build (youtube) as well as the Cloudflare default", async () => {
		getMergedSearchProviderConfigs.mockResolvedValue([
			config({ providerName: "cloudflare", isDefault: true }),
			config({ providerName: "youtube", priority: 0 }),
			config({ providerName: "exa", priority: 20 }),
		]);

		const tools = await createBuiltInTools({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(tools).toHaveProperty("webSearch");
		expect(createProvider).toHaveBeenCalledTimes(1);
		expect(createProvider).toHaveBeenCalledWith("exa", "decrypted:enc-exa");
	});

	it("still uses a search-capable default", async () => {
		getMergedSearchProviderConfigs.mockResolvedValue([
			config({ providerName: "exa", isDefault: true }),
			config({ providerName: "cloudflare", priority: 0 }),
		]);

		await createBuiltInTools({ userId: "user-1", organizationId: "org-1" });

		expect(createProvider).toHaveBeenCalledWith("exa", "decrypted:enc-exa");
	});
});
