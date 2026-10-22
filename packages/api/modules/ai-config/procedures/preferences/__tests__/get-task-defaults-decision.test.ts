import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockSystem,
	mockOrgSystem,
	mockSelector,
	mockModelById,
	mockFindMany,
	mockFindFirst,
	mockConfigured,
	mockModels,
	mockEmbeddingProvider,
	mockGetDefaultProvider,
	mockOrganizationDefault,
	mockGetProviderByProvider,
} = vi.hoisted(() => ({
	mockSystem: vi.fn(),
	mockOrgSystem: vi.fn(),
	mockSelector: vi.fn(),
	mockModelById: vi.fn(),
	mockFindMany: vi.fn(),
	mockFindFirst: vi.fn(),
	mockConfigured: vi.fn(),
	mockModels: vi.fn(),
	mockEmbeddingProvider: vi.fn(),
	mockGetDefaultProvider: vi.fn(),
	mockOrganizationDefault: vi.fn(),
	mockGetProviderByProvider: vi.fn(),
}));

vi.mock("@repo/ai/model-selector", () => ({
	selectModelDynamic: mockSelector,
}));

vi.mock("@repo/database", () => ({
	readTaskDefaultsSnapshot: vi.fn(() => null),
	TEXT_TASK_TYPES: [
		"SIMPLE",
		"COMPLEX",
		"REASONING",
		"CHAT",
		"TOOL_CALLING",
		"EVAL",
	],
	db: {
		aiTaskModelDefault: { findMany: mockFindMany },
		cloudProviderConfig: {
			findFirst: mockFindFirst,
			findMany: mockConfigured,
		},
		userCloudProviderConfig: { findFirst: vi.fn() },
		aiModel: { findMany: mockModels, findUnique: mockModelById },
	},
	LLM_PROVIDER_PURPOSE_FILTER: { purpose: { not: "EMBEDDINGS_ONLY" } },
	getOrganizationDefaultProvider: (...args: unknown[]) =>
		mockOrganizationDefault(...args),
	getSystemAiProviderApiKey: mockSystem,
	getOrganizationSystemAiProviderApiKey: mockOrgSystem,
	getEmbeddingProviderConfig: mockEmbeddingProvider,
	getAiProviderApiKey: (...args: unknown[]) =>
		mockGetDefaultProvider(...args),
	getAiProviderApiKeyByProvider: (...args: unknown[]) =>
		mockGetProviderByProvider(...args),
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
		resolveOrganizationId: (organizationId: string) => organizationId,
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: { ORG_AI_CONFIG_READ: "org_ai_config_read" },
	};
});

import { getTaskDefaultsProcedure } from "../get-task-defaults";

const getTaskDefaults = getTaskDefaultsProcedure as unknown as {
	_handler: (args: {
		input: unknown;
		context: { user: { id: string }; session: unknown };
	}) => Promise<Array<{ taskType: string; provider: string | null }>>;
};

const context = { user: { id: "user-1" }, session: {} };

