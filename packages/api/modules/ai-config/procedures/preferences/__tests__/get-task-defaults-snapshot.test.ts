import { beforeEach, expect, it, vi } from "vitest";
import { snapshotFixture } from "../../../../../../database/__tests__/_helpers/task-default-snapshot";

const { mockDb, config } = vi.hoisted(() => ({
	mockDb: {
		aiTaskModelDefault: { findMany: vi.fn() },
		aiModel: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
	},
	config: {
		provider: "ANTHROPIC_DIRECT",
		configId: "example-connection",
		taskDefaultsSnapshot: null as unknown,
	},
}));
vi.mock("../../../../../../database/prisma/client", () => ({ db: mockDb }));
vi.mock("../../../../../../database/prisma/queries/ai-credits", () => ({
	estimateAiUsageCostUsd: vi.fn(),
}));
vi.mock("../../../../../../database/prisma/queries/cache", () => ({
	aiModelCatalogCache: {
		get: () => null,
		set: () => {},
		getOrSet: (_key: string, fn: () => unknown) => fn(),
	},
	aiTaskDefaultsCache: {
		getOrSet: (_key: string, fn: () => unknown) => fn(),
	},
}));
vi.mock("@repo/ai/model-selector", () => ({ selectModelDynamic: vi.fn() }));
vi.mock("@repo/database", async () => {
	const { getTaskDefaultModel } = await import(
		"../../../../../../database/prisma/queries/ai-models"
	);
	const { TEXT_TASK_TYPES, readTaskDefaultsSnapshot } = await import(
		"../../../../../../database/prisma/queries/task-default-snapshots"
	);
	return {
		db: mockDb,
		getTaskDefaultModel,
		readTaskDefaultsSnapshot,
		TEXT_TASK_TYPES,
		getOrganizationSystemAiProviderApiKey: async () => ({ provider: null }),
		getSystemAiProviderApiKey: async () => ({ provider: null }),
		getEmbeddingProviderConfig: async () => ({ provider: null }),
		getAiProviderApiKey: async () => config,
		getOrganizationDefaultProvider: async () => config.provider,
		getAiProviderApiKeyByProvider: async ({
			provider,
		}: {
			provider: string;
		}) => (provider === config.provider ? config : { provider: null }),
	};
});
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const method of ["use", "route", "input", "output"]) {
		chain[method] = () => chain;
	}
	chain.output = (schema: unknown) => {
		chain._outputSchema = schema;
		return chain;
	};
	chain.handler = (fn: unknown) => ({
		_handler: fn,
		_outputSchema: chain._outputSchema,
	});
	return {
		tenantProtectedProcedure: chain,
		resolveOrganizationId: () => "example-org",
		requireInputOrgPermission: vi.fn(),
		Permissions: {},
	};
});

import { getTaskDefaultsProcedure } from "../get-task-defaults";

const model = (name: string) => ({
	id: name,
	canonicalName: name,
	displayName: name,
	family: "example",
	vendor: "Example",
	speedTier: "BALANCED",
	qualityTier: "STANDARD",
	inputCostPer1M: { toString: () => "2" },
	outputCostPer1M: { toString: () => "8" },
	suitableForTasks: ["CHAT", "COMPLEX"],
	capabilities: ["TEXT"],
	deprecatedAt: null,
	providerMappings: [{ provider: "ANTHROPIC_DIRECT", providerModelId: name }],
});
const latest = model("example-current");
beforeEach(() => {
	vi.clearAllMocks();
	config.taskDefaultsSnapshot = null;
	mockDb.aiModel.findUnique.mockResolvedValue(model("example-frozen"));
	mockDb.aiTaskModelDefault.findMany.mockImplementation(async ({ where }) =>
		(where.taskType
			? [where.taskType]
			: [
					"SIMPLE",
					"COMPLEX",
					"REASONING",
					"CHAT",
					"TOOL_CALLING",
					"EMBEDDING",
					"IMAGE",
					"AUDIO",
					"EVAL",
					"DECISION",
				]
		).map((taskType: string) => ({
			id: taskType,
			taskType,
			complexity: "MEDIUM",
			priority: 1,
			provider: "ANTHROPIC_DIRECT",
			model: latest,
		})),
	);
});
// Returning raw template rows in settings would display example-current for the frozen connection.
it.each(["frozen", "new"])(
	"shows the runtime default for a %s connection",
	async (kind) => {
		config.taskDefaultsSnapshot = snapshotFixture({
			CHAT: kind === "frozen" ? "example-frozen" : "example-current",
		});
		mockDb.aiModel.findUnique.mockResolvedValue(
			model(kind === "frozen" ? "example-frozen" : "example-current"),
		);
		const handler = getTaskDefaultsProcedure as unknown as {
			_handler: (
				args: unknown,
			) => Promise<
				{ taskType: string; model: { canonicalName: string } }[]
			>;
		};
		const rows = await handler._handler({
			input: {},
			context: { user: { id: "example-user" }, session: {} },
		});
		expect(
			rows.find((row) => row.taskType === "CHAT")?.model.canonicalName,
		).toBe(kind === "frozen" ? "example-frozen" : "example-current");
	},
);

it("removes a newly added template row for a frozen null", async () => {
	config.taskDefaultsSnapshot = snapshotFixture({ CHAT: null });
	const handler = getTaskDefaultsProcedure as unknown as {
		_handler: (args: unknown) => Promise<{ taskType: string }[]>;
	};
	const rows = await handler._handler({
		input: {},
		context: { user: { id: "example-user" }, session: {} },
	});
	expect(rows.some((row) => row.taskType === "CHAT")).toBe(false);
});

it("preserves fit metadata for effective defaults", async () => {
	const handler = getTaskDefaultsProcedure as unknown as {
		_handler: (args: unknown) => Promise<Array<{ model: unknown }>>;
	};
	const result = await handler._handler({
		input: {},
		context: { user: { id: "example-user" }, session: {} },
	});
	const schema = (
		getTaskDefaultsProcedure as unknown as {
			_outputSchema: {
				parse: (value: unknown) => Array<{ model: unknown }>;
			};
		}
	)._outputSchema;
	expect(schema.parse(result)[0].model).toMatchObject({
		inputCostPer1M: 2,
		outputCostPer1M: 8,
		suitableForTasks: ["CHAT", "COMPLEX"],
		capabilities: ["TEXT"],
	});
});
