/**
 * An "embeddings only" provider key (purpose EMBEDDINGS_ONLY, Fizzy #2770 F11).
 *
 * The writers must keep the invariant every reader relies on: an
 * embeddings-only key is the documents provider and is never the default —
 * not on create, not by explicit request, not by promotion when a default is
 * removed. Both config tables are faked in memory, evaluating the real `where`
 * clauses, so these pin the resulting rows rather than the queries.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const { tables, mockRequireOrgMembership, state } = vi.hoisted(() => ({
	state: {
		template: "example-current",
		failDefault: false,
		flipOnReadId: null as string | null,
		lockedIds: [] as string[],
		activeTransaction: false,
		tenantLocked: false,
		selectorActiveStates: [] as boolean[],
		tenantLocks: [] as { table: string; owner: string }[],
	},
	tables: {
		cloudProviderConfig: [] as Record<string, unknown>[],
		userCloudProviderConfig: [] as Record<string, unknown>[],
		organizationModelPreference: [] as Record<string, unknown>[],
		userModelPreference: [] as Record<string, unknown>[],
	},
	mockRequireOrgMembership: vi.fn(),
}));

vi.mock("@repo/ai/model-selector", () => ({
	selectModelDynamic: vi.fn(async () => {
		state.selectorActiveStates.push(state.activeTransaction);
		return {
			modelId: "example-default",
			canonicalName: "example-default",
			displayName: "Example default",
		};
	}),
}));

vi.mock("@repo/database", async () => {
	const shared = await vi.importActual<
		typeof import("../../../../../../database/prisma/queries/ai-gateway")
	>("../../../../../../database/prisma/queries/ai-gateway");
	function matches(row: Row, where: Row = {}): boolean {
		return Object.entries(where).every(([key, condition]) => {
			if (
				key === "organizationId_provider" ||
				key === "userId_provider"
			) {
				return matches(row, condition as Row);
			}
			if (
				condition !== null &&
				typeof condition === "object" &&
				"notIn" in (condition as Row)
			) {
				return !((condition as Row).notIn as unknown[]).includes(
					row[key],
				);
			}
			if (
				condition !== null &&
				typeof condition === "object" &&
				"not" in (condition as Row)
			) {
				return row[key] !== (condition as Row).not;
			}
			return row[key] === condition;
		});
	}
	// Prisma hands back a snapshot, never a live reference.
	function assertTenantLock() {
		if (state.activeTransaction && !state.tenantLocked) {
			throw new Error(
				"tenant provider lock must be the first transaction statement",
			);
		}
	}
	function snapshot(rows: Row[], where: Row) {
		assertTenantLock();
		const row = rows.find((r) => matches(r, where));
		const result = row ? { ...row } : null;

		return result;
	}
	function table(rows: Row[]) {
		return {
			findMany: vi.fn(async ({ where }: { where: Row }) =>
				rows.filter((row) => matches(row, where)),
			),
			findUnique: vi.fn(async ({ where }: { where: Row }) =>
				snapshot(rows, where),
			),
			findFirst: vi.fn(async ({ where }: { where: Row }) =>
				snapshot(rows, where),
			),
			updateMany: vi.fn(
				async ({ where, data }: { where: Row; data: Row }) => {
					assertTenantLock();
					if (state.failDefault && data.isDefault === true) {
						throw new Error("default write failed");
					}
					const hit = rows.filter((row) => matches(row, where));
					for (const row of hit) {
						Object.assign(row, data);
					}
					return { count: hit.length };
				},
			),
			update: vi.fn(
				async ({ where, data }: { where: Row; data: Row }) => {
					assertTenantLock();
					const row = rows.find((r) => matches(r, where));
					if (!row) {
						throw new Error("not found");
					}
					Object.assign(row, data);
					return { ...row };
				},
			),
			create: vi.fn(async ({ data }: { data: Row }) => {
				assertTenantLock();
				const row = {
					isEmbeddingProvider: false,
					purpose: "ALL",
					...data,
				};
				rows.push(row);
				return { ...row };
			}),
			deleteMany: vi.fn(async ({ where }: { where: Row }) => {
				assertTenantLock();
				const before = rows.length;
				for (let i = rows.length - 1; i >= 0; i--) {
					if (matches(rows[i], where)) {
						rows.splice(i, 1);
					}
				}
				return { count: before - rows.length };
			}),
		};
	}
	const tx = {
		aiModel: { findFirst: vi.fn(async () => null) },
		$queryRaw: vi.fn(async (sql: TemplateStringsArray, owner: string) => {
			expect(state.activeTransaction).toBe(true);
			expect(state.tenantLocked).toBe(false);
			const text = sql.join("?").replace(/\s+/g, " ").trim();
			const organization = text.includes('"cloud_provider_config"');
			const table = organization
				? "cloud_provider_config"
				: "user_cloud_provider_config";
			const column = organization ? "organizationId" : "userId";
			expect(text).toBe(
				`SELECT id FROM "${table}" WHERE "${column}" = ? ORDER BY id FOR NO KEY UPDATE`,
			);
			const rows = (
				organization
					? tables.cloudProviderConfig
					: tables.userCloudProviderConfig
			).filter((row) => row[column] === owner);
			// A concurrent writer may commit while this statement waits for its lock.
			const target = rows.find((row) => row.id === state.flipOnReadId);
			if (target) {
				state.flipOnReadId = null;
				const wasDefault = target.isDefault;
				for (const row of rows) {
					row.isDefault =
						row.id === target.id ? !wasDefault : !!wasDefault;
				}
			}
			state.tenantLocked = true;
			state.tenantLocks.push({ table, owner });
			state.lockedIds.push(...rows.map((row) => row.id as string).sort());
			return rows.map((row) => ({ id: row.id }));
		}),
		aiTaskModelDefault: {
			findMany: vi.fn(async ({ where }) => {
				assertTenantLock();
				return where.taskType === "CHAT"
					? [{ model: { canonicalName: state.template } }]
					: [];
			}),
		},
		cloudProviderConfig: table(tables.cloudProviderConfig),
		userCloudProviderConfig: table(tables.userCloudProviderConfig),
		organizationModelPreference: table(tables.organizationModelPreference),
		userModelPreference: table(tables.userModelPreference),
	};
	const { taskDefaultsSnapshotMutation } = await import(
		"../../../../../../database/prisma/queries/task-default-snapshots"
	);
	return {
		lockTenantProviderConnections: (
			await import(
				"../../../../../../database/prisma/queries/provider-write-locks"
			)
		).lockTenantProviderConnections,
		getTaskDefaultModelUncached: (
			await vi.importActual<
				typeof import("../../../../../../database/prisma/queries/ai-models")
			>("../../../../../../database/prisma/queries/ai-models")
		).getTaskDefaultModelUncached,
		taskDefaultsSnapshotMutation,
		organizationDefaultProviderWhere:
			shared.organizationDefaultProviderWhere,
		getOrganizationDefaultProvider: async () =>
			tables.cloudProviderConfig.find(
				(row) =>
					row.isDefault &&
					row.enabled &&
					row.purpose !== "EMBEDDINGS_ONLY" &&
					shared.readProviderRowCredentials(row as never)
						.hasCredentials,
			)?.provider ?? null,
		getAiProviderApiKeyByProvider: async ({
			provider,
		}: {
			provider: string;
		}) => ({ provider, source: "organization" }),
		getSystemAiProviderApiKey: async () => ({ provider: null }),
		readProviderRowCredentials: shared.readProviderRowCredentials,
		db: {
			...tx,
			$transaction: vi.fn(async (cb: (t: unknown) => unknown) => {
				const before = structuredClone(tables);
				state.activeTransaction = true;
				state.tenantLocked = false;
				try {
					const result = await cb(tx);
					expect(state.tenantLocked).toBe(true);
					return result;
				} catch (error) {
					for (const key of Object.keys(
						tables,
					) as (keyof typeof tables)[]) {
						tables[key].splice(
							0,
							tables[key].length,
							...before[key],
						);
					}
					throw error;
				} finally {
					state.activeTransaction = false;
				}
			}),
		},
		getProviderMetadata: vi.fn(() => ({ requiresBaseUrl: false })),
		getProviderDisplayName: vi.fn((p: string) => p),
		getEmbeddingProviderConfig: vi
			.fn()
			.mockResolvedValue({ provider: null }),
		ALL_EMBEDDING_CAPABLE_PROVIDERS: ["OPENAI_DIRECT"],
		canProviderSupportEmbeddings: vi.fn((p: string) => p !== "ANTHROPIC"),
		LLM_PROVIDER_PURPOSE_FILTER: { purpose: { not: "EMBEDDINGS_ONLY" } },
	};
});

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: (...args: unknown[]) =>
		mockRequireOrgMembership(...args),
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
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
		requirePermission: vi.fn(() => ({})),
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

import {
	deleteUserProviderProcedure,
	setDefaultProviderProcedure,
	setEmbeddingProviderProcedure,
	upsertUserProviderProcedure,
} from "../upsert";

type Handler = {
	_handler: (args: { input: unknown; context: unknown }) => Promise<unknown>;
};

const ORG = "org-1";
const USER = "user-1";
const orgContext = {
	user: { id: USER, email: "admin@example.com" },
	session: { id: "s1", activeOrganizationId: ORG },
};
const personalContext = {
	user: { id: USER, email: "admin@example.com" },
	session: { id: "s1", activeOrganizationId: null },
};

const call = (
	procedure: unknown,
	input: Record<string, unknown>,
	context: typeof orgContext | typeof personalContext = orgContext,
) =>
	(procedure as Handler)._handler({
		input: {
			organizationId: context.session.activeOrganizationId,
			...input,
		},
		context,
	});

function orgRow(provider: string) {
	return tables.cloudProviderConfig.find((row) => row.provider === provider);
}

function seedOrgRow(overrides: Row) {
	tables.cloudProviderConfig.push({
		id: `cpc_${overrides.provider}`,
		organizationId: ORG,
		enabled: true,
		isDefault: false,
		isEmbeddingProvider: false,
		purpose: "ALL",
		encryptedApiKey: "encrypted:key",
		clientId: null,
		encryptedClientSecret: null,
		config: {},
		...overrides,
	});
}

beforeEach(() => {
	state.template = "example-current";
	state.failDefault = false;
	state.flipOnReadId = null;
	state.lockedIds = [];
	state.activeTransaction = false;
	state.tenantLocked = false;
	state.tenantLocks = [];
	tables.cloudProviderConfig.length = 0;
	tables.userCloudProviderConfig.length = 0;
	tables.organizationModelPreference.length = 0;
	tables.userModelPreference.length = 0;
	mockRequireOrgMembership.mockResolvedValue({ role: "owner" });
});

describe("upsert — embeddings-only key", () => {
	it("is never made default, even as the organization's first key, and is the documents provider", async () => {
		const result = await call(upsertUserProviderProcedure, {
			provider: "OPENAI_DIRECT",
			apiKey: "sk-test",
			isDefault: false,
			purpose: "EMBEDDINGS_ONLY",
		});

		expect(result).toMatchObject({
			isDefault: false,
			purpose: "EMBEDDINGS_ONLY",
		});
		expect(orgRow("OPENAI_DIRECT")).toMatchObject({
			isDefault: false,
			isEmbeddingProvider: true,
			purpose: "EMBEDDINGS_ONLY",
		});
	});

	it("is never made default in personal context either", async () => {
		await call(
			upsertUserProviderProcedure,
			{
				provider: "OPENAI_DIRECT",
				apiKey: "sk-test",
				purpose: "EMBEDDINGS_ONLY",
			},
			personalContext,
		);

		expect(tables.userCloudProviderConfig[0]).toMatchObject({
			isDefault: false,
			isEmbeddingProvider: true,
			purpose: "EMBEDDINGS_ONLY",
		});
	});

	it("rejects an explicit request to make it default", async () => {
		await expect(
			call(upsertUserProviderProcedure, {
				provider: "OPENAI_DIRECT",
				apiKey: "sk-test",
				isDefault: true,
				purpose: "EMBEDDINGS_ONLY",
			}),
		).rejects.toThrow(/cannot be the default/);
		expect(tables.cloudProviderConfig).toHaveLength(0);
	});

	it("keeps an existing key embeddings-only when a re-save omits purpose", async () => {
		seedOrgRow({
			provider: "OPENAI_DIRECT",
			isEmbeddingProvider: true,
			purpose: "EMBEDDINGS_ONLY",
		});

		await call(upsertUserProviderProcedure, {
			provider: "OPENAI_DIRECT",
			apiKey: "sk-rotated",
		});

		expect(orgRow("OPENAI_DIRECT")).toMatchObject({
			isDefault: false,
			purpose: "EMBEDDINGS_ONLY",
		});
	});

	it("does not count as a default: the next ordinary key becomes default", async () => {
		seedOrgRow({
			provider: "OPENAI_DIRECT",
			isEmbeddingProvider: true,
			purpose: "EMBEDDINGS_ONLY",
		});

		await call(upsertUserProviderProcedure, {
			provider: "ANTHROPIC",
			apiKey: "sk-ant",
			isDefault: false,
		});

		expect(orgRow("ANTHROPIC")?.isDefault).toBe(true);
		expect(orgRow("OPENAI_DIRECT")?.isDefault).toBe(false);
	});

	it("hands the default to another key when the default becomes embeddings-only", async () => {
		seedOrgRow({ provider: "OPENAI_DIRECT", isDefault: true });
		seedOrgRow({ provider: "ANTHROPIC" });

		await call(upsertUserProviderProcedure, {
			provider: "OPENAI_DIRECT",
			apiKey: "sk-test",
			purpose: "EMBEDDINGS_ONLY",
		});

		expect(orgRow("OPENAI_DIRECT")).toMatchObject({
			isDefault: false,
			purpose: "EMBEDDINGS_ONLY",
		});
		expect(orgRow("ANTHROPIC")?.isDefault).toBe(true);
	});

	it("rejects a second embeddings-only key", async () => {
		seedOrgRow({
			provider: "OPENAI_DIRECT",
			isEmbeddingProvider: true,
			purpose: "EMBEDDINGS_ONLY",
		});

		await expect(
			call(upsertUserProviderProcedure, {
				provider: "MISTRAL",
				apiKey: "sk-mistral",
				purpose: "EMBEDDINGS_ONLY",
			}),
		).rejects.toThrow(/already the embeddings-only key/);
	});

	it("rejects a provider that cannot embed", async () => {
		await expect(
			call(upsertUserProviderProcedure, {
				provider: "ANTHROPIC",
				apiKey: "sk-ant",
				purpose: "EMBEDDINGS_ONLY",
			}),
		).rejects.toThrow(/does not support embeddings/);
	});
});

describe("delete — default promotion", () => {
	it("never promotes an embeddings-only key", async () => {
		seedOrgRow({ provider: "ANTHROPIC", isDefault: true });
		seedOrgRow({
			provider: "OPENAI_DIRECT",
			isEmbeddingProvider: true,
			purpose: "EMBEDDINGS_ONLY",
		});

		await call(deleteUserProviderProcedure, { provider: "ANTHROPIC" });

		expect(orgRow("OPENAI_DIRECT")?.isDefault).toBe(false);
	});

	it("still promotes an ordinary key", async () => {
		seedOrgRow({ provider: "ANTHROPIC", isDefault: true });
		seedOrgRow({
			provider: "OPENAI_DIRECT",
			isEmbeddingProvider: true,
			purpose: "EMBEDDINGS_ONLY",
		});
		seedOrgRow({ provider: "MISTRAL" });

		await call(deleteUserProviderProcedure, { provider: "ANTHROPIC" });

		expect(orgRow("MISTRAL")?.isDefault).toBe(true);
		expect(orgRow("OPENAI_DIRECT")?.isDefault).toBe(false);
	});
});

describe("set default / set embedding", () => {
	it("refuses to make an embeddings-only key the default", async () => {
		seedOrgRow({
			provider: "OPENAI_DIRECT",
			isEmbeddingProvider: true,
			purpose: "EMBEDDINGS_ONLY",
		});

		await expect(
			call(setDefaultProviderProcedure, { provider: "OPENAI_DIRECT" }),
		).rejects.toThrow(/cannot be the default/);
		expect(orgRow("OPENAI_DIRECT")?.isDefault).toBe(false);
	});

	it("restricts the default key to embeddings and promotes another", async () => {
		seedOrgRow({ provider: "OPENAI_DIRECT", isDefault: true });
		seedOrgRow({ provider: "ANTHROPIC" });

		await call(setEmbeddingProviderProcedure, {
			provider: "OPENAI_DIRECT",
			purpose: "EMBEDDINGS_ONLY",
		});

		expect(orgRow("OPENAI_DIRECT")).toMatchObject({
			isDefault: false,
			isEmbeddingProvider: true,
			purpose: "EMBEDDINGS_ONLY",
		});
		expect(orgRow("ANTHROPIC")?.isDefault).toBe(true);
	});

	// Fizzy #3085: an embeddings-only key never stands in for a spent plan.
	it("clears a personal key's plan-spent opt-in when it becomes embeddings-only", async () => {
		tables.userCloudProviderConfig.push({
			id: "ucpc_OPENAI_DIRECT",
			userId: USER,
			provider: "OPENAI_DIRECT",
			enabled: true,
			isDefault: false,
			isEmbeddingProvider: true,
			purpose: "ALL",
			useWhenPlanSpent: true,
			encryptedApiKey: "encrypted:key",
			clientId: null,
			encryptedClientSecret: null,
			config: {},
		});

		await call(
			setEmbeddingProviderProcedure,
			{ provider: "OPENAI_DIRECT", purpose: "EMBEDDINGS_ONLY" },
			personalContext,
		);

		expect(tables.userCloudProviderConfig[0]).toMatchObject({
			purpose: "EMBEDDINGS_ONLY",
			useWhenPlanSpent: false,
		});
	});

	it("clears the opt-in when a personal key is re-saved embeddings-only", async () => {
		tables.userCloudProviderConfig.push({
			id: "ucpc_OPENAI_DIRECT",
			userId: USER,
			provider: "OPENAI_DIRECT",
			enabled: true,
			isDefault: false,
			isEmbeddingProvider: false,
			purpose: "ALL",
			useWhenPlanSpent: true,
			encryptedApiKey: "encrypted:key",
			clientId: null,
			encryptedClientSecret: null,
			config: {},
		});

		await call(
			upsertUserProviderProcedure,
			{
				provider: "OPENAI_DIRECT",
				apiKey: "sk-test",
				purpose: "EMBEDDINGS_ONLY",
			},
			personalContext,
		);

		expect(tables.userCloudProviderConfig[0]).toMatchObject({
			purpose: "EMBEDDINGS_ONLY",
			useWhenPlanSpent: false,
		});
	});

	it("lifts the restriction without touching the default", async () => {
		seedOrgRow({ provider: "ANTHROPIC", isDefault: true });
		seedOrgRow({
			provider: "OPENAI_DIRECT",
			isEmbeddingProvider: true,
			purpose: "EMBEDDINGS_ONLY",
		});

		await call(setEmbeddingProviderProcedure, {
			provider: "OPENAI_DIRECT",
			purpose: "ALL",
		});

		expect(orgRow("OPENAI_DIRECT")).toMatchObject({
			purpose: "ALL",
			isEmbeddingProvider: true,
			isDefault: false,
		});
		expect(orgRow("ANTHROPIC")?.isDefault).toBe(true);
	});

	it("refuses to move the documents flag off an embeddings-only key", async () => {
		seedOrgRow({
			provider: "OPENAI_DIRECT",
			isEmbeddingProvider: true,
			purpose: "EMBEDDINGS_ONLY",
		});
		seedOrgRow({ provider: "MISTRAL", isDefault: true });

		await expect(
			call(setEmbeddingProviderProcedure, { provider: "MISTRAL" }),
		).rejects.toThrow(/must stay the documents provider/);
		expect(orgRow("OPENAI_DIRECT")?.isEmbeddingProvider).toBe(true);
	});
});

describe("model preferences", () => {
	function pref(taskType: string, provider: string) {
		return { organizationId: ORG, taskType, provider };
	}
	const prefs = () =>
		tables.organizationModelPreference.map(
			(row) => `${row.taskType}:${row.provider}`,
		);

	it("drops the LLM preferences pinned to a key that becomes embeddings-only, keeping its EMBEDDING one", async () => {
		seedOrgRow({ provider: "OPENAI_DIRECT", isDefault: true });
		seedOrgRow({ provider: "ANTHROPIC" });
		tables.organizationModelPreference.push(
			pref("CHAT", "OPENAI_DIRECT"),
			pref("EMBEDDING", "OPENAI_DIRECT"),
			pref("CHAT", "ANTHROPIC"),
			pref("CHAT", "OPENAI_CHATGPT_PLAN"),
		);

		await call(setEmbeddingProviderProcedure, {
			provider: "OPENAI_DIRECT",
			purpose: "EMBEDDINGS_ONLY",
		});

		expect(prefs()).toEqual([
			"EMBEDDING:OPENAI_DIRECT",
			"CHAT:ANTHROPIC",
			"CHAT:OPENAI_CHATGPT_PLAN",
		]);
	});

	it("does the same when the purpose is set through upsert", async () => {
		seedOrgRow({ provider: "OPENAI_DIRECT", isDefault: true });
		tables.organizationModelPreference.push(
			pref("CHAT", "OPENAI_DIRECT"),
			pref("EMBEDDING", "OPENAI_DIRECT"),
		);

		await call(upsertUserProviderProcedure, {
			provider: "OPENAI_DIRECT",
			apiKey: "sk-test",
			purpose: "EMBEDDINGS_ONLY",
		});

		expect(prefs()).toEqual(["EMBEDDING:OPENAI_DIRECT"]);
	});

	it("drops every preference pinned to a deleted provider", async () => {
		seedOrgRow({ provider: "OPENAI_DIRECT", isDefault: true });
		seedOrgRow({ provider: "ANTHROPIC" });
		tables.organizationModelPreference.push(
			pref("CHAT", "OPENAI_DIRECT"),
			pref("EMBEDDING", "OPENAI_DIRECT"),
			pref("CHAT", "ANTHROPIC"),
		);

		await call(deleteUserProviderProcedure, { provider: "OPENAI_DIRECT" });

		expect(prefs()).toEqual(["CHAT:ANTHROPIC"]);
	});

	it("keeps the ChatGPT plan's model choices when the default provider changes", async () => {
		seedOrgRow({ provider: "OPENAI_DIRECT", isDefault: true });
		seedOrgRow({ provider: "ANTHROPIC" });
		tables.organizationModelPreference.push(
			pref("CHAT", "OPENAI_DIRECT"),
			pref("CHAT", "OPENAI_CHATGPT_PLAN"),
		);

		await call(setDefaultProviderProcedure, { provider: "ANTHROPIC" });

		expect(prefs()).toEqual(["CHAT:OPENAI_CHATGPT_PLAN"]);
	});
});

// Without capture on create, these rows carry no frozen defaults.
describe.each([orgContext, personalContext])(
	"connection snapshots (%j)",
	(context) => {
		it("captures on creation, including a non-default connection", async () => {
			await call(
				upsertUserProviderProcedure,
				{ provider: "OPENAI_DIRECT", apiKey: "sk-test" },
				context,
			);
			await call(
				upsertUserProviderProcedure,
				{
					provider: "ANTHROPIC_DIRECT",
					apiKey: "sk-test",
					isDefault: false,
				},
				context,
			);
			const rows =
				context === orgContext
					? tables.cloudProviderConfig
					: tables.userCloudProviderConfig;
			expect(rows[1].taskDefaultsSnapshot).toMatchObject({
				version: 1,
				scoped: { CHAT: "example-current" },
				unscoped: { CHAT: "example-current" },
			});
		});
		// Recapture-on-edit would lose the old model; omitting switch capture would retain it.
		it("preserves credential edits and re-defaults, and recaptures an explicit switch", async () => {
			const rows =
				context === orgContext
					? tables.cloudProviderConfig
					: tables.userCloudProviderConfig;
			await call(
				upsertUserProviderProcedure,
				{ provider: "OPENAI_DIRECT", apiKey: "sk-test" },
				context,
			);
			const original = structuredClone(rows[0].taskDefaultsSnapshot);
			state.template = "example-new";
			await call(
				upsertUserProviderProcedure,
				{
					provider: "OPENAI_DIRECT",
					apiKey: "sk-rotated",
					displayName: "Example connection",
					baseUrl: "https://example.com",
					enabledProviders: ["OPENAI"],
				},
				context,
			);
			expect(rows[0].enabled).toBe(true);
			expect(rows[0].taskDefaultsSnapshot).toEqual(original);
			await call(
				setDefaultProviderProcedure,
				{ provider: "OPENAI_DIRECT" },
				context,
			);
			expect(rows[0].taskDefaultsSnapshot).toEqual(original);
			await call(
				upsertUserProviderProcedure,
				{
					provider: "ANTHROPIC_DIRECT",
					apiKey: "sk-test",
					isDefault: false,
				},
				context,
			);
			state.template = "example-newest";
			await call(
				setDefaultProviderProcedure,
				{ provider: "ANTHROPIC_DIRECT" },
				context,
			);
			expect(rows[1].taskDefaultsSnapshot).toMatchObject({
				scoped: { CHAT: "example-newest" },
				unscoped: { CHAT: "example-newest" },
			});
			expect(rows[0].isDefault).toBe(false);
			expect(rows[1].isDefault).toBe(true);
		});
		// Promotion without capture would retain example-current on the surviving connection.
		it("recaptures automatic promotion after deleting the default and captures a re-add", async () => {
			const rows =
				context === orgContext
					? tables.cloudProviderConfig
					: tables.userCloudProviderConfig;
			for (const provider of ["OPENAI_DIRECT", "ANTHROPIC_DIRECT"]) {
				await call(
					upsertUserProviderProcedure,
					{ provider, apiKey: "sk-test", isDefault: false },
					context,
				);
			}
			state.template = "example-promoted";
			await call(
				deleteUserProviderProcedure,
				{ provider: "OPENAI_DIRECT" },
				context,
			);
			expect(rows[0]).toMatchObject({
				isDefault: true,
				taskDefaultsSnapshot: {
					scoped: { CHAT: "example-promoted" },
					unscoped: { CHAT: "example-promoted" },
				},
			});
			await call(
				upsertUserProviderProcedure,
				{
					provider: "OPENAI_DIRECT",
					apiKey: "sk-test",
					isDefault: false,
				},
				context,
			);
			expect(rows[1].taskDefaultsSnapshot).toMatchObject({
				scoped: { CHAT: "example-promoted" },
				unscoped: { CHAT: "example-promoted" },
			});
		});
		it("preserves re-enabling a non-default connection and captures when re-enabling makes it the resolved default", async () => {
			const rows =
				context === orgContext
					? tables.cloudProviderConfig
					: tables.userCloudProviderConfig;
			for (const provider of ["OPENAI_DIRECT", "ANTHROPIC_DIRECT"]) {
				await call(
					upsertUserProviderProcedure,
					{ provider, apiKey: "example-key", isDefault: false },
					context,
				);
			}
			const original = structuredClone(rows[1].taskDefaultsSnapshot);
			rows[1].enabled = false;
			state.template = "example-re-enabled";
			await call(
				upsertUserProviderProcedure,
				{ provider: "ANTHROPIC_DIRECT", apiKey: "example-key" },
				context,
			);
			expect(rows[1].taskDefaultsSnapshot).toEqual(original);
			rows[0].enabled = false;
			rows[1].enabled = false;
			rows[1].isDefault = true;
			await call(
				upsertUserProviderProcedure,
				{ provider: "ANTHROPIC_DIRECT", apiKey: "example-key" },
				context,
			);
			expect(rows[1].taskDefaultsSnapshot).toMatchObject({
				scoped: { CHAT: state.template },
				unscoped: { CHAT: state.template },
			});
		});
		it("recaptures an upsert that makes a non-default connection default", async () => {
			const rows =
				context === orgContext
					? tables.cloudProviderConfig
					: tables.userCloudProviderConfig;
			for (const provider of ["OPENAI_DIRECT", "ANTHROPIC_DIRECT"]) {
				await call(
					upsertUserProviderProcedure,
					{ provider, apiKey: "sk-test", isDefault: false },
					context,
				);
			}
			state.template = "example-switched";
			await call(
				upsertUserProviderProcedure,
				{
					provider: "ANTHROPIC_DIRECT",
					apiKey: "sk-rotated",
					isDefault: true,
				},
				context,
			);
			expect(rows[1]).toMatchObject({
				isDefault: true,
				taskDefaultsSnapshot: {
					scoped: { CHAT: "example-switched" },
					unscoped: { CHAT: "example-switched" },
				},
			});
		});

		// Deletion outside the transaction would survive the failed default update.
		it("rolls back preference deletion when the default flip fails", async () => {
			const rows =
				context === orgContext
					? tables.cloudProviderConfig
					: tables.userCloudProviderConfig;
			const prefs =
				context === orgContext
					? tables.organizationModelPreference
					: tables.userModelPreference;
			for (const provider of ["OPENAI_DIRECT", "ANTHROPIC_DIRECT"]) {
				await call(
					upsertUserProviderProcedure,
					{ provider, apiKey: "sk-test", isDefault: false },
					context,
				);
			}
			prefs.push({
				organizationId: ORG,
				userId: USER,
				provider: "OPENAI_DIRECT",
				taskType: "CHAT",
				modelId: "example-model",
			});
			const before = structuredClone(rows);
			state.failDefault = true;
			await expect(
				call(
					setDefaultProviderProcedure,
					{ provider: "ANTHROPIC_DIRECT" },
					context,
				),
			).rejects.toThrow("default write failed");
			expect(prefs).toHaveLength(1);
			expect(rows).toEqual(before);
		});
		// Both paths that restrict a default to embeddings must capture the promoted connection.
		it.each(["upsert", "documents"])(
			"recaptures promotion when the default becomes embeddings-only via %s",
			async (mode) => {
				const rows =
					context === orgContext
						? tables.cloudProviderConfig
						: tables.userCloudProviderConfig;
				for (const provider of ["OPENAI_DIRECT", "ANTHROPIC_DIRECT"]) {
					await call(
						upsertUserProviderProcedure,
						{ provider, apiKey: "sk-test", isDefault: false },
						context,
					);
				}
				state.template = "example-promoted";
				await call(
					mode === "upsert"
						? upsertUserProviderProcedure
						: setEmbeddingProviderProcedure,
					{
						provider: "OPENAI_DIRECT",
						apiKey: "sk-test",
						purpose: "EMBEDDINGS_ONLY",
					},
					context,
				);
				expect(rows[1]).toMatchObject({
					isDefault: true,
					taskDefaultsSnapshot: {
						scoped: { CHAT: "example-promoted" },
						unscoped: { CHAT: "example-promoted" },
					},
				});
			},
		);
	},
);

describe.each([orgContext, personalContext])(
	"post-lock default decisions (%j)",
	(context) => {
		it.each(["setDefault", "upsert"] as const)(
			"%s rejects a concurrent default switch and captures on retry",
			async (mode) => {
				const rows =
					context === orgContext
						? tables.cloudProviderConfig
						: tables.userCloudProviderConfig;
				for (const provider of ["OPENAI_DIRECT", "ANTHROPIC_DIRECT"]) {
					await call(
						upsertUserProviderProcedure,
						{ provider, apiKey: "example-key", isDefault: false },
						context,
					);
				}
				const before = structuredClone(rows);
				const procedure =
					mode === "setDefault"
						? setDefaultProviderProcedure
						: upsertUserProviderProcedure;
				const request = {
					provider: "OPENAI_DIRECT",
					isDefault: true,
					apiKey: "example-key",
				};
				state.template = "example-after-switch";
				state.flipOnReadId = rows[0].id as string;
				await expect(
					call(procedure, request, context),
				).rejects.toMatchObject({ code: "CONFLICT" });
				expect(rows).toEqual(before);
				// The transaction fake rolls back the simulated competing commit too.
				// Reapply that commit before retrying against the new default.
				rows[0].isDefault = false;
				rows[1].isDefault = true;
				await call(procedure, request, context);
				expect(rows[0]).toMatchObject({
					isDefault: true,
					taskDefaultsSnapshot: {
						scoped: { CHAT: "example-after-switch" },
						unscoped: { CHAT: "example-after-switch" },
					},
				});
				const snapshot = structuredClone(rows[0].taskDefaultsSnapshot);
				state.template = "example-should-preserve";
				await call(procedure, request, context);
				expect(rows[0].taskDefaultsSnapshot).toEqual(snapshot);
			},
		);

		it("does not capture when setDefault targets a missing connection", async () => {
			const { db } = await import("@repo/database");
			vi.mocked(db.aiTaskModelDefault.findMany).mockClear();
			const result = call(
				setDefaultProviderProcedure,
				{ provider: "OPENAI_DIRECT" },
				context,
			);
			if (context === orgContext) {
				await expect(result).rejects.toThrow(
					"Choose an enabled API provider",
				);
			} else {
				await result;
			}
			expect(db.aiTaskModelDefault.findMany).not.toHaveBeenCalled();
		});
	},
);

describe.each([orgContext, personalContext])(
	"tenant lock first (%j)",
	(context) => {
		it.each(["upsert", "delete", "setDefault", "setEmbedding"] as const)(
			"%s locks the resolved tenant before reading or writing",
			async (operation) => {
				for (const provider of ["OPENAI_DIRECT", "ANTHROPIC_DIRECT"]) {
					await call(
						upsertUserProviderProcedure,
						{ provider, apiKey: "example-key", isDefault: false },
						context,
					);
				}
				state.tenantLocks = [];
				const procedure = {
					upsert: upsertUserProviderProcedure,
					delete: deleteUserProviderProcedure,
					setDefault: setDefaultProviderProcedure,
					setEmbedding: setEmbeddingProviderProcedure,
				}[operation];
				await call(
					procedure,
					{
						provider: "OPENAI_DIRECT",
						apiKey: "example-key",
						isDefault: true,
						...(operation === "setEmbedding"
							? { purpose: "EMBEDDINGS_ONLY" }
							: {}),
					},
					context,
				);
				expect(state.tenantLocks).toEqual([
					{
						table:
							context === orgContext
								? "cloud_provider_config"
								: "user_cloud_provider_config",
						owner:
							context.session.activeOrganizationId ??
							context.user.id,
					},
				]);
			},
		);
	},
);

it.each(["delete", "upsert embeddings-only", "set embeddings-only"])(
	"promotes exactly one credentialed organization row after %s despite a stale default flag",
	async (action) => {
		seedOrgRow({
			provider: "GROQ",
			isDefault: true,
			encryptedApiKey: null,
		});
		seedOrgRow({ provider: "ANTHROPIC" });
		seedOrgRow({
			provider: "OPENAI_DIRECT",
			isDefault: action === "set embeddings-only",
		});
		if (action === "delete") {
			await call(deleteUserProviderProcedure, {
				provider: "OPENAI_DIRECT",
			});
		} else if (action === "upsert embeddings-only") {
			await call(upsertUserProviderProcedure, {
				provider: "OPENAI_DIRECT",
				apiKey: "example-key",
				purpose: "EMBEDDINGS_ONLY",
			});
		} else {
			await call(setEmbeddingProviderProcedure, {
				provider: "OPENAI_DIRECT",
				purpose: "EMBEDDINGS_ONLY",
			});
		}
		expect(
			tables.cloudProviderConfig
				.filter((row) => row.isDefault)
				.map((row) => row.provider),
		).toEqual(["ANTHROPIC"]);
	},
);

describe.each([orgContext, personalContext])(
	"duplicate default flags (%j)",
	(context) => {
		it.each(["setDefault", "upsert"] as const)(
			"%s captures a flagged target that is not the resolved default",
			async (operation) => {
				const rows =
					context === orgContext
						? tables.cloudProviderConfig
						: tables.userCloudProviderConfig;
				for (const provider of ["OPENAI_DIRECT", "ANTHROPIC_DIRECT"]) {
					await call(
						upsertUserProviderProcedure,
						{ provider, apiKey: "example-key", isDefault: false },
						context,
					);
				}
				const target = rows[1];
				target.isDefault = true;
				state.template = "example-live-after-duplicate";
				await call(
					operation === "setDefault"
						? setDefaultProviderProcedure
						: upsertUserProviderProcedure,
					{
						provider: "ANTHROPIC_DIRECT",
						apiKey: "example-key",
						isDefault: true,
					},
					context,
				);
				expect(target.taskDefaultsSnapshot).toMatchObject({
					scoped: { CHAT: state.template },
					unscoped: { CHAT: state.template },
				});
				expect(
					rows
						.filter((row) => row.isDefault)
						.map((row) => row.provider),
				).toEqual(["ANTHROPIC_DIRECT"]);
			},
		);
		it("delete captures a flagged survivor when the resolved default is removed", async () => {
			const rows =
				context === orgContext
					? tables.cloudProviderConfig
					: tables.userCloudProviderConfig;
			for (const provider of ["OPENAI_DIRECT", "ANTHROPIC_DIRECT"]) {
				await call(
					upsertUserProviderProcedure,
					{ provider, apiKey: "example-key", isDefault: false },
					context,
				);
			}
			rows[1].isDefault = true;
			state.template = "example-live-after-delete";
			await call(
				deleteUserProviderProcedure,
				{ provider: "OPENAI_DIRECT" },
				context,
			);
			expect(rows[0].taskDefaultsSnapshot).toMatchObject({
				scoped: { CHAT: state.template },
				unscoped: { CHAT: state.template },
			});
		});
		it.each(["upsert", "documents"] as const)(
			"%s promotion recaptures a flagged replacement when no default resolves",
			async (operation) => {
				const rows =
					context === orgContext
						? tables.cloudProviderConfig
						: tables.userCloudProviderConfig;
				for (const provider of ["OPENAI_DIRECT", "ANTHROPIC_DIRECT"]) {
					await call(
						upsertUserProviderProcedure,
						{ provider, apiKey: "example-key", isDefault: false },
						context,
					);
				}
				// The first flagged row has no credential. Runtime resolves no default,
				// even though the usable replacement also has a stale default flag.
				rows[0].encryptedApiKey = null;
				rows[1].isDefault = true;
				state.template = "example-live-promotion";
				await call(
					operation === "upsert"
						? upsertUserProviderProcedure
						: setEmbeddingProviderProcedure,
					{
						provider: "OPENAI_DIRECT",
						apiKey: "example-key",
						purpose: "EMBEDDINGS_ONLY",
					},
					context,
				);
				expect(rows[1].taskDefaultsSnapshot).toMatchObject({
					scoped: { CHAT: state.template },
					unscoped: { CHAT: state.template },
				});
			},
		);
	},
);

it.each(["organization", "user"] as const)(
	"pins embeddings with resolution outside the transaction when an upsert switches the %s default",
	async (scope) => {
		state.selectorActiveStates = [];
		const context = {
			user: { id: "example-user", email: "dev@example.com" },
			session: {
				activeOrganizationId:
					scope === "organization" ? "example-org" : null,
			},
		};
		const rows =
			scope === "organization"
				? tables.cloudProviderConfig
				: tables.userCloudProviderConfig;
		const preferences =
			scope === "organization"
				? tables.organizationModelPreference
				: tables.userModelPreference;
		rows.push({
			id: "example-outgoing",
			provider: "OPENAI_DIRECT",
			organizationId: "example-org",
			userId: "example-user",
			isDefault: true,
			isEmbeddingProvider: false,
			enabled: true,
			purpose: "ALL",
			encryptedApiKey: "example-key",
			config: {},
		});
		preferences.push({
			id: "example-embedding-choice",
			taskType: "EMBEDDING",
			provider: "OPENAI_DIRECT",
			organizationId: "example-org",
			userId: "example-user",
		});
		await call(
			upsertUserProviderProcedure,
			{
				provider: "ANTHROPIC_DIRECT",
				apiKey: "example-key",
				isDefault: true,
			},
			context,
		);
		expect(state.selectorActiveStates.length).toBeGreaterThan(0);
		expect(state.selectorActiveStates).not.toContain(true);
		expect(
			rows.find((entry) => entry.id === "example-outgoing")
				?.isEmbeddingProvider,
		).toBe(true);
		expect(preferences.map((entry) => entry.id)).toEqual([
			"example-embedding-choice",
		]);
		const { recordAuditFromRequest } = await import(
			"../../../../../lib/audit"
		);
		expect(recordAuditFromRequest).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: `${scope === "organization" ? "org" : "account"}.ai_provider.embedding_changed`,
				metadata: expect.objectContaining({
					reason: "pinned_by_default_switch",
				}),
			}),
		);
	},
);
