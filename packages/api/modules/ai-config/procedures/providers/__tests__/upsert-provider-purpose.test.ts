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

const { tables, mockRequireOrgMembership } = vi.hoisted(() => ({
	tables: {
		cloudProviderConfig: [] as Record<string, unknown>[],
		userCloudProviderConfig: [] as Record<string, unknown>[],
		organizationModelPreference: [] as Record<string, unknown>[],
		userModelPreference: [] as Record<string, unknown>[],
	},
	mockRequireOrgMembership: vi.fn(),
}));

vi.mock("@repo/database", async () => {
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
	function snapshot(rows: Row[], where: Row) {
		const row = rows.find((r) => matches(r, where));
		return row ? { ...row } : null;
	}
	function table(rows: Row[]) {
		return {
			findUnique: vi.fn(async ({ where }: { where: Row }) =>
				snapshot(rows, where),
			),
			findFirst: vi.fn(async ({ where }: { where: Row }) =>
				snapshot(rows, where),
			),
			updateMany: vi.fn(
				async ({ where, data }: { where: Row; data: Row }) => {
					const hit = rows.filter((row) => matches(row, where));
					for (const row of hit) {
						Object.assign(row, data);
					}
					return { count: hit.length };
				},
			),
			update: vi.fn(
				async ({ where, data }: { where: Row; data: Row }) => {
					const row = rows.find((r) => matches(r, where));
					if (!row) {
						throw new Error("not found");
					}
					Object.assign(row, data);
					return { ...row };
				},
			),
			create: vi.fn(async ({ data }: { data: Row }) => {
				const row = {
					isEmbeddingProvider: false,
					purpose: "ALL",
					...data,
				};
				rows.push(row);
				return { ...row };
			}),
			deleteMany: vi.fn(async ({ where }: { where: Row }) => {
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
		cloudProviderConfig: table(tables.cloudProviderConfig),
		userCloudProviderConfig: table(tables.userCloudProviderConfig),
		organizationModelPreference: table(tables.organizationModelPreference),
		userModelPreference: table(tables.userModelPreference),
	};
	return {
		db: {
			...tx,
			$transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
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
