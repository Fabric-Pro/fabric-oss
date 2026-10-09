/**
 * The organization's only provider is a Vercel AI Gateway key saved for
 * embeddings only (Fizzy #2770 F11): it is never the default, yet the AI
 * Models embeddings row must list its embedding models — and no language-
 * model listing may offer a model only that key would serve. Provider
 * resolution is the real `getConfiguredProviders`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	providers: vi.fn(),
	models: vi.fn(),
	planModel: vi.fn(async (_params: unknown) => null),
}));

vi.mock("@repo/database", () => ({
	db: {
		cloudProviderConfig: { findMany: db.providers },
		aiModel: { findMany: db.models },
	},
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
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
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
	inputCostPer1M: null,
	outputCostPer1M: null,
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
