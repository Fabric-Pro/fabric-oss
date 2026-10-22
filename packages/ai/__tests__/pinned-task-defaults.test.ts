import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotFixture } from "../../database/__tests__/_helpers/task-default-snapshot";

const { mockDb, connections } = vi.hoisted(() => ({
	mockDb: {
		aiTaskModelDefault: { findMany: vi.fn() },
		aiModel: { findUnique: vi.fn() },
		organizationModelPreference: { findUnique: vi.fn() },
		userModelPreference: { findUnique: vi.fn() },
	},
	connections: { default: null as unknown, explicit: null as unknown },
}));
vi.mock("../../database/prisma/client", () => ({ db: mockDb }));
vi.mock("../../database/prisma/queries/ai-credits", () => ({
	estimateAiUsageCostUsd: vi.fn(),
}));
vi.mock("../../database/prisma/queries/cache", () => ({
	aiModelCatalogCache: {
		get: () => null,
		set: () => {},
		getOrSet: (_key: string, fn: () => unknown) => fn(),
	},
	aiTaskDefaultsCache: {
		getOrSet: (_key: string, fn: () => unknown) => fn(),
	},
}));
vi.mock("@repo/database", async () => {
	const actual = await import("../../database/prisma/queries/ai-models");
	const { TEXT_TASK_TYPES } = await import(
		"../../database/prisma/queries/task-default-snapshots"
	);
	return {
		...actual,
		TEXT_TASK_TYPES,
		GATEWAY_PROVIDERS: ["VERCEL_GATEWAY"],
		getAiProviderApiKey: async () => connections.default,
		getAiProviderApiKeyByProvider: async ({
			provider,
		}: {
			provider: string;
		}) => {
			const config = connections.explicit as { provider?: string } | null;
			if (config?.provider !== provider) {
				throw new Error(`Unexpected provider lookup: ${provider}`);
			}
			return config;
		},
	};
});
vi.mock("@repo/payments", () => ({ assertWithinAiUsageLimits: vi.fn() }));

import {
	getConfiguredModelString,
	getModelForTaskDynamic,
	resolveModelConfiguration,
	resolveModelWithProvider,
	selectModelDynamic,
} from "../lib/dynamic-model-selector";

