/**
 * An organization whose only API key is "embeddings only" (Fizzy #2770 F11).
 *
 * LLM work gets the ordinary provider-not-configured refusal; embeddings —
 * model resolution and the background gate in front of every embedding job —
 * still resolve on that key.
 *
 * Unlike the neighbouring suites, the REAL `ai-gateway` queries run here: only
 * the Prisma client under them is faked, by an in-memory table that evaluates
 * each query's `where`. The purpose filter is a database-layer rule, so a mock
 * at the `@repo/database` boundary would assume the very thing under test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const { orgRows, userRows, getModelForTask } = vi.hoisted(() => ({
	orgRows: [] as Record<string, unknown>[],
	userRows: [] as Record<string, unknown>[],
	getModelForTask: vi.fn(),
}));

vi.mock("../../database/prisma/client", () => {
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
	const table = (rows: Row[]) => ({
		findFirst: vi.fn(async ({ where }: { where: Row }) => {
			const row = rows.find((r) => matches(r, where));
			return row ? { ...row } : null;
		}),
	});
	return {
		db: {
			cloudProviderConfig: table(orgRows),
			userCloudProviderConfig: table(userRows),
		},
	};
});

vi.mock("@repo/database", async () => {
	const gateway = await vi.importActual<Record<string, unknown>>(
		"../../database/prisma/queries/ai-gateway",
	);
	return {
		...gateway,
		GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
		getActiveModels: vi.fn(),
		getProviderModelIdForCanonical: vi.fn(),
		getModelForTask,
		getTaskDefaultModel: vi.fn(),
		logAiUsageAsync: vi.fn(),
	};
});

vi.mock("@repo/config", async (importOriginal) => {
	const actual = await importOriginal<{ config: Record<string, unknown> }>();
	return {
		...actual,
		config: {
			...actual.config,
			ai: {
				enableGateway: false,
				gatewayApiKey: null,
				enabledProviders: [],
			},
		},
	};
});

vi.mock("@repo/payments", () => ({
	assertWithinAiUsageLimits: vi.fn(),
	getTenantAiGatewayBillingState: vi.fn(() => ({
		mode: "external_provider",
		headers: null,
	})),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
	decryptApiKey: vi.fn((value: string) => value.replace("encrypted:", "")),
	decryptApiKeyMaybe: vi.fn((value: string) =>
		value.replace("encrypted:", ""),
	),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
	AIProviderNotConfiguredError,
	getEmbeddingRAGProviderConfig,
	getRAGProviderConfig,
	getSystemEmbeddingRAGProviderConfig,
	getSystemRAGProviderConfig,
	resolveModelWithProvider,
} from "../lib/dynamic-model-selector";

const CONTEXT = { userId: "user-1", organizationId: "org-1" };

function embeddingsOnlyRow(): Row {
	return {
		id: "cpc_embed",
		organizationId: "org-1",
		provider: "OPENAI_DIRECT",
		enabled: true,
		isDefault: false,
		isEmbeddingProvider: true,
		purpose: "EMBEDDINGS_ONLY",
		encryptedApiKey: "encrypted:sk-embed",
		clientId: null,
		encryptedClientSecret: null,
		config: {},
	};
}

beforeEach(() => {
	orgRows.length = 0;
	userRows.length = 0;
	orgRows.push(embeddingsOnlyRow());
	getModelForTask.mockResolvedValue({
		providerModelId: "text-embedding-3-small",
		provider: "OPENAI_DIRECT",
		selectionSource: "system_default",
		model: { canonicalName: "text-embedding-3-small" },
	});
});

describe("an organization whose only key is embeddings-only", () => {
	it("refuses LLM model resolution as provider-not-configured", async () => {
		const resolved = await resolveModelWithProvider("CHAT", CONTEXT);

		expect(resolved.apiKey).toBeNull();
		expect(resolved.selectionSource).toBe("none");
		expect(getModelForTask).not.toHaveBeenCalled();
	});

	it("refuses the tenant RAG resolver and the system one alike", async () => {
		await expect(getRAGProviderConfig(CONTEXT)).rejects.toBeInstanceOf(
			AIProviderNotConfiguredError,
		);
		await expect(
			getSystemRAGProviderConfig(CONTEXT),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
	});

	it("still resolves the embedding model on that key", async () => {
		const resolved = await resolveModelWithProvider("EMBEDDING", CONTEXT);

		expect(resolved.provider).toBe("OPENAI_DIRECT");
		expect(resolved.apiKey).toBe("encrypted:sk-embed");
		expect(resolved.configId).toBe("cpc_embed");
	});

	it("still passes the gate in front of background embedding jobs", async () => {
		const config = await getSystemEmbeddingRAGProviderConfig(CONTEXT);

		expect(config.provider).toBe("OPENAI_DIRECT");
		expect(config.apiKey).toBe("sk-embed");
		expect(config.source).toBe("organization");
	});

	it("still passes the gate in front of a person's search or upload", async () => {
		const config = await getEmbeddingRAGProviderConfig(CONTEXT);

		expect(config.provider).toBe("OPENAI_DIRECT");
		expect(config.apiKey).toBe("sk-embed");
		expect(config.source).toBe("organization");
	});

	it("leaves the person-facing embedding gate refusing when there is no key at all", async () => {
		orgRows.length = 0;
		await expect(
			getEmbeddingRAGProviderConfig(CONTEXT),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
	});

	it("an ordinary (purpose ALL) key keeps serving LLM work exactly as before", async () => {
		orgRows[0] = {
			...embeddingsOnlyRow(),
			isDefault: true,
			purpose: "ALL",
		};

		const config = await getRAGProviderConfig(CONTEXT);

		expect(config.provider).toBe("OPENAI_DIRECT");
	});
});
