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
	getOrganizationDefaultProvider: vi.fn(),
	getOrganizationSystemAiProviderApiKey: async () => ({ provider: null }),
	getSystemAiProviderApiKey: async () => ({ provider: null }),
	getEmbeddingProviderConfig: vi.fn(),
	getOrgModelPreferences: vi.fn(),
	getUserModelPreferences: vi.fn(),
}));

vi.mock("@repo/ai/model-selector", () => ({
	selectModelDynamic: vi.fn(async () => ({
		modelId: "VERCEL_GATEWAY-EMBEDDING",
		canonicalName: "example-embedding",
		displayName: "Example embedding",
		providerModelId: "example-embedding",
	})),
}));

vi.mock("@repo/database", () => ({
	SELECTABLE_CATALOG_MODEL_FILTER: { isActive: true, deprecatedAt: null },
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
		aiModel: {
			findMany: vi.fn().mockResolvedValue([]),
			findUnique: vi.fn(
				async () =>
					CATALOG.find((entry) => entry.taskType === "EMBEDDING")
						?.model ?? null,
			),
		},
	},
	getAiProviderApiKey: mocks.getAiProviderApiKey,
	getOrganizationDefaultProvider: mocks.getOrganizationDefaultProvider,
	getSystemAiProviderApiKey: mocks.getSystemAiProviderApiKey,
	getOrganizationSystemAiProviderApiKey:
		mocks.getOrganizationSystemAiProviderApiKey,
	getEmbeddingProviderConfig: mocks.getEmbeddingProviderConfig,
	getAiProviderApiKeyByProvider: vi
		.fn()
		.mockResolvedValue({ provider: null }),
	getOrgModelPreferences: mocks.getOrgModelPreferences,
	getUserModelPreferences: mocks.getUserModelPreferences,
	LLM_PROVIDER_PURPOSE_FILTER: { purpose: { not: "EMBEDDINGS_ONLY" } },
	// No connection snapshot: Settings reads the live template rows above.
	readTaskDefaultsSnapshot: vi.fn(() => null),
	getTaskDefaultModel: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: (schema: unknown) => {
			chainable._outputSchema = schema;
			return chainable;
		},
		handler: (fn: (...args: unknown[]) => unknown) => ({
			_handler: fn,
			_outputSchema: chainable._outputSchema,
		}),
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
	mocks.getOrganizationDefaultProvider.mockResolvedValue(null);
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
		expect(mocks.orgProviderFindMany).not.toHaveBeenCalled();
	});

	it("returns no text defaults when configured LLM providers have no default", async () => {
		mocks.getAiProviderApiKey.mockResolvedValue({ provider: null });
		mocks.orgProviderFindMany.mockResolvedValue([
			{ provider: "ANTHROPIC_DIRECT" },
		]);

		const defaults = await getTaskDefaults._handler({
			input: { organizationId: "org-1" },
			context,
		});

		expect(defaults).toEqual([]);
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
		const { selectModelDynamic } = await import("@repo/ai/model-selector");
		expect(selectModelDynamic).toHaveBeenCalledWith(
			{
				taskType: "EMBEDDING",
				preferredProvider: "VERCEL_GATEWAY",
				ignorePreferences: true,
			},
			{
				userId: "user-1",
				organizationId: "org-1",
				organizationOnly: true,
			},
		);
		expect(mocks.getEmbeddingProviderConfig).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("still returns the default provider's defaults, never a plan row", async () => {
		mocks.getOrganizationDefaultProvider.mockResolvedValue("OPENAI_DIRECT");
		mocks.getAiProviderApiKey.mockResolvedValue({
			provider: "OPENAI_DIRECT",
		});

		const defaults = await getTaskDefaults._handler({
			input: { organizationId: "org-1" },
			context,
		});

		expect(defaults.map((d) => d.provider)).toEqual([
			"OPENAI_DIRECT",
			"OPENAI_DIRECT",
		]);
		expect(mocks.orgProviderFindMany).not.toHaveBeenCalled();
	});
});

