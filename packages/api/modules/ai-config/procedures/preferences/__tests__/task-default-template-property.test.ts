import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiTaskType } from "../../../../../../database/prisma/generated/client";

const { db, state, procedures } = vi.hoisted(() => {
	const chain: Record<string, any> = {};
	for (const name of ["use", "route", "input", "output"]) {
		chain[name] = () => chain;
	}
	chain.handler = (handler: unknown) => ({ _handler: handler });
	return {
		db: {
			aiTaskModelDefault: { findMany: vi.fn() },
			aiModel: {
				findUnique: vi.fn(),
				findMany: vi.fn(),
				findFirst: vi.fn(async () => null),
			},
			organizationModelPreference: {
				findUnique: vi.fn(),
				findMany: vi.fn(async () => []),
				deleteMany: vi.fn(async () => ({ count: 0 })),
			},
			userModelPreference: { findUnique: vi.fn() },
			cloudProviderConfig: {
				findFirst: vi.fn(),
				findMany: vi.fn(),
				updateMany: vi.fn(),
			},
			$transaction: vi.fn(),
			userApiKey: { findFirst: vi.fn() },
			organizationApiKey: { findFirst: vi.fn(), update: vi.fn() },
		},
		state: {
			connection: {} as any,
			connections: [] as any[],
			locked: false,
			documentsProvider: null as string | null,
			useTaskCache: false,
			rows: [] as any[],
			models: [] as any[],
		},
		procedures: {
			tenantProtectedProcedure: chain,
			publicProcedure: chain,
			requireInputOrgPermission: vi.fn(),
			requirePermission: vi.fn(),
			Permissions: {},
			resolveOrganizationId: () => "example-org",
		},
	};
});
vi.mock("../../../../../../database/prisma/client", () => ({ db }));
vi.mock("../../../../../../database/prisma/queries/ai-credits", () => ({}));
vi.mock("../../../../../../database/prisma/queries/cache", async () => {
	const actual = await vi.importActual<
		typeof import("../../../../../../database/prisma/queries/cache")
	>("../../../../../../database/prisma/queries/cache");
	return {
		aiModelCatalogCache: {
			get: () => null,
			set: () => {},
			getOrSet: (_key: string, fn: () => unknown) => fn(),
		},
		aiTaskDefaultsCache: {
			clear: () => actual.aiTaskDefaultsCache.clear(),
			getOrSet: (key: string, fn: () => Promise<unknown>) =>
				state.useTaskCache
					? actual.aiTaskDefaultsCache.getOrSet(key, fn)
					: fn(),
		},
	};
});
vi.mock("../../../../../../database/prisma/queries/ai-gateway", () => ({
	getSystemAiProviderApiKey: async () => state.connection,
	getAiProviderApiKeyByProvider: async () => state.connection,
}));
vi.mock("@repo/database", async () => ({
	...(await import("../../../../../../database/prisma/queries/ai-models")),
	...(await import(
		"../../../../../../database/prisma/queries/task-default-snapshots"
	)),
	db,
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY"],
	getAiProviderApiKey: async () =>
		state.connections.find((c) => c.isDefault) ?? state.connection,
	getOrganizationDefaultProvider: async () =>
		(state.connections.find((c) => c.isDefault) ?? state.connection)
			.provider,
	getAiProviderApiKeyByProvider: async ({ provider }: { provider: string }) =>
		state.connections.find((c) => c.provider === provider) ??
		(provider === state.connection.provider
			? state.connection
			: { provider: null }),
	getEmbeddingProviderConfig: async () => ({
		provider: state.documentsProvider,
	}),
	getOrganizationSystemAiProviderApiKey: async () =>
		state.connections.find((c) => c.isDefault) ?? state.connection,
	getSystemAiProviderApiKey: async () =>
		state.connections.find((c) => c.isDefault) ?? state.connection,
	lockTenantProviderConnections: (
		await import(
			"../../../../../../database/prisma/queries/provider-write-locks"
		)
	).lockTenantProviderConnections,
	organizationDefaultProviderWhere: (organizationId: string) => ({
		organizationId,
		isDefault: true,
		enabled: true,
		purpose: { not: "EMBEDDINGS_ONLY" },
	}),
	readProviderRowCredentials: (row: any) => ({
		hasCredentials: !!row.encryptedApiKey,
	}),
	ALL_EMBEDDING_CAPABLE_PROVIDERS: [],
	canProviderSupportEmbeddings: () => true,
	getProviderDisplayName: (provider: string) => provider,
}));
vi.mock("@repo/payments", () => ({}));
vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: async () => ({ role: "admin" }),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => procedures);
// Keep the company stamping resolver real; replace only its heavy I/O adapters.
vi.mock("@repo/ai", async () => ({
	...(await import("../../../../../../ai/lib/dynamic-model-selector")),
	hasProviderCredentials: (
		await import("../../../../../../ai/lib/databricks-oauth")
	).hasProviderCredentials,
}));
vi.mock("../../../../../../rag/lib/embedding/generator", () => ({
	getEmbeddingDimensions: () => 1536,
}));
vi.mock("../../../../../../rag/lib/vector-store/client", () => ({
	VECTOR_SIZE: 1536,
}));

