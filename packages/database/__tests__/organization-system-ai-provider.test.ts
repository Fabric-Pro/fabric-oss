/**
 * `getOrganizationSystemAiProviderApiKey` (company context, Fizzy #2719).
 *
 * The background resolver without its personal rung: the organization's own
 * default provider, else the deployment's gateway key. An organization-wide
 * index resolves its embedding model through it, so the model cannot depend on
 * which member is acting. What this pins: it never reads a personal provider,
 * and `getSystemAiProviderApiKey` — which every other caller uses — still does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { orgFindFirst, userFindFirst, aiConfig } = vi.hoisted(() => ({
	orgFindFirst: vi.fn(),
	userFindFirst: vi.fn(),
	aiConfig: {
		enableGateway: false,
		gatewayApiKey: null as string | null,
		enabledProviders: ["openai"],
	},
}));

vi.mock("../prisma/client", () => ({
	db: {
		cloudProviderConfig: { findFirst: orgFindFirst },
		userCloudProviderConfig: { findFirst: userFindFirst },
	},
}));

vi.mock("@repo/config", () => ({
	config: { ai: aiConfig },
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
}));

import {
	getOrganizationSystemAiProviderApiKey,
	getSystemAiProviderApiKey,
} from "../prisma/queries/ai-gateway";

const ORG = "org-1";

const orgRow = {
	id: "cpc_org",
	provider: "OPENAI_DIRECT",
	encryptedApiKey: "encrypted:org-key",
	clientId: null,
	encryptedClientSecret: null,
	config: {},
};

const personalRow = {
	id: "ucpc_personal",
	provider: "MISTRAL",
	encryptedApiKey: "encrypted:personal-key",
	clientId: null,
	encryptedClientSecret: null,
	config: {},
};

beforeEach(() => {
	vi.clearAllMocks();
	aiConfig.enableGateway = false;
	aiConfig.gatewayApiKey = null;
	orgFindFirst.mockResolvedValue(null);
	userFindFirst.mockResolvedValue(personalRow);
});

describe("getOrganizationSystemAiProviderApiKey", () => {
	it("returns the organization's default provider", async () => {
		orgFindFirst.mockResolvedValue(orgRow);

		const result = await getOrganizationSystemAiProviderApiKey({
			organizationId: ORG,
		});

		expect(result.provider).toBe("OPENAI_DIRECT");
		expect(result.configId).toBe("cpc_org");
		expect(result.source).toBe("organization");
		expect(orgFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId: ORG,
					isDefault: true,
					enabled: true,
					purpose: { not: "EMBEDDINGS_ONLY" },
				},
			}),
		);
		expect(userFindFirst).not.toHaveBeenCalled();
	});

	it("falls back to the deployment's gateway, never a personal provider", async () => {
		aiConfig.enableGateway = true;
		aiConfig.gatewayApiKey = "gateway-key";

		const result = await getOrganizationSystemAiProviderApiKey({
			organizationId: ORG,
		});

		expect(result.provider).toBe("VERCEL_GATEWAY");
		expect(result.apiKey).toBe("encrypted:gateway-key");
		expect(result.source).toBeNull();
		expect(userFindFirst).not.toHaveBeenCalled();
	});

	it("resolves nothing configured when the organization has no provider and there is no gateway", async () => {
		const result = await getOrganizationSystemAiProviderApiKey({
			organizationId: ORG,
		});

		expect(result.provider).toBeNull();
		expect(result.apiKey).toBeNull();
		expect(userFindFirst).not.toHaveBeenCalled();
	});

	it("refuses to resolve without an organization", async () => {
		await expect(
			getOrganizationSystemAiProviderApiKey({ organizationId: "" }),
		).rejects.toThrow(/requires an organizationId/);
		expect(orgFindFirst).not.toHaveBeenCalled();
	});
});

describe("getSystemAiProviderApiKey (unchanged)", () => {
	it("still falls back to the acting user's personal provider inside an organization", async () => {
		const result = await getSystemAiProviderApiKey({
			userId: "user-1",
			organizationId: ORG,
		});

		expect(result.provider).toBe("MISTRAL");
		expect(result.source).toBe("user");
	});

	it("still prefers the organization's default provider", async () => {
		orgFindFirst.mockResolvedValue(orgRow);

		const result = await getSystemAiProviderApiKey({
			userId: "user-1",
			organizationId: ORG,
		});

		expect(result.provider).toBe("OPENAI_DIRECT");
		expect(userFindFirst).not.toHaveBeenCalled();
	});
});