const context = { userId: "example-user", organizationId: "example-org" };
const model = (name: string) => ({
	id: name,
	canonicalName: name,
	displayName: name,
	deprecatedAt: null,
	contextWindow: 10000,
	maxOutputTokens: 2000,
	providerMappings: [{ provider: "ANTHROPIC_DIRECT", providerModelId: name }],
});
const config = (name: string) => ({
	configId: name,
	provider: "ANTHROPIC_DIRECT",
	apiKey: "encrypted:example",
	source: "user",
	baseUrl: null,
	enabledProviders: [],
	deploymentName: null,
	clientId: null,
	encryptedClientSecret: null,
	taskDefaultsSnapshot: snapshotFixture({ CHAT: name }),
});
beforeEach(() => {
	vi.clearAllMocks();
	connections.default = config("example-personal-pin");
	connections.explicit = config("example-explicit-pin");
	mockDb.aiModel.findUnique.mockImplementation(async ({ where }) =>
		model(where.canonicalName),
	);
	mockDb.organizationModelPreference.findUnique.mockResolvedValue(null);
	mockDb.userModelPreference.findUnique.mockResolvedValue(null);
	mockDb.aiTaskModelDefault.findMany.mockImplementation(async ({ where }) =>
		where.provider === "GROQ" ? [] : [{ model: model("example-template") }],
	);
});
// Dropping the connection parameter from selectModelDynamic or any wrapper
// makes these select example-template rather than the connection's model.
describe("text selection entry points", () => {
	it("uses the personal default connection inside an organization", async () => {
		expect(
			(
				await selectModelDynamic(
					{ taskType: "CHAT", preferredProvider: "ANTHROPIC_DIRECT" },
					context,
				)
			).canonicalName,
		).toBe("example-personal-pin");
	});
	it("threads the snapshot through getModelForTaskDynamic", async () => {
		expect(
			await getModelForTaskDynamic("CHAT", context, {
				preferredProvider: "ANTHROPIC_DIRECT",
			}),
		).toBe("example-personal-pin");
	});
	it("threads it through resolveModelConfiguration", async () => {
		expect(
			(
				await resolveModelConfiguration("CHAT", context, {
					preferredProvider: "ANTHROPIC_DIRECT",
				})
			).providerModelId,
		).toBe("example-personal-pin");
	});
	it("threads it through getConfiguredModelString", async () => {
		expect(
			await getConfiguredModelString("CHAT", context, {
				preferredProvider: "ANTHROPIC_DIRECT",
			}),
		).toBe("anthropic/example-personal-pin");
	});
	it("uses the supplied spent-plan connection instead of another same-provider connection", async () => {
		const own = config("example-spent-plan-pin");
		expect(
			(
				await resolveModelWithProvider("CHAT", context, {
					providerConfig:
						own as import("@repo/database").AiProviderConfig,
				})
			).canonicalName,
		).toBe("example-spent-plan-pin");
	});
	it("keeps the base cross-provider model instead of the destination snapshot", async () => {
		connections.default = {
			...config("example-groq-pin"),
			provider: "GROQ",
			taskDefaultsSnapshot: snapshotFixture(
				{},
				{ CHAT: "example-template" },
			),
		};
		const result = await resolveModelWithProvider("CHAT", context);
		expect(result).toMatchObject({
			canonicalName: "example-template",
			modelString: "example-template",
			configId: "example-explicit-pin",
			provider: "ANTHROPIC_DIRECT",
		});
	});
	it("keeps system_default and ignores destination preferences during cross-provider fallback", async () => {
		connections.default = {
			...config("example-groq-pin"),
			provider: "GROQ",
			taskDefaultsSnapshot: snapshotFixture(
				{},
				{ CHAT: "example-template" },
			),
		};
		mockDb.organizationModelPreference.findUnique.mockImplementation(
			async ({ where }) =>
				where.organizationId_taskType_provider.provider ===
				"ANTHROPIC_DIRECT"
					? {
							modelId: "example-org-pick",
							model: model("example-org-pick"),
						}
					: null,
		);
		const result = await resolveModelWithProvider("CHAT", context);
		expect(result).toMatchObject({
			canonicalName: "example-template",
			configId: "example-explicit-pin",
			provider: "ANTHROPIC_DIRECT",
			selectionSource: "system_default",
		});
	});
	it("keeps a Databricks REASONING fallback frozen when the template changes", async () => {
		const pinned = {
			...config("example-databricks"),
			provider: "DATABRICKS",
			taskDefaultsSnapshot: snapshotFixture(
				{},
				{ REASONING: "example-frozen-fallback" },
			),
		};
		connections.default = pinned;
		mockDb.aiTaskModelDefault.findMany.mockImplementation(
			async ({ where }) =>
				where.provider === "DATABRICKS"
					? []
					: [{ model: model("example-changed-template") }],
		);
		const result = await resolveModelWithProvider("REASONING", context);
		expect(result).toMatchObject({
			canonicalName: "example-frozen-fallback",
			provider: "ANTHROPIC_DIRECT",
			selectionSource: "system_default",
			configId: "example-explicit-pin",
		});
	});
	it("keeps a pinned null without a default after a template row is added", async () => {
		connections.default = {
			...config("example-null"),
			taskDefaultsSnapshot: snapshotFixture({ CHAT: null }),
		};
		await expect(resolveModelWithProvider("CHAT", context)).rejects.toThrow(
			"No model configured",
		);
		expect(mockDb.aiTaskModelDefault.findMany).not.toHaveBeenCalled();
	});

	it("keeps the base canonical-name fallback when the frozen model has no mappings", async () => {
		mockDb.aiModel.findUnique.mockResolvedValue({
			...model("example-unmapped"),
			providerMappings: [],
		});
		expect(await resolveModelWithProvider("CHAT", context)).toMatchObject({
			canonicalName: "example-unmapped",
			provider: "ANTHROPIC_DIRECT",
			modelString: "example-unmapped",
			selectionSource: "system_default",
		});
	});
});

it("leaves an unscoped deprecated fallback unresolved, as the base selector does", async () => {
	connections.default = {
		...config("example-empty"),
		provider: "OPENROUTER",
		taskDefaultsSnapshot: snapshotFixture({}, { CHAT: "example-retired" }),
	};
	mockDb.aiModel.findUnique.mockImplementation(async ({ where }) => ({
		...model(where.canonicalName),
		deprecatedAt: new Date("2026-10-20T00:00:00.000Z"),
		replacementModelId: "example-replacement",
	}));
	expect(
		await selectModelDynamic(
			{ taskType: "CHAT", preferredProvider: "OPENROUTER" },
			context,
		),
	).toMatchObject({
		canonicalName: "example-retired",
		provider: "ANTHROPIC_DIRECT",
	});
	expect(
		mockDb.aiModel.findUnique.mock.calls.every(
			([args]) => args.where.canonicalName === "example-retired",
		),
	).toBe(true);
});
