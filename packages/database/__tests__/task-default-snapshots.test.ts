import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb } = vi.hoisted(() => ({
	mockDb: {
		aiTaskModelDefault: { findMany: vi.fn() },
		aiModel: { findUnique: vi.fn() },
		organizationModelPreference: { findUnique: vi.fn() },
		userModelPreference: { findUnique: vi.fn() },
	},
}));
vi.mock("../prisma/client", () => ({ db: mockDb }));
vi.mock("../prisma/queries/ai-credits", () => ({
	estimateAiUsageCostUsd: vi.fn(),
}));
vi.mock("../prisma/queries/cache", async (importOriginal) => ({
	aiTaskDefaultsCache: {
		getOrSet: (_key: string, fn: () => unknown) => fn(),
	},
	aiModelCatalogCache: (
		await importOriginal<typeof import("../prisma/queries/cache")>()
	).aiModelCatalogCache,
}));

import {
	getModelForTask,
	getTaskDefaultModel,
} from "../prisma/queries/ai-models";
import { aiModelCatalogCache } from "../prisma/queries/cache";
import { snapshotFixture } from "./_helpers/task-default-snapshot";

const model = (name: string) => ({
	id: name,
	canonicalName: name,
	deprecatedAt: null,
	replacementModelId: null,
	providerMappings: [{ provider: "ANTHROPIC_DIRECT", providerModelId: name }],
});
const pinned = model("claude-sonnet-5");
const latest = model("claude-sonnet-5-5");
const connection = {
	configId: "example-connection",
	provider: "ANTHROPIC_DIRECT",
	taskDefaultsSnapshot: snapshotFixture({ CHAT: pinned.canonicalName }),
};

beforeEach(() => {
	aiModelCatalogCache.clear();
});

describe("connection task defaults", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.organizationModelPreference.findUnique.mockResolvedValue(null);
		mockDb.userModelPreference.findUnique.mockResolvedValue(null);
		mockDb.aiTaskModelDefault.findMany.mockResolvedValue([
			{ model: latest },
		]);
		mockDb.aiModel.findUnique.mockResolvedValue(pinned);
	});
	// Removing the snapshot lookup makes this resolve the moving template.
	it("uses the connection snapshot before the template at non-MEDIUM complexity", async () => {
		const result = await getModelForTask(
			"example-user",
			"ANTHROPIC_DIRECT",
			"CHAT",
			"example-org",
			"COMPLEX",
			connection,
		);
		expect(result?.model?.canonicalName).toBe(pinned.canonicalName);
		expect(mockDb.aiTaskModelDefault.findMany).not.toHaveBeenCalled();
	});
});

