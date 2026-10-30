/**
 * The organization's only provider is a Vercel AI Gateway key saved for
 * embeddings only (Fizzy #2770 F11): it is never the default, yet the AI
 * Models embeddings row must list its embedding models — and no language-
 * model listing may offer a model only that key would serve. Provider
 * resolution is the real `getConfiguredProviders`.
 */

import { getOrganizationDefaultProvider } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	providers: vi.fn(),
	models: vi.fn(),
	planModel: vi.fn(async (_params: unknown) => null),
}));

vi.mock("@repo/database", () => ({
	SELECTABLE_CATALOG_MODEL_FILTER: { isActive: true, deprecatedAt: null },
	db: {
		cloudProviderConfig: { findMany: db.providers },
		aiModel: { findMany: db.models },
	},
	getOrganizationDefaultProvider: vi.fn(async () => null),
	getProviderDisplayName: (provider: string) => provider,
	ALL_AUDIO_CAPABLE_PROVIDERS: ["OPENAI_DIRECT"],
	ALL_IMAGE_CAPABLE_PROVIDERS: ["OPENAI_DIRECT"],
	ALL_EMBEDDING_CAPABLE_PROVIDERS: ["OPENAI_DIRECT", "VERCEL_GATEWAY"],
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY"],
}));

vi.mock("@repo/ai/lib/chatgpt-plan/pool", () => ({
	interactivePlanModel: db.planModel,
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
		resolveOrganizationId: (
			organizationId: string | undefined,
			session?: { activeOrganizationId?: string },
		) => organizationId ?? session?.activeOrganizationId,
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: { ORG_AI_CONFIG_READ: "org_ai_config_read" },
	};
});

import { listAvailableModelsProcedure } from "../list-available";

const listAvailable = listAvailableModelsProcedure as unknown as {
	_handler: (args: {
		input: unknown;
		context: { user: { id: string }; session: unknown };
	}) => Promise<{
		organizationDefaultProvider: string | null;
		defaultProvider: string | null;
		configuredProviders: Array<{ provider: string; isDefault: boolean }>;
		models: Array<{ canonicalName: string }>;
		modelsByGatewayAndProvider: Record<
			string,
			{
				providers: Record<
					string,
					{ models: Array<{ canonicalName: string }> }
				>;
			}
		>;
	}>;
};

const model = (canonicalName: string, suitableForTasks: string[]) => ({
	id: canonicalName,
	canonicalName,
	displayName: canonicalName,
	description: null,
	family: "openai",
	vendor: "OpenAI",
	contextWindow: 8192,
	speedTier: "BALANCED",
	qualityTier: "STANDARD",
	suitableForTasks,
	capabilities: suitableForTasks.includes("EMBEDDING")
		? ["EMBEDDING"]
		: ["TEXT"],
	inputCostPer1M: { toString: () => "2" },
	outputCostPer1M: { toString: () => "8" },
	providerMappings: [
		{
			provider: "VERCEL_GATEWAY",
			providerModelId: `openai/${canonicalName}`,
			isAvailable: true,
		},
	],
});

beforeEach(() => {
	vi.clearAllMocks();
	db.providers.mockResolvedValue([
		{
			id: "cpc-1",
			provider: "VERCEL_GATEWAY",
			displayName: "Vercel AI Gateway",
			isDefault: false,
			priority: 1,
			purpose: "EMBEDDINGS_ONLY",
			isEmbeddingProvider: true,
			config: { enabledProviders: ["OPENAI_DIRECT"] },
		},
	]);
	// Honours the task filter the way the database does.
	const catalog = [
		model("text-embedding-3-small", ["EMBEDDING"]),
		model("gpt-6.1-sol", ["COMPLEX", "CHAT", "TOOL_CALLING"]),
	];
	db.models.mockImplementation(
		async (args: { where: { suitableForTasks?: { has: string } } }) =>
			catalog.filter(
				(entry) =>
					!args.where.suitableForTasks ||
					entry.suitableForTasks.includes(
						args.where.suitableForTasks.has,
					),
			),
	);
});

const call = (input: Record<string, unknown>) =>
	listAvailable._handler({
		input: { organizationId: "org-1", ...input },
		context: {
			user: { id: "user-1" },
			session: { activeOrganizationId: "org-1" },
		},
	});

describe("an embeddings-only gateway key as the only provider", () => {
	it("lists its embedding models for the embeddings row", async () => {
		const result = await call({ taskType: "EMBEDDING" });
		expect(result.models.map((m) => m.canonicalName)).toEqual([
			"text-embedding-3-small",
		]);
	});

	it("lists only its embedding models in the general listing the settings use", async () => {
		const result = await call({});
		expect(result.models.map((m) => m.canonicalName)).toEqual([
			"text-embedding-3-small",
		]);
		const listed = Object.values(result.modelsByGatewayAndProvider).flatMap(
			(gateway) =>
				Object.values(gateway.providers).flatMap((provider) =>
					provider.models.map((m) => m.canonicalName),
				),
		);
		expect(listed).not.toContain("gpt-6.1-sol");
		expect(listed).toContain("text-embedding-3-small");
	});

	it("offers nothing for language-model work", async () => {
		const result = await call({ taskType: "CHAT" });
		expect(result.models).toEqual([]);
	});
});

