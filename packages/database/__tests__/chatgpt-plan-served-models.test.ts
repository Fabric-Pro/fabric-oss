/**
 * The plan's model list in the database (Fizzy #2770 F8/F10): a model OpenAI
 * lists before the catalog knows it gets one plan-only catalog row, once; the
 * catalog seed leaves such rows alone; every plan model carries the plan
 * label in the picker; and the organization's fallback must be a plan model.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
	models: [] as Array<Record<string, unknown>>,
	mappings: [] as Array<Record<string, unknown>>,
	policy: null as null | Record<string, unknown>,
	deleted: { models: [] as unknown[], mappings: [] as unknown[] },
}));

vi.mock("../prisma/queries/cache", () => ({
	aiTaskDefaultsCache: {
		getOrSet: async (_key: string, factory: () => Promise<unknown>) =>
			factory(),
	},
	aiModelCatalogCache: {
		getOrSet: async (_key: string, factory: () => Promise<unknown>) =>
			factory(),
	},
}));
vi.mock("../prisma/queries/ai-credits", () => ({
	estimateAiUsageCostUsd: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../prisma/client", () => {
	const mappingRow = (mapping: Row) => ({
		...mapping,
		model: store.models.find((model) => model.id === mapping.modelId),
	});
	return {
		db: {
			aiModelProviderMapping: {
				findMany: vi.fn(async (args?: { where?: Row }) =>
					store.mappings
						.filter(
							(mapping) =>
								!args?.where?.provider ||
								mapping.provider === args.where.provider,
						)
						.map(mappingRow),
				),
				findFirst: vi.fn(
					async ({ where }: { where: Row }) =>
						store.mappings.find(
							(mapping) =>
								mapping.provider === where.provider &&
								mapping.providerModelId ===
									where.providerModelId,
						) ?? null,
				),
				deleteMany: vi.fn(async ({ where }: { where: Row }) => {
					store.deleted.mappings.push(where);
					return { count: 0 };
				}),
			},
			aiModel: {
				findUnique: vi.fn(
					async ({ where }: { where: Row }) =>
						store.models.find(
							(model) =>
								model.canonicalName === where.canonicalName,
						) ?? null,
				),
				findMany: vi.fn(async () =>
					store.models.map((model) => ({
						...model,
						providerMappings: store.mappings.filter(
							(mapping) => mapping.modelId === model.id,
						),
					})),
				),
				upsert: vi.fn(
					async ({ where, create }: { where: Row; create: Row }) => {
						const existing = store.models.find(
							(model) =>
								model.canonicalName === where.canonicalName,
						);
						if (existing) {
							return existing;
						}
						const { providerMappings, ...data } = create as {
							providerMappings: { create: Row };
						} & Row;
						const id = `model_${store.models.length + 1}`;
						store.models.push({ id, ...data });
						store.mappings.push({
							id: `map_${store.mappings.length + 1}`,
							modelId: id,
							...providerMappings.create,
						});
						return store.models.at(-1);
					},
				),
				deleteMany: vi.fn(async ({ where }: { where: Row }) => {
					store.deleted.models.push(where);
					return { count: 0 };
				}),
			},
			aiTaskModelDefault: {
				deleteMany: vi.fn(async () => ({ count: 0 })),
				findMany: vi.fn(async () => []),
			},
			chatGptPlanOrgPolicy: {
				findUnique: vi.fn(async () => store.policy),
				upsert: vi.fn(async ({ update }: { update: Row }) => {
					store.policy = { ...(store.policy ?? {}), ...update };
					return store.policy;
				}),
			},
		},
	};
});

import {
	listChatGptPlanModels,
	setChatGptPlanOrgFallbackModel,
} from "../prisma/queries/chatgpt-plan-models";
import {
	CHATGPT_PLAN_AUTO_DETECTED_ORIGIN,
	ensureChatGptPlanCatalogModels,
} from "../prisma/queries/chatgpt-plan-served-models";

function seedCatalog() {
	store.models.push(
		{
			id: "astra",
			canonicalName: "gpt-6-astra",
			displayName: "GPT-6 Astra",
			description: "Frontier",
			family: "gpt",
			vendor: "OpenAI",
			capabilities: ["TEXT"],
			contextWindow: 1,
			maxOutputTokens: null,
			speedTier: "QUALITY",
			qualityTier: "PREMIUM",
			suitableForTasks: ["COMPLEX"],
			metadata: null,
		},
		{
			id: "sol",
			canonicalName: "gpt-5.6-sol",
			displayName: "GPT-5.6 Sol (ChatGPT plan)",
			description: "Workhorse",
			family: "gpt",
			vendor: "OpenAI",
			capabilities: ["TEXT", "REASONING"],
			contextWindow: 272000,
			maxOutputTokens: null,
			speedTier: "BALANCED",
			qualityTier: "STANDARD",
			suitableForTasks: ["COMPLEX", "CHAT"],
			metadata: null,
		},
		// An API-only model whose name a new plan model might also take.
		{
			id: "api-sol",
			canonicalName: "gpt-6.1-sol",
			displayName: "GPT-6.1 Sol",
			metadata: null,
		},
	);
	store.mappings.push(
		{
			id: "m1",
			modelId: "astra",
			provider: "OPENAI_CHATGPT_PLAN",
			providerModelId: "gpt-6-astra",
		},
		{
			id: "m2",
			modelId: "sol",
			provider: "OPENAI_CHATGPT_PLAN",
			providerModelId: "gpt-5.6-sol",
		},
		{
			id: "m3",
			modelId: "api-sol",
			provider: "OPENAI_DIRECT",
			providerModelId: "gpt-6.1-sol",
		},
	);
}

const newSol = {
	slug: "gpt-6.1-sol",
	displayName: "GPT-6.1-Sol",
	description: "Our newest workhorse.",
	priority: 1,
};

beforeEach(() => {
	store.models.length = 0;
	store.mappings.length = 0;
	store.policy = null;
	store.deleted.models.length = 0;
	store.deleted.mappings.length = 0;
	seedCatalog();
});

describe("ensureChatGptPlanCatalogModels", () => {
	it("adds exactly one plan-only row for an unknown model, priced and specced like its family", async () => {
		const added = await ensureChatGptPlanCatalogModels([
			{
				slug: "gpt-6-astra",
				displayName: "GPT-6-Astra",
				description: null,
				priority: 2,
			},
			newSol,
		]);

		expect(added).toEqual(["gpt-6.1-sol"]);
		const created = store.models.at(-1);
		expect(created).toMatchObject({
			// The API catalog already uses this name; the plan row gets its own.
			canonicalName: "gpt-6.1-sol-chatgpt-plan",
			// OpenAI's hyphens normalised to the catalog's style.
			displayName: "GPT-6.1 Sol (ChatGPT plan)",
			description: "Our newest workhorse.",
			capabilities: ["TEXT", "REASONING"],
			metadata: {
				origin: CHATGPT_PLAN_AUTO_DETECTED_ORIGIN,
				pricedLike: "gpt-5.6-sol",
			},
		});
		expect(store.mappings.at(-1)).toMatchObject({
			provider: "OPENAI_CHATGPT_PLAN",
			providerModelId: "gpt-6.1-sol",
		});
	});

	it("always names a plan row with the plan suffix, even when the slug is free", async () => {
		const nova = {
			slug: "gpt-7-nova",
			displayName: "GPT-7-Nova",
			description: null,
			priority: 1,
		};
		await expect(ensureChatGptPlanCatalogModels([nova])).resolves.toEqual([
			"gpt-7-nova",
		]);
		expect(store.models.at(-1)).toMatchObject({
			canonicalName: "gpt-7-nova-chatgpt-plan",
		});
	});

	it("is idempotent", async () => {
		await ensureChatGptPlanCatalogModels([newSol]);
		const models = store.models.length;
		await expect(ensureChatGptPlanCatalogModels([newSol])).resolves.toEqual(
			[],
		);
		expect(store.models).toHaveLength(models);
	});
});

describe("the catalog seed", () => {
	it("retires a stand-in once the catalog maps the same plan slug, moving what chose it", async () => {
		// The probe row, for a slug the catalog does not know yet.
		await ensureChatGptPlanCatalogModels([newSol]);
		const probe = store.models.at(-1) as Row;
		const { retireAdoptedChatGptPlanProbeModels } = await import(
			"../prisma/seed-ai-models"
		);
		const { db } = await import("../prisma/client");
		const ops: Array<[string, unknown]> = [];
		const recorder = (name: string) =>
			vi.fn((args: unknown) => {
				ops.push([name, args]);
				return Promise.resolve({ count: 1 });
			});
		Object.assign(db, {
			organizationModelPreference: { updateMany: recorder("orgPrefs") },
			userModelPreference: { updateMany: recorder("userPrefs") },
			$transaction: (steps: Promise<unknown>[]) => Promise.all(steps),
		});
		Object.assign(db.aiTaskModelDefault, {
			updateMany: recorder("taskDefaults"),
		});

		// Not adopted yet: it stays.
		await expect(retireAdoptedChatGptPlanProbeModels()).resolves.toBe(0);
		expect(ops).toEqual([]);

		// The catalog adopts the slug under its own model.
		store.models.push({
			id: "model_catalog",
			// The catalog's own GPT-6.1 Sol row, which now also maps the plan.
			canonicalName: "gpt-6.1-sol",
			metadata: null,
		});
		store.mappings.push({
			id: "map_catalog",
			modelId: "model_catalog",
			provider: "OPENAI_CHATGPT_PLAN",
			providerModelId: "gpt-6.1-sol",
		});
		await expect(retireAdoptedChatGptPlanProbeModels()).resolves.toBe(1);
		const repoint = {
			where: { modelId: probe.id },
			data: { modelId: "model_catalog" },
		};
		expect(ops).toEqual([
			["orgPrefs", repoint],
			["userPrefs", repoint],
			["taskDefaults", repoint],
		]);
		expect(store.deleted.mappings).toContainEqual({
			modelId: probe.id,
		});
		expect(store.deleted.models).toContainEqual({ id: probe.id });
	});

	// The catalog adopts the GPT-6 family the plans serve (Fizzy #2770), so
	// the stand-ins staging auto-added for these slugs are retired on the
	// next seed and what chose them moves to the catalog rows.
	it("maps the GPT-6 plan slugs on the catalog's own rows, as the plan defaults", async () => {
		const { MODELS, TASK_DEFAULTS } = await import(
			"../prisma/seed-ai-models"
		);
		for (const slug of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
			const row = MODELS.find((model) => model.canonicalName === slug);
			expect(row?.providerMappings).toContainEqual({
				provider: "OPENAI_CHATGPT_PLAN",
				providerModelId: slug,
			});
		}
		const planDefaults = Object.fromEntries(
			TASK_DEFAULTS.filter(
				(entry) => entry.provider === "OPENAI_CHATGPT_PLAN",
			).map((entry) => [entry.taskType, entry.canonicalName]),
		);
		expect(planDefaults).toMatchObject({
			SIMPLE: "gpt-6-luna",
			COMPLEX: "gpt-6.1-sol",
			REASONING: "gpt-6.1-sol",
			TOOL_CALLING: "gpt-6.1-sol",
			CHAT: "gpt-6.1-sol",
		});
	});

	it("retires the auto-added GPT-6 Luna once the catalog row maps it", async () => {
		await ensureChatGptPlanCatalogModels([
			{
				slug: "gpt-6-luna",
				displayName: "GPT-6-Luna",
				description: null,
				priority: 3,
			},
		]);
		const probe = store.models.at(-1) as Row;
		expect(probe).toMatchObject({
			canonicalName: "gpt-6-luna-chatgpt-plan",
			displayName: "GPT-6 Luna (ChatGPT plan)",
		});
		const { retireAdoptedChatGptPlanProbeModels } = await import(
			"../prisma/seed-ai-models"
		);
		const { db } = await import("../prisma/client");
		const repointed: unknown[] = [];
		const record = vi.fn((args: unknown) => {
			repointed.push(args);
			return Promise.resolve({ count: 1 });
		});
		Object.assign(db, {
			organizationModelPreference: { updateMany: record },
			userModelPreference: { updateMany: record },
			$transaction: (steps: Promise<unknown>[]) => Promise.all(steps),
		});
		Object.assign(db.aiTaskModelDefault, { updateMany: record });
		store.models.push({ id: "model_luna", canonicalName: "gpt-6-luna" });
		store.mappings.push({
			id: "map_luna_plan",
			modelId: "model_luna",
			provider: "OPENAI_CHATGPT_PLAN",
			providerModelId: "gpt-6-luna",
		});
		await expect(retireAdoptedChatGptPlanProbeModels()).resolves.toBe(1);
		expect(repointed).toContainEqual({
			where: { modelId: probe.id },
			data: { modelId: "model_luna" },
		});
		expect(store.deleted.models).toContainEqual({ id: probe.id });
	});

	it("leaves a model added from a plan's list, and its mapping, alone", async () => {
		await ensureChatGptPlanCatalogModels([newSol]);
		const { seedAiModels } = await import("../prisma/seed-ai-models");
		const { db } = await import("../prisma/client");
		Object.assign(db, {
			userModelPreference: { count: async () => 0 },
			organizationModelPreference: { count: async () => 0 },
		});
		// Only the cleanup pass matters here; stop before the catalog upserts.
		vi.mocked(db.aiTaskModelDefault.findMany).mockRejectedValueOnce(
			new Error("stop after cleanup"),
		);
		await seedAiModels().catch(() => {});

		const autoId = store.models.at(-1)?.id;
		const autoMappingId = store.mappings.at(-1)?.id;
		const deletedModelIds = store.deleted.models.flatMap(
			(where) => (where as { id: { in: string[] } }).id.in,
		);
		const deletedMappingIds = store.deleted.mappings.flatMap(
			(where) =>
				(where as { id?: { in: string[] } }).id?.in ??
				(where as { modelId: { in: string[] } }).modelId.in,
		);
		// The non-catalog test rows are orphans; the auto-detected one is not.
		expect(deletedModelIds).not.toContain(autoId);
		expect(deletedMappingIds).not.toContain(autoMappingId);
		expect(deletedMappingIds).not.toContain(autoId);
	});
});

describe("listChatGptPlanModels", () => {
	it("gives every plan model the plan label and its slug, Astra included (F7)", async () => {
		await ensureChatGptPlanCatalogModels([newSol]);
		const models = await listChatGptPlanModels();
		expect(
			models
				.filter((model) => model.canonicalName !== "gpt-6.1-sol")
				.map(({ slug, displayName, autoDetected }) => ({
					slug,
					displayName,
					autoDetected,
				})),
		).toEqual([
			{
				slug: "gpt-6-astra",
				displayName: "GPT-6 Astra (ChatGPT plan)",
				autoDetected: false,
			},
			{
				slug: "gpt-5.6-sol",
				displayName: "GPT-5.6 Sol (ChatGPT plan)",
				autoDetected: false,
			},
			{
				slug: "gpt-6.1-sol",
				displayName: "GPT-6.1 Sol (ChatGPT plan)",
				autoDetected: true,
			},
		]);
	});
});

describe("setChatGptPlanOrgFallbackModel", () => {
	it("saves a plan model, reporting the default as the value before", async () => {
		await expect(
			setChatGptPlanOrgFallbackModel({
				organizationId: "org_a",
				slug: "gpt-5.6-sol",
			}),
		).resolves.toEqual({ saved: true, before: "gpt-6-astra" });
		expect(store.policy).toMatchObject({ fallbackModel: "gpt-5.6-sol" });
	});

	it("turns the fallback off with null", async () => {
		store.policy = { fallbackModel: "gpt-5.6-sol" };
		await expect(
			setChatGptPlanOrgFallbackModel({
				organizationId: "org_a",
				slug: null,
			}),
		).resolves.toEqual({ saved: true, before: "gpt-5.6-sol" });
		expect(store.policy).toMatchObject({ fallbackModel: null });
	});

	it("refuses a model no plan serves", async () => {
		await expect(
			setChatGptPlanOrgFallbackModel({
				organizationId: "org_a",
				slug: "claude-opus",
			}),
		).resolves.toEqual({ saved: false, before: null });
		expect(store.policy).toBeNull();
	});
});