import { selectModelDynamic } from "../../../../../../ai/lib/dynamic-model-selector";
import * as models from "../../../../../../database/prisma/queries/ai-models";
import { aiTaskDefaultsCache } from "../../../../../../database/prisma/queries/cache";
import { resolveModel } from "../../../../../../database/prisma/queries/model-resolution";
import {
	captureTaskDefaultsSnapshot,
	TEXT_TASK_TYPES,
} from "../../../../../../database/prisma/queries/task-default-snapshots";
import { previewDefaultProviderSwitch } from "../../../lib/default-provider-switch";
import { setDefaultProviderProcedure } from "../../providers/upsert";
import { resolveModelForAgentProcedure } from "../../resolution/resolve-for-agent";
import { resolveModelProcedure } from "../../resolution/resolve-model";
import { getTaskDefaultsProcedure } from "../get-task-defaults";

// Produced in the previous rework with a temporary offline harness loading
// `git show 05d45582e:<path>` versions of these six entry points. The expected
// outcomes were cross-checked by hand against the base resolver branches;
// Settings ordering follows the Postgres enum and base computed-row append order.
// The temporary generator was not retained.
const oracle = JSON.parse(
	readFileSync(
		join(__dirname, "task-default-template-property.oracle.json"),
		"utf8",
	),
);
const context = { userId: "example-user", organizationId: "example-org" };
const apiContext = { user: { id: context.userId }, session: {} };
const model = (name: string, providers: string[]) => ({
	id: name,
	canonicalName: name,
	displayName: name,
	family: "example",
	vendor: "Example",
	speedTier: "BALANCED",
	qualityTier: "STANDARD",
	capabilities: ["TEXT", "REASONING", "TOOL_CALLING"],
	contextWindow: 10000,
	maxOutputTokens: 2000,
	inputCostPer1M: null,
	outputCostPer1M: null,
	deprecatedAt: null,
	replacementModelId: null,
	providerMappings: providers.map((provider) => ({
		provider,
		providerModelId: `${provider}/${name}`,
		isAvailable: true,
	})),
});
const row = (taskType: string, provider: string | null, model: any) => ({
	id: `${taskType}-${provider}`,
	taskType,
	provider,
	model,
	modelId: model.id,
	complexity: "MEDIUM",
	priority: 100,
});
beforeEach(() => {
	vi.clearAllMocks();
	state.connections = [];
	state.documentsProvider = null;
	state.useTaskCache = false;
	aiTaskDefaultsCache.clear();
	state.locked = false;
	db.organizationModelPreference.findUnique.mockResolvedValue(null);
	db.userModelPreference.findUnique.mockResolvedValue(null);
	db.userApiKey.findFirst.mockResolvedValue(null);
	db.organizationApiKey.findFirst.mockResolvedValue({
		id: "example-key",
		organizationId: context.organizationId,
		createdByUserId: context.userId,
		scopes: ["*"],
	});
	db.cloudProviderConfig.findFirst.mockResolvedValue(null);
	db.aiModel.findMany.mockImplementation(async () =>
		state.models.filter((m) =>
			m.providerMappings.some(
				(p: any) => p.provider === state.connection.provider,
			),
		),
	);
	db.aiModel.findUnique.mockImplementation(
		async ({ where }) =>
			state.models.find(
				(m) =>
					m.canonicalName === where.canonicalName ||
					m.id === where.id,
			) ?? null,
	);
	db.aiTaskModelDefault.findMany.mockImplementation(
		async ({ where, take }) => {
			let rows = state.rows.filter(
				(r) =>
					(!where.taskType ||
						(typeof where.taskType === "string"
							? r.taskType === where.taskType
							: where.taskType.in.includes(r.taskType))) &&
					(!where.complexity || r.complexity === where.complexity) &&
					(!where.provider || r.provider === where.provider),
			);
			if (!where.taskType && !where.complexity) {
				rows = [...rows].sort(
					(a, b) =>
						Object.values(AiTaskType).indexOf(a.taskType) -
						Object.values(AiTaskType).indexOf(b.taskType),
				);
			}
			return take ? rows.slice(0, take) : rows;
		},
	);
});
async function outcome(fn: () => Promise<unknown>) {
	try {
		return { value: await fn() };
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
			code: (error as ORPCError<string, unknown>).code,
		};
	}
}
function entries(
	taskType: string,
	complexity: "SIMPLE" | "MEDIUM" | "COMPLEX",
) {
	const provider = state.connection.provider;
	const m = models;
	return {
		getModelForTask: () =>
			m.getModelForTask(
				context.userId,
				provider,
				taskType,
				context.organizationId,
				complexity,
				state.connection,
			),
		selectModelDynamic: () =>
			selectModelDynamic(
				{
					taskType,
					complexity: complexity.toLowerCase(),
					preferredProvider: provider,
				},
				context,
			),
		resolveModel: () => resolveModel({ ...context, taskType, complexity }),
		"resolve-for-agent": () =>
			(resolveModelForAgentProcedure as any)._handler({
				input: { taskType, apiKey: "example-key" },
			}),
		"resolve-model": () =>
			(resolveModelProcedure as any)._handler({
				input: { taskType, complexity },
				context: apiContext,
			}),
		// The oracle predates the model-fit display fields, which describe a
		// model rather than which model resolves, so they are left out here.
		Settings: async () =>
			(
				await (getTaskDefaultsProcedure as any)._handler({
					input: {},
					context: apiContext,
				})
			).map(
				({
					model: {
						suitableForTasks,
						capabilities,
						inputCostPer1M,
						outputCostPer1M,
						...model
					},
					...rest
				}: any) => ({ ...rest, model }),
			),
	};
}