function defaultFor(taskType: string, provider: string) {
	return {
		taskType,
		complexity: "MEDIUM",
		priority: 1,
		provider,
		model: {
			id: `${provider}-${taskType}`,
			canonicalName: `${provider.toLowerCase()}-${taskType.toLowerCase()}`,
			displayName: `${provider} ${taskType}`,
			family: "example",
			vendor: "Example AI",
			speedTier: "BALANCED",
			qualityTier: "STANDARD",
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockSystem.mockResolvedValue({ provider: null });
	mockOrgSystem.mockResolvedValue({ provider: null });
	mockSelector.mockImplementation(async ({ preferredProvider }) => {
		if (["GROQ", "ANTHROPIC_DIRECT"].includes(preferredProvider)) {
			throw new Error("[ModelSelector] No model configured");
		}
		return {
			modelId: "VERCEL_GATEWAY-EMBEDDING",
			canonicalName: "example-embedding",
			displayName: "Example embedding",
			provider: preferredProvider,
			providerModelId: "example-embedding",
		};
	});
	mockModelById.mockResolvedValue(
		defaultFor("EMBEDDING", "VERCEL_GATEWAY").model,
	);
	mockEmbeddingProvider.mockResolvedValue({ provider: null });
	mockConfigured.mockResolvedValue([{ provider: "VERCEL_GATEWAY" }]);
	mockModels.mockResolvedValue([]);
	mockGetDefaultProvider.mockResolvedValue({ provider: "GROQ" });
	mockOrganizationDefault.mockResolvedValue("GROQ");
	mockGetProviderByProvider.mockResolvedValue({
		provider: "VERCEL_GATEWAY",
		source: "organization",
		apiKey: "decrypted-placeholder",
	});
	mockFindFirst.mockResolvedValue({ id: "openai-config" });
	mockFindMany.mockImplementation(
		(args: { where: Record<string, unknown> }) => {
			if (args.where.provider === "GROQ") {
				return Promise.resolve(
					[
						"SIMPLE",
						"COMPLEX",
						"REASONING",
						"CHAT",
						"TOOL_CALLING",
						"EMBEDDING",
						"AUDIO",
						"EVAL",
					].map((taskType) => defaultFor(taskType, "GROQ")),
				);
			}
			if (args.where.provider === "VERCEL_GATEWAY") {
				return Promise.resolve([
					defaultFor("DECISION", "VERCEL_GATEWAY"),
					defaultFor("IMAGE", "VERCEL_GATEWAY"),
				]);
			}
			return Promise.resolve([defaultFor("IMAGE", "OPENAI_DIRECT")]);
		},
	);
});

describe("task defaults for DECISION", () => {
	it("retains gateway Image and Decision defaults with an inference primary", async () => {
		const defaults = await getTaskDefaults._handler({
			input: { organizationId: "org-1" },
			context,
		});

		expect(defaults).toContainEqual(
			expect.objectContaining({
				taskType: "DECISION",
				provider: "VERCEL_GATEWAY",
			}),
		);
		expect(mockFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					provider: "VERCEL_GATEWAY",
					taskType: { in: ["DECISION", "IMAGE"] },
				},
			}),
		);
		expect(defaults).not.toContainEqual(
			expect.objectContaining({
				taskType: "IMAGE",
				provider: "OPENAI_DIRECT",
			}),
		);
		expect(defaults).toContainEqual(
			expect.objectContaining({
				taskType: "IMAGE",
				provider: "VERCEL_GATEWAY",
			}),
		);
	});
});

