/**
 * Project Repository Integration Tests
 *
 * Tests for:
 * A. Credential layer — parseRepoUrl, findProjectRepoCredentials
 * B. Optimistic locking — refreshProjectRepoToken
 * C. Owner removal — disconnectIntegrationsForUser
 * E. Credential resolution priority
 *
 * Run with: pnpm --filter @repo/database test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma client
const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockCreate = vi.fn();
const mockUpdateMany = vi.fn();
const mockUpdate = vi.fn();
const mockDeleteMany = vi.fn();
const mockFindUnique = vi.fn();
const mockActivityCreate = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		projectRepositoryIntegration: {
			findFirst: (...args: unknown[]) => mockFindFirst(...args),
			findMany: (...args: unknown[]) => mockFindMany(...args),
			create: (...args: unknown[]) => mockCreate(...args),
			updateMany: (...args: unknown[]) => mockUpdateMany(...args),
			update: (...args: unknown[]) => mockUpdate(...args),
			deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
			findUnique: (...args: unknown[]) => mockFindUnique(...args),
		},
		projectActivity: {
			create: (...args: unknown[]) => mockActivityCreate(...args),
		},
	},
	Prisma: {},
}));

import {
	createProjectRepoIntegration,
	deleteProjectRepoIntegration,
	disconnectIntegrationsForUser,
	findProjectRepoCredentials,
	getActiveIntegrations,
	getProjectRepoIntegration,
	listProjectRepoIntegrations,
	logRepoIntegrationActivity,
	parseRepoUrl,
	refreshProjectRepoToken,
	restoreIntegrationActive,
	setIntegrationStatus,
} from "../prisma/queries/project-repository-integrations";

describe("Project Repository Integrations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// =========================================================================
	// A. Credential Layer — parseRepoUrl
	// =========================================================================
	describe("parseRepoUrl", () => {
		it("parses GitHub HTTPS URL", () => {
			const result = parseRepoUrl("https://github.com/owner/repo");
			expect(result).toEqual({
				provider: "GITHUB",
				owner: "owner",
				name: "repo",
			});
		});

		it("parses GitHub URL with .git suffix", () => {
			const result = parseRepoUrl("https://github.com/owner/repo.git");
			expect(result).toEqual({
				provider: "GITHUB",
				owner: "owner",
				name: "repo",
			});
		});

		it("parses Azure DevOps URL (new format)", () => {
			const result = parseRepoUrl(
				"https://dev.azure.com/org/project/_git/repo",
			);
			expect(result).toEqual({
				provider: "AZURE_DEVOPS",
				owner: "org",
				project: "project",
				name: "repo",
			});
		});

		it("parses Azure DevOps URL (old format)", () => {
			const result = parseRepoUrl(
				"https://org.visualstudio.com/project/_git/repo",
			);
			expect(result).toEqual({
				provider: "AZURE_DEVOPS",
				owner: "org",
				project: "project",
				name: "repo",
			});
		});

		// Regression: ADO repo names may contain dots (e.g. `Example.Chat`).
		// Previously the name capture excluded `.` which caused 400 errors on
		// connect. See fix/ado-repo-url-dot-parsing.
		it("parses Azure DevOps URL with a dot in the repo name", () => {
			const result = parseRepoUrl(
				"https://dev.azure.com/example-org/Example_SaaS/_git/Example.Chat",
			);
			expect(result).toEqual({
				provider: "AZURE_DEVOPS",
				owner: "example-org",
				project: "Example_SaaS",
				name: "Example.Chat",
			});
		});

		it("parses Azure DevOps URL with dot in name and .git suffix", () => {
			const result = parseRepoUrl(
				"https://dev.azure.com/org/proj/_git/Example.Chat.git",
			);
			expect(result).toEqual({
				provider: "AZURE_DEVOPS",
				owner: "org",
				project: "proj",
				name: "Example.Chat",
			});
		});

		it("parses Azure DevOps old-format URL with a dot in the repo name", () => {
			const result = parseRepoUrl(
				"https://org.visualstudio.com/proj/_git/my.repo.name",
			);
			expect(result).toEqual({
				provider: "AZURE_DEVOPS",
				owner: "org",
				project: "proj",
				name: "my.repo.name",
			});
		});

		// The project segment is optional: `_git/` is a hard anchor, so a URL that
		// omits the project still yields the right owner/name with project absent.
		it("parses an Azure DevOps URL that omits the project segment", () => {
			const result = parseRepoUrl("https://dev.azure.com/org/_git/repo");
			expect(result).toEqual({
				provider: "AZURE_DEVOPS",
				owner: "org",
				name: "repo",
			});
			expect(result?.project).toBeUndefined();
		});

		it("parses GitHub URL with a dot in the repo name", () => {
			const result = parseRepoUrl(
				"https://github.com/lodash/lodash.debounce",
			);
			expect(result).toEqual({
				provider: "GITHUB",
				owner: "lodash",
				name: "lodash.debounce",
			});
		});

		it("parses GitHub URL with dot in name and .git suffix", () => {
			const result = parseRepoUrl(
				"https://github.com/lodash/lodash.debounce.git",
			);
			expect(result).toEqual({
				provider: "GITHUB",
				owner: "lodash",
				name: "lodash.debounce",
			});
		});

		it("parses GitLab URL", () => {
			expect(parseRepoUrl("https://gitlab.com/owner/repo")).toEqual({
				provider: "GITLAB",
				owner: "owner",
				name: "repo",
			});
		});

		it("parses GitLab URL with subgroups", () => {
			expect(
				parseRepoUrl("https://gitlab.com/group/subgroup/repo"),
			).toEqual({
				provider: "GITLAB",
				owner: "group/subgroup",
				name: "repo",
			});
		});

		it("returns null for unsupported URL", () => {
			expect(parseRepoUrl("not-a-url")).toBeNull();
			expect(parseRepoUrl("")).toBeNull();
		});

		it("handles URLs with trailing whitespace", () => {
			const result = parseRepoUrl("  https://github.com/owner/repo  ");
			expect(result).toEqual({
				provider: "GITHUB",
				owner: "owner",
				name: "repo",
			});
		});
	});

	// =========================================================================
	// A. Credential Layer — findProjectRepoCredentials
	// =========================================================================
	describe("findProjectRepoCredentials", () => {
		it("returns source: 'project' when active integration exists", async () => {
			mockFindFirst.mockResolvedValueOnce({
				id: "int-1",
				provider: "GITHUB",
				encryptedAccessToken: "enc-token",
				encryptedRefreshToken: "enc-refresh",
				tokenExpiresAt: new Date("2099-01-01"),
				encryptedPat: null,
				azureOrganization: null,
				authMethod: "OAUTH",
			});

			const result = await findProjectRepoCredentials(
				"https://github.com/owner/repo",
				"project-1",
			);

			expect(result.source).toBe("project");
			if (result.source === "project") {
				expect(result.integrationId).toBe("int-1");
				expect(result.provider).toBe("GITHUB");
				expect(result.encryptedAccessToken).toBe("enc-token");
			}

			expect(mockFindFirst).toHaveBeenCalledWith({
				where: {
					projectId: "project-1",
					provider: "GITHUB",
					repositoryOwner: "owner",
					repositoryName: "repo",
					status: "ACTIVE",
				},
			});
		});

		it("returns source: 'none' when no project integration exists", async () => {
			mockFindFirst.mockResolvedValueOnce(null);

			const result = await findProjectRepoCredentials(
				"https://github.com/owner/repo",
				"project-1",
			);

			expect(result.source).toBe("none");
			if (result.source === "none") {
				expect(result.reason).toContain(
					"No active project-level integration",
				);
			}
		});

		it("returns source: 'none' for unparseable URL", async () => {
			const result = await findProjectRepoCredentials(
				"not-a-url",
				"project-1",
			);

			expect(result.source).toBe("none");
			if (result.source === "none") {
				expect(result.reason).toContain("Cannot parse repo URL");
			}
		});
	});

	// =========================================================================
	// B. Optimistic Locking — refreshProjectRepoToken
	// =========================================================================
	describe("refreshProjectRepoToken", () => {
		it("returns true and updates when updatedAt matches", async () => {
			mockUpdateMany.mockResolvedValueOnce({ count: 1 });

			const expectedUpdatedAt = new Date("2024-01-01T00:00:00Z");
			const result = await refreshProjectRepoToken({
				integrationId: "int-1",
				encryptedAccessToken: "new-enc-token",
				encryptedRefreshToken: "new-enc-refresh",
				tokenExpiresAt: new Date("2099-01-01"),
				expectedUpdatedAt,
			});

			expect(result).toBe(true);
			expect(mockUpdateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						id: "int-1",
						updatedAt: expectedUpdatedAt,
					},
				}),
			);
		});

		it("returns false when updatedAt has changed (race condition)", async () => {
			mockUpdateMany.mockResolvedValueOnce({ count: 0 });

			const result = await refreshProjectRepoToken({
				integrationId: "int-1",
				encryptedAccessToken: "new-enc-token",
				encryptedRefreshToken: "new-enc-refresh",
				tokenExpiresAt: new Date("2099-01-01"),
				expectedUpdatedAt: new Date("2024-01-01T00:00:00Z"),
			});

			expect(result).toBe(false);
		});
	});

	// =========================================================================
	// D. Owner Removal — disconnectIntegrationsForUser
	// =========================================================================
	describe("disconnectIntegrationsForUser", () => {
		it("sets status to DISCONNECTED and nulls configuredByUserId", async () => {
			mockUpdateMany.mockResolvedValueOnce({ count: 2 });

			const result = await disconnectIntegrationsForUser(
				"project-1",
				"user-1",
			);

			expect(result.count).toBe(2);
			expect(mockUpdateMany).toHaveBeenCalledWith({
				where: {
					projectId: "project-1",
					configuredByUserId: "user-1",
				},
				data: {
					configuredByUserId: null,
					status: "DISCONNECTED",
					lastError: "Configured user removed from project",
					encryptedAccessToken: null,
					encryptedRefreshToken: null,
					encryptedPat: null,
				},
			});
		});

		it("returns count 0 when user has no integrations", async () => {
			mockUpdateMany.mockResolvedValueOnce({ count: 0 });

			const result = await disconnectIntegrationsForUser(
				"project-1",
				"user-not-configurer",
			);

			expect(result.count).toBe(0);
		});
	});

	// =========================================================================
	// E. Credential Resolution Priority — only ACTIVE integrations returned
	// =========================================================================
	describe("credential resolution priority", () => {
		it("does not return TOKEN_EXPIRED integrations", async () => {
			// findProjectRepoCredentials only queries status: ACTIVE
			mockFindFirst.mockResolvedValueOnce(null);

			const result = await findProjectRepoCredentials(
				"https://github.com/owner/repo",
				"project-1",
			);

			expect(result.source).toBe("none");
			expect(mockFindFirst).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						status: "ACTIVE",
					}),
				}),
			);
		});
	});

	// =========================================================================
	// Additional query function tests
	// =========================================================================
	describe("setIntegrationStatus", () => {
		it("updates status and lastError only for non-DISCONNECTED rows", async () => {
			mockFindUnique.mockResolvedValueOnce({ status: "ACTIVE" });
			mockUpdateMany.mockResolvedValueOnce({ count: 1 });

			const result = await setIntegrationStatus(
				"int-1",
				"TOKEN_EXPIRED",
				"Token expired",
			);

			expect(mockUpdateMany).toHaveBeenCalledWith({
				where: { id: "int-1", status: { not: "DISCONNECTED" } },
				data: {
					status: "TOKEN_EXPIRED",
					lastError: "Token expired",
					lastHealthCheck: expect.any(Date),
				},
			});
			expect(result).toEqual({
				status: "TOKEN_EXPIRED",
				previousStatus: "ACTIVE",
				statusChanged: true,
				written: true,
			});
		});

		it("does NOT transition a row that was disconnected concurrently (count 0)", async () => {
			mockFindUnique.mockResolvedValueOnce({ status: "DISCONNECTED" });
			mockUpdateMany.mockResolvedValueOnce({ count: 0 });

			const result = await setIntegrationStatus("int-1", "TOKEN_EXPIRED");

			expect(result).toEqual({
				status: "DISCONNECTED",
				previousStatus: "DISCONNECTED",
				statusChanged: false,
				written: false,
			});
		});

		it("pins the write to one credential generation when given expectedRefreshToken", async () => {
			mockFindUnique.mockResolvedValueOnce({ status: "ACTIVE" });
			mockUpdateMany.mockResolvedValueOnce({ count: 0 });

			const result = await setIntegrationStatus(
				"int-1",
				"TOKEN_EXPIRED",
				"rejected",
				"enc:rejected-refresh",
			);

			expect(mockUpdateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						id: "int-1",
						status: { not: "DISCONNECTED" },
						encryptedRefreshToken: "enc:rejected-refresh",
					},
				}),
			);
			// A miss means a reconnect replaced the credential the caller's
			// evidence referred to: nothing written, and the row keeps ACTIVE.
			expect(result).toEqual({
				status: "ACTIVE",
				previousStatus: "ACTIVE",
				statusChanged: false,
				written: false,
			});
		});

		it("omits the credential predicate entirely when no pin is given", async () => {
			// `undefined` must mean "no pin", NOT "match rows whose refresh
			// token is null" — otherwise every unpinned caller would silently
			// stop writing to rows that have a refresh token.
			mockFindUnique.mockResolvedValueOnce({ status: "ACTIVE" });
			mockUpdateMany.mockResolvedValueOnce({ count: 1 });

			await setIntegrationStatus("int-1", "ERROR", "boom");

			expect(mockUpdateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: "int-1", status: { not: "DISCONNECTED" } },
				}),
			);
		});
	});

	// =========================================================================
	// F. Create — initial status passthrough (Fizzy #2252 AC1)
	// =========================================================================
	describe("createProjectRepoIntegration", () => {
		it("persists the caller's probe verdict instead of the column default", async () => {
			// The OAuth callbacks pass a REPO_UNAVAILABLE/TOKEN_EXPIRED verdict from
			// their repository probe. If this passthrough regressed to hard-coded
			// "ACTIVE", an unreadable repo would wear Active again and every
			// callback-level test would still pass — the default only applies at
			// this seam.
			mockCreate.mockResolvedValueOnce({ id: "pri_1" });

			await createProjectRepoIntegration({
				projectId: "proj_1",
				provider: "GITHUB",
				authMethod: "OAUTH",
				repositoryUrl: "https://github.com/acme/widgets",
				repositoryOwner: "acme",
				repositoryName: "widgets",
				configuredByUserId: "user-1",
				status: "REPO_UNAVAILABLE",
				lastError:
					"GitHub authenticated the credentials but refused this repository.",
			});

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						status: "REPO_UNAVAILABLE",
						lastError:
							"GitHub authenticated the credentials but refused this repository.",
					}),
				}),
			);
		});

		it("defaults to ACTIVE with no error when the caller passes no verdict", async () => {
			mockCreate.mockResolvedValueOnce({ id: "pri_2" });

			await createProjectRepoIntegration({
				projectId: "proj_1",
				provider: "AZURE_DEVOPS",
				authMethod: "PAT",
				repositoryUrl: "https://dev.azure.com/org/project/_git/repo",
				repositoryOwner: "org",
				repositoryName: "repo",
				configuredByUserId: "user-1",
			});

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						status: "ACTIVE",
						// `undefined`, not null: Prisma reads it as "leave the default",
						// which is the ACTIVE the schema column declares.
						lastError: undefined,
					}),
				}),
			);
		});
	});

	describe("getActiveIntegrations", () => {
		it("sweeps ACTIVE/ERROR plus still-recoverable REPO_UNAVAILABLE, re-includes GitHub AND GitLab OAUTH TOKEN_EXPIRED rows, excludes ADO TOKEN_EXPIRED", async () => {
			mockFindMany.mockResolvedValueOnce([]);

			await getActiveIntegrations();

			expect(mockFindMany).toHaveBeenCalledTimes(1);
			const where = mockFindMany.mock.calls[0][0].where;
			expect(where).toEqual({
				OR: [
					// REPO_UNAVAILABLE rows are swept only while they can still
					// self-heal; past the retirement threshold a permanently
					// unreadable repo stops being probed forever.
					{
						status: "REPO_UNAVAILABLE",
						probeFailCount: { lt: 6 },
					},
					{ status: { in: ["ACTIVE", "ERROR"] } },
					{
						status: "TOKEN_EXPIRED",
						provider: { in: ["GITHUB", "GITLAB"] },
						authMethod: "OAUTH",
						refreshTokenRejectedAt: null,
					},
				],
			});
		});

		it("excludes TOKEN_EXPIRED OAUTH rows whose refresh token the provider already rejected", async () => {
			// Without this the sweep re-probes and re-exchanges a dead grant
			// every 30 minutes forever — no retry can recover it, only a
			// reconnect, which clears the marker and lets the row back in.
			mockFindMany.mockResolvedValueOnce([]);

			await getActiveIntegrations();

			const where = mockFindMany.mock.calls[0][0].where;
			// The TOKEN_EXPIRED arm moved to third when the retirement-scoped
			// REPO_UNAVAILABLE arm was inserted before it.
			expect(where.OR[2]).toMatchObject({ refreshTokenRejectedAt: null });
		});
	});

	describe("restoreIntegrationActive", () => {
		it("restores ACTIVE only for rows that are not DISCONNECTED, returns true when a row matched", async () => {
			mockUpdateMany.mockResolvedValueOnce({ count: 1 });

			const ok = await restoreIntegrationActive("int-1");

			expect(ok).toBe(true);
			const call = mockUpdateMany.mock.calls[0][0];
			expect(call.where).toEqual({
				id: "int-1",
				status: { not: "DISCONNECTED" },
			});
			expect(call.data).toMatchObject({
				status: "ACTIVE",
				lastError: null,
			});
			expect(call.data.lastHealthCheck).toBeInstanceOf(Date);
			// Restoring on a healthy ACCESS-token probe must not erase a
			// confirmed REFRESH-token rejection — they are separate
			// credentials, and only a successful refresh or a reconnect proves
			// the marker obsolete.
			expect(call.data).not.toHaveProperty("refreshTokenRejectedAt");
		});

		it("returns false when no row matched (row was disconnected/deleted concurrently)", async () => {
			mockUpdateMany.mockResolvedValueOnce({ count: 0 });

			const ok = await restoreIntegrationActive("int-gone");

			expect(ok).toBe(false);
		});
	});

	describe("logRepoIntegrationActivity", () => {
		it("creates a project activity record", async () => {
			mockActivityCreate.mockResolvedValueOnce({ id: "act-1" });

			await logRepoIntegrationActivity({
				projectId: "project-1",
				userId: "user-1",
				userName: "Test User",
				organizationId: "org-1",
				activityType: "repo_integration_configured",
				integrationId: "int-1",
				repositoryName: "owner/repo",
				metadata: { provider: "GITHUB" },
			});

			expect(mockActivityCreate).toHaveBeenCalledWith({
				data: expect.objectContaining({
					projectId: "project-1",
					userId: "user-1",
					userName: "Test User",
					activityType: "repo_integration_configured",
					resourceType: "repository_integration",
					resourceId: "int-1",
					resourceName: "owner/repo",
					organizationId: "org-1",
				}),
			});
		});

		it("handles null organizationId", async () => {
			mockActivityCreate.mockResolvedValueOnce({ id: "act-1" });

			await logRepoIntegrationActivity({
				projectId: "project-1",
				userId: "user-1",
				userName: "Test User",
				activityType: "repo_integration_removed",
			});

			expect(mockActivityCreate).toHaveBeenCalledWith({
				data: expect.objectContaining({
					organizationId: null,
				}),
			});
		});
	});

	describe("CRUD operations", () => {
		it("listProjectRepoIntegrations queries by projectId only", async () => {
			mockFindMany.mockResolvedValueOnce([]);
			await listProjectRepoIntegrations("project-1");
			expect(mockFindMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { projectId: "project-1" },
				}),
			);
		});

		it("getProjectRepoIntegration requires both id and projectId", async () => {
			mockFindFirst.mockResolvedValueOnce(null);
			await getProjectRepoIntegration("int-1", "project-1");
			expect(mockFindFirst).toHaveBeenCalledWith({
				where: { id: "int-1", projectId: "project-1" },
			});
		});

		it("deleteProjectRepoIntegration requires both id and projectId", async () => {
			mockDeleteMany.mockResolvedValueOnce({ count: 1 });
			await deleteProjectRepoIntegration("int-1", "project-1");
			expect(mockDeleteMany).toHaveBeenCalledWith({
				where: { id: "int-1", projectId: "project-1" },
			});
		});

		it("listProjectRepoIntegrations never selects encrypted fields", async () => {
			mockFindMany.mockResolvedValueOnce([]);
			await listProjectRepoIntegrations("project-1");

			const selectArg = mockFindMany.mock.calls[0][0].select;
			expect(selectArg.encryptedAccessToken).toBeUndefined();
			expect(selectArg.encryptedRefreshToken).toBeUndefined();
			expect(selectArg.encryptedPat).toBeUndefined();
		});
	});
});