describe.each([
	["own-row", "ANTHROPIC_DIRECT", true, true],
	["fallback with preferred mapping", "DATABRICKS", false, true],
	["fallback without preferred mapping", "OPENROUTER", false, false],
	["agent has no own TOOL_CALLING row", "TOGETHER_AI", false, false],
	["nothing found", "OPENROUTER", false, false],
] as const)("template property: %s", (scenario, provider, own, mapped) => {
	it.each(["SIMPLE", "MEDIUM", "COMPLEX"] as const)(
		"matches base before and after template edits at %s complexity",
		async (complexity) => {
			const old = model(
				"example-old",
				mapped ? [provider, "ANTHROPIC_DIRECT"] : ["ANTHROPIC_DIRECT"],
			);
			const next = model("example-new", [provider]);
			state.models = [old, next];
			state.rows =
				scenario === "nothing found"
					? []
					: TEXT_TASK_TYPES.filter((t) => t !== "EVAL").map((t) =>
							row(t, own ? provider : "ANTHROPIC_DIRECT", old),
						);
			state.connection = {
				provider,
				configId: "example-connection",
				apiKey: "example-encrypted",
				taskDefaultsSnapshot: undefined,
			};
			const { scoped, unscoped, expected } = oracle.cases[scenario];
			const captured = await captureTaskDefaultsSnapshot(provider);
			expect(captured.scoped).toEqual(scoped);
			expect(captured.unscoped).toEqual(unscoped);
			state.connection.taskDefaultsSnapshot = captured;
			for (const phase of ["captured", "mutated"]) {
				if (phase === "mutated") {
					// Changes an occupied slot, adds the previously empty EVAL slot,
					// and deletes SIMPLE. Catalog models and preferences stay fixed.
					state.rows = TEXT_TASK_TYPES.filter(
						(t) => t !== "SIMPLE",
					).map((t) => row(t, provider, next));
				}
				for (const task of TEXT_TASK_TYPES) {
					for (const [entry, fn] of Object.entries(
						entries(task, complexity),
					)) {
						expect
							.soft(
								await outcome(fn),
								`${phase}: ${task}/${entry}`,
							)
							.toEqual(
								oracle.outcomes[
									expected[
										entry === "Settings"
											? "CHAT/Settings"
											: `${task}/${entry}`
									]
								],
							);
					}
				}
			}
			if (provider === "TOGETHER_AI") {
				expect(
					oracle.outcomes[expected["TOOL_CALLING/resolve-for-agent"]],
				).toMatchObject({ code: "NOT_FOUND" });
			}
		},
	);
});
it.each(["connection without snapshot", "platform gateway"])(
	"%s follows the live template",
	async (kind) => {
		const provider = "VERCEL_GATEWAY";
		state.connection = {
			provider,
			configId: kind === "platform gateway" ? null : "example-connection",
			apiKey: "example-key",
		};
		state.models = [
			model("example-old", [provider]),
			model("example-new", [provider]),
		];
		state.rows = [row("CHAT", provider, state.models[0])];
		const before = new Map<string, unknown>();
		for (const [entry, fn] of Object.entries(entries("CHAT", "MEDIUM"))) {
			before.set(entry, await outcome(fn));
		}
		state.rows = [row("CHAT", provider, state.models[1])];
		for (const [entry, fn] of Object.entries(entries("CHAT", "MEDIUM"))) {
			expect(await outcome(fn), entry).not.toEqual(before.get(entry));
		}
	},
);