describe("explicit provider defaults", () => {
	it("returns the configured target provider defaults instead of the current provider", async () => {
		const rows = await getTaskDefaults._handler({
			input: {
				organizationId: "example-org",
				provider: "VERCEL_GATEWAY",
			},
			context,
		});
		expect(mockConfigured).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organizationId: "example-org",
					enabled: true,
					purpose: { not: "EMBEDDINGS_ONLY" },
				}),
			}),
		);
		expect(rows).not.toContainEqual(
			expect.objectContaining({ provider: "GROQ" }),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				taskType: "IMAGE",
				provider: "VERCEL_GATEWAY",
			}),
		);
	});
	it("rejects a provider not enabled for the organization", async () => {
		await expect(
			getTaskDefaults._handler({
				input: {
					organizationId: "example-org",
					provider: "ANTHROPIC_DIRECT",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mockFindMany).not.toHaveBeenCalled();
	});
	it("does not reuse another organization's configured provider", async () => {
		mockConfigured.mockImplementation(async ({ where }) =>
			where.organizationId === "example-org"
				? [{ provider: "VERCEL_GATEWAY" }]
				: [],
		);
		await expect(
			getTaskDefaults._handler({
				input: {
					organizationId: "example-other-org",
					provider: "VERCEL_GATEWAY",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it("computes an unseeded gateway IMAGE default from its image catalog", async () => {
		mockGetDefaultProvider.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
		});
		mockOrganizationDefault.mockResolvedValue("VERCEL_GATEWAY");
		mockFindMany.mockResolvedValue([]);
		mockModels.mockResolvedValue([
			{
				...defaultFor("IMAGE", "VERCEL_GATEWAY").model,
				capabilities: ["IMAGE"],
				contextWindow: 4096,
			},
		]);
		const rows = await getTaskDefaults._handler({
			input: { organizationId: "example-org" },
			context,
		});
		expect(rows).toContainEqual(
			expect.objectContaining({
				taskType: "IMAGE",
				provider: "VERCEL_GATEWAY",
			}),
		);
	});
});

it("does not offer personal or secondary text defaults without an organization default", async () => {
	mockOrganizationDefault.mockResolvedValue(null);
	mockGetDefaultProvider.mockResolvedValue({
		provider: "GROQ",
		source: "user",
	});
	const rows = await getTaskDefaults._handler({
		input: { organizationId: "example-org" },
		context,
	});
	expect(
		rows.filter((r) =>
			[
				"SIMPLE",
				"COMPLEX",
				"REASONING",
				"CHAT",
				"TOOL_CALLING",
				"EVAL",
			].includes(r.taskType),
		),
	).toEqual([]);
	expect(mockGetDefaultProvider).not.toHaveBeenCalled();
});

describe("documents provider embedding defaults", () => {
	it.each(["ANTHROPIC_DIRECT", "GROQ", "VERCEL_GATEWAY", null])(
		"returns the gateway embedding model with default %s",
		async (provider) => {
			mockOrganizationDefault.mockResolvedValue(provider);
			mockEmbeddingProvider.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
			});
			mockFindMany.mockImplementation(async ({ where }) => {
				if (typeof where.provider !== "string") {
					return [];
				}
				const tasks =
					where.provider === "VERCEL_GATEWAY"
						? ["EMBEDDING", "IMAGE", "DECISION"]
						: where.provider === "OPENAI_DIRECT"
							? ["EMBEDDING", "AUDIO"]
							: ["CHAT"];
				return tasks
					.filter(
						(task) =>
							!where.taskType ||
							(typeof where.taskType === "string"
								? task === where.taskType
								: where.taskType.in.includes(task)),
					)
					.map((task) => defaultFor(task, where.provider));
			});
			const rows = await getTaskDefaults._handler({
				input: { organizationId: "example-org" },
				context: { user: { id: "example-user" }, session: {} },
			});
			expect(mockSelector).toHaveBeenCalledWith(
				expect.objectContaining({
					taskType: "EMBEDDING",
					preferredProvider: "VERCEL_GATEWAY",
				}),
				expect.objectContaining({
					organizationId: "example-org",
					organizationOnly: true,
				}),
			);
			const embeddingRows = rows.filter(
				(row) => row.taskType === "EMBEDDING",
			);
			expect(embeddingRows).toHaveLength(1);
			expect(embeddingRows[0]).toMatchObject({
				...defaultFor("EMBEDDING", "VERCEL_GATEWAY"),
				priority: 100,
			});
		},
	);

	it("does not compute another provider's embedding default when runtime cannot resolve embeddings", async () => {
		mockSelector.mockRejectedValue(
			new Error(
				"[ModelSelector] Embedding provider has no model mapping",
			),
		);
		mockOrganizationDefault.mockResolvedValue("OPENAI_DIRECT");
		mockEmbeddingProvider.mockResolvedValue({ provider: "VERCEL_GATEWAY" });
		mockFindMany.mockResolvedValue([]);
		mockModels.mockResolvedValue([
			{
				...defaultFor("EMBEDDING", "OPENAI_DIRECT").model,
				capabilities: ["EMBEDDING"],
			},
		]);
		const rows = await getTaskDefaults._handler({
			input: { organizationId: "example-org" },
			context: { user: { id: "example-user" }, session: {} },
		});
		expect(rows.filter((row) => row.taskType === "EMBEDDING")).toEqual([]);
	});
});

it.each([false, true])(
	"does not expose a platform default model when the organization has no usable provider (platform %s)",
	async (enabled) => {
		const { config } = await import("@repo/config");
		const previous = {
			enableGateway: config.ai.enableGateway,
			gatewayApiKey: config.ai.gatewayApiKey,
		};
		config.ai.enableGateway = enabled;
		config.ai.gatewayApiKey = "example-platform-key";
		mockOrganizationDefault.mockResolvedValue(null);
		mockFindMany.mockResolvedValue([]);
		mockSystem.mockResolvedValue({
			provider: "OPENAI_DIRECT",
			source: "user",
		});
		try {
			for (const userId of ["example-admin-a", "example-admin-b"]) {
				const rows = await getTaskDefaults._handler({
					input: { organizationId: "example-org" },
					context: { user: { id: userId }, session: {} },
				});
				expect(
					rows.filter((row) => row.taskType === "EMBEDDING"),
				).toEqual([]);
			}
			expect(mockSelector).not.toHaveBeenCalled();
			expect(mockSystem).not.toHaveBeenCalled();
			expect(mockOrgSystem).not.toHaveBeenCalled();
		} finally {
			Object.assign(config.ai, previous);
		}
	},
);
