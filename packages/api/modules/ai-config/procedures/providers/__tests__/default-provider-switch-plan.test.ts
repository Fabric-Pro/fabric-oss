import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	rows: [] as Array<Record<string, unknown>>,
	templates: [] as Array<Record<string, unknown>>,
	preferences: [] as Array<{
		id: string;
		taskType: string;
		provider: string;
		modelId: string | null;
	}>,
	membership: vi.fn(),
	displayFailure: false,
	update: vi.fn(),
	locked: false,
	catalogMapping: false,
	systemOverride: null as null | Record<string, unknown>,
	onLock: () => {},
}));

function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
	return Object.entries(where).every(([key, value]) =>
		typeof value === "object" && value !== null
			? "not" in value
				? row[key] !== value.not
				: true
			: row[key] === value,
	);
}
function embeddingModel({ where }: { where: Record<string, any> }) {
	return state.catalogMapping &&
		where.isActive === true &&
		where.deprecatedAt === null &&
		where.capabilities?.has === "EMBEDDING" &&
		where.providerMappings?.some?.isAvailable === true &&
		["OPENAI_DIRECT", "VERCEL_GATEWAY"].includes(
			where.providerMappings.some.provider,
		)
		? { id: "example-embedding" }
		: null;
}
function templateRows({ where }: { where: Record<string, unknown> }) {
	return Promise.resolve(
		state.templates.filter((row) => matches(row, where)).slice(0, 1),
	);
}
vi.mock("../../../../../../database/prisma/queries/ai-credits", () => ({}));
vi.mock("../../../../../../database/prisma/client", () => ({
	db: {
		aiTaskModelDefault: { findMany: templateRows },
		cloudProviderConfig: {
			findFirst: async ({ where }: { where: Record<string, unknown> }) =>
				state.rows.find((row) => matches(row, where)) ?? null,
		},
		userCloudProviderConfig: { findFirst: async () => null },
	},
}));
vi.mock("@repo/config", () => ({
	config: {
		ai: { enableGateway: false, gatewayApiKey: null, enabledProviders: [] },
	},
}));
vi.mock("@repo/database", async () => {
	const resolvers = await vi.importActual<
		typeof import("../../../../../../database/prisma/queries/ai-gateway")
	>("../../../../../../database/prisma/queries/ai-gateway");
	return {
		...resolvers,
		getSystemAiProviderApiKey: async (
			args: Parameters<typeof resolvers.getSystemAiProviderApiKey>[0],
		) => state.systemOverride ?? resolvers.getSystemAiProviderApiKey(args),
		getTaskDefaultModelUncached: (
			await vi.importActual<
				typeof import("../../../../../../database/prisma/queries/ai-models")
			>("../../../../../../database/prisma/queries/ai-models")
		).getTaskDefaultModelUncached,
		lockTenantProviderConnections: (
			await import(
				"../../../../../../database/prisma/queries/provider-write-locks"
			)
		).lockTenantProviderConnections,
		captureTaskDefaultsSnapshot: (
			await import(
				"../../../../../../database/prisma/queries/task-default-snapshots"
			)
		).captureTaskDefaultsSnapshot,
		taskDefaultsSnapshotMutation: (
			await import(
				"../../../../../../database/prisma/queries/task-default-snapshots"
			)
		).taskDefaultsSnapshotMutation,
		db: {
			aiTaskModelDefault: { findMany: templateRows },
			aiModel: {
				findFirst: async (args: Parameters<typeof embeddingModel>[0]) =>
					embeddingModel(args),
			},
			cloudProviderConfig: {
				findMany: async ({
					where,
				}: {
					where: Record<string, unknown>;
				}) => state.rows.filter((row) => matches(row, where)),
				findFirst: async ({
					where,
				}: {
					where: Record<string, unknown>;
				}) => state.rows.find((row) => matches(row, where)) ?? null,
			},
			organizationModelPreference: {
				findMany: async () => state.preferences,
				deleteMany: async ({
					where,
				}: {
					where: {
						taskType: { notIn: string[] };
						provider: { not: string };
					};
				}) => {
					const before = state.preferences.length;
					state.preferences = state.preferences.filter(
						(row) =>
							where.taskType.notIn.includes(row.taskType) ||
							row.provider === where.provider.not,
					);
					return { count: before - state.preferences.length };
				},
			},
			$transaction: async (fn: (tx: unknown) => unknown) => {
				const before = [...state.preferences];
				const beforeRows = state.rows.map((row) => ({ ...row }));
				state.locked = false;
				try {
					return await fn({
						aiModel: {
							findFirst: async (
								args: Parameters<typeof embeddingModel>[0],
							) => embeddingModel(args),
						},
						aiTaskModelDefault: {
							findMany: (args: {
								where: Record<string, unknown>;
							}) => {
								expect(state.locked).toBe(true);
								return templateRows(args);
							},
						},
						$queryRaw: async (
							strings: TemplateStringsArray,
							owner: string,
						) => {
							expect(state.locked).toBe(false);
							expect(
								strings.join("?").replace(/\s+/g, " ").trim(),
							).toBe(
								'SELECT id FROM "cloud_provider_config" WHERE "organizationId" = ? ORDER BY id FOR NO KEY UPDATE',
							);
							expect(owner).toBe("example-org");
							state.locked = true;
							state.onLock();
							return [];
						},
						cloudProviderConfig: {
							findFirst: async ({
								where,
							}: {
								where: Record<string, unknown>;
							}) => {
								expect(state.locked).toBe(true);
								return (
									state.rows.find((row) =>
										matches(row, where),
									) ?? null
								);
							},
							updateMany: async (...args: unknown[]) => {
								expect(state.locked).toBe(true);
								return state.update(...args);
							},
						},
						organizationModelPreference: {
							deleteMany: async ({
								where,
							}: {
								where: {
									taskType: { notIn: string[] };
									provider: { not: string };
								};
							}) => {
								expect(state.locked).toBe(true);
								const previous = state.preferences.length;
								state.preferences = state.preferences.filter(
									(row) =>
										where.taskType.notIn.includes(
											row.taskType,
										) ||
										row.provider === where.provider.not,
								);
								return {
									count: previous - state.preferences.length,
								};
							},
						},
					});
				} catch (error) {
					state.preferences = before;
					state.rows = beforeRows;
					throw error;
				}
			},
		},
		ALL_EMBEDDING_CAPABLE_PROVIDERS: [],
		canProviderSupportEmbeddings: () => true,
		getProviderDisplayName: (p: string) => p,
	};
});
vi.mock("@repo/ai/model-selector", () => ({
	selectModelDynamic: async (options: {
		taskType: string;
		preferredProvider: string;
		ignorePreferences?: boolean;
		providerConfig?: {
			taskDefaultsSnapshot?: { scoped: Record<string, string | null> };
		};
	}) => {
		if (state.displayFailure) {
			throw new Error("Example display catalog unavailable");
		}
		const saved = options.ignorePreferences
			? undefined
			: state.preferences.find(
					(p) =>
						p.provider === options.preferredProvider &&
						p.taskType === options.taskType,
				);
		if (
			options.taskType === "EMBEDDING" &&
			!saved?.modelId &&
			!state.catalogMapping &&
			!state.templates.some(
				(row) =>
					row.taskType === "EMBEDDING" &&
					row.provider === options.preferredProvider,
			)
		) {
			throw new Error(
				"[ModelSelector] No model configured for embeddings",
			);
		}

		const canonicalName =
			saved?.modelId ??
			options.providerConfig?.taskDefaultsSnapshot?.scoped[
				options.taskType
			] ??
			(options.taskType === "EMBEDDING"
				? "example-shared-embedding"
				: `example-${options.preferredProvider}-${options.taskType}`);
		return {
			modelId: canonicalName,
			canonicalName,
			displayName: canonicalName,
		};
	},
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ encryptApiKey: (s: string) => s }));
vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: (...args: unknown[]) => state.membership(...args),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chain,
		requirePermission: () => ({}),
		requireInputOrgPermission: () => ({}),
		Permissions: { ORG_AI_CONFIG_EDIT: "edit" },
		resolveOrganizationId: (id: string) => id,
	};
});

