import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotFixture } from "./_helpers/task-default-snapshot";

const { mockDb, state } = vi.hoisted(() => {
	const state = { snapshot: null as unknown };
	const delegate = () => ({
		findFirst: vi.fn(),
		findMany: vi.fn(),
		updateMany: vi.fn(async ({ data }) => {
			if (state.snapshot === null) {
				state.snapshot = data.taskDefaultsSnapshot;
				return { count: 1 };
			}
			return { count: 0 };
		}),
		findUniqueOrThrow: vi.fn(async () => ({
			taskDefaultsSnapshot: state.snapshot,
		})),
	});
	return {
		state,
		mockDb: {
			cloudProviderConfig: delegate(),
			userCloudProviderConfig: delegate(),
			aiTaskModelDefault: { findMany: vi.fn() },
			aiModel: { findUnique: vi.fn() },
			organizationModelPreference: { findUnique: vi.fn() },
			userModelPreference: { findUnique: vi.fn() },
		},
	};
});
vi.mock("../prisma/client", () => ({
	db: mockDb,
	Prisma: { DbNull: "sql-null" },
}));
vi.mock("@repo/config", () => ({ config: { ai: { enableGateway: false } } }));
vi.mock("@repo/utils", () => ({ encryptApiKey: (value: string) => value }));
vi.mock("../prisma/queries/ai-credits", () => ({
	estimateAiUsageCostUsd: vi.fn(),
}));
vi.mock("../prisma/queries/cache", () => ({
	aiModelCatalogCache: {
		get: () => null,
		set: () => {},
		getOrSet: (_key: string, fn: () => unknown) => fn(),
	},
	aiTaskDefaultsCache: {
		getOrSet: (_key: string, fn: () => unknown) => fn(),
	},
}));

import {
	getAiProviderApiKey,
	getAiProviderApiKeyByProvider,
	getPlanSpentPersonalProviderConfig,
} from "../prisma/queries/ai-gateway";
import { getModelForTask } from "../prisma/queries/ai-models";

const snapshot = snapshotFixture({ CHAT: "example-pinned" });
const row = {
	id: "example-connection",
	provider: "OPENAI_DIRECT",
	encryptedApiKey: "encrypted:example",
	config: {},
	clientId: null,
	encryptedClientSecret: null,
	taskDefaultsSnapshot: snapshot,
};
const pinnedModel = {
	id: "example-pinned",
	canonicalName: "example-pinned",
	deprecatedAt: null,
	providerMappings: [
		{ provider: "OPENAI_DIRECT", providerModelId: "example-pinned" },
	],
};
beforeEach(() => {
	vi.clearAllMocks();
	state.snapshot = null;
	mockDb.cloudProviderConfig.findFirst.mockResolvedValue(null);
	mockDb.userCloudProviderConfig.findFirst.mockResolvedValue(row);
	mockDb.userCloudProviderConfig.findMany.mockResolvedValue([row]);
	mockDb.aiTaskModelDefault.findMany.mockImplementation(async ({ where }) =>
		where.taskType === "CHAT"
			? [{ model: { canonicalName: "example-live" } }]
			: [],
	);
	mockDb.aiModel.findUnique.mockResolvedValue(pinnedModel);
	mockDb.organizationModelPreference.findUnique.mockResolvedValue(null);
	mockDb.userModelPreference.findUnique.mockResolvedValue(null);
});
// Omitting the snapshot from any gateway select/mapper loses the selected connection's pin.
it("uses a personal connection inside an organization with the organization's preferences", async () => {
	const config = await getAiProviderApiKey({
		userId: "example-user",
		organizationId: "example-org",
	});
	expect(config).toMatchObject({
		source: "user",
		configId: row.id,
		taskDefaultsSnapshot: snapshot,
	});
	expect(mockDb.userCloudProviderConfig.findFirst).toHaveBeenCalledWith(
		expect.objectContaining({
			select: expect.objectContaining({ taskDefaultsSnapshot: true }),
		}),
	);
	expect(
		(
			await getModelForTask(
				"example-user",
				"OPENAI_DIRECT",
				"CHAT",
				"example-org",
				"MEDIUM",
				config,
			)
		)?.model?.canonicalName,
	).toBe("example-pinned");
	mockDb.organizationModelPreference.findUnique.mockResolvedValue({
		modelId: "example-org-pick",
		model: { ...pinnedModel, canonicalName: "example-org-pick" },
	});
	expect(
		(
			await getModelForTask(
				"example-user",
				"OPENAI_DIRECT",
				"CHAT",
				"example-org",
				"MEDIUM",
				config,
			)
		)?.model?.canonicalName,
	).toBe("example-org-pick");
	expect(mockDb.userModelPreference.findUnique).not.toHaveBeenCalled();
});
it("carries the spent-plan personal connection snapshot", async () => {
	const config = await getPlanSpentPersonalProviderConfig({
		userId: "example-user",
		configId: row.id,
	});
	expect(config?.taskDefaultsSnapshot).toEqual(snapshot);
	expect(mockDb.userCloudProviderConfig.findMany).toHaveBeenCalledWith(
		expect.objectContaining({
			select: expect.objectContaining({ taskDefaultsSnapshot: true }),
		}),
	);
});
describe.each(["organization", "user"] as const)(
	"explicit %s lookup",
	(source) => {
		it("carries that provider connection's snapshot", async () => {
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue(
				source === "organization" ? row : null,
			);
			const config = await getAiProviderApiKeyByProvider({
				userId: "example-user",
				organizationId:
					source === "organization" ? "example-org" : null,
				provider: "OPENAI_DIRECT",
			});
			expect(config).toMatchObject({
				source,
				taskDefaultsSnapshot: snapshot,
			});
		});
		it("materializes a rollout NULL and uses it on first resolution", async () => {
			const empty = { ...row, taskDefaultsSnapshot: null };
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue(
				source === "organization" ? empty : null,
			);
			mockDb.userCloudProviderConfig.findFirst.mockResolvedValue(empty);
			const config = await getAiProviderApiKey({
				userId: "example-user",
				organizationId: "example-org",
			});
			expect(config.taskDefaultsSnapshot?.scoped).toEqual({
				SIMPLE: null,
				COMPLEX: null,
				REASONING: null,
				TOOL_CALLING: null,
				EVAL: null,
				CHAT: "example-live",
			});
			mockDb.aiModel.findUnique.mockResolvedValue({
				...pinnedModel,
				canonicalName: "example-live",
			});
			expect(
				(
					await getModelForTask(
						"example-user",
						"OPENAI_DIRECT",
						"CHAT",
						"example-org",
						"MEDIUM",
						config,
					)
				)?.model?.canonicalName,
			).toBe("example-live");
			const delegate =
				source === "organization"
					? mockDb.cloudProviderConfig
					: mockDb.userCloudProviderConfig;
			expect(delegate.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						id: row.id,
						taskDefaultsSnapshot: { equals: "sql-null" },
					},
				}),
			);
		});
	},
);
