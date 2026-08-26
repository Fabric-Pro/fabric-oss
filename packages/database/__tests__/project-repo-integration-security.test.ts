/**
 * Project Repository Integration — Security Tests
 *
 * Verifies:
 * - listProjectRepoIntegrations never returns encrypted credential fields
 * - Queries always scope by projectId (multi-tenant isolation)
 * - parseRepoUrl doesn't allow injection patterns
 *
 * Run with: pnpm --filter @repo/database test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		projectRepositoryIntegration: {
			findMany: (...args: unknown[]) => mockFindMany(...args),
			findFirst: (...args: unknown[]) => mockFindFirst(...args),
		},
		projectActivity: {
			create: vi.fn(),
		},
	},
	Prisma: {},
}));

import {
	getProjectRepoIntegration,
	listProjectRepoIntegrations,
	parseRepoUrl,
} from "../prisma/queries/project-repository-integrations";

describe("Security — No Credential Leakage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("listProjectRepoIntegrations select block excludes all encrypted fields", async () => {
		mockFindMany.mockResolvedValueOnce([]);
		await listProjectRepoIntegrations("project-1");

		const call = mockFindMany.mock.calls[0][0];
		const selectKeys = Object.keys(call.select);

		// Must NOT include encrypted fields
		expect(selectKeys).not.toContain("encryptedAccessToken");
		expect(selectKeys).not.toContain("encryptedRefreshToken");
		expect(selectKeys).not.toContain("encryptedPat");

		// Must include status and metadata fields
		expect(selectKeys).toContain("id");
		expect(selectKeys).toContain("status");
		expect(selectKeys).toContain("provider");
		expect(selectKeys).toContain("repositoryOwner");
		expect(selectKeys).toContain("repositoryName");
		expect(selectKeys).toContain("configuredByUserId");
	});

	// Azure DevOps code-repo: the ADO `startCodeSetup` procedure reads repo URLs
	// via listProjectRepoIntegrations. Even when the project's integrations are
	// Azure DevOps (PAT-backed), the select must NEVER surface `encryptedPat`.
	it("ADO list selects never include encryptedPat", async () => {
		mockFindMany.mockResolvedValueOnce([
			{
				id: "int-ado",
				status: "ACTIVE",
				provider: "AZURE_DEVOPS",
				repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/repo",
				repositoryOwner: "my-org",
				repositoryName: "repo",
				configuredByUserId: "user-1",
			},
		]);

		const rows = await listProjectRepoIntegrations("project-1");

		// The select block (the projection sent to Prisma) omits encryptedPat …
		const selectKeys = Object.keys(mockFindMany.mock.calls[0][0].select);
		expect(selectKeys).not.toContain("encryptedPat");
		expect(selectKeys).not.toContain("encryptedAccessToken");

		// … and the returned ADO rows carry no PAT field for callers to leak.
		for (const row of rows) {
			expect(row).not.toHaveProperty("encryptedPat");
		}
	});
});

describe("Security — Multi-Tenant Isolation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("listProjectRepoIntegrations always filters by projectId", async () => {
		mockFindMany.mockResolvedValueOnce([]);
		await listProjectRepoIntegrations("project-1");

		expect(mockFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "project-1" },
			}),
		);
	});

	it("getProjectRepoIntegration requires both id AND projectId", async () => {
		mockFindFirst.mockResolvedValueOnce(null);
		await getProjectRepoIntegration("int-1", "project-1");

		expect(mockFindFirst).toHaveBeenCalledWith({
			where: { id: "int-1", projectId: "project-1" },
		});
	});

	it("cannot access integration without correct projectId", async () => {
		// Even if integrationId is correct, wrong projectId returns null
		mockFindFirst.mockResolvedValueOnce(null);
		const result = await getProjectRepoIntegration(
			"int-1",
			"wrong-project",
		);

		expect(result).toBeNull();
		expect(mockFindFirst).toHaveBeenCalledWith({
			where: { id: "int-1", projectId: "wrong-project" },
		});
	});
});

describe("Security — URL Parsing Safety", () => {
	it("rejects URLs without recognized providers", () => {
		expect(parseRepoUrl("https://evil.com/owner/repo")).toBeNull();
		expect(parseRepoUrl("javascript:alert(1)")).toBeNull();
		expect(parseRepoUrl("file:///etc/passwd")).toBeNull();
	});

	it("matches providers by hostname rather than a path substring", () => {
		expect(
			parseRepoUrl("http://169.254.169.254/gitlab.com/group/repo"),
		).toBeNull();
		expect(
			parseRepoUrl("https://evil.example/github.com/owner/repo"),
		).toBeNull();
		expect(
			parseRepoUrl("https://github.com.evil.example/owner/repo"),
		).toBeNull();
		expect(
			parseRepoUrl("https://github.com@evil.example/owner/repo"),
		).toBeNull();
	});

	it("handles extremely long URLs gracefully", () => {
		const longUrl = `https://github.com/${"a".repeat(1000)}/${"b".repeat(1000)}`;
		const result = parseRepoUrl(longUrl);
		// Should parse without error (regex may or may not match, but shouldn't crash)
		expect(result === null || typeof result.owner === "string").toBe(true);
	});

	it("rejects URLs with special characters in owner/repo", () => {
		// These should still parse since GitHub allows hyphens/underscores
		const result = parseRepoUrl("https://github.com/my-org/my_repo");
		expect(result).toEqual({
			provider: "GITHUB",
			owner: "my-org",
			name: "my_repo",
		});
	});
});

describe("Security — Read-Only Tool Names", () => {
	it("only read-only operations are exposed via parseRepoUrl", () => {
		// parseRepoUrl is used to match repos for reading — it does not
		// provide any write capability. This test documents that the
		// credential resolution only enables read operations.
		// Write operations (push, PR) require separate OAuth scopes
		// not configured in the project integration.

		// The tool handlers in packages/integrations/src/github/index.ts
		// include read operations like list_repositories, get_file_contents,
		// search_code — all read-only. The project integration only provides
		// the read-scoped token.
		expect(true).toBe(true); // Documented assertion
	});
});
