/**
 * An "embeddings only" provider key (purpose EMBEDDINGS_ONLY, Fizzy #2770 F11).
 *
 * Every lookup that can feed LLM work must skip such a row; only the embedding
 * lookup may resolve it. The two tables are faked with an in-memory store that
 * evaluates the real `where` clauses, so these pin behaviour rather than the
 * exact shape of a query.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const { orgRows, userRows, aiConfig } = vi.hoisted(() => ({
	orgRows: [] as Record<string, unknown>[],
	userRows: [] as Record<string, unknown>[],
	aiConfig: {
		enableGateway: false,
		gatewayApiKey: null as string | null,
		enabledProviders: ["openai"],
	},
}));

function matches(row: Row, where: Row): boolean {
	return Object.entries(where).every(([key, condition]) => {
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

function fakeTable(rows: Row[]) {
	return {
		findFirst: vi.fn(
			async ({ where }: { where: Row }) =>
				rows.find((row) => matches(row, where)) ?? null,
		),
	};
}

vi.mock("../prisma/client", () => ({
	db: {
		cloudProviderConfig: fakeTable(orgRows),
		userCloudProviderConfig: fakeTable(userRows),
	},
}));

vi.mock("@repo/config", () => ({
	config: { ai: aiConfig },
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
}));

import {
	getAiProviderApiKey,
	getAiProviderApiKeyByProvider,
	getEmbeddingProviderConfig,
	getOrganizationSystemAiProviderApiKey,
	getSystemAiProviderApiKey,
} from "../prisma/queries/ai-gateway";

const ORG = "org-1";
const USER = "user-1";

function providerRow(overrides: Row): Row {
	return {
		id: "row",
		provider: "OPENAI_DIRECT",
		enabled: true,
		isDefault: false,
		isEmbeddingProvider: false,
		purpose: "ALL",
		encryptedApiKey: "encrypted:key",
		clientId: null,
		encryptedClientSecret: null,
		config: {},
		...overrides,
	};
}

beforeEach(() => {
	orgRows.length = 0;
	userRows.length = 0;
	aiConfig.enableGateway = false;
	aiConfig.gatewayApiKey = null;
});

describe("organization default lookup", () => {
	it("skips an embeddings-only row even if it is marked default", async () => {
		orgRows.push(
			providerRow({
				id: "cpc_embed",
				organizationId: ORG,
				isDefault: true,
				isEmbeddingProvider: true,
				purpose: "EMBEDDINGS_ONLY",
			}),
		);

		const tenant = await getAiProviderApiKey({
			userId: USER,
			organizationId: ORG,
		});
		const orgSystem = await getOrganizationSystemAiProviderApiKey({
			organizationId: ORG,
		});

		expect(tenant.provider).toBeNull();
		expect(tenant.source).toBeNull();
		expect(orgSystem.provider).toBeNull();
	});

	it("still resolves an ordinary default (purpose ALL) exactly as before", async () => {
		orgRows.push(
			providerRow({
				id: "cpc_all",
				organizationId: ORG,
				isDefault: true,
			}),
		);

		const result = await getAiProviderApiKey({
			userId: USER,
			organizationId: ORG,
		});

		expect(result.configId).toBe("cpc_all");
		expect(result.source).toBe("organization");
	});
});

describe("personal fallback", () => {
	it("skips a personal embeddings-only row inside an organization", async () => {
		userRows.push(
			providerRow({
				id: "ucpc_embed",
				userId: USER,
				isDefault: true,
				isEmbeddingProvider: true,
				purpose: "EMBEDDINGS_ONLY",
			}),
		);

		const tenant = await getAiProviderApiKey({
			userId: USER,
			organizationId: ORG,
		});
		const system = await getSystemAiProviderApiKey({
			userId: USER,
			organizationId: ORG,
		});

		expect(tenant.provider).toBeNull();
		expect(system.provider).toBeNull();
	});

	it("still falls back to an ordinary personal default", async () => {
		userRows.push(
			providerRow({ id: "ucpc_all", userId: USER, isDefault: true }),
		);

		const result = await getAiProviderApiKey({
			userId: USER,
			organizationId: ORG,
		});

		expect(result.configId).toBe("ucpc_all");
		expect(result.source).toBe("user");
	});
});

describe("lookup by provider", () => {
	it("never returns an organization's embeddings-only row", async () => {
		orgRows.push(
			providerRow({
				id: "cpc_embed",
				organizationId: ORG,
				isEmbeddingProvider: true,
				purpose: "EMBEDDINGS_ONLY",
			}),
		);

		const result = await getAiProviderApiKeyByProvider({
			userId: USER,
			organizationId: ORG,
			provider: "OPENAI_DIRECT",
		});

		expect(result.provider).toBeNull();
	});

	it("never returns a personal embeddings-only row", async () => {
		userRows.push(
			providerRow({
				id: "ucpc_embed",
				userId: USER,
				isEmbeddingProvider: true,
				purpose: "EMBEDDINGS_ONLY",
			}),
		);

		const result = await getAiProviderApiKeyByProvider({
			userId: USER,
			provider: "OPENAI_DIRECT",
		});

		expect(result.provider).toBeNull();
	});

	it("still returns an ordinary row of that provider", async () => {
		orgRows.push(providerRow({ id: "cpc_all", organizationId: ORG }));

		const result = await getAiProviderApiKeyByProvider({
			userId: USER,
			organizationId: ORG,
			provider: "OPENAI_DIRECT",
		});

		expect(result.configId).toBe("cpc_all");
	});
});

describe("embedding lookup", () => {
	it("resolves the organization's embeddings-only row", async () => {
		orgRows.push(
			providerRow({
				id: "cpc_embed",
				organizationId: ORG,
				isEmbeddingProvider: true,
				purpose: "EMBEDDINGS_ONLY",
			}),
		);

		const result = await getEmbeddingProviderConfig({
			userId: USER,
			organizationId: ORG,
		});

		expect(result.configId).toBe("cpc_embed");
		expect(result.source).toBe("organization");
	});

	it("resolves a personal embeddings-only row", async () => {
		userRows.push(
			providerRow({
				id: "ucpc_embed",
				userId: USER,
				isEmbeddingProvider: true,
				purpose: "EMBEDDINGS_ONLY",
			}),
		);

		const result = await getEmbeddingProviderConfig({ userId: USER });

		expect(result.configId).toBe("ucpc_embed");
		expect(result.source).toBe("user");
	});
});