import * as procedures from "../upsert";

type Plan = Awaited<
	ReturnType<
		typeof import("../../../lib/default-provider-switch").previewDefaultProviderSwitch
	>
>;
type Handler<T = Plan> = {
	_handler: (args: { input: unknown; context: unknown }) => Promise<T>;
};
const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org" },
};
const input = { organizationId: "example-org", provider: "ANTHROPIC_DIRECT" };
const preview = () =>
	(
		procedures as unknown as Record<string, Handler>
	).previewSetDefaultProviderProcedure._handler({ input, context });
const apply = () =>
	(
		procedures.setDefaultProviderProcedure as unknown as Handler<{
			success: boolean;
			preferencesCleared: number;
		}>
	)._handler({ input, context });
beforeEach(() => {
	vi.clearAllMocks();
	state.displayFailure = false;
	state.catalogMapping = false;
	state.systemOverride = null;
	state.onLock = () => {};
	state.update.mockImplementation(async ({ where, data }) => {
		let count = 0;
		for (const row of state.rows) {
			if (matches(row, where)) {
				Object.assign(row, data);
				count++;
			}
		}
		return { count };
	});
	state.rows = [
		"OPENAI_DIRECT",
		"ANTHROPIC_DIRECT",
		"VERCEL_GATEWAY",
		"GROQ",
		"MISTRAL_AI",
		"OPENAI_CHATGPT_PLAN",
	].map((provider) => ({
		id: `example-${provider}`,
		organizationId: "example-org",
		provider,
		isDefault: provider === "OPENAI_DIRECT",
		enabled: provider !== "GROQ",
		purpose: provider === "MISTRAL_AI" ? "EMBEDDINGS_ONLY" : "ALL",
		encryptedApiKey: "encrypted-example-key",
		clientId: null,
		encryptedClientSecret: null,
		config: {},
		isEmbeddingProvider: false,
	}));
	state.membership.mockImplementation(async (_user, org) =>
		org === "example-org" ? { role: "admin" } : null,
	);

	state.templates = state.rows.flatMap((row) =>
		["SIMPLE", "COMPLEX", "REASONING", "CHAT", "TOOL_CALLING", "EVAL"].map(
			(taskType) => ({
				taskType,
				complexity: "MEDIUM",
				provider: row.provider,
				model: { canonicalName: `example-${row.provider}-${taskType}` },
			}),
		),
	);

	state.preferences = [
		"SIMPLE",
		"COMPLEX",
		"REASONING",
		"CHAT",
		"TOOL_CALLING",
		"EVAL",
		"EMBEDDING",
		"IMAGE",
		"AUDIO",
		"DECISION",
	].map((taskType) => ({
		id: `example-${taskType}`,
		taskType,
		provider:
			taskType === "DECISION" || taskType === "IMAGE"
				? "VERCEL_GATEWAY"
				: "OPENAI_DIRECT",
		modelId:
			taskType === "DECISION"
				? null
				: taskType === "EMBEDDING"
					? "example-old-embedding"
					: "example-saved",
	}));
	state.preferences.push({
		id: "example-plan",
		taskType: "CHAT",
		provider: "OPENAI_CHATGPT_PLAN",
		modelId: "example-plan-model",
	});
});