// These cases exercise the preference branches and the shared effective default,
// so bypassing either branch changes the selected model.
describe("snapshot precedence and retirement", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.organizationModelPreference.findUnique.mockResolvedValue(null);
		mockDb.userModelPreference.findUnique.mockResolvedValue(null);
		mockDb.aiTaskModelDefault.findMany.mockResolvedValue([
			{ model: latest },
		]);
		mockDb.aiModel.findUnique.mockResolvedValue(pinned);
	});
	it("keeps an organization pick above the serving personal connection snapshot", async () => {
		mockDb.organizationModelPreference.findUnique.mockResolvedValue({
			modelId: latest.id,
			model: latest,
		});
		const result = await getModelForTask(
			"example-user",
			"ANTHROPIC_DIRECT",
			"CHAT",
			"example-org",
			"MEDIUM",
			connection,
		);
		expect(result?.model?.canonicalName).toBe(latest.canonicalName);
		expect(result?.source).toBe("org_override");
		expect(mockDb.userModelPreference.findUnique).not.toHaveBeenCalled();
	});
	it("honors the organization's NULL opt-out above a text snapshot", async () => {
		mockDb.organizationModelPreference.findUnique.mockResolvedValue({
			modelId: null,
			model: null,
		});
		expect(
			await getModelForTask(
				"example-user",
				"ANTHROPIC_DIRECT",
				"CHAT",
				"example-org",
				"MEDIUM",
				connection,
			),
		).toBeNull();
		expect(mockDb.aiModel.findUnique).not.toHaveBeenCalled();
	});
	it("uses personal preferences only outside an organization", async () => {
		mockDb.userModelPreference.findUnique.mockResolvedValue({
			modelId: latest.id,
			model: latest,
		});
		expect(
			(
				await getModelForTask(
					"example-user",
					"ANTHROPIC_DIRECT",
					"CHAT",
					null,
					"MEDIUM",
					connection,
				)
			)?.source,
		).toBe("user_override");
		expect(
			(
				await getModelForTask(
					"example-user",
					"ANTHROPIC_DIRECT",
					"CHAT",
					"example-org",
					"MEDIUM",
					connection,
				)
			)?.model?.canonicalName,
		).toBe(pinned.canonicalName);
	});
	it.each(["missing model"])(
		"warns and uses the template for a %s",
		async (failure) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			mockDb.aiModel.findUnique.mockResolvedValue(
				failure === "missing model"
					? null
					: { ...pinned, providerMappings: [] },
			);
			expect(
				(
					await getModelForTask(
						"example-user",
						"ANTHROPIC_DIRECT",
						"CHAT",
						"example-org",
						"MEDIUM",
						connection,
					)
				)?.model?.canonicalName,
			).toBe(latest.canonicalName);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("Pinned model"),
				expect.objectContaining({ configId: "example-connection" }),
			);
			warn.mockRestore();
		},
	);
	it("follows a deprecated snapshot model's replacement", async () => {
		mockDb.aiModel.findUnique
			.mockResolvedValueOnce({
				...pinned,
				deprecatedAt: new Date(),
				replacementModelId: latest.id,
			})
			.mockResolvedValueOnce(latest);
		const result = await getModelForTask(
			"example-user",
			"ANTHROPIC_DIRECT",
			"CHAT",
			"example-org",
			"MEDIUM",
			connection,
		);
		expect(result).toMatchObject({
			wasDeprecated: true,
			deprecatedModelName: pinned.canonicalName,
			model: { canonicalName: latest.canonicalName },
		});
	});
	it.each(["DECISION", "EMBEDDING"] as const)(
		"ignores snapshot content for %s",
		async (taskType) => {
			const resolved = await getModelForTask(
				"example-user",
				"ANTHROPIC_DIRECT",
				taskType,
				"example-org",
				"MEDIUM",
				{
					...connection,
					taskDefaultsSnapshot: {
						...connection.taskDefaultsSnapshot,
						scoped: {
							...connection.taskDefaultsSnapshot.scoped,
							[taskType]: pinned.canonicalName,
						},
					},
				},
			);
			expect(resolved?.model?.canonicalName).toBe(latest.canonicalName);
			expect(mockDb.aiModel.findUnique).not.toHaveBeenCalled();
		},
	);
	it("logs an invalid snapshot and uses the template", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(
			(
				await getModelForTask(
					"example-user",
					"ANTHROPIC_DIRECT",
					"CHAT",
					"example-org",
					"MEDIUM",
					{ ...connection, taskDefaultsSnapshot: { version: 2 } },
				)
			)?.model?.canonicalName,
		).toBe(latest.canonicalName);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid"), {
			configId: connection.configId,
		});
		warn.mockRestore();
	});
	it("keeps template exact-complexity then MEDIUM fallback without a snapshot", async () => {
		mockDb.aiTaskModelDefault.findMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ model: latest }]);
		const result = await getModelForTask(
			"example-user",
			"ANTHROPIC_DIRECT",
			"SIMPLE",
			"example-org",
			"COMPLEX",
			{ ...connection, taskDefaultsSnapshot: undefined },
		);
		expect(result?.model?.canonicalName).toBe(latest.canonicalName);
		expect(
			mockDb.aiTaskModelDefault.findMany.mock.calls.map(
				([args]) => args.where.complexity,
			),
		).toEqual(["COMPLEX", "MEDIUM"]);
	});
});

