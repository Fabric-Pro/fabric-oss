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

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			findFirst: (...args: unknown[]) => mockRepoFindFirst(...args),
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

vi.mock("@repo/utils", () => ({
	encryptApiKey: (...args: unknown[]) => mockEncryptApiKey(...args),
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
	mockRepoFindFirst.mockResolvedValue(null);
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
});
