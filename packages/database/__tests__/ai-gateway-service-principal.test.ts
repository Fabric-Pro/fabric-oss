/**
 * Tests for AI provider credential reads with service-principal (OAuth M2M)
 * configs.
 *
 * The read paths used to gate on `if (apiKey)`. A Databricks service-principal
 * row has a NULL `encrypted_api_key` — it mints a token instead — so that bare
 * check would silently treat it as unconfigured and fall through to the next
 * config source (or report "no AI provider configured"). These tests pin the
 * corrected behaviour, and that both credential columns are selected and
 * surfaced so the caller can resolve a token.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { orgFindFirst, userFindFirst } = vi.hoisted(() => ({
	orgFindFirst: vi.fn(),
	userFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		cloudProviderConfig: { findFirst: orgFindFirst },
		userCloudProviderConfig: { findFirst: userFindFirst },
	},
}));

vi.mock("@repo/config", () => ({
	// Platform gateway fallback disabled so an unconfigured tenant resolves to
	// the empty config rather than the shared gateway key.
	config: {
		ai: { enableGateway: false, gatewayApiKey: null, enabledProviders: [] },
	},
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
}));

import {
	getAiProviderApiKey,
	getAiProviderApiKeyByProvider,
	getEmbeddingProviderConfig,
} from "../prisma/queries/ai-gateway";

const WORKSPACE = "https://example-workspace.cloud.databricks.com";

/** A Databricks row authenticating with a service principal (no API key). */
const servicePrincipalRow = {
	id: "ucpc_1",
	provider: "DATABRICKS",
	encryptedApiKey: null,
	clientId: "client-abc",
	encryptedClientSecret: "encrypted:secret-xyz",
	config: { baseUrl: WORKSPACE },
};

/** A Databricks row authenticating with a PAT (the pre-existing shape). */
const patRow = {
	id: "ucpc_2",
	provider: "DATABRICKS",
	encryptedApiKey: "encrypted:dapi-token",
	clientId: null,
	encryptedClientSecret: null,
	config: { baseUrl: WORKSPACE },
};

beforeEach(() => {
	vi.clearAllMocks();
	orgFindFirst.mockResolvedValue(null);
	userFindFirst.mockResolvedValue(null);
});

describe("getAiProviderApiKey", () => {
	it("treats a service-principal row as configured and returns its credentials", async () => {
		userFindFirst.mockResolvedValue(servicePrincipalRow);

		const result = await getAiProviderApiKey({ userId: "user-1" });

		expect(result.provider).toBe("DATABRICKS");
		expect(result.configId).toBe("ucpc_1");
		expect(result.source).toBe("user");
		// No API key — the caller mints a token from these instead.
		expect(result.apiKey).toBeNull();
		expect(result.clientId).toBe("client-abc");
		expect(result.encryptedClientSecret).toBe("encrypted:secret-xyz");
		expect(result.baseUrl).toBe(WORKSPACE);
	});

	it("still returns a PAT row unchanged (regression guard)", async () => {
		userFindFirst.mockResolvedValue(patRow);

		const result = await getAiProviderApiKey({ userId: "user-1" });

		expect(result.apiKey).toBe("encrypted:dapi-token");
		expect(result.clientId).toBeNull();
		expect(result.encryptedClientSecret).toBeNull();
	});

	it("selects both credential columns so a token can be resolved", async () => {
		userFindFirst.mockResolvedValue(servicePrincipalRow);

		await getAiProviderApiKey({ userId: "user-1" });

		expect(userFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				select: expect.objectContaining({
					encryptedApiKey: true,
					clientId: true,
					encryptedClientSecret: true,
				}),
			}),
		);
	});

	it("does NOT fall through to personal config when the ORG row is a service principal", async () => {
		// The bug this guards: an org-level OAuth config has no apiKey, so the
		// old `if (apiKey)` check skipped it and silently used the user's key.
		orgFindFirst.mockResolvedValue({
			...servicePrincipalRow,
			id: "cpc_1",
		});
		userFindFirst.mockResolvedValue(patRow);

		const result = await getAiProviderApiKey({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(result.source).toBe("organization");
		expect(result.configId).toBe("cpc_1");
		expect(userFindFirst).not.toHaveBeenCalled();
	});

	it("falls through when a row carries only HALF a service principal", async () => {
		orgFindFirst.mockResolvedValue({
			...servicePrincipalRow,
			id: "cpc_1",
			encryptedClientSecret: null,
		});
		userFindFirst.mockResolvedValue(patRow);

		const result = await getAiProviderApiKey({
			userId: "user-1",
			organizationId: "org-1",
		});

		// An incomplete credential is not usable — treat it as unconfigured.
		expect(result.source).toBe("user");
		expect(result.apiKey).toBe("encrypted:dapi-token");
	});

	it("returns the empty config when nothing is configured", async () => {
		const result = await getAiProviderApiKey({ userId: "user-1" });

		expect(result.provider).toBeNull();
		expect(result.apiKey).toBeNull();
		expect(result.clientId).toBeNull();
		expect(result.encryptedClientSecret).toBeNull();
	});
});

describe("getEmbeddingProviderConfig", () => {
	it("treats a service-principal embedding provider as configured", async () => {
		userFindFirst.mockResolvedValue(servicePrincipalRow);

		const result = await getEmbeddingProviderConfig({ userId: "user-1" });

		expect(result.provider).toBe("DATABRICKS");
		expect(result.clientId).toBe("client-abc");
		expect(result.encryptedClientSecret).toBe("encrypted:secret-xyz");
	});

	it("selects both credential columns", async () => {
		userFindFirst.mockResolvedValue(servicePrincipalRow);

		await getEmbeddingProviderConfig({ userId: "user-1" });

		expect(userFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				select: expect.objectContaining({
					clientId: true,
					encryptedClientSecret: true,
				}),
			}),
		);
	});
});

describe("getAiProviderApiKeyByProvider", () => {
	it("treats a service-principal row as configured for the requested provider", async () => {
		userFindFirst.mockResolvedValue(servicePrincipalRow);

		const result = await getAiProviderApiKeyByProvider({
			userId: "user-1",
			provider: "DATABRICKS",
		});

		expect(result.provider).toBe("DATABRICKS");
		expect(result.clientId).toBe("client-abc");
		expect(result.encryptedClientSecret).toBe("encrypted:secret-xyz");
	});

	it("selects both credential columns", async () => {
		userFindFirst.mockResolvedValue(servicePrincipalRow);

		await getAiProviderApiKeyByProvider({
			userId: "user-1",
			provider: "DATABRICKS",
		});

		expect(userFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				select: expect.objectContaining({
					clientId: true,
					encryptedClientSecret: true,
				}),
			}),
		);
	});
});
