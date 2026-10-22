/**
 * Contract tests for the organization "switched off" model preference.
 *
 * `OrganizationModelPreference.modelId` is nullable, and a NULL row is a third
 * state that is easy to collapse back into the other two by accident:
 *
 *   - no row            -> use the seeded system default
 *   - row with a model  -> use that model
 *   - row with NO model -> use NOTHING; the organization turned this task off
 *
 * The regression worth guarding is the middle of `getModelForTask`: the branch
 * that falls through to `getTaskDefaultModel` when an organization override
 * cannot be honored. Falling through for a NULL row would silently re-enable
 * the seeded default for an organization that had just switched it off,
 * and the off switch would look like it did nothing.
 *
 * Mocks stand in for the prisma client and the task-default cache so the real
 * resolution logic runs without a database. `aiTaskModelDefault.findMany` is
 * the observable proof of whether the system-default path was consulted at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Pass-through cache, so a system-default lookup really hits the mocked db
// instead of a memoized value from a sibling case.
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
const orgPreferenceUpsert = vi.fn();
const userPreferenceFindUnique = vi.fn();
const taskDefaultFindMany = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		organizationModelPreference: {
			findUnique: orgPreferenceFindUnique,
			upsert: orgPreferenceUpsert,
		},
		userModelPreference: { findUnique: userPreferenceFindUnique },
		aiTaskModelDefault: { findMany: taskDefaultFindMany },
		aiModel: { findUnique: vi.fn() },
		aiModelProviderMapping: { findMany: vi.fn() },
	},
}));

const { getModelForTask, setOrgModelPreference } = await import(
	"../prisma/queries/ai-models"
);

const JEV = {
	id: "model-jev",
	canonicalName: "typesafe-ai-jev",
	displayName: "TypeSafe AI Jev",
	deprecatedAt: null,
	replacementModelId: null,
	providerMappings: [
		{ provider: "VERCEL_GATEWAY", providerModelId: "typesafe-ai/jev" },
	],
};

describe("getModelForTask — an organization that switched the task off", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// A seeded default exists for DECISION. Every assertion below is about
		// whether resolution is allowed to reach it.
		taskDefaultFindMany.mockResolvedValue([{ model: JEV }]);
	});

	it("resolves to no model, and never consults the system default", async () => {
		orgPreferenceFindUnique.mockResolvedValue({
			id: "pref-1",
			organizationId: "org-1",
			taskType: "DECISION",
			provider: "VERCEL_GATEWAY",
			modelId: null,
			model: null,
		});

		const resolved = await getModelForTask(
			"user-1",
			"VERCEL_GATEWAY",
			"DECISION",
			"org-1",
		);

		expect(resolved).toBeNull();
		// The load-bearing half: a fall-through would have re-enabled the default.
		expect(taskDefaultFindMany).not.toHaveBeenCalled();
	});

	it("still resolves an organization row that does carry a model", async () => {
		orgPreferenceFindUnique.mockResolvedValue({
			id: "pref-1",
			organizationId: "org-1",
			taskType: "DECISION",
			provider: "VERCEL_GATEWAY",
			modelId: JEV.id,
			model: JEV,
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
		expect(taskDefaultFindMany).not.toHaveBeenCalled();
	});

	it("falls through to the system default when the organization has no row", async () => {
		orgPreferenceFindUnique.mockResolvedValue(null);

		const resolved = await getModelForTask(
			"user-1",
			"VERCEL_GATEWAY",
			"DECISION",
			"org-1",
		);

		expect(resolved).toMatchObject({ source: "system_default" });
		expect(taskDefaultFindMany).toHaveBeenCalled();
	});

	it("leaves personal-context resolution alone", async () => {
		// XOR isolation: with no organizationId the org row must not be read
		// at all, so an organization's off switch cannot leak into a personal
		// context (nor a personal preference into an organization).
		userPreferenceFindUnique.mockResolvedValue(null);

		const resolved = await getModelForTask(
			"user-1",
			"VERCEL_GATEWAY",
			"DECISION",
			null,
		);

		expect(orgPreferenceFindUnique).not.toHaveBeenCalled();
		expect(userPreferenceFindUnique).toHaveBeenCalled();
		expect(resolved).toMatchObject({ source: "system_default" });
	});
});

// Dropping provider from getOrgModelPreference's unique key must break this contract.
it("seeds two COMPLEX choices and runs the default provider's row", async () => {
	taskDefaultFindMany.mockResolvedValue([]);
	const rows = new Map<
		string,
		{
			organizationId: string;
			taskType: string;
			provider: string;
			modelId: string;
			model: typeof JEV;
		}
	>();
	const models = ["example-secondary", "example-default"].map((id) => ({
		...JEV,
		id,
		canonicalName: id,
		providerMappings: [
			{ provider: "OPENAI_DIRECT", providerModelId: id },
			{ provider: "VERCEL_GATEWAY", providerModelId: `example/${id}` },
		],
	}));
	orgPreferenceUpsert.mockImplementation(async ({ where, create }) => {
		const row = {
			...create,
			model: models.find((m) => m.id === create.modelId),
		};
		rows.set(JSON.stringify(where.organizationId_taskType_provider), row);
		return row;
	});
	orgPreferenceFindUnique.mockImplementation(
		async ({ where }) =>
			rows.get(JSON.stringify(where.organizationId_taskType_provider)) ??
			null,
	);
	for (const [index, provider] of [
		"VERCEL_GATEWAY",
		"OPENAI_DIRECT",
	].entries()) {
		await setOrgModelPreference({
			organizationId: "example-org",
			taskType: "COMPLEX",
			provider: provider as "OPENAI_DIRECT" | "VERCEL_GATEWAY",
			modelId: models[index].id,
		});
	}
	const resolved = await getModelForTask(
		"example-user",
		"OPENAI_DIRECT",
		"COMPLEX",
		"example-org",
	);
	expect(resolved).toMatchObject({
		source: "org_override",
		providerModelId: "example-default",
		model: { canonicalName: "example-default" },
	});
});

// A switch preview must resolve the catalog default without deleting the saved
// choice first; otherwise the embedding-model comparison reports a false keep.
it("resolves the post-switch default without reading or changing saved preferences", async () => {
	vi.clearAllMocks();
	const saved = {
		...JEV,
		id: "example-saved",
		canonicalName: "example-saved",
		displayName: "Example saved",
	};
	const fallback = {
		...JEV,
		id: "example-default",
		canonicalName: "example-default",
		displayName: "Example default",
	};
	orgPreferenceFindUnique.mockResolvedValue({
		modelId: saved.id,
		model: saved,
	});
	taskDefaultFindMany.mockResolvedValue([{ model: fallback }]);
	const current = await getModelForTask(
		"example-user",
		"VERCEL_GATEWAY",
		"CHAT",
		"example-org",
	);
	expect(current?.model?.id).toBe("example-saved");
	orgPreferenceFindUnique.mockClear();
	const after = await getModelForTask(
		"example-user",
		"VERCEL_GATEWAY",
		"CHAT",
		"example-org",
		"MEDIUM",
		undefined,
		{ ignorePreferences: true },
	);
	expect(after?.model?.id).toBe("example-default");
	expect(orgPreferenceFindUnique).not.toHaveBeenCalled();
	expect(orgPreferenceUpsert).not.toHaveBeenCalled();
});