// Fizzy #2770 F13: Advisor lists chat models but runs tool calling, so its
// plan "Default" is resolved for the task that actually runs.
describe("the plan answer's task", () => {
	it("follows planTaskType when given, else the listing's task", async () => {
		await call({ taskType: "CHAT", planTaskType: "TOOL_CALLING" });
		expect(db.planModel).toHaveBeenLastCalledWith(
			expect.objectContaining({ taskType: "TOOL_CALLING" }),
		);
		await call({ taskType: "CHAT" });
		expect(db.planModel).toHaveBeenLastCalledWith(
			expect.objectContaining({ taskType: "CHAT" }),
		);
	});
});

it("returns no default and never marks an arbitrary enabled organization provider as default", async () => {
	db.providers.mockResolvedValue([
		{
			id: "example-config",
			provider: "OPENAI_DIRECT",
			displayName: "OpenAI",
			isDefault: false,
			enabled: true,
			priority: 1,
			purpose: "ALL",
			config: {},
		},
	]);
	const result = await call({});
	expect(result.defaultProvider).toBeNull();
	expect(result.configuredProviders).toEqual([
		expect.objectContaining({
			provider: "OPENAI_DIRECT",
			isDefault: false,
		}),
	]);
	expect(result.organizationDefaultProvider).toBeNull();
});

it("resolves the organization default once for a model listing", async () => {
	await call({});
	expect(getOrganizationDefaultProvider).toHaveBeenCalledTimes(1);
});

it("preserves fit metadata in the flat and gateway model payloads", async () => {
	const raw = await call({ taskType: "EMBEDDING" });
	const result = (
		listAvailableModelsProcedure as unknown as {
			_outputSchema: {
				parse: (value: unknown) => typeof raw & {
					modelsByProvider: Record<string, unknown[]>;
				};
			};
		}
	)._outputSchema.parse(raw);
	const metadata = {
		inputCostPer1M: 2,
		outputCostPer1M: 8,
		suitableForTasks: ["EMBEDDING"],
		capabilities: ["EMBEDDING"],
		qualityTier: "STANDARD",
	};
	expect(result.models[0]).toMatchObject(metadata);
	expect(result.modelsByProvider.VERCEL_GATEWAY[0]).toMatchObject(metadata);
	expect(
		result.modelsByGatewayAndProvider.VERCEL_GATEWAY.providers.OpenAI
			.models[0],
	).toMatchObject(metadata);
});

it.each(["CHAT", "EMBEDDING", undefined] as const)(
	"filters a mixed provider catalog for %s",
	async (taskType) => {
		vi.mocked(getOrganizationDefaultProvider).mockResolvedValue(
			"ANTHROPIC_DIRECT",
		);
		db.providers.mockResolvedValue(
			["ANTHROPIC_DIRECT", "OPENAI_DIRECT", "VERCEL_GATEWAY"].map(
				(provider) => ({
					id: `example-${provider}`,
					provider,
					purpose: "ALL",
					config: {},
					isDefault: provider === "ANTHROPIC_DIRECT",
				}),
			),
		);
		const anthropic = {
			...model("claude-example", ["CHAT"]),
			providerMappings: [
				{
					provider: "ANTHROPIC_DIRECT",
					providerModelId: "claude-example",
					isAvailable: true,
				},
			],
		};
		const gateway = model("gateway-example", ["CHAT"]);
		const embedding = model("embedding-example", ["EMBEDDING"]);
		const openaiEmbedding = {
			...model("openai-embedding-example", ["EMBEDDING"]),
			providerMappings: [
				{
					provider: "OPENAI_DIRECT",
					providerModelId: "openai-embedding-example",
					isAvailable: true,
				},
			],
		};
		db.models.mockImplementation(async ({ where }) =>
			[anthropic, gateway, embedding, openaiEmbedding].filter(
				(entry) =>
					(!where.suitableForTasks ||
						entry.suitableForTasks.includes(
							where.suitableForTasks.has,
						)) &&
					entry.providerMappings.some((mapping) =>
						where.providerMappings.some.provider.in.includes(
							mapping.provider,
						),
					),
			),
		);
		const result = await call(taskType ? { taskType } : {});
		expect(result.models.map((m) => m.canonicalName)).toEqual(
			taskType === "CHAT"
				? ["claude-example"]
				: taskType === "EMBEDDING"
					? ["embedding-example", "openai-embedding-example"]
					: [
							"claude-example",
							"gateway-example",
							"embedding-example",
							"openai-embedding-example",
						],
		);
	},
);