describe("getOrg preferences (F5)", () => {
	beforeEach(() =>
		mocks.orgProviderFindMany.mockResolvedValue([
			{ provider: "OPENAI_DIRECT" },
		]),
	);
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
			inputCostPer1M: 2,
			outputCostPer1M: 8,
			suitableForTasks: ["EMBEDDING"],
			capabilities: ["EMBEDDING"],
		},
	};

	it("shows the saved EMBEDDING choice when the only key is embeddings-only", async () => {
		mocks.getAiProviderApiKey.mockResolvedValue({ provider: null });
		mocks.getEmbeddingProviderConfig.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
		});
		mocks.getOrgModelPreferences.mockResolvedValue([
			{
				...EMBEDDING_PREFERENCE,
				model: {
					...EMBEDDING_PREFERENCE.model,
					inputCostPer1M: { toString: () => "2" },
					outputCostPer1M: { toString: () => "8" },
				},
			},
		]);

		const preferences = await getOrg._handler({
			input: { organizationId: "org-1" },
			context,
		});

		const parsed = (
			getOrgModelPreferencesProcedure as unknown as {
				_outputSchema: { parse: (value: unknown) => unknown };
			}
		)._outputSchema.parse(preferences);
		expect(parsed).toEqual([EMBEDDING_PREFERENCE]);
		expect(mocks.orgProviderFindMany).toHaveBeenCalledWith({
			where: { organizationId: "org-1", enabled: true },
			select: { id: true },
			take: 1,
		});
	});

	it("returns nothing when the organization has no provider at all", async () => {
		mocks.orgProviderFindMany.mockResolvedValue([]);
		mocks.getOrganizationDefaultProvider.mockResolvedValue(null);
		mocks.getAiProviderApiKey.mockResolvedValue({ provider: null });
		mocks.getOrgModelPreferences.mockResolvedValue([
			{
				...EMBEDDING_PREFERENCE,
				model: {
					...EMBEDDING_PREFERENCE.model,
					inputCostPer1M: { toString: () => "2" },
					outputCostPer1M: { toString: () => "8" },
				},
			},
		]);

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

it("preserves personal documents defaults when no personal LLM default is configured", async () => {
	mocks.getAiProviderApiKey.mockResolvedValue({ provider: null });
	mocks.getEmbeddingProviderConfig.mockResolvedValue({
		provider: "VERCEL_GATEWAY",
	});
	const result = await (
		getTaskDefaultsProcedure as unknown as Handler<
			Array<{ taskType: string; provider: string }>
		>
	)._handler({ input: { organizationId: null }, context });
	expect(result.map((row) => [row.taskType, row.provider])).toEqual([
		["EMBEDDING", "VERCEL_GATEWAY"],
	]);
});

it("returns the saved Decision choice with a keyed gateway and no organization default", async () => {
	mocks.getOrganizationDefaultProvider.mockResolvedValue(null);
	mocks.getAiProviderApiKey.mockResolvedValue({ provider: null });
	mocks.getEmbeddingProviderConfig.mockResolvedValue({ provider: null });
	mocks.orgProviderFindMany.mockResolvedValue([
		{
			provider: "VERCEL_GATEWAY",
			enabled: true,
			purpose: "ALL",
			encryptedApiKey: "example-key",
		},
	]);
	const choice = {
		id: "example-decision",
		provider: "VERCEL_GATEWAY",
		taskType: "DECISION",
		customParameters: null,
		model: taskDefault("DECISION", "VERCEL_GATEWAY").model,
	};
	mocks.getOrgModelPreferences.mockResolvedValue([choice]);
	const result = await (
		getOrgModelPreferencesProcedure as unknown as Handler<unknown>
	)._handler({ input: { organizationId: "example-org" }, context });
	expect(result).toEqual([
		{
			...choice,
			model: {
				...choice.model,
				inputCostPer1M: null,
				outputCostPer1M: null,
			},
		},
	]);
});

it.each([false, true])(
	"returns a saved OpenJev choice with Databricks credentials (OAuth=%s)",
	async (oauth) => {
		mocks.getOrganizationDefaultProvider.mockResolvedValue(null);
		mocks.orgProviderFindMany.mockResolvedValue([
			{
				provider: "DATABRICKS",
				enabled: true,
				purpose: "ALL",
				encryptedApiKey: oauth ? null : "encrypted:example-key",
				clientId: oauth ? "example-client" : null,
				encryptedClientSecret: oauth
					? "encrypted:example-secret"
					: null,
			},
		]);
		const choice = {
			id: "example-preference",
			provider: "DATABRICKS",
			taskType: "DECISION",
			customParameters: null,
			model: {
				...taskDefault("DECISION", "DATABRICKS").model,
				canonicalName: "openjev-qwen35-4b",
				displayName: "OpenJev (Qwen3.5 4B)",
			},
		};
		mocks.getOrgModelPreferences.mockResolvedValue([choice]);
		const result = await (
			getOrgModelPreferencesProcedure as unknown as Handler<unknown>
		)._handler({ input: { organizationId: "example-org" }, context });
		expect(result).toMatchObject([
			{
				provider: "DATABRICKS",
				taskType: "DECISION",
				model: { canonicalName: "openjev-qwen35-4b" },
			},
		]);
		expect(mocks.userProviderFindMany).not.toHaveBeenCalled();
	},
);
