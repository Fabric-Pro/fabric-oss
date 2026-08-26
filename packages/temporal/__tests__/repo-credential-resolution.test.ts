/**
 * Repository Credential Resolution Tests
 *
 * Tests for findMcpConfigsForRepos with project-level credential priority:
 * - Project integration takes priority over user MCP config
 * - Falls back to user MCP config when no project integration
 * - Expired project integrations are skipped (status !== ACTIVE)
 * - usedProjectCredentials flag set correctly
 *
 * Run with: pnpm --filter @repo/temporal test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/database
const mockFindProjectRepoCredentials = vi.fn();
const mockGetMcpServerByKey = vi.fn();
const mockGetMcpConfigForTenantAndServer = vi.fn();
const mockDbMcpConfigFindFirst = vi.fn();

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		mCPConfig: {
			findFirst: (...args: unknown[]) =>
				mockDbMcpConfigFindFirst(...args),
		},
		mCPServer: {
			findFirst: vi.fn(),
		},
		workflowIntegration: {
			findFirst: vi.fn().mockResolvedValue(null),
		},
	},
	findProjectRepoCredentials: (...args: unknown[]) =>
		mockFindProjectRepoCredentials(...args),
	getMcpServerByKey: (...args: unknown[]) => mockGetMcpServerByKey(...args),
	getMcpConfigForTenantAndServer: (...args: unknown[]) =>
		mockGetMcpConfigForTenantAndServer(...args),
	// Provider constants needed by @repo/ai gateway-config.ts at import time
	GATEWAY_PROVIDERS: [
		"VERCEL_GATEWAY",
		"OPENROUTER",
		"CLOUDFLARE_AI",
	] as const,
	DIRECT_PROVIDERS: ["OPENAI_DIRECT", "ANTHROPIC_DIRECT", "GROQ"] as const,
	AI_PROVIDER_METADATA: {},
	isGatewayProvider: () => false,
	isDirectProvider: () => false,
	getProviderDisplayName: (p: string) => p,
	getProviderMetadata: () => undefined,
}));

import { findMcpConfigsForRepos } from "../src/activities/code-based-setup";

describe("findMcpConfigsForRepos — credential resolution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses project integration when available (priority over user MCP)", async () => {
		mockFindProjectRepoCredentials.mockResolvedValueOnce({
			source: "project",
			integrationId: "int-1",
			provider: "GITHUB",
			encryptedAccessToken: "enc-token",
			authMethod: "OAUTH",
		});

		// Project credentials provide auth, but we still look up the MCP config
		// for tool definitions so the orchestrator can discover GitHub tools
		mockGetMcpServerByKey.mockResolvedValueOnce({ id: "server-1" });
		mockGetMcpConfigForTenantAndServer.mockResolvedValueOnce({
			id: "config-1",
			enabled: true,
		});

		const result = await findMcpConfigsForRepos({
			repoUrls: ["https://github.com/owner/repo"],
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
		});

		expect(result.mappings).toHaveLength(1);
		// mcpConfigId is the REAL config (for tool loading), not synthetic
		expect(result.mappings[0].mcpConfigId).toBe("config-1");
		expect(result.mappings[0].projectIntegrationId).toBe("int-1");
		expect(result.usedProjectCredentials).toBe(true);
		// Real MCP config added for tool loading
		expect(result.allMcpConfigIds).toContain("config-1");
	});

	it("falls back to user MCP config when no project integration", async () => {
		mockFindProjectRepoCredentials.mockResolvedValueOnce({
			source: "none",
			reason: "No active project-level integration",
		});

		mockGetMcpServerByKey.mockResolvedValueOnce({ id: "server-1" });
		mockGetMcpConfigForTenantAndServer.mockResolvedValueOnce({
			id: "config-1",
			enabled: true,
		});

		const result = await findMcpConfigsForRepos({
			repoUrls: ["https://github.com/owner/repo"],
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
		});

		expect(result.mappings).toHaveLength(1);
		expect(result.mappings[0].mcpConfigId).toBe("config-1");
		expect(result.mappings[0].projectIntegrationId).toBeUndefined();
		expect(result.usedProjectCredentials).toBe(false);
	});

	it("skips projectId lookup when not provided (backward compat)", async () => {
		mockGetMcpServerByKey.mockResolvedValueOnce({ id: "server-1" });
		mockGetMcpConfigForTenantAndServer.mockResolvedValueOnce({
			id: "config-1",
			enabled: true,
		});

		const result = await findMcpConfigsForRepos({
			repoUrls: ["https://github.com/owner/repo"],
			userId: "user-1",
			// No projectId
		});

		expect(mockFindProjectRepoCredentials).not.toHaveBeenCalled();
		expect(result.mappings).toHaveLength(1);
		expect(result.mappings[0].mcpConfigId).toBe("config-1");
		expect(result.usedProjectCredentials).toBe(false);
	});

	it("returns empty when both project and user credentials are absent", async () => {
		mockFindProjectRepoCredentials.mockResolvedValueOnce({
			source: "none",
			reason: "No active project-level integration",
		});

		mockGetMcpServerByKey.mockResolvedValueOnce(null);
		mockDbMcpConfigFindFirst.mockResolvedValueOnce(null);

		const result = await findMcpConfigsForRepos({
			repoUrls: ["https://github.com/owner/repo"],
			userId: "user-1",
			projectId: "project-1",
		});

		expect(result.mappings).toHaveLength(0);
		expect(result.usedProjectCredentials).toBe(false);
	});

	it("handles multiple repos with mixed credential sources", async () => {
		// First repo: project integration
		mockFindProjectRepoCredentials.mockResolvedValueOnce({
			source: "project",
			integrationId: "int-1",
			provider: "GITHUB",
		});

		// Second repo: no project integration
		mockFindProjectRepoCredentials.mockResolvedValueOnce({
			source: "none",
			reason: "Not found",
		});

		mockGetMcpServerByKey.mockResolvedValueOnce({ id: "server-1" });
		mockGetMcpConfigForTenantAndServer.mockResolvedValueOnce({
			id: "config-1",
			enabled: true,
		});

		const result = await findMcpConfigsForRepos({
			repoUrls: [
				"https://github.com/owner/repo1",
				"https://github.com/owner/repo2",
			],
			userId: "user-1",
			projectId: "project-1",
		});

		expect(result.mappings).toHaveLength(2);
		expect(result.mappings[0].projectIntegrationId).toBe("int-1");
		expect(result.mappings[1].mcpConfigId).toBe("config-1");
		expect(result.usedProjectCredentials).toBe(true);
	});

	it("skips empty/blank URLs", async () => {
		mockFindProjectRepoCredentials.mockResolvedValueOnce({
			source: "project",
			integrationId: "int-1",
			provider: "GITHUB",
		});

		const result = await findMcpConfigsForRepos({
			repoUrls: ["", "  ", "https://github.com/owner/repo"],
			userId: "user-1",
			projectId: "project-1",
		});

		// Only the valid URL should be processed
		expect(mockFindProjectRepoCredentials).toHaveBeenCalledTimes(1);
		expect(result.mappings).toHaveLength(1);
	});

	it("skips unknown provider URLs", async () => {
		mockFindProjectRepoCredentials.mockResolvedValueOnce({
			source: "none",
			reason: "Cannot parse repo URL",
		});

		const result = await findMcpConfigsForRepos({
			repoUrls: ["https://gitlab.com/owner/repo"],
			userId: "user-1",
			projectId: "project-1",
		});

		// gitlab.com isn't recognized as GitHub or ADO by the URL detection
		expect(result.mappings).toHaveLength(0);
	});
});