// Both template queries must apply the same stable secondary ordering as capture.
it.each([undefined, "ANTHROPIC_DIRECT"] as const)(
	"breaks provider %s template ties by id, including the MEDIUM fallback",
	async (provider) => {
		const a = model("example-a");
		const z = model("example-z");
		mockDb.aiTaskModelDefault.findMany.mockImplementation(
			async ({ where, orderBy }) => {
				if (where.complexity === "COMPLEX") {
					return [];
				}
				return orderBy?.some?.(
					(order: { id?: string }) => order.id === "asc",
				)
					? [{ model: a }, { model: z }]
					: [{ model: z }, { model: a }];
			},
		);
		expect(
			(await getTaskDefaultModel("REASONING", "MEDIUM", provider))
				?.canonicalName,
		).toBe("example-a");
		expect(
			(await getTaskDefaultModel("REASONING", "COMPLEX", provider))
				?.canonicalName,
		).toBe("example-a");
		for (const [args] of mockDb.aiTaskModelDefault.findMany.mock.calls) {
			expect(args.orderBy).toEqual([{ priority: "desc" }, { id: "asc" }]);
		}
	},
);
it("caches pinned catalog lookups by canonical name across connections", async () => {
	vi.clearAllMocks();
	mockDb.organizationModelPreference.findUnique.mockResolvedValue(null);
	mockDb.aiModel.findUnique.mockImplementation(async ({ where }) =>
		model(where.canonicalName),
	);
	for (const configId of ["example-first", "example-second"]) {
		await getModelForTask(
			"example-user",
			"ANTHROPIC_DIRECT",
			"CHAT",
			"example-org",
			"MEDIUM",
			{ ...connection, configId },
		);
	}
	expect(mockDb.aiModel.findUnique).toHaveBeenCalledTimes(1);
	await getModelForTask(
		"example-user",
		"ANTHROPIC_DIRECT",
		"CHAT",
		"example-org",
		"MEDIUM",
		{
			...connection,
			taskDefaultsSnapshot: {
				...connection.taskDefaultsSnapshot,
				scoped: {
					...connection.taskDefaultsSnapshot.scoped,
					CHAT: "example-different",
				},
			},
		},
	);
	expect(mockDb.aiModel.findUnique).toHaveBeenCalledTimes(2);
});

it("returns a deprecated frozen model unchanged at the query seam", async () => {
	const retired = {
		...pinned,
		deprecatedAt: new Date(),
		replacementModelId: latest.id,
	};
	mockDb.aiModel.findUnique.mockResolvedValue(retired);
	expect(
		await getTaskDefaultModel("CHAT", "SIMPLE", undefined, connection),
	).toEqual(retired);
	expect(mockDb.aiModel.findUnique).toHaveBeenCalledWith({
		where: { canonicalName: pinned.canonicalName },
		include: { providerMappings: { where: { isAvailable: true } } },
	});
});
it("leaves an uncaptured provider scope live", async () => {
	mockDb.aiTaskModelDefault.findMany.mockResolvedValue([{ model: latest }]);
	expect(
		await getTaskDefaultModel(
			"CHAT",
			"MEDIUM",
			"OPENAI_DIRECT",
			connection,
		),
	).toEqual(latest);
});

it("caches a missing pinned model briefly and warns once before retrying", async () => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		mockDb.aiModel.findUnique.mockResolvedValue(null);
		mockDb.aiTaskModelDefault.findMany.mockResolvedValue([
			{ model: latest },
		]);
		expect(
			await getTaskDefaultModel(
				"CHAT",
				"MEDIUM",
				"ANTHROPIC_DIRECT",
				connection,
			),
		).toEqual(latest);
		mockDb.aiModel.findUnique.mockResolvedValue(pinned);
		expect(
			await getTaskDefaultModel(
				"CHAT",
				"MEDIUM",
				"ANTHROPIC_DIRECT",
				connection,
			),
		).toEqual(latest);
		expect(mockDb.aiModel.findUnique).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60_001);
		expect(
			await getTaskDefaultModel(
				"CHAT",
				"MEDIUM",
				"ANTHROPIC_DIRECT",
				connection,
			),
		).toEqual(pinned);
		expect(mockDb.aiModel.findUnique).toHaveBeenCalledTimes(2);
	} finally {
		vi.useRealTimers();
		warn.mockRestore();
	}
});
