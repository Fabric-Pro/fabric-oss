import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, findMany } = vi.hoisted(() => ({
	findUnique: vi.fn(),
	findMany: vi.fn(),
}));

vi.mock("../../client", () => ({
	db: { aiModel: { findUnique, findMany } },
	Prisma: {},
}));

import { MODELS } from "../../ai-model-catalog";
import {
	getAvailableCanonicalNameForProviderModelId,
	getCanonicalNameForProviderModelId,
	getProviderModelIdForCanonical,
	getProviderModelMappingForCanonical,
} from "../ai-models";

beforeEach(() => {
	vi.resetAllMocks();
	findUnique.mockResolvedValue(null);
	findMany.mockResolvedValue([]);
});

describe("getCanonicalNameForProviderModelId", () => {
	it("prefers an available mapping on the requested provider", async () => {
		findMany.mockResolvedValueOnce([{ canonicalName: "claude-sonnet-5" }]);
		expect(
			await getCanonicalNameForProviderModelId(
				"system.ai.claude-sonnet-5",
				"DATABRICKS",
			),
		).toBe("claude-sonnet-5");
		expect(findMany).toHaveBeenCalledWith({
			where: {
				providerMappings: {
					some: {
						provider: "DATABRICKS",
						providerModelId: "system.ai.claude-sonnet-5",
						isAvailable: true,
					},
				},
			},
			select: { canonicalName: true },
			take: 2,
		});
		expect(findMany).toHaveBeenCalledTimes(1);
	});

	it("accepts a unique catalog model across providers", async () => {
		findMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ canonicalName: "claude-haiku-4-5" }]);
		expect(
			await getCanonicalNameForProviderModelId(
				"anthropic/claude-haiku-4.5",
				"CLOUDFLARE_AI",
			),
		).toBe("claude-haiku-4-5");
		expect(findMany).toHaveBeenCalledWith({
			where: {
				providerMappings: {
					some: {
						providerModelId: "anthropic/claude-haiku-4.5",
					},
				},
			},
			select: { canonicalName: true },
			take: 2,
		});
	});

	it("rejects ids shared by distinct catalog models", async () => {
		findMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ canonicalName: "example-model-a" },
				{ canonicalName: "example-model-b" },
			]);
		expect(
			await getCanonicalNameForProviderModelId(
				"example-shared-id",
				"DATABRICKS",
			),
		).toBeNull();
	});

	it("returns null for an unknown id", async () => {
		expect(
			await getCanonicalNameForProviderModelId(
				"example-unknown-id",
				"DATABRICKS",
			),
		).toBeNull();
	});
});

it("the seeded ChatGPT plan ids are their catalog canonical names", () => {
	const planModels = MODELS.flatMap((model) =>
		model.providerMappings
			.filter((mapping) => mapping.provider === "OPENAI_CHATGPT_PLAN")
			.map((mapping) => ({
				canonicalName: model.canonicalName,
				providerModelId: mapping.providerModelId,
			})),
	);
	expect(planModels.length).toBeGreaterThan(0);
	for (const model of planModels) {
		expect(model.providerModelId).toBe(model.canonicalName);
	}
});

it("rejects ambiguity on the requested provider without consulting other providers", async () => {
	findMany.mockResolvedValueOnce([
		{ canonicalName: "example-a" },
		{ canonicalName: "example-b" },
	]);
	expect(
		await getCanonicalNameForProviderModelId(
			"example-shared",
			"DATABRICKS",
		),
	).toBeNull();
	expect(findMany).toHaveBeenCalledTimes(1);
});

it.each([
	[null, { exists: false, providerModelId: null }],
	[{ providerMappings: [] }, { exists: true, providerModelId: null }],
	[
		{ providerMappings: [{ providerModelId: "example-provider-id" }] },
		{ exists: true, providerModelId: "example-provider-id" },
	],
])(
	"returns existence and mapping from one canonical query: %j",
	async (model, result) => {
		findUnique.mockResolvedValue(model);
		expect(
			await getProviderModelMappingForCanonical(
				"example-canonical",
				"DATABRICKS",
			),
		).toEqual(result);
		expect(findUnique).toHaveBeenCalledTimes(1);
		expect(
			await getProviderModelIdForCanonical(
				"example-canonical",
				"DATABRICKS",
			),
		).toBe(result.providerModelId);
		expect(findUnique).toHaveBeenCalledTimes(2);
		expect(findMany).not.toHaveBeenCalled();
	},
);

it("mapping-first usage resolution has no cross-model canonical collisions in the catalog", () => {
	const canonicalNames = new Set(MODELS.map((model) => model.canonicalName));
	const collisions = MODELS.flatMap((model) =>
		model.providerMappings
			.filter(
				(mapping) =>
					canonicalNames.has(mapping.providerModelId) &&
					mapping.providerModelId !== model.canonicalName,
			)
			.map((mapping) => ({
				canonicalName: model.canonicalName,
				providerModelId: mapping.providerModelId,
			})),
	);
	expect(collisions).toEqual([]);
});

it.each([
	[[]],
	[[{ canonicalName: "example-model" }]],
	[[{ canonicalName: "example-a" }, { canonicalName: "example-b" }]],
])(
	"scopes override ID lookup to available provider mappings: %j",
	async (models) => {
		findMany.mockResolvedValue(models);
		expect(
			await getAvailableCanonicalNameForProviderModelId(
				"system.ai.example",
				"DATABRICKS",
			),
		).toBe(models.length === 1 ? models[0].canonicalName : null);
		expect(findMany).toHaveBeenCalledExactlyOnceWith({
			where: {
				providerMappings: {
					some: {
						provider: "DATABRICKS",
						providerModelId: "system.ai.example",
						isAvailable: true,
					},
				},
			},
			select: { canonicalName: true },
			take: 2,
		});
	},
);