// Deleting the planner, changing its credential-aware documents rule, or applying
// a different delete predicate must break these independently specified outcomes.
it.each([
	{
		name: "no documents provider",
		documents: null,
		current: "OPENAI_DIRECT",
		keepEmbedding: true,
		changed: false,
	},
	{
		name: "distinct usable documents provider",
		documents: "VERCEL_GATEWAY",
		current: "OPENAI_DIRECT",
		keepEmbedding: true,
		changed: false,
	},
	{
		name: "documents provider equals target",
		documents: "ANTHROPIC_DIRECT",
		current: "OPENAI_DIRECT",
		keepEmbedding: true,
		changed: false,
	},
	{
		name: "documents target keeps its saved embedding model",
		documents: "ANTHROPIC_DIRECT",
		current: "OPENAI_DIRECT",
		keepEmbedding: true,
		changed: false,
	},
	{
		name: "documents row without usable credentials",
		documents: null,
		current: "OPENAI_DIRECT",
		keepEmbedding: false,
		changed: false,
	},
	{
		name: "no current default",
		documents: null,
		current: null,
		keepEmbedding: false,
		changed: false,
	},
	{
		name: "current default without usable credentials",
		documents: null,
		current: null,
		keepEmbedding: false,
		changed: false,
	},
	{
		name: "different providers resolve same embedding model",
		documents: null,
		current: "OPENAI_DIRECT",
		keepEmbedding: true,
		changed: false,
	},
])(
	"preview matches apply: $name",
	async ({ name, documents, current, keepEmbedding, changed }) => {
		if (!current) {
			state.rows[0].isDefault =
				name === "current default without usable credentials";
		}
		if (name === "current default without usable credentials") {
			state.rows[0].encryptedApiKey = null;
		}
		if (documents) {
			const row = state.rows.find((row) => row.provider === documents);
			if (!row) {
				throw new Error("Missing documents fixture");
			}
			row.isEmbeddingProvider = true;
		}
		if (name === "documents row without usable credentials") {
			const preference = state.preferences.find(
				(p) => p.taskType === "EMBEDDING",
			);
			if (!preference) {
				throw new Error("Missing embedding fixture");
			}
			preference.provider = "COHERE";
			state.rows.push({
				id: "example-unusable-documents",
				organizationId: "example-org",
				provider: "COHERE",
				enabled: true,
				purpose: "EMBEDDINGS_ONLY",
				encryptedApiKey: null,
				clientId: null,
				encryptedClientSecret: null,
				config: {},
				isEmbeddingProvider: true,
				isDefault: false,
			});
		}
		if (
			documents === "VERCEL_GATEWAY" ||
			name === "documents target keeps its saved embedding model"
		) {
			const row = state.preferences.find(
				(p) => p.taskType === "EMBEDDING",
			);
			if (!row) {
				throw new Error("Missing embedding fixture");
			}
			row.provider = documents as string;
		}
		if (name === "different providers resolve same embedding model") {
			state.templates.push({
				taskType: "EMBEDDING",
				complexity: "MEDIUM",
				provider: "ANTHROPIC_DIRECT",
				model: { canonicalName: "example-shared-embedding" },
			});
			const row = state.preferences.find(
				(p) => p.taskType === "EMBEDDING",
			);
			if (!row) {
				throw new Error("Missing embedding fixture");
			}
			row.modelId = "example-shared-embedding";
		}
		const plan = await preview();
		expect(
			plan.validProviders.map((p: { provider: string }) => p.provider),
		).toEqual(
			name === "current default without usable credentials"
				? ["ANTHROPIC_DIRECT", "VERCEL_GATEWAY"]
				: ["OPENAI_DIRECT", "ANTHROPIC_DIRECT", "VERCEL_GATEWAY"],
		);
		expect(plan.savedTextChoiceCount).toBe(6);
		expect(plan.preservesEmbedding).toBe(keepEmbedding);
		expect(plan.embeddingsModelChanged).toBe(changed);
		expect(plan.textTasks).toHaveLength(6);
		expect(
			plan.textTasks.find(
				(r: { taskType: string }) => r.taskType === "CHAT",
			),
		).toMatchObject({
			currentModel: current ? { canonicalName: "example-saved" } : null,
			targetModel: { canonicalName: "example-ANTHROPIC_DIRECT-CHAT" },
		});
		const removed = plan.removedPreferences
			.map((p: { id: string }) => p.id)
			.sort();
		const kept = plan.keptPreferences
			.map((p: { id: string }) => p.id)
			.sort();
		expect(kept).toEqual(
			[
				"example-AUDIO",
				"example-DECISION",
				...(keepEmbedding ? ["example-EMBEDDING"] : []),
				"example-IMAGE",
				"example-plan",
			].sort(),
		);
		const before = state.preferences.map((p) => p.id);
		const result = await apply();
		expect(state.preferences.map((p) => p.id).sort()).toEqual(kept);
		expect(
			before
				.filter((id) => !state.preferences.some((p) => p.id === id))
				.sort(),
		).toEqual(removed);
		expect(result.preferencesCleared).toBe(keepEmbedding ? 6 : 7);
	},
);
it("does not clear or warn when the default is unchanged", async () => {
	state.rows[0].isDefault = false;
	state.rows[1].isDefault = true;
	const plan = await preview();
	expect(plan.removedPreferences).toEqual([]);
	expect(plan.embeddingsModelChanged).toBe(false);
	expect((await apply()).preferencesCleared).toBe(0);
});
it.each(["preview", "apply"])(
	"%s refuses a non-admin and another organization",
	async (which) => {
		const run = () => (which === "preview" ? preview() : apply());
		state.membership.mockResolvedValue(null);
		await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
		state.membership.mockImplementation(async (_user, org) =>
			org === "example-org" ? { role: "admin" } : null,
		);
		const procedure =
			which === "preview"
				? (procedures as unknown as Record<string, Handler>)
						.previewSetDefaultProviderProcedure
				: (procedures.setDefaultProviderProcedure as unknown as Handler);
		await expect(
			procedure._handler({
				context,
				input: { ...input, organizationId: "example-other-org" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(state.update).not.toHaveBeenCalled();
	},
);
it.each([
	"GROQ",
	"MISTRAL_AI",
	"COHERE",
	"OPENAI_CHATGPT_PLAN",
	"INVALID_PROVIDER",
])(
	"refuses invalid or unusable target %s in preview and apply",
	async (provider) => {
		state.rows.push({
			id: "example-unusable-target",
			organizationId: "example-org",
			provider: "COHERE",
			enabled: true,
			purpose: "ALL",
			encryptedApiKey: null,
			clientId: null,
			encryptedClientSecret: null,
			config: {},
			isDefault: false,
		});
		for (const name of [
			"previewSetDefaultProviderProcedure",
			"setDefaultProviderProcedure",
		]) {
			const procedure = (
				procedures as unknown as Record<string, Handler>
			)[name];
			await expect(
				procedure._handler({ input: { ...input, provider }, context }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(state.update).not.toHaveBeenCalled();
	},
);

it("does not switch when embedding resolution fails unexpectedly", async () => {
	state.displayFailure = true;
	const before = [...state.preferences];
	await expect(preview()).rejects.toThrow(
		"Example display catalog unavailable",
	);
	await expect(apply()).rejects.toThrow(
		"Example display catalog unavailable",
	);
	expect(state.preferences).toEqual(before);
	expect(state.update).not.toHaveBeenCalled();
});

it("rolls back preference deletion when the default flag update fails", async () => {
	const before = [...state.preferences];
	state.update.mockRejectedValueOnce(
		new Error("Example default update failed"),
	);
	await expect(apply()).rejects.toThrow("Example default update failed");
	expect(state.preferences).toEqual(before);
});

it.each(["default", "mapping"])(
	"pins the outgoing embedding provider using catalog %s coverage",
	async (coverage) => {
		if (coverage === "default") {
			state.templates.push({
				taskType: "EMBEDDING",
				complexity: "MEDIUM",
				provider: "OPENAI_DIRECT",
				model: { canonicalName: "example-embedding" },
			});
		} else {
			state.catalogMapping = true;
		}
		const plan = await preview();
		expect(plan).toMatchObject({
			preservesEmbedding: true,
			documentsProvider: "OPENAI_DIRECT",
			embeddingsModelChanged: false,
		});
		expect(plan.currentEmbeddingModel).toEqual(plan.targetEmbeddingModel);
		expect(plan.keptPreferences.map((row) => row.taskType)).toContain(
			"EMBEDDING",
		);
		expect(state.update).not.toHaveBeenCalled();
		await apply();
		expect(state.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organizationId: "example-org",
					id: "example-OPENAI_DIRECT",
				}),
				data: { isEmbeddingProvider: true },
			}),
		);
		expect(state.preferences.map((row) => row.taskType)).toContain(
			"EMBEDDING",
		);
	},
);

it("does not pin when the organization has no usable outgoing default", async () => {
	state.catalogMapping = true;
	state.systemOverride = {
		provider: "VERCEL_GATEWAY",
		source: null,
		configId: null,
	};
	state.rows[0].encryptedApiKey = null;
	const plan = await preview();
	expect(plan.preservesEmbedding).toBe(false);
	expect(plan.documentsProvider).toBeNull();
	await apply();
	expect(
		state.update.mock.calls.some(([args]) => args.data.isEmbeddingProvider),
	).toBe(false);
});

it("keeps existing behavior when the outgoing default has no embedding catalog coverage", async () => {
	state.rows[0].isDefault = false;
	state.rows[1].isDefault = true;
	const request = { ...input, provider: "VERCEL_GATEWAY" };
	const plan = await (
		procedures as unknown as Record<string, Handler>
	).previewSetDefaultProviderProcedure._handler({ input: request, context });
	expect(plan.preservesEmbedding).toBe(false);
	expect(plan.documentsProvider).toBeNull();
	await (
		procedures.setDefaultProviderProcedure as unknown as Handler
	)._handler({ input: request, context });
	expect(state.rows.some((row) => row.isEmbeddingProvider)).toBe(false);
});

it("rejects a changed outgoing default under lock before writes", async () => {
	state.catalogMapping = true;
	expect((await preview()).documentsProvider).toBe("OPENAI_DIRECT");
	state.onLock = () => {
		state.rows[0].isDefault = false;
		state.rows[2].isDefault = true;
	};
	await expect(apply()).rejects.toMatchObject({ code: "CONFLICT" });
	expect(state.update).not.toHaveBeenCalled();
});

it("rejects documents routing that changed after the pre-read", async () => {
	state.catalogMapping = true;
	state.onLock = () => {
		state.rows[2].isEmbeddingProvider = true;
	};
	await expect(apply()).rejects.toMatchObject({ code: "CONFLICT" });
	expect(state.update).not.toHaveBeenCalled();
	expect(state.preferences.map((row) => row.taskType)).toContain("EMBEDDING");
});

it("rolls back the embedding pin and preference deletion when the default flip fails", async () => {
	state.catalogMapping = true;
	const write = state.update.getMockImplementation();
	const before = state.rows.map((row) => ({ ...row }));
	const preferences = [...state.preferences];
	state.update.mockImplementation(async (args) => {
		if (args.data.isDefault === true) {
			throw new Error("Example default flip failed");
		}
		return write?.(args);
	});
	await expect(apply()).rejects.toThrow("Example default flip failed");
	expect(state.rows).toEqual(before);
	expect(state.preferences).toEqual(preferences);
	const { recordAuditFromRequest } = await import("../../../../../lib/audit");
	expect(recordAuditFromRequest).not.toHaveBeenCalled();
});

it("fails closed when the outgoing embedding flag write misses", async () => {
	state.catalogMapping = true;
	const write = state.update.getMockImplementation();
	const before = [...state.preferences];
	state.update.mockImplementation(async (args) =>
		args.data.isEmbeddingProvider === true ? { count: 0 } : write?.(args),
	);
	await expect(apply()).rejects.toMatchObject({ code: "CONFLICT" });
	expect(state.preferences).toEqual(before);
	expect(state.rows.some((row) => row.isEmbeddingProvider)).toBe(false);
});

it.each(["disabled", "missing credentials"])(
	"protects a flagged embeddings-only row that is %s",
	async (condition) => {
		state.catalogMapping = true;
		state.rows.push({
			id: "example-protected-documents",
			organizationId: "example-org",
			provider: "COHERE",
			isEmbeddingProvider: true,
			isDefault: false,
			purpose: "EMBEDDINGS_ONLY",
			enabled: condition !== "disabled",
			encryptedApiKey:
				condition === "missing credentials" ? null : "example-key",
			config: {},
		});
		await expect(preview()).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(apply()).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			state.rows.find(
				(entry) => entry.id === "example-protected-documents",
			)?.isEmbeddingProvider,
		).toBe(true);
		expect(state.rows[0].isEmbeddingProvider).toBe(false);
	},
);

it("audits the previous flagged provider when a pin moves its flag", async () => {
	state.catalogMapping = true;
	state.rows.push({
		id: "example-previous-documents",
		organizationId: "example-org",
		provider: "COHERE",
		isEmbeddingProvider: true,
		purpose: "ALL",
		enabled: false,
		encryptedApiKey: "example-key",
		config: {},
	});
	await apply();
	const { recordAuditFromRequest } = await import("../../../../../lib/audit");
	expect(recordAuditFromRequest).toHaveBeenCalledWith(
		context,
		expect.objectContaining({
			action: "org.ai_provider.embedding_changed",
			metadata: expect.objectContaining({
				previousEmbeddingProvider: "COHERE",
				reason: "pinned_by_default_switch",
			}),
		}),
	);
});

it("does not plan an organization pin from a member's personal resolution", async () => {
	state.catalogMapping = true;
	state.rows[0].encryptedApiKey = null;
	state.systemOverride = {
		provider: "OPENAI_DIRECT",
		configId: "example-personal-key",
		source: "user",
	};
	const plan = await preview();
	expect(plan.preservesEmbedding).toBe(false);
	expect(plan.documentsProvider).toBeNull();
});

it("detects a provider-qualified identity change from platform to direct for the same canonical embedding model", async () => {
	const { config } = await import("@repo/config");
	const previous = {
		enableGateway: config.ai.enableGateway,
		gatewayApiKey: config.ai.gatewayApiKey,
	};
	config.ai.enableGateway = true;
	config.ai.gatewayApiKey = "example-platform-key";
	try {
		state.rows[0].encryptedApiKey = null;
		state.systemOverride = {
			provider: "VERCEL_GATEWAY",
			source: null,
			configId: null,
		};
		state.templates.push({
			taskType: "EMBEDDING",
			complexity: "MEDIUM",
			provider: "VERCEL_GATEWAY",
			model: { canonicalName: "example-shared-embedding" },
		});
		state.rows[1].provider = "OPENAI_DIRECT";
		state.rows[0].provider = "VERCEL_GATEWAY";
		state.preferences = state.preferences.filter(
			(p) => p.taskType !== "EMBEDDING",
		);
		state.templates.push({
			taskType: "EMBEDDING",
			complexity: "MEDIUM",
			provider: "OPENAI_DIRECT",
			model: { canonicalName: "example-shared-embedding" },
		});
		const plan = await (
			procedures.previewSetDefaultProviderProcedure as unknown as Handler
		)._handler({ input: { ...input, provider: "OPENAI_DIRECT" }, context });
		expect(plan.embeddingsModelChanged).toBe(true);
		expect(plan.currentEmbeddingModel).toBeNull();
		expect(plan.targetEmbeddingModel.canonicalName).toBe(
			"example-shared-embedding",
		);
	} finally {
		Object.assign(config.ai, previous);
	}
});
it("does not conflict when enabled subproviders change during a default switch", async () => {
	state.catalogMapping = true;
	state.onLock = () => {
		state.rows[0].config = { enabledProviders: ["example-subprovider"] };
	};
	await expect(apply()).resolves.toMatchObject({ success: true });
});

it("refuses a switch when runtime’s first flagged row changes after the pre-read", async () => {
	state.catalogMapping = true;
	state.rows.push(
		...["z", "a"].map((suffix) => ({
			id: `example-documents-${suffix}`,
			organizationId: "example-org",
			provider: suffix === "z" ? "COHERE" : "TOGETHER_AI",
			isEmbeddingProvider: true,
			isDefault: false,
			enabled: false,
			purpose: "ALL",
			encryptedApiKey: null,
			config: {},
			priority: 0,
		})),
	);
	const { db } = await import("@repo/database");
	const findFirst = vi
		.spyOn(db.cloudProviderConfig, "findFirst")
		.mockImplementation(async (args: any) => {
			const candidates = state.rows.filter((row) =>
				matches(row, args.where),
			);
			if (args.orderBy) {
				candidates.sort(
					(a, b) =>
						Number(b.priority ?? 0) - Number(a.priority ?? 0) ||
						String(a.id).localeCompare(String(b.id)),
				);
			}
			return (candidates[0] ?? null) as never;
		});
	try {
		const { prepareDefaultSwitchEmbeddings, pinDefaultSwitchEmbeddings } =
			await import("../../../lib/default-provider-switch");
		const params = {
			organizationId: "example-org",
			userId: "example-user",
			targetProvider: "ANTHROPIC_DIRECT",
		};
		const prepared = await prepareDefaultSwitchEmbeddings(params);
		expect(prepared.plan.pin?.provider).toBe("OPENAI_DIRECT");
		state.rows.reverse();
		const client = {
			cloudProviderConfig: {
				findFirst,
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
		};
		await expect(
			pinDefaultSwitchEmbeddings(client as never, {
				...params,
				prepared,
				currentDefault: state.rows.find(
					(row) => row.isDefault,
				) as never,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(client.cloudProviderConfig.updateMany).not.toHaveBeenCalled();
	} finally {
		findFirst.mockRestore();
	}
});

it("requires impact confirmation when a default switch stops platform embeddings", async () => {
	const { config } = await import("@repo/config");
	const previous = {
		enableGateway: config.ai.enableGateway,
		gatewayApiKey: config.ai.gatewayApiKey,
	};
	config.ai.enableGateway = true;
	config.ai.gatewayApiKey = "example-platform-key";
	state.rows[0].encryptedApiKey = null;
	state.preferences = state.preferences.filter(
		(p) => p.taskType !== "EMBEDDING",
	);
	try {
		const plan = await preview();
		expect(plan.currentEmbeddingModel).toBeNull();
		expect(plan.targetEmbeddingModel).toBeNull();
		expect(plan.embeddingsModelChanged).toBe(true);
	} finally {
		Object.assign(config.ai, previous);
	}
});