// These use the real selector, template seam and capture helper on both sides of the switch.
it.each([
	"switch",
	"re-default",
	"stale cached template",
	"duplicate default flags",
])(
	"previews a %s with the serving snapshots and agrees with post-switch resolution",
	async (operation) => {
		const redefault = operation === "re-default";
		const currentProvider = "OPENAI_DIRECT";
		const targetProvider = redefault ? currentProvider : "ANTHROPIC_DIRECT";
		const oldCurrent = model("example-current-frozen", [currentProvider]);
		const oldTarget = model("example-target-frozen", ["ANTHROPIC_DIRECT"]);
		const live = model("example-live", [
			currentProvider,
			"ANTHROPIC_DIRECT",
		]);
		state.models = [oldCurrent, oldTarget, live];
		const connection = (provider: string, isDefault: boolean) => ({
			id: `example-${provider}`,
			configId: `example-${provider}`,
			provider,
			organizationId: context.organizationId,
			isDefault,
			enabled: true,
			purpose: "ALL",
			source: "organization",
			apiKey: "example-key",
			encryptedApiKey: "example-key",
			taskDefaultsSnapshot: undefined as unknown,
		});
		const current = connection(currentProvider, true);
		const target = connection("ANTHROPIC_DIRECT", false);
		state.connections = [current, target];
		state.rows = TEXT_TASK_TYPES.map((task) =>
			row(task, currentProvider, oldCurrent),
		);
		current.taskDefaultsSnapshot =
			await captureTaskDefaultsSnapshot(currentProvider);
		state.rows = TEXT_TASK_TYPES.map((task) =>
			row(task, "ANTHROPIC_DIRECT", oldTarget),
		);
		target.taskDefaultsSnapshot =
			await captureTaskDefaultsSnapshot("ANTHROPIC_DIRECT");
		if (operation === "stale cached template") {
			state.useTaskCache = true;
			// Warm the real hour-long live-template cache with A before the seed changes to B.
			for (const task of TEXT_TASK_TYPES) {
				expect(
					(
						await models.getTaskDefaultModel(
							task,
							"MEDIUM",
							"ANTHROPIC_DIRECT",
						)
					)?.canonicalName,
				).toBe(oldTarget.canonicalName);
			}
		}
		if (operation === "duplicate default flags") {
			target.isDefault = true;
			expect(state.connections.find((c) => c.isDefault)).toBe(current);
		}
		state.rows = [currentProvider, "ANTHROPIC_DIRECT"].flatMap((provider) =>
			TEXT_TASK_TYPES.map((task) => row(task, provider, live)),
		);
		if (operation === "stale cached template") {
			expect(
				(
					await models.getTaskDefaultModel(
						"CHAT",
						"MEDIUM",
						"ANTHROPIC_DIRECT",
					)
				)?.canonicalName,
			).toBe(oldTarget.canonicalName);
			expect(
				(
					await models.getTaskDefaultModelUncached(
						"CHAT",
						"MEDIUM",
						"ANTHROPIC_DIRECT",
					)
				)?.canonicalName,
			).toBe(live.canonicalName);
		}
		let preferences =
			operation === "duplicate default flags"
				? [
						{
							id: "example-saved-choice",
							taskType: "CHAT",
							provider: target.provider,
							modelId: oldTarget.id,
							model: oldTarget,
						},
					]
				: [];
		db.organizationModelPreference.findMany.mockImplementation(
			async () => preferences,
		);
		db.organizationModelPreference.findUnique.mockImplementation(
			async ({ where }) =>
				preferences.find(
					(p) =>
						p.provider ===
							where.organizationId_taskType_provider.provider &&
						p.taskType ===
							where.organizationId_taskType_provider.taskType,
				) ?? null,
		);
		db.organizationModelPreference.deleteMany.mockImplementation(
			async () => {
				expect(state.locked).toBe(true);
				const count = preferences.length;
				preferences = [];
				return { count };
			},
		);
		db.cloudProviderConfig.findMany.mockImplementation(
			async () => state.connections,
		);
		db.cloudProviderConfig.findFirst.mockImplementation(
			async ({ where }) => {
				if (where.isEmbeddingProvider) {
					return (
						state.connections.find(
							(c) => c.isEmbeddingProvider && c.enabled,
						) ?? null
					);
				}
				if (where.provider) {
					return (
						state.connections.find(
							(c) => c.provider === where.provider,
						) ?? null
					);
				}
				return state.connections.find((c) => c.isDefault) ?? null;
			},
		);
		db.cloudProviderConfig.updateMany.mockImplementation(
			async ({ where, data }) => {
				expect(state.locked).toBe(true);
				for (const c of state.connections) {
					if (
						(!where.provider || c.provider === where.provider) &&
						(where.isDefault === undefined ||
							c.isDefault === where.isDefault)
					) {
						Object.assign(c, data);
					}
				}
				return { count: 1 };
			},
		);
		db.$transaction.mockImplementation(async (fn) => {
			state.locked = false;
			return fn({
				...db,
				$queryRaw: async (sql: TemplateStringsArray, owner: string) => {
					expect(state.locked).toBe(false);
					expect(sql.join("?").replace(/\s+/g, " ").trim()).toBe(
						'SELECT id FROM "cloud_provider_config" WHERE "organizationId" = ? ORDER BY id FOR NO KEY UPDATE',
					);
					expect(owner).toBe(context.organizationId);
					state.locked = true;
					return [];
				},
			});
		});
		const params = { ...context, targetProvider };
		const preview = await previewDefaultProviderSwitch(params);
		for (const task of preview.textTasks) {
			expect(task.currentModel?.canonicalName).toBe(
				oldCurrent.canonicalName,
			);
			expect(task.targetModel?.canonicalName).toBe(
				redefault ? oldCurrent.canonicalName : live.canonicalName,
			);
		}
		const applied = await (setDefaultProviderProcedure as any)._handler({
			input: {
				organizationId: context.organizationId,
				provider: targetProvider,
			},
			context: apiContext,
		});
		if (operation === "duplicate default flags") {
			expect(applied.preferencesCleared).toBe(1);
			expect(preview.savedTextChoiceCount).toBe(1);
			expect(preferences).toEqual([]);
		}
		if (operation === "stale cached template") {
			// The snapshot bypasses the stale cache; preview/apply do not need to invalidate it.
			expect(
				(
					await models.getTaskDefaultModel(
						"CHAT",
						"MEDIUM",
						"ANTHROPIC_DIRECT",
					)
				)?.canonicalName,
			).toBe(oldTarget.canonicalName);
		}
		const serving = state.connections.find((c) => c.isDefault);
		expect(serving?.taskDefaultsSnapshot.scoped.CHAT).toBe(
			redefault ? oldCurrent.canonicalName : live.canonicalName,
		);
		for (const task of preview.textTasks) {
			const after = await selectModelDynamic(
				{ taskType: task.taskType, preferredProvider: targetProvider },
				context,
			);
			expect(after.canonicalName).toBe(task.targetModel?.canonicalName);
		}
	},
);

