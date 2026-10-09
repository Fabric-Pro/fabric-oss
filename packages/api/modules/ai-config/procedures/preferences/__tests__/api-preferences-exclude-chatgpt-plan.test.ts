/**
 * The API model form never sees a ChatGPT plan row (Fizzy #2770 F4/F5).
 *
 * The plan tab stores its per-task models in the same preferences table, and
 * the catalog seeds task defaults for OPENAI_CHATGPT_PLAN. Neither is an API
 * choice: task defaults come only from the tenant's default or configured LLM
 * providers, and the preference readers return API rows only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	taskDefaultFindMany: vi.fn(),
	orgProviderFindMany: vi.fn(),
	userProviderFindMany: vi.fn(),
	getAiProviderApiKey: vi.fn(),
	getEmbeddingProviderConfig: vi.fn(),
	getOrgModelPreferences: vi.fn(),
	getUserModelPreferences: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		aiTaskModelDefault: { findMany: mocks.taskDefaultFindMany },
		cloudProviderConfig: {
			findMany: mocks.orgProviderFindMany,
			findFirst: vi.fn(),
		},
		userCloudProviderConfig: {
			findMany: mocks.userProviderFindMany,
			findFirst: vi.fn(),
		},
		aiModel: { findMany: vi.fn().mockResolvedValue([]) },
	},
	getAiProviderApiKey: mocks.getAiProviderApiKey,
	getEmbeddingProviderConfig: mocks.getEmbeddingProviderConfig,
	getAiProviderApiKeyByProvider: vi
		.fn()
		.mockResolvedValue({ provider: null }),
	getOrgModelPreferences: mocks.getOrgModelPreferences,
	getUserModelPreferences: mocks.getUserModelPreferences,
	LLM_PROVIDER_PURPOSE_FILTER: { purpose: { not: "EMBEDDINGS_ONLY" } },
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

import { getOrgModelPreferencesProcedure } from "../get-org";
import { getTaskDefaultsProcedure } from "../get-task-defaults";
import { getUserModelPreferencesProcedure } from "../get-user";

type Handler<T> = {
	_handler: (args: { input: unknown; context: unknown }) => Promise<T>;
};
const context = { user: { id: "user-1" }, session: {} };

function taskDefault(taskType: string, provider: string) {
	return {
		taskType,
		complexity: "MEDIUM",
		priority: 1,
		provider,
		model: {
			id: `${provider}-${taskType}`,
			canonicalName: `${provider}-${taskType}`.toLowerCase(),
			displayName: `${provider} ${taskType}`,
			family: "example",
			vendor: "Example AI",
			speedTier: "BALANCED",
			qualityTier: "STANDARD",
		},
	};
}

const CATALOG = [
	taskDefault("CHAT", "OPENAI_CHATGPT_PLAN"),
	taskDefault("CHAT", "OPENAI_DIRECT"),
	taskDefault("CHAT", "ANTHROPIC_DIRECT"),
	taskDefault("CHAT", "VERCEL_GATEWAY"),
	taskDefault("EMBEDDING", "VERCEL_GATEWAY"),
];

function inProviders(where: Record<string, unknown>) {
	const condition = where.provider as string | { in: string[] } | undefined;
	return (row: { provider: string }) =>
		condition === undefined ||
		(typeof condition === "string"
			? row.provider === condition
			: condition.in.includes(row.provider));
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.taskDefaultFindMany.mockImplementation(
		async ({ where }: { where: Record<string, unknown> }) =>
			CATALOG.filter(inProviders(where)).filter(
				(row) =>
					where.taskType === undefined ||
					row.taskType === where.taskType,
			),
	);
	mocks.getEmbeddingProviderConfig.mockResolvedValue({ provider: null });
	mocks.orgProviderFindMany.mockResolvedValue([]);
	mocks.userProviderFindMany.mockResolvedValue([]);
});

describe("getTaskDefaults (F4)", () => {
	const getTaskDefaults = getTaskDefaultsProcedure as unknown as Handler<
		Array<{ provider: string | null }>
	>;

	it("returns nothing when the organization has no default and no configured LLM provider", async () => {
		mocks.getAiProviderApiKey.mockResolvedValue({ provider: null });

		const defaults = await getTaskDefaults._handler({
			input: { organizationId: "org-1" },
			context,
		});

		expect(defaults).toEqual([]);
		expect(mocks.orgProviderFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId: "org-1",
					enabled: true,
					purpose: { not: "EMBEDDINGS_ONLY" },
				},
			}),
		);
	});

	it("returns only the configured LLM providers' defaults when there is no default", async () => {
		mocks.getAiProviderApiKey.mockResolvedValue({ provider: null });
		mocks.orgProviderFindMany.mockResolvedValue([
			{ provider: "ANTHROPIC_DIRECT" },
		]);

		const defaults = await getTaskDefaults._handler({
			input: { organizationId: "org-1" },
			context,
		});

		expect(defaults.map((d) => d.provider)).toEqual(["ANTHROPIC_DIRECT"]);
	});

	// Fizzy #2770: an embeddings-only key is never the default and never an
	// LLM provider, but its documents default still shows.
	it("returns only the documents provider's EMBEDDING default for an embeddings-only key", async () => {
		mocks.getAiProviderApiKey.mockResolvedValue({ provider: null });
		mocks.getEmbeddingProviderConfig.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
		});

		const defaults = (await getTaskDefaults._handler({
			input: { organizationId: "org-1" },
			context,
		})) as Array<{ provider: string | null; taskType?: string }>;

		expect(defaults.map((d) => [d.taskType, d.provider])).toEqual([
			["EMBEDDING", "VERCEL_GATEWAY"],
		]);
		expect(mocks.getEmbeddingProviderConfig).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("still returns the default provider's defaults, never a plan row", async () => {
		mocks.getAiProviderApiKey.mockResolvedValue({
			provider: "OPENAI_DIRECT",
		});

		const defaults = await getTaskDefaults._handler({
			input: { organizationId: "org-1" },
			context,
		});

		expect(defaults.map((d) => d.provider)).toEqual(["OPENAI_DIRECT"]);
		expect(mocks.orgProviderFindMany).not.toHaveBeenCalled();
	});
});

describe("getOrg preferences (F5)", () => {
	const getOrg = getOrgModelPreferencesProcedure as unknown as Handler<
		Array<{ provider: string }>
	>;

	it("reads the organization's preferences through the API-only reader", async () => {
		mocks.getAiProviderApiKey.mockResolvedValue({
			provider: "OPENAI_DIRECT",
		});
		mocks.getOrgModelPreferences.mockResolvedValue([]);

		await getOrg._handler({ input: { organizationId: "org-1" }, context });

		// No provider argument: the reader then excludes plan rows itself.
		expect(mocks.getOrgModelPreferences).toHaveBeenCalledWith("org-1");
	});

	// Fizzy #2770: the staging setup — only an embeddings-only Vercel AI
	// Gateway key, so no default provider, and a saved EMBEDDING choice.
	const EMBEDDING_PREFERENCE = {
		id: "pref-1",
		provider: "VERCEL_GATEWAY",
		taskType: "EMBEDDING",
		customParameters: null,
		model: {
			id: "model-embed-large",
			canonicalName: "text-embedding-3-large",
			displayName: "Text Embedding 3 Large",
			family: "text-embedding-3",
			vendor: "OpenAI",
			contextWindow: 8191,
			speedTier: "BALANCED",
			qualityTier: "PREMIUM",
		},
	};

	it("shows the saved EMBEDDING choice when the only key is embeddings-only", async () => {
		mocks.getAiProviderApiKey.mockResolvedValue({ provider: null });
		mocks.getEmbeddingProviderConfig.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
		});
		mocks.getOrgModelPreferences.mockResolvedValue([EMBEDDING_PREFERENCE]);

		const preferences = await getOrg._handler({
			input: { organizationId: "org-1" },
			context,
		});

		expect(preferences).toEqual([EMBEDDING_PREFERENCE]);
		expect(mocks.getEmbeddingProviderConfig).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("returns nothing when the organization has no provider at all", async () => {
		mocks.getAiProviderApiKey.mockResolvedValue({ provider: null });
		mocks.getOrgModelPreferences.mockResolvedValue([EMBEDDING_PREFERENCE]);

		await expect(
			getOrg._handler({ input: { organizationId: "org-1" }, context }),
		).resolves.toEqual([]);
		expect(mocks.getOrgModelPreferences).not.toHaveBeenCalled();
	});

	it("shows a member's saved EMBEDDING choice on an embeddings-only key too", async () => {
		const getUser = getUserModelPreferencesProcedure as unknown as Handler<
			Array<{ taskType: string }>
		>;
		mocks.getAiProviderApiKey.mockResolvedValue({ provider: null });
		mocks.getEmbeddingProviderConfig.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
		});
		mocks.getUserModelPreferences.mockResolvedValue([EMBEDDING_PREFERENCE]);

		const preferences = await getUser._handler({
			input: { organizationId: "org-1" },
			context,
		});

		expect(preferences.map((pref) => pref.taskType)).toEqual(["EMBEDDING"]);
	});
});
