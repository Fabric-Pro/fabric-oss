/**
 * Regression tests for the `connect.ts` standards cleanup (Task 1.4 / R2).
 *
 * The Azure DevOps PAT validation moved from an inline `fetch()` in the handler
 * to the `@repo/connectors` `validateAzureDevOpsPat` request-path helper. This
 * is a NON-BREAKING internal refactor — these tests lock the external contract:
 *
 *   - the helper IS invoked with { organization, pat } (no inline fetch).
 *   - 401 / 403 → BAD_REQUEST "Invalid PAT or insufficient permissions".
 *   - other non-OK → BAD_REQUEST "Azure DevOps returned status N".
 *   - on success the integration is created + legacy repo synced, and the PAT
 *     is encrypted (never returned).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAT_INVALID_REASON } from "../lib/pat-validation-errors";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------
const mockValidateAzureDevOpsPat = vi.fn();
const mockValidateGitHubPat = vi.fn();
const mockValidateGitLabPat = vi.fn();
const mockResolveDefaultBranch = vi.fn();
const mockCreateProjectRepoIntegration = vi.fn();
const mockSyncLegacyProjectRepoOnConnect = vi.fn();
const mockLogRepoIntegrationActivity = vi.fn();
const mockParseRepoUrl = vi.fn();
const mockEncryptApiKey = vi.fn();
const mockDecryptApiKey = vi.fn();
const mockRecordAuditFromRequest = vi.fn();

vi.mock("@repo/connectors", () => ({
	validateAzureDevOpsPat: (...args: unknown[]) =>
		mockValidateAzureDevOpsPat(...args),
	validateGitHubPat: (...args: unknown[]) => mockValidateGitHubPat(...args),
	validateGitLabPat: (...args: unknown[]) => mockValidateGitLabPat(...args),
	resolveDefaultBranch: (...args: unknown[]) =>
		mockResolveDefaultBranch(...args),
}));

const mockRepoFindFirst = vi.fn();
const mockRepoFindMany = vi.fn();
const mockGetGitHubWorkflowCredential = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			findFirst: (...args: unknown[]) => mockRepoFindFirst(...args),
			findMany: (...args: unknown[]) => mockRepoFindMany(...args),
		},
	},
	createProjectRepoIntegration: (...args: unknown[]) =>
		mockCreateProjectRepoIntegration(...args),
	syncLegacyProjectRepoOnConnect: (...args: unknown[]) =>
		mockSyncLegacyProjectRepoOnConnect(...args),
	logRepoIntegrationActivity: (...args: unknown[]) =>
		mockLogRepoIntegrationActivity(...args),
	parseRepoUrl: (...args: unknown[]) => mockParseRepoUrl(...args),
}));

vi.mock("@repo/integrations/github", () => ({
	getGitHubWorkflowCredential: (...args: unknown[]) =>
		mockGetGitHubWorkflowCredential(...args),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (...args: unknown[]) => mockEncryptApiKey(...args),
	decryptApiKey: (...args: unknown[]) => mockDecryptApiKey(...args),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		mockRecordAuditFromRequest(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: {
		user: { id: string; name: string };
		session: { id: string };
	};
}) => Promise<{ integration: { id: string }; success: boolean }>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../connect");
	return (
		mod.connectRepoIntegrationProcedure as unknown as { handler: Handler }
	).handler;
}

const adoInput = {
	projectId: "p1",
	organizationId: null,
	provider: "AZURE_DEVOPS",
	authMethod: "PAT",
	repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/repo",
	repositoryOwner: "my-org",
	repositoryName: "repo",
	pat: "secret-pat",
	azureOrganization: "my-org",
};

const baseContext = {
	user: { id: "user-1", name: "User One" },
	session: { id: "session-1" },
};

beforeEach(() => {
	vi.resetAllMocks();
	mockEncryptApiKey.mockImplementation((k: string) => `enc_${k}`);
	mockDecryptApiKey.mockImplementation((k: string) =>
		k.replace(/^enc_/, "dec_"),
	);
	mockRepoFindFirst.mockResolvedValue(null);
	mockGetGitHubWorkflowCredential.mockResolvedValue(null);
	mockParseRepoUrl.mockReturnValue({
		provider: "AZURE_DEVOPS",
		owner: "my-org",
		name: "repo",
	});
	mockEncryptApiKey.mockReturnValue("encrypted:secret-pat");
	mockValidateAzureDevOpsPat.mockResolvedValue({ ok: true });
	mockValidateGitHubPat.mockResolvedValue({ ok: true });
	mockValidateGitLabPat.mockResolvedValue({ ok: true });
	mockResolveDefaultBranch.mockResolvedValue("main");
	mockCreateProjectRepoIntegration.mockResolvedValue({ id: "int-1" });
	mockSyncLegacyProjectRepoOnConnect.mockResolvedValue(undefined);
	mockLogRepoIntegrationActivity.mockResolvedValue(undefined);
});

describe("connectRepoIntegrationProcedure — ADO PAT validation refactor", () => {
	it("validates via the connectors helper (no inline fetch) and creates the integration", async () => {
		const handler = await loadHandler();
		const result = await handler({ input: adoInput, context: baseContext });

		// The connectors helper is invoked with org + PAT.
		expect(mockValidateAzureDevOpsPat).toHaveBeenCalledWith({
			organization: "my-org",
			pat: "secret-pat",
		});

		// PAT encrypted, integration created + legacy repo synced.
		expect(mockEncryptApiKey).toHaveBeenCalledWith("secret-pat");
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledTimes(1);
		expect(mockSyncLegacyProjectRepoOnConnect).toHaveBeenCalledTimes(1);

		// Contract: returns the integration id + success, never the PAT.
		expect(result).toEqual({ integration: { id: "int-1" }, success: true });
		expect(JSON.stringify(result)).not.toContain("secret-pat");
	});

	it("auto-detects default branch via resolveDefaultBranch if not provided in input", async () => {
		const handler = await loadHandler();

		// Mock resolveDefaultBranch to return "dev"
		mockResolveDefaultBranch.mockResolvedValueOnce("dev");

		const inputWithoutBranch = { ...adoInput, defaultBranch: undefined };
		await handler({ input: inputWithoutBranch, context: baseContext });

		expect(mockResolveDefaultBranch).toHaveBeenCalledWith({
			providedBranch: undefined,
			provider: "AZURE_DEVOPS",
			token: "secret-pat",
			repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/repo",
			owner: "my-org",
			repo: "repo",
			azureOrganization: "my-org",
		});

		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultBranch: "dev",
			}),
		);
		expect(mockSyncLegacyProjectRepoOnConnect).toHaveBeenCalledWith(
			adoInput.projectId,
			adoInput.repositoryUrl,
			"my-org",
			"repo",
			"dev",
		);
	});

	it("maps 401 → BAD_REQUEST 'Invalid PAT or insufficient permissions' and does NOT create the integration", async () => {
		mockValidateAzureDevOpsPat.mockResolvedValue({
			ok: false,
			status: 401,
		});

		const handler = await loadHandler();
		await expect(
			handler({ input: adoInput, context: baseContext }),
		).rejects.toMatchObject({
			message: "Invalid PAT or insufficient permissions",
		});

		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("maps 403 → the same invalid-PAT BAD_REQUEST", async () => {
		mockValidateAzureDevOpsPat.mockResolvedValue({
			ok: false,
			status: 403,
		});

		const handler = await loadHandler();
		await expect(
			handler({ input: adoInput, context: baseContext }),
		).rejects.toMatchObject({
			message: "Invalid PAT or insufficient permissions",
		});
	});

	it("maps other non-OK → BAD_REQUEST 'Azure DevOps returned status N'", async () => {
		mockValidateAzureDevOpsPat.mockResolvedValue({
			ok: false,
			status: 500,
		});

		const handler = await loadHandler();
		await expect(
			handler({ input: adoInput, context: baseContext }),
		).rejects.toMatchObject({
			message: "Azure DevOps returned status 500",
		});

		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("rejects an unparseable repository URL with BAD_REQUEST (validation never runs)", async () => {
		mockParseRepoUrl.mockReturnValue(null);

		const handler = await loadHandler();
		await expect(
			handler({ input: adoInput, context: baseContext }),
		).rejects.toMatchObject({ message: "Cannot parse repository URL" });

		expect(mockValidateAzureDevOpsPat).not.toHaveBeenCalled();
	});
});

describe("connectRepoIntegrationProcedure — GitHub / GitLab PAT connect", () => {
	const githubInput = {
		projectId: "p1",
		organizationId: null,
		provider: "GITHUB",
		authMethod: "PAT",
		repositoryUrl: "https://github.com/acme/store",
		repositoryOwner: "unparsed-owner",
		repositoryName: "unparsed-store",
		pat: "ghp_token",
	};
	const gitlabInput = {
		projectId: "p1",
		organizationId: null,
		provider: "GITLAB",
		authMethod: "PAT",
		repositoryUrl: "https://gitlab.com/group/app",
		repositoryOwner: "group",
		repositoryName: "app",
		pat: "glpat_token",
	};

	it("connects a GitHub repo via its PAT validator (not the ADO one)", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "store",
		});
		const handler = await loadHandler();
		const result = await handler({
			input: githubInput,
			context: baseContext,
		});

		expect(mockValidateGitHubPat).toHaveBeenCalledWith({
			pat: "ghp_token",
			owner: "acme",
			repo: "store",
		});
		expect(mockValidateAzureDevOpsPat).not.toHaveBeenCalled();
		expect(mockValidateGitLabPat).not.toHaveBeenCalled();
		expect(mockEncryptApiKey).toHaveBeenCalledWith("ghp_token");
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				authMethod: "PAT",
				encryptedPat: expect.any(String),
			}),
		);
		expect(result).toEqual({ integration: { id: "int-1" }, success: true });
		expect(JSON.stringify(result)).not.toContain("ghp_token");
	});

	it("maps an invalid GitHub token (403) to a scoped BAD_REQUEST and does NOT create the integration", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "store",
		});
		mockValidateGitHubPat.mockResolvedValue({ ok: false, status: 403 });
		const handler = await loadHandler();
		// Exact message, not a substring: the 403 and 404 answers must stay
		// distinct sentences (a shared literal would pass either assertion).
		await expect(
			handler({ input: githubInput, context: baseContext }),
		).rejects.toMatchObject({
			message:
				"GitHub authenticated this token but refused this repository — it is missing read access (needs repo / Actions: read), or the app is not installed on it.",
		});
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("maps a missing or un-scoped GitHub repo (404) to BAD_REQUEST and does NOT create the integration", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "store",
		});
		mockValidateGitHubPat.mockResolvedValue({ ok: false, status: 404 });
		const handler = await loadHandler();
		await expect(
			handler({ input: githubInput, context: baseContext }),
		).rejects.toMatchObject({
			message:
				"GitHub can't find this repository for this token — check the URL; a private repository also answers 404 when the token cannot see it.",
		});
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("maps a rejected credential (401) to the re-authenticate wording", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "store",
		});
		mockValidateGitHubPat.mockResolvedValue({ ok: false, status: 401 });
		const handler = await loadHandler();
		await expect(
			handler({ input: githubInput, context: baseContext }),
		).rejects.toMatchObject({
			message:
				"GitHub rejected this token as invalid or expired — check the token and try again.",
		});
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("connects a GitLab repo, validating the PAT against the repo's host", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITLAB",
			owner: "group",
			name: "app",
		});
		const handler = await loadHandler();
		await handler({ input: gitlabInput, context: baseContext });

		// Host is pinned to gitlab.com — never derived from an attacker URL.
		// projectPath is the repo we validate READ access to (not `/user`, which
		// needs an unrelated User: Read permission a least-privilege token lacks).
		expect(mockValidateGitLabPat).toHaveBeenCalledWith({
			pat: "glpat_token",
			host: "https://gitlab.com",
			projectPath: "group/app",
		});
		expect(mockValidateAzureDevOpsPat).not.toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "GITLAB", authMethod: "PAT" }),
		);
	});

	it("rejects a GitLab URL whose host is not gitlab.com (SSRF guard) before any fetch", async () => {
		// parseRepoUrl matches `gitlab.com` as a substring, so a crafted internal
		// URL classifies as GITLAB — the handler must reject it, never fetch it.
		mockParseRepoUrl.mockReturnValue({
			provider: "GITLAB",
			owner: "a",
			name: "b",
		});
		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					...gitlabInput,
					repositoryUrl: "https://169.254.169.254/gitlab.com/a/b",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining("gitlab.com"),
		});
		expect(mockValidateGitLabPat).not.toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("maps an invalid GitLab token (401) to BAD_REQUEST", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITLAB",
			owner: "group",
			name: "app",
		});
		mockValidateGitLabPat.mockResolvedValue({ ok: false, status: 401 });
		const handler = await loadHandler();
		await expect(
			handler({ input: gitlabInput, context: baseContext }),
		).rejects.toMatchObject({
			message: expect.stringContaining("read_api"),
		});
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("maps a Prisma P2002 duplicate unique constraint error to an ORPCError CONFLICT", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "store",
		});
		mockValidateGitHubPat.mockResolvedValue({ ok: true, status: 200 });
		mockCreateProjectRepoIntegration.mockRejectedValueOnce({
			code: "P2002",
		});
		const handler = await loadHandler();
		await expect(
			handler({ input: githubInput, context: baseContext }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: "Repository is already connected to this project",
		});
	});

	it("throws CONFLICT when roleTag is already in use by another repository in the project", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "store",
		});
		mockValidateGitHubPat.mockResolvedValue({ ok: true, status: 200 });
		mockRepoFindFirst.mockResolvedValue({
			id: "int-other",
			repositoryOwner: "acme",
			repositoryName: "legacy-store",
		});
		const handler = await loadHandler();
		await expect(
			handler({
				input: { ...githubInput, roleTag: "Legacy" },
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message:
				'The role tag "Legacy" is already assigned to acme/legacy-store',
		});
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("reuses stored PAT when input.pat is omitted and active stored PAT exists for the project and provider", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});
		mockRepoFindMany.mockResolvedValueOnce([
			{
				id: "int-1",
				encryptedPat: "enc_ghp_stored123",
			},
		]);
		mockValidateGitHubPat.mockResolvedValue({ ok: true, status: 200 });
		mockResolveDefaultBranch.mockResolvedValue("main");
		mockCreateProjectRepoIntegration.mockResolvedValue({ id: "int-new" });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: null,
				provider: "GITHUB",
				authMethod: "PAT",
				repositoryUrl: "https://github.com/acme/second-repo",
				repositoryOwner: "acme",
				repositoryName: "second-repo",
				roleTag: "Backend",
				// Notice: pat is omitted!
			},
			context: baseContext,
		});

		expect(result.success).toBe(true);
		expect(mockRepoFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "p1",
					provider: "GITHUB",
					authMethod: "PAT",
					status: "ACTIVE",
					encryptedPat: { not: null },
				}),
				select: {
					id: true,
					encryptedPat: true,
				},
			}),
		);
		expect(mockValidateGitHubPat).toHaveBeenCalledWith({
			pat: "dec_ghp_stored123",
			owner: "acme",
			repo: "second-repo",
		});
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				provider: "GITHUB",
				authMethod: "PAT",
				roleTag: "Backend",
				encryptedPat: "enc_ghp_stored123",
			}),
		);
	});

	it("selects the candidate PAT that validates against the target repository when multiple stored PATs exist", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});
		mockRepoFindMany.mockResolvedValueOnce([
			{
				id: "int-wrong",
				encryptedPat: "enc_wrong_pat",
			},
			{
				id: "int-correct",
				encryptedPat: "enc_correct_pat",
			},
		]);
		// First candidate fails (404/403 for this repo), second candidate succeeds
		mockValidateGitHubPat
			.mockResolvedValueOnce({ ok: false, status: 404 })
			.mockResolvedValueOnce({ ok: true, status: 200 });
		mockResolveDefaultBranch.mockResolvedValue("main");
		mockCreateProjectRepoIntegration.mockResolvedValue({ id: "int-new" });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: null,
				provider: "GITHUB",
				authMethod: "PAT",
				repositoryUrl: "https://github.com/acme/second-repo",
				repositoryOwner: "acme",
				repositoryName: "second-repo",
			},
			context: baseContext,
		});

		expect(result.success).toBe(true);
		expect(mockValidateGitHubPat).toHaveBeenCalledTimes(2);
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				encryptedPat: "enc_correct_pat",
			}),
		);
	});

	it("prioritizes sourceIntegrationId candidate when provided", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});
		mockRepoFindMany.mockResolvedValueOnce([
			{
				id: "int-1",
				encryptedPat: "enc_first_pat",
			},
			{
				id: "int-target",
				encryptedPat: "enc_target_pat",
			},
		]);
		mockValidateGitHubPat.mockResolvedValueOnce({ ok: true, status: 200 });
		mockResolveDefaultBranch.mockResolvedValue("main");
		mockCreateProjectRepoIntegration.mockResolvedValue({ id: "int-new" });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: null,
				provider: "GITHUB",
				authMethod: "PAT",
				repositoryUrl: "https://github.com/acme/second-repo",
				repositoryOwner: "acme",
				repositoryName: "second-repo",
				sourceIntegrationId: "int-target",
			},
			context: baseContext,
		});

		expect(result.success).toBe(true);
		// int-target was checked first and succeeded, so only 1 validation call was made
		expect(mockValidateGitHubPat).toHaveBeenCalledTimes(1);
		expect(mockValidateGitHubPat).toHaveBeenCalledWith({
			pat: "dec_target_pat",
			owner: "acme",
			repo: "second-repo",
		});
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				encryptedPat: "enc_target_pat",
			}),
		);
	});

	it("throws BAD_REQUEST when input.pat is omitted and no candidate PAT validates against the target repo", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});
		mockRepoFindMany.mockResolvedValueOnce([
			{
				id: "int-1",
				encryptedPat: "enc_wrong_pat",
			},
		]);
		mockValidateGitHubPat.mockResolvedValueOnce({ ok: false, status: 404 });

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					organizationId: null,
					provider: "GITHUB",
					authMethod: "PAT",
					repositoryUrl: "https://github.com/acme/second-repo",
					repositoryOwner: "acme",
					repositoryName: "second-repo",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Invalid PAT or insufficient permissions",
			data: { reason: PAT_INVALID_REASON },
		});

		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("throws BAD_REQUEST when stored PAT decryption fails for candidate", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});
		mockRepoFindMany.mockResolvedValueOnce([
			{
				id: "int-1",
				encryptedPat: "enc_corrupt_pat",
			},
		]);
		mockDecryptApiKey.mockImplementationOnce(() => {
			throw new Error("Invalid decryption key");
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					organizationId: null,
					provider: "GITHUB",
					authMethod: "PAT",
					repositoryUrl: "https://github.com/acme/second-repo",
					repositoryOwner: "acme",
					repositoryName: "second-repo",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Invalid PAT or insufficient permissions",
			data: { reason: PAT_INVALID_REASON },
		});

		expect(mockValidateGitHubPat).not.toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("throws BAD_REQUEST when input.pat is omitted for non-GitHub provider", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "AZURE_DEVOPS",
			owner: "acme",
			name: "second-repo",
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					organizationId: null,
					provider: "AZURE_DEVOPS",
					authMethod: "PAT",
					repositoryUrl:
						"https://dev.azure.com/acme/proj/_git/second-repo",
					repositoryOwner: "acme",
					repositoryName: "second-repo",
					azureOrganization: "acme",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "PAT is required for PAT authentication",
		});

		expect(mockRepoFindMany).not.toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("rejects when an explicit empty or whitespace PAT is provided for GITHUB rather than silently reusing stored PAT", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					organizationId: null,
					provider: "GITHUB",
					authMethod: "PAT",
					repositoryUrl: "https://github.com/acme/second-repo",
					repositoryOwner: "acme",
					repositoryName: "second-repo",
					pat: "   ",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "PAT is required for PAT authentication",
		});

		expect(mockRepoFindMany).not.toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("connects with the caller's personal PAT when the project has no stored credential", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});
		mockRepoFindMany.mockResolvedValueOnce([]);
		mockGetGitHubWorkflowCredential.mockResolvedValue({
			kind: "pat",
			token: "ghp_personal_token",
		});
		mockValidateGitHubPat.mockResolvedValue({ ok: true, status: 200 });
		mockResolveDefaultBranch.mockResolvedValue("main");
		mockCreateProjectRepoIntegration.mockResolvedValue({ id: "int-new" });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: null,
				provider: "GITHUB",
				authMethod: "PAT",
				repositoryUrl: "https://github.com/acme/second-repo",
				repositoryOwner: "acme",
				repositoryName: "second-repo",
			},
			context: baseContext,
		});

		expect(result.success).toBe(true);
		expect(mockValidateGitHubPat).toHaveBeenCalledWith({
			pat: "ghp_personal_token",
			owner: "acme",
			repo: "second-repo",
		});
		// The personal token is what gets encrypted and stored on the new row.
		expect(mockEncryptApiKey).toHaveBeenCalledWith("ghp_personal_token");
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({ authMethod: "PAT" }),
		);
	});

	it("ignores the caller's workflow credential when it is an App grant rather than a PAT", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});
		mockRepoFindMany.mockResolvedValueOnce([]);
		// An App grant cannot be stored as a PAT — it needs its authorization flow
		// to install the App on the repository first.
		mockGetGitHubWorkflowCredential.mockResolvedValue({
			kind: "oauth",
			token: "gho_oauth_token",
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					organizationId: null,
					provider: "GITHUB",
					authMethod: "PAT",
					repositoryUrl: "https://github.com/acme/second-repo",
					repositoryOwner: "acme",
					repositoryName: "second-repo",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "No stored GitHub token found for this project",
		});

		expect(mockValidateGitHubPat).not.toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("prefers a stored project PAT over the caller's personal PAT", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});
		mockRepoFindMany.mockResolvedValueOnce([
			{ id: "int-1", encryptedPat: "enc_project_pat" },
		]);
		mockGetGitHubWorkflowCredential.mockResolvedValue({
			kind: "pat",
			token: "ghp_personal_token",
		});
		mockValidateGitHubPat.mockResolvedValue({ ok: true, status: 200 });
		mockResolveDefaultBranch.mockResolvedValue("main");
		mockCreateProjectRepoIntegration.mockResolvedValue({ id: "int-new" });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: null,
				provider: "GITHUB",
				authMethod: "PAT",
				repositoryUrl: "https://github.com/acme/second-repo",
				repositoryOwner: "acme",
				repositoryName: "second-repo",
			},
			context: baseContext,
		});

		expect(result.success).toBe(true);
		expect(mockGetGitHubWorkflowCredential).not.toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({ encryptedPat: "enc_project_pat" }),
		);
	});

	it("throws BAD_REQUEST when input.pat is omitted and no active stored PAT exists for the project", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});
		mockRepoFindMany.mockResolvedValueOnce([]);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					organizationId: null,
					provider: "GITHUB",
					authMethod: "PAT",
					repositoryUrl: "https://github.com/acme/second-repo",
					repositoryOwner: "acme",
					repositoryName: "second-repo",
					// Notice: pat is omitted!
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "No stored GitHub token found for this project",
			data: { reason: PAT_INVALID_REASON },
		});

		expect(mockValidateGitHubPat).not.toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("tolerates TypeError during decryption of the first candidate and connects via the second candidate", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});
		mockRepoFindMany.mockResolvedValueOnce([
			{
				id: "int-corrupt",
				encryptedPat: "enc_corrupt",
			},
			{
				id: "int-valid",
				encryptedPat: "enc_valid",
			},
		]);
		mockDecryptApiKey
			.mockImplementationOnce(() => {
				throw new TypeError("ERR_CRYPTO_INVALID_IV");
			})
			.mockReturnValueOnce("dec_valid");

		mockValidateGitHubPat.mockResolvedValueOnce({ ok: true, status: 200 });
		mockResolveDefaultBranch.mockResolvedValue("main");
		mockCreateProjectRepoIntegration.mockResolvedValue({ id: "int-new" });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: null,
				provider: "GITHUB",
				authMethod: "PAT",
				repositoryUrl: "https://github.com/acme/second-repo",
				repositoryOwner: "acme",
				repositoryName: "second-repo",
			},
			context: baseContext,
		});

		expect(result.success).toBe(true);
		expect(mockValidateGitHubPat).toHaveBeenCalledTimes(1);
		expect(mockValidateGitHubPat).toHaveBeenCalledWith({
			pat: "dec_valid",
			owner: "acme",
			repo: "second-repo",
		});
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				encryptedPat: "enc_valid",
			}),
		);
	});

	it("surfaces GitHub outage status when candidate validation receives 5xx", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "acme",
			name: "second-repo",
		});
		mockRepoFindMany.mockResolvedValueOnce([
			{
				id: "int-1",
				encryptedPat: "enc_ghp_stored123",
			},
		]);
		mockValidateGitHubPat.mockResolvedValueOnce({ ok: false, status: 503 });

		const handler = await loadHandler();
		// One invocation: the mocks above are `...Once`, so a second call would
		// exercise a different (crashing) path and assert nothing.
		const error = (await handler({
			input: {
				projectId: "p1",
				organizationId: null,
				provider: "GITHUB",
				authMethod: "PAT",
				repositoryUrl: "https://github.com/acme/second-repo",
				repositoryOwner: "acme",
				repositoryName: "second-repo",
			},
			context: baseContext,
		}).catch((e) => e)) as { data?: { reason?: string } };

		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			message: "GitHub returned status 503",
		});
		// An outage must NOT carry the credential-rejection tag: the picker reads
		// that tag as "this credential is unusable, go sign in", and a sign-in
		// popup against a provider returning 503 stores an App credential that
		// cannot read the repository.
		expect(error.data?.reason).toBeUndefined();
	});
});

describe("connectRepoIntegrationInputSchema validation", () => {
	it("validates when pat is omitted entirely", async () => {
		const { connectRepoIntegrationInputSchema } = await import(
			"../connect"
		);
		const parsed = connectRepoIntegrationInputSchema.safeParse({
			projectId: "p1",
			provider: "GITHUB",
			authMethod: "PAT",
			repositoryUrl: "https://github.com/acme/repo",
			repositoryOwner: "acme",
			repositoryName: "repo",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.pat).toBeUndefined();
		}
	});

	it("accepts string pat when provided", async () => {
		const { connectRepoIntegrationInputSchema } = await import(
			"../connect"
		);
		const parsed = connectRepoIntegrationInputSchema.safeParse({
			projectId: "p1",
			provider: "GITHUB",
			authMethod: "PAT",
			repositoryUrl: "https://github.com/acme/repo",
			repositoryOwner: "acme",
			repositoryName: "repo",
			pat: "ghp_token123",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.pat).toBe("ghp_token123");
		}
	});

	it("rejects invalid repository URL", async () => {
		const { connectRepoIntegrationInputSchema } = await import(
			"../connect"
		);
		const parsed = connectRepoIntegrationInputSchema.safeParse({
			projectId: "p1",
			provider: "GITHUB",
			authMethod: "PAT",
			repositoryUrl: "not-a-valid-url",
			repositoryOwner: "acme",
			repositoryName: "repo",
		});
		expect(parsed.success).toBe(false);
	});
});