it("shows the runtime embedding fallback when the documents provider has no template", async () => {
	const embedding = {
		...model("example-embedding-fallback", [
			"OPENAI_DIRECT",
			"TOGETHER_AI",
		]),
		capabilities: ["EMBEDDING"],
	};
	state.models = [embedding];
	state.rows = [row("EMBEDDING", "OPENAI_DIRECT", embedding)];
	state.connection = {
		provider: "TOGETHER_AI",
		source: "organization",
		configId: "example-documents",
	};
	state.documentsProvider = "TOGETHER_AI";
	const runtime = await selectModelDynamic(
		{
			taskType: "EMBEDDING",
			preferredProvider: "TOGETHER_AI",
			ignorePreferences: true,
		},
		context,
	);
	const defaults = await (getTaskDefaultsProcedure as any)._handler({
		input: {},
		context: apiContext,
	});
	expect(
		defaults.filter((entry: any) => entry.taskType === "EMBEDDING"),
	).toEqual([
		expect.objectContaining({
			provider: "TOGETHER_AI",
			model: expect.objectContaining({ id: runtime.modelId }),
		}),
	]);
});

it("does not pin an arbitrary mapped embedding model when runtime rejects its fallback", async () => {
	const fallback = {
		...model("example-unmapped-default", ["OPENAI_DIRECT"]),
		capabilities: ["EMBEDDING"],
	};
	const mapped = {
		...model("example-mapped-embedding", ["TOGETHER_AI"]),
		capabilities: ["EMBEDDING"],
	};
	state.models = [fallback, mapped];
	state.rows = [row("EMBEDDING", "OPENAI_DIRECT", fallback)];
	state.connection = {
		provider: "TOGETHER_AI",
		source: "organization",
		configId: "example-outgoing",
	};
	db.aiModel.findFirst.mockResolvedValue(mapped as never);
	await expect(
		selectModelDynamic(
			{
				taskType: "EMBEDDING",
				preferredProvider: "TOGETHER_AI",
				ignorePreferences: true,
			},
			context,
		),
	).rejects.toThrow("does not have a model mapping");
	const { planDefaultSwitchEmbeddings } = await import(
		"../../../lib/default-provider-switch"
	);
	const plan = await planDefaultSwitchEmbeddings({
		...context,
		currentProvider: "TOGETHER_AI",
		targetProvider: "ANTHROPIC_DIRECT",
		documentsProvider: null,
		currentEmbeddingConfig: state.connection,
	});
	expect(plan.pin).toBeNull();
});

