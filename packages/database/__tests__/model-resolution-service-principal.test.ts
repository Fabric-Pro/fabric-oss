/**
 * Tests for `resolveModelWithCredentials` with a service-principal config.
 *
 * This resolver backs several Temporal activities. It used to require
 * `providerConfig.apiKey`, so an OAuth-only Databricks tenant hit
 * "No API key configured" before any work started. It must now accept either
 * credential shape and pass the service-principal fields through, since
 * `@repo/database` cannot mint the token itself (that would invert the
 * dependency on `@repo/ai`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSystemAiProviderApiKey, getModelForTask } = vi.hoisted(() => ({
	// The SYSTEM entry point, not the tenant-facing one: `resolveModelWithCredentials`
	// backs background work (Temporal activities, agent runtimes), which keeps the
	// platform-gateway fallback the user-facing resolver no longer has.
	getSystemAiProviderApiKey: vi.fn(),
	getModelForTask: vi.fn(),
}));

vi.mock("../prisma/queries/ai-gateway", async (importOriginal) => {
	// Keep the real `hasProviderCredentials` — it is the predicate under test.
	const actual =
		await importOriginal<typeof import("../prisma/queries/ai-gateway")>();
	return { ...actual, getSystemAiProviderApiKey };
});

vi.mock("../prisma/queries/ai-models", () => ({ getModelForTask }));

vi.mock("../prisma/client", () => ({
	db: {},
}));

import { resolveModelWithCredentials } from "../prisma/queries/model-resolution";

const WORKSPACE = "https://example-workspace.cloud.databricks.com";

const servicePrincipalConfig = {
	apiKey: null,
	configId: "ucpc_1",
	provider: "DATABRICKS",
	baseUrl: WORKSPACE,
	enabledProviders: [],
	source: "user" as const,
	deploymentName: null,
	clientId: "client-abc",
	encryptedClientSecret: "encrypted:secret-xyz",
};

beforeEach(() => {
	vi.clearAllMocks();
	getModelForTask.mockResolvedValue({
		canonicalName: "claude-sonnet-5",
		providerModelId: "databricks-claude-sonnet-5",
		source: "system_default",
	});
});

describe("resolveModelWithCredentials", () => {
	it("resolves for an OAuth-only config instead of throwing 'no API key'", async () => {
		getSystemAiProviderApiKey.mockResolvedValue(servicePrincipalConfig);

		const resolved = await resolveModelWithCredentials({
			userId: "user-1",
			organizationId: null,
			taskType: "EMBEDDING",
		});

		expect(resolved.provider).toBe("DATABRICKS");
		expect(resolved.apiKey).toBeNull();
		// Passed through so a consumer can mint the bearer token.
		expect(resolved.clientId).toBe("client-abc");
		expect(resolved.encryptedClientSecret).toBe("encrypted:secret-xyz");
		expect(resolved.baseUrl).toBe(WORKSPACE);
	});

	it("still resolves a PAT config unchanged (regression guard)", async () => {
		getSystemAiProviderApiKey.mockResolvedValue({
			...servicePrincipalConfig,
			apiKey: "encrypted:dapi-token",
			clientId: null,
			encryptedClientSecret: null,
		});

		const resolved = await resolveModelWithCredentials({
			userId: "user-1",
			organizationId: null,
			taskType: "EMBEDDING",
		});

		expect(resolved.apiKey).toBe("encrypted:dapi-token");
		expect(resolved.clientId).toBeNull();
		expect(resolved.encryptedClientSecret).toBeNull();
	});

	it("throws when the config carries no credentials at all", async () => {
		getSystemAiProviderApiKey.mockResolvedValue({
			...servicePrincipalConfig,
			apiKey: null,
			clientId: null,
			encryptedClientSecret: null,
		});

		await expect(
			resolveModelWithCredentials({
				userId: "user-1",
				organizationId: null,
				taskType: "EMBEDDING",
			}),
		).rejects.toThrow(/No credentials configured/i);
	});

	it("throws when only HALF a service principal is stored", async () => {
		getSystemAiProviderApiKey.mockResolvedValue({
			...servicePrincipalConfig,
			encryptedClientSecret: null,
		});

		await expect(
			resolveModelWithCredentials({
				userId: "user-1",
				organizationId: null,
				taskType: "EMBEDDING",
			}),
		).rejects.toThrow(/No credentials configured/i);
	});

	it("throws when no provider is configured at all", async () => {
		getSystemAiProviderApiKey.mockResolvedValue({
			...servicePrincipalConfig,
			provider: null,
		});

		await expect(
			resolveModelWithCredentials({
				userId: "user-1",
				organizationId: null,
				taskType: "EMBEDDING",
			}),
		).rejects.toThrow(/No AI provider configured/i);
	});
});
