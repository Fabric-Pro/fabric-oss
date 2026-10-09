/**
 * Which decision model an organization resolves to after the catalog's
 * DECISION default moved from TypeSafe AI Jev to GPT-6 Luna Decisions.
 *
 * `seed-ai-models.ts` upserts the `aiTaskModelDefault` row for
 * (DECISION, MEDIUM, VERCEL_GATEWAY) from `TASK_DEFAULTS`, and
 * `getModelForTask` reads that row at runtime. These tests build the row the
 * seed would write from the catalog itself, so a catalog default that drifts
 * away from Luna fails here, and run the real resolution logic against it:
 *
 *   - no organization row        -> the seeded default (Luna), system_default
 *   - an explicit Jev preference -> Jev, org_override
 *
 * Mocks stand in for the prisma client and the task-default cache.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODELS, TASK_DEFAULTS } from "../prisma/ai-model-catalog";

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

// Reads env vars at import time, which the test environment does not provide.
vi.mock("../prisma/queries/ai-credits", () => ({
	estimateAiUsageCostUsd: vi.fn(),
}));

const orgPreferenceFindUnique = vi.fn();
const taskDefaultFindMany = vi.fn();
const aiModelFindUnique = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		organizationModelPreference: { findUnique: orgPreferenceFindUnique },
		userModelPreference: { findUnique: vi.fn() },
		aiTaskModelDefault: { findMany: taskDefaultFindMany },
		aiModel: { findUnique: aiModelFindUnique },
		aiModelProviderMapping: { findMany: vi.fn() },
	},
}));

const { getModelForTask } = await import("../prisma/queries/ai-models");

/** The model row the seed writes for a catalog entry, with its mappings. */
function seededModel(canonicalName: string) {
	const entry = MODELS.find((model) => model.canonicalName === canonicalName);
	if (!entry) {
		throw new Error(`${canonicalName} is not in the model catalog`);
	}
	return {
		id: `model-${canonicalName}`,
		canonicalName: entry.canonicalName,
		displayName: entry.displayName,
		capabilities: entry.capabilities,
		suitableForTasks: entry.suitableForTasks,
		deprecatedAt: null,
		replacementModelId: null,
		providerMappings: entry.providerMappings.map((mapping) => ({
			provider: mapping.provider,
			providerModelId: mapping.providerModelId,
			isAvailable: true,
		})),
	};
}

/** The (DECISION, MEDIUM, VERCEL_GATEWAY) default the seed writes. */
function seededDecisionDefault() {
	const seed = TASK_DEFAULTS.find(
		(row) =>
			row.taskType === "DECISION" &&
			row.complexity === "MEDIUM" &&
			row.provider === "VERCEL_GATEWAY",
	);
	if (!seed) {
		throw new Error(
			"The catalog has no Vercel AI Gateway DECISION default",
		);
	}
	return { model: seededModel(seed.canonicalName) };
}

describe("DECISION default model resolution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		taskDefaultFindMany.mockResolvedValue([seededDecisionDefault()]);
	});

	it("resolves an organization with no decision preference to GPT-6 Luna Decisions", async () => {
		orgPreferenceFindUnique.mockResolvedValue(null);

		const resolved = await getModelForTask(
			"user-1",
			"VERCEL_GATEWAY",
			"DECISION",
			"org-1",
		);

		expect(resolved).toMatchObject({
			source: "system_default",
			providerModelId: "openai/gpt-6-luna-decisions",
		});
		expect(resolved?.model?.canonicalName).toBe("gpt-6-luna-decisions");
	});

	it("keeps an organization that explicitly chose Jev on Jev", async () => {
		const jev = seededModel("typesafe-ai-jev");
		orgPreferenceFindUnique.mockResolvedValue({
			id: "pref-jev",
			organizationId: "org-1",
			taskType: "DECISION",
			provider: "VERCEL_GATEWAY",
			modelId: jev.id,
			model: jev,
		});

		const resolved = await getModelForTask(
			"user-1",
			"VERCEL_GATEWAY",
			"DECISION",
			"org-1",
		);

		expect(resolved).toMatchObject({
			source: "org_override",
			providerModelId: "typesafe-ai/jev",
		});
		expect(resolved?.model?.canonicalName).toBe("typesafe-ai-jev");
		// An explicit choice never consults the system default.
		expect(taskDefaultFindMany).not.toHaveBeenCalled();
	});
});

/** An organization DECISION preference row as `getOrgModelPreference` loads it. */
function orgPreference(model: ReturnType<typeof seededModel> | null) {
	return {
		id: "pref-decision",
		organizationId: "org-1",
		taskType: "DECISION",
		provider: "VERCEL_GATEWAY",
		modelId: model?.id ?? null,
		model,
	};
}

describe("an organization's explicit DECISION choice is never substituted", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		taskDefaultFindMany.mockResolvedValue([seededDecisionDefault()]);
	});

	it("resolves no decision model, and never Luna, when the chosen Jev has no available gateway mapping", async () => {
		// `getOrgModelPreference` loads only available mappings for the
		// provider, so a removed or deactivated Jev mapping arrives as none.
		orgPreferenceFindUnique.mockResolvedValue(
			orgPreference({
				...seededModel("typesafe-ai-jev"),
				providerMappings: [],
			}),
		);

		const resolved = await getModelForTask(
			"user-1",
			"VERCEL_GATEWAY",
			"DECISION",
			"org-1",
		);

		expect(resolved).toBeNull();
		// The load-bearing half: the system default (Luna) is never consulted.
		expect(taskDefaultFindMany).not.toHaveBeenCalled();
	});

	it("resolves no decision model when deprecation would replace the chosen model", async () => {
		const luna = seededModel("gpt-6-luna-decisions");
		orgPreferenceFindUnique.mockResolvedValue(
			orgPreference({
				...seededModel("typesafe-ai-jev"),
				deprecatedAt: new Date("2026-01-01") as unknown as null,
				replacementModelId: luna.id as unknown as null,
			}),
		);
		aiModelFindUnique.mockResolvedValue(luna);

		const resolved = await getModelForTask(
			"user-1",
			"VERCEL_GATEWAY",
			"DECISION",
			"org-1",
		);

		expect(resolved).toBeNull();
		expect(taskDefaultFindMany).not.toHaveBeenCalled();
	});

	it("keeps an explicit disable off", async () => {
		orgPreferenceFindUnique.mockResolvedValue(orgPreference(null));

		const resolved = await getModelForTask(
			"user-1",
			"VERCEL_GATEWAY",
			"DECISION",
			"org-1",
		);

		expect(resolved).toBeNull();
		expect(taskDefaultFindMany).not.toHaveBeenCalled();
	});

	it("leaves language-model tasks on their soft degrade to the system default", async () => {
		// Same unavailable-mapping shape for a text task: the long-standing
		// behaviour (PR 1090 review I-1) still falls through to the default.
		const textModel = {
			...seededModel("typesafe-ai-jev"),
			id: "model-text",
			canonicalName: "example-text-model",
			providerMappings: [],
		};
		orgPreferenceFindUnique.mockResolvedValue({
			...orgPreference(textModel),
			taskType: "SIMPLE",
		});
		taskDefaultFindMany.mockResolvedValue([
			{
				model: {
					...textModel,
					id: "model-default",
					providerMappings: [],
				},
			},
		]);

		const resolved = await getModelForTask(
			"user-1",
			"VERCEL_GATEWAY",
			"SIMPLE",
			"org-1",
		);

		expect(resolved).toMatchObject({ source: "system_default" });
		expect(taskDefaultFindMany).toHaveBeenCalled();
	});
});