it("does not display a computed embeddings default that runtime rejects", async () => {
	const fallback = {
		...model("example-unmapped-default", ["OPENAI_DIRECT"]),
		capabilities: ["EMBEDDING"],
	};
	const mapped = {
		...model("example-mapped-embedding", ["TOGETHER_AI"]),
		capabilities: ["EMBEDDING"],
	};
	state.models = [fallback, mapped];
	state.rows = [row("EMBEDDING", "OPENAI_DIRECT", fallback)];
	state.connection = {
		provider: "TOGETHER_AI",
		source: "organization",
		configId: "example-outgoing",
	};
	const defaults = await (getTaskDefaultsProcedure as any)._handler({
		input: {},
		context: apiContext,
	});
	expect(
		defaults.filter((entry: any) => entry.taskType === "EMBEDDING"),
	).toEqual([]);
});

it("pins an outgoing provider covered only by a saved EMBEDDING choice", async () => {
	const embedding = {
		...model("example-saved-embedding", ["OPENAI_DIRECT"]),
		capabilities: ["EMBEDDING"],
	};
	state.models = [embedding];
	state.rows = [];
	state.connection = {
		provider: "OPENAI_DIRECT",
		source: "organization",
		configId: "example-outgoing",
	};
	db.organizationModelPreference.findUnique.mockResolvedValue({
		modelId: embedding.id,
		model: embedding,
	} as never);
	const { planDefaultSwitchEmbeddings } = await import(
		"../../../lib/default-provider-switch"
	);
	const plan = await planDefaultSwitchEmbeddings({
		...context,
		currentProvider: "OPENAI_DIRECT",
		targetProvider: "ANTHROPIC_DIRECT",
		documentsProvider: null,
		currentEmbeddingConfig: state.connection,
	});
	expect(plan).toMatchObject({
		documentsProvider: "OPENAI_DIRECT",
		pin: { id: "example-outgoing", provider: "OPENAI_DIRECT" },
	});
});

it.each(["OPENAI_DIRECT", "VERCEL_GATEWAY"])(
	"matches company context’s stamped embedding identity (%s)",
	async (provider) => {
		const embedding = {
			...model("example-embedding", [provider]),
			capabilities: ["EMBEDDING"],
		};
		state.models = [embedding];
		state.rows = [row("EMBEDDING", provider, embedding)];
		state.connection = {
			provider,
			source: "organization",
			configId: "example-key",
			apiKey: "example-key",
		};
		const { resolveOrganizationEmbedding } = await import(
			"../../../lib/organization-embedding-resolution"
		);
		const { resolveCompanyEmbeddingModel } = await import(
			"../../../../../../rag/lib/company-contexts/model"
		);
		const settings = await resolveOrganizationEmbedding(context);
		const stamped = await resolveCompanyEmbeddingModel(context);
		expect(settings.identity).not.toBeNull();
		expect(settings.identity).toBe(stamped.identity);
	},
);
