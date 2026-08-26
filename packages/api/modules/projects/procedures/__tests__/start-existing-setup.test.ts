/**
 * Tests for `startExistingSetupProcedure` — Azure DevOps repo-URL handling
 * (Task Group 4.3 of the Azure DevOps code-repository spec).
 *
 * This procedure historically auto-created `ProjectRepositoryIntegration` rows
 * for GitHub and GitLab only; Azure DevOps URLs fell through both branches and
 * were silently dropped. ADO authenticates with a per-repo PAT (no stored OAuth
 * `workflowIntegration`), so the shared `AzureDevOpsPatRepoPicker` now creates
 * the integration up front via `repositoryIntegrations.connect`.
 *
 * These tests lock the fixed contract:
 *   - ADO repo URLs are PASSED THROUGH to `existingProjectSetupWorkflow`
 *     (the `repoUrls` arg is provider-agnostic — never provider-filtered).
 *   - The ADO branch is gated to project OWNERs (parity with GitHub/GitLab).
 *   - The procedure NEVER recreates an ADO integration here
 *     (`createProjectRepoIntegration` is never called for AZURE_DEVOPS) — it is
 *     a deliberate no-op, because the picker already created it.
 */

import { encryptApiKey } from "@repo/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------
const mockProjectFindUnique = vi.fn();
const mockProjectUpdate = vi.fn();
const mockRepoIntegrationFindFirst = vi.fn();
const mockRepoIntegrationUpdate = vi.fn();
const mockWorkflowIntegrationFindFirst = vi.fn();
const mockCreateProjectRepoIntegration = vi.fn();
const mockSyncLegacyProjectRepoOnConnect = vi.fn();
const mockGetProjectMemberRole = vi.fn();
const mockLogRepoIntegrationActivity = vi.fn();
const mockParseRepoUrl = vi.fn();
const mockIssueAIToken = vi.fn();
const mockWorkflowStart = vi.fn();
const mockGetTemporalClient = vi.fn();
const mockAssertSafeOutboundUrlResolved = vi.fn();

const mockRepoIntegrationFindMany = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...args: unknown[]) => mockProjectFindUnique(...args),
			update: (...args: unknown[]) => mockProjectUpdate(...args),
		},
		projectRepositoryIntegration: {
			findFirst: (...args: unknown[]) =>
				mockRepoIntegrationFindFirst(...args),
			findMany: (...args: unknown[]) =>
				mockRepoIntegrationFindMany(...args),
			update: (...args: unknown[]) => mockRepoIntegrationUpdate(...args),
		},
		workflowIntegration: {
			findFirst: (...args: unknown[]) =>
				mockWorkflowIntegrationFindFirst(...args),
		},
	},
	createProjectRepoIntegration: (...args: unknown[]) =>
		mockCreateProjectRepoIntegration(...args),
	syncLegacyProjectRepoOnConnect: (...args: unknown[]) =>
		mockSyncLegacyProjectRepoOnConnect(...args),
	getProjectMemberRole: (...args: unknown[]) =>
		mockGetProjectMemberRole(...args),
	logRepoIntegrationActivity: (...args: unknown[]) =>
		mockLogRepoIntegrationActivity(...args),
	parseRepoUrl: (...args: unknown[]) => mockParseRepoUrl(...args),
	ProjectMemberRole: { OWNER: "OWNER", ADMIN: "ADMIN", MEMBER: "MEMBER" },
}));

vi.mock("@repo/ai-token", () => ({
	issueAIToken: (...args: unknown[]) => mockIssueAIToken(...args),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...args: unknown[]) => mockGetTemporalClient(...args),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string | undefined) => {
		if (!value) {
			throw new Error("API key cannot be empty");
		}
		return `encrypted:${value}`;
	},
	decryptApiKey: (value: string) => value.replace(/^encrypted:/, ""),
}));
vi.mock("@repo/utils/url-security", () => ({
	assertSafeOutboundUrlResolved: (...args: unknown[]) =>
		mockAssertSafeOutboundUrlResolved(...args),
}));

// withCorrelationMemo just augments + returns its options object.
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));

const mockResolveDefaultBranch = vi.fn();
// The GitHub auto-populate arm probes the repository itself (Fizzy #2252);
// outcomes drive skip-vs-create. GitLab PATs still use their dedicated
// validator, unchanged.
const mockVerifyRepositoryAccess = vi
	.fn()
	.mockResolvedValue({ outcome: "accessible" });
const mockValidateGitLabPat = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@repo/connectors", () => ({
	resolveDefaultBranch: (...args: unknown[]) =>
		mockResolveDefaultBranch(...args),
	verifyRepositoryAccess: (...args: unknown[]) =>
		mockVerifyRepositoryAccess(...args),
	validateGitLabPat: (...args: unknown[]) => mockValidateGitLabPat(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
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

interface HandlerInput {
	projectId: string;
	organizationId?: string | null;
	repoUrls?: string[];
	selectedDocumentTypes?: string[];
	projectTypes?: string[];
	projectName: string;
}

type Handler = (args: {
	input: HandlerInput;
	context: {
		user: { id: string; name: string };
		session: { id: string };
	};
}) => Promise<{ workflowId: string; status: string }>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../start-existing-setup");
	return (mod.startExistingSetupProcedure as unknown as { handler: Handler })
		.handler;
}

const baseContext = {
	user: { id: "user-1", name: "User One" },
	session: { id: "session-1" },
};

const ADO_URL = "https://dev.azure.com/my-org/Proj/_git/repo";

beforeEach(() => {
	vi.resetAllMocks();
	mockRepoIntegrationFindMany.mockResolvedValue([]);
	mockVerifyRepositoryAccess.mockResolvedValue({ outcome: "accessible" });
	mockValidateGitLabPat.mockResolvedValue({ ok: true });
	mockProjectFindUnique.mockResolvedValue({
		id: "p1",
		name: "Proj",
		codeAnalysisStatus: "NOT_STARTED",
		defaultBranch: "main",
		projectManagementMcpConfigId: null,
		projectManagementContainerId: null,
		projectManagementAdditionalContext: null,
	});
	mockProjectUpdate.mockResolvedValue(undefined);
	// No prior ADO integration row by default (picker is assumed to have made it,
	// but the lookup is what we assert — the recreation must never happen).
	mockRepoIntegrationFindFirst.mockResolvedValue({ id: "existing-int" });
	// No stored OAuth integration for GitHub/GitLab.
	mockWorkflowIntegrationFindFirst.mockResolvedValue(null);
	mockGetProjectMemberRole.mockResolvedValue("OWNER");
	mockLogRepoIntegrationActivity.mockResolvedValue(undefined);
	mockIssueAIToken.mockResolvedValue("ai-token-123");
	mockAssertSafeOutboundUrlResolved.mockResolvedValue(undefined);
	// parseRepoUrl returns AZURE_DEVOPS for our ADO fixture URL.
	mockParseRepoUrl.mockReturnValue({
		provider: "AZURE_DEVOPS",
		owner: "my-org",
		name: "repo",
	});
	mockWorkflowStart.mockResolvedValue({ workflowId: "wf-1" });
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: mockWorkflowStart },
	});
});

describe("startExistingSetupProcedure — Azure DevOps repo URLs", () => {
	it("rejects a repository URL whose host resolves to a non-public address", async () => {
		mockAssertSafeOutboundUrlResolved.mockRejectedValueOnce(
			new Error("Private network access is not allowed"),
		);
		const handler = await loadHandler();

		await expect(
			handler({
				input: {
					projectId: "p1",
					organizationId: "org-1",
					repoUrls: [ADO_URL],
					selectedDocumentTypes: [],
					projectTypes: ["web"],
					projectName: "Proj",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: `Repository URL must resolve to a public address: ${ADO_URL}`,
		});

		expect(mockIssueAIToken).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("passes Azure DevOps repo URLs through to existingProjectSetupWorkflow (no provider filter)", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: [ADO_URL],
				selectedDocumentTypes: [],
				projectTypes: ["web"],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result.status).toBe("SCANNING");
		expect(mockWorkflowStart).toHaveBeenCalledTimes(1);

		const [workflowName, options] = mockWorkflowStart.mock.calls[0];
		expect(workflowName).toBe("existingProjectSetupWorkflow");

		const args = (options as { args: unknown[] }).args[0] as {
			repoUrls: string[];
		};
		// The ADO URL survives — it is NOT dropped.
		expect(args.repoUrls).toEqual([ADO_URL]);
	});

	it("does NOT recreate the ADO integration (deliberate no-op; the picker already created it)", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: [ADO_URL],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		// The ADO branch runs the existence lookup (OWNER gate satisfied) ...
		expect(mockRepoIntegrationFindFirst).toHaveBeenCalledWith({
			where: {
				projectId: "p1",
				provider: "AZURE_DEVOPS",
				repositoryOwner: "my-org",
				repositoryName: "repo",
			},
		});
		// ... but NEVER recreates an integration for ADO.
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("warns (but still passes the URL through) when no ADO integration exists yet", async () => {
		mockRepoIntegrationFindFirst.mockResolvedValue(null);
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: [ADO_URL],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain("Azure DevOps");
		// No auto-creation even on the missing-integration path.
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
		// The URL still reaches the workflow.
		const [, options] = mockWorkflowStart.mock.calls[0];
		const args = (options as { args: unknown[] }).args[0] as {
			repoUrls: string[];
		};
		expect(args.repoUrls).toEqual([ADO_URL]);

		warnSpy.mockRestore();
	});

	it("OWNER gate: a non-owner skips the ADO branch entirely (no lookup, no create) but the URL still flows", async () => {
		mockGetProjectMemberRole.mockResolvedValue("MEMBER");

		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: [ADO_URL],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		// Non-owner → the ADO branch (and GitHub/GitLab branches) never query.
		expect(mockRepoIntegrationFindFirst).not.toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();

		// The workflow still starts with the ADO URL — the gate only governs
		// integration auto-population, not whether URLs reach the workflow.
		const [, options] = mockWorkflowStart.mock.calls[0];
		const args = (options as { args: unknown[] }).args[0] as {
			repoUrls: string[];
		};
		expect(args.repoUrls).toEqual([ADO_URL]);
	});
});

describe("startExistingSetupProcedure — GitHub and GitLab auto-populate", () => {
	it("auto-detects default branch from GitHub API if project.defaultBranch is null", async () => {
		const GITHUB_URL = "https://github.com/my-org/my-repo";
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			name: "Proj",
			codeAnalysisStatus: "NOT_STARTED",
			defaultBranch: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
			projectManagementAdditionalContext: null,
		});

		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			id: "wi-1",
			credentials: encryptApiKey(
				JSON.stringify({
					access_token: "fake-github-token",
					scope: "repo",
				}),
			),
		});

		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "my-org",
			name: "my-repo",
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);

		mockVerifyRepositoryAccess.mockResolvedValueOnce({
			outcome: "accessible",
			defaultBranch: "github-dev",
		});
		mockResolveDefaultBranch.mockResolvedValueOnce("github-dev");

		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: [GITHUB_URL],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({ defaultBranch: "github-dev" }),
		);

		expect(mockSyncLegacyProjectRepoOnConnect).toHaveBeenCalledWith(
			"p1",
			GITHUB_URL,
			"my-org",
			"my-repo",
			"github-dev",
		);
	});

	it("auto-detects default branch from GitLab API if project.defaultBranch is null", async () => {
		const GITLAB_URL = "https://gitlab.com/my-org/my-repo";
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			name: "Proj",
			codeAnalysisStatus: "NOT_STARTED",
			defaultBranch: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
			projectManagementAdditionalContext: null,
		});

		mockWorkflowIntegrationFindFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				id: "wi-2",
				credentials: encryptApiKey(
					JSON.stringify({ access_token: "fake-gitlab-token" }),
				),
			});

		mockParseRepoUrl.mockReturnValue({
			provider: "GITLAB",
			owner: "my-org",
			name: "my-repo",
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);

		// The probe payload already carries default_branch; the GitLab arm must
		// reuse it like the GitHub arm does, so resolveDefaultBranch's second
		// identical fetch short-circuits.
		mockVerifyRepositoryAccess.mockResolvedValue({
			outcome: "accessible",
			defaultBranch: "gitlab-probed",
		});
		mockResolveDefaultBranch.mockResolvedValueOnce("gitlab-dev");

		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: [GITLAB_URL],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(mockResolveDefaultBranch).toHaveBeenCalledWith({
			providedBranch: "gitlab-probed",
			provider: "GITLAB",
			token: "fake-gitlab-token",
			repositoryUrl: GITLAB_URL,
			owner: "my-org",
			repo: "my-repo",
		});

		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({ defaultBranch: "gitlab-dev" }),
		);

		expect(mockSyncLegacyProjectRepoOnConnect).toHaveBeenCalledWith(
			"p1",
			GITLAB_URL,
			"my-org",
			"my-repo",
			"gitlab-dev",
		);
	});

	it("auto-populates PAT credential when apiKey is present", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "my-org",
			name: "my-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ apiKey: "ghp_pat123" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);
		mockResolveDefaultBranch.mockResolvedValueOnce("main");
		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: ["https://github.com/my-org/my-repo"],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				authMethod: "PAT",
				encryptedPat: "encrypted:ghp_pat123",
				encryptedAccessToken: undefined,
				tokenScopes: [],
			}),
		);
		expect(mockSyncLegacyProjectRepoOnConnect).toHaveBeenCalledWith(
			"p1",
			"https://github.com/my-org/my-repo",
			"my-org",
			"my-repo",
			"main",
		);
	});

	it("prefers OAuth credential when access_token and apiKey are both present", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "my-org",
			name: "my-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({
					access_token: "gho_123",
					apiKey: "ghp_pat123",
					refresh_token: "ghr_456",
					expires_in: 3600,
					scope: "repo,read:user",
					token_obtained_at: new Date(
						"2024-01-01T00:00:00Z",
					).getTime(),
				}),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);
		mockResolveDefaultBranch.mockResolvedValueOnce("main");

		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: ["https://github.com/my-org/my-repo"],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				authMethod: "OAUTH",
				encryptedAccessToken: "encrypted:gho_123",
				encryptedPat: undefined,
				encryptedRefreshToken: "encrypted:ghr_456",
				tokenExpiresAt: expect.any(Date),
				tokenScopes: ["repo", "read:user"],
			}),
		);
	});

	it("auto-populates GitLab PAT credential when apiToken is present", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITLAB",
			owner: "my-org",
			name: "my-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ apiToken: "glpat_123" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);
		mockResolveDefaultBranch.mockResolvedValueOnce("main");

		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: ["https://gitlab.com/my-org/my-repo"],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(mockValidateGitLabPat).toHaveBeenCalledWith({
			pat: "glpat_123",
			host: "https://gitlab.com",
			projectPath: "my-org/my-repo",
		});

		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				authMethod: "PAT",
				encryptedPat: "encrypted:glpat_123",
				encryptedAccessToken: undefined,
			}),
		);
		expect(mockSyncLegacyProjectRepoOnConnect).toHaveBeenCalledWith(
			"p1",
			"https://gitlab.com/my-org/my-repo",
			"my-org",
			"my-repo",
			"main",
		);
	});

	it("skips GitHub repo integration but continues project setup when the repo probe says the credential cannot read it", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "my-org",
			name: "my-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ apiKey: "ghp_invalid_token" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);
		mockVerifyRepositoryAccess.mockResolvedValueOnce({
			outcome: "unauthorized",
		});

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: ["https://github.com/my-org/my-repo"],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result).toEqual({
			workflowId: expect.any(String),
			status: "SCANNING",
			skippedRepos: ["GitHub: my-org/my-repo"],
		});
		expect(mockVerifyRepositoryAccess).toHaveBeenCalledWith({
			provider: "GITHUB",
			token: "ghp_invalid_token",
			repositoryUrl: "https://github.com/my-org/my-repo",
			owner: "my-org",
			repo: "my-repo",
		});
		expect(mockResolveDefaultBranch).not.toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
		expect(mockWorkflowStart).toHaveBeenCalled();
	});

	it("attaches roleTag from repoTags when creating repo integration", async () => {
		const GITHUB_URL = "https://github.com/my-org/legacy-repo";
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			name: "Proj",
			codeAnalysisStatus: "NOT_STARTED",
			defaultBranch: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
			projectManagementAdditionalContext: null,
		});

		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			id: "wi-1",
			credentials: encryptApiKey(
				JSON.stringify({
					access_token: "fake-github-token",
					scope: "repo",
				}),
			),
		});

		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "my-org",
			name: "legacy-repo",
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);
		mockResolveDefaultBranch.mockResolvedValueOnce("main");

		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: [GITHUB_URL],
				repoTags: { [GITHUB_URL]: "Legacy" },
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				roleTag: "Legacy",
			}),
		);
	});

	it("rejects submission when multiple repos are assigned the same roleTag in repoTags", async () => {
		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					organizationId: "org-1",
					repoUrls: [
						"https://github.com/my-org/repo-a",
						"https://github.com/my-org/repo-b",
					],
					repoTags: {
						"https://github.com/my-org/repo-a": "Legacy",
						"https://github.com/my-org/repo-b": "Legacy",
					},
					selectedDocumentTypes: [],
					projectTypes: [],
					projectName: "Proj",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: "Each repository must have a unique role tag",
		});
	});

	it("rejects submission when repoTags conflicts with an already existing tagged repo in the project", async () => {
		mockRepoIntegrationFindMany.mockResolvedValue([
			{
				roleTag: "Legacy",
				repositoryOwner: "my-org",
				repositoryName: "existing-legacy-repo",
			},
		]);
		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					organizationId: "org-1",
					repoUrls: ["https://github.com/my-org/repo-new"],
					repoTags: {
						"https://github.com/my-org/repo-new": "Legacy",
					},
					selectedDocumentTypes: [],
					projectTypes: [],
					projectName: "Proj",
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message:
				'The role tag "Legacy" is already assigned to my-org/existing-legacy-repo',
		});
	});

	it("creates the row anyway when the probe is inconclusive (5xx) — the sweep re-classifies later", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "my-org",
			name: "my-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ apiKey: "ghp_pat123" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);
		mockResolveDefaultBranch.mockResolvedValueOnce("main");
		mockVerifyRepositoryAccess.mockResolvedValueOnce("unreachable");

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: ["https://github.com/my-org/my-repo"],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		// Inconclusive ≠ cannot-read: a provider blip must not block a bulk
		// import; the scheduled health check owns the verdict.
		expect(result.skippedRepos).toBeUndefined();
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledTimes(1);
		expect(mockWorkflowStart).toHaveBeenCalled();
	});

	it("skips GitLab repo integration but continues project setup if PAT validation returns 404", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITLAB",
			owner: "my-org",
			name: "my-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ apiToken: "glpat_private_repo" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);
		mockValidateGitLabPat.mockResolvedValueOnce({ ok: false, status: 404 });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: ["https://gitlab.com/my-org/my-repo"],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result).toEqual({
			workflowId: expect.any(String),
			status: "SCANNING",
			skippedRepos: ["GitLab: my-org/my-repo"],
		});
		expect(mockValidateGitLabPat).toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
		expect(mockWorkflowStart).toHaveBeenCalled();
	});

	it("connects successful repos and skips failing repos across providers when one credential fails its probe", async () => {
		mockParseRepoUrl.mockImplementation((url: string) => {
			if (url.includes("github.com")) {
				return { provider: "GITHUB", owner: "gh-org", name: "gh-repo" };
			}
			if (url.includes("gitlab.com")) {
				return { provider: "GITLAB", owner: "gl-org", name: "gl-repo" };
			}
			return null;
		});

		mockWorkflowIntegrationFindFirst.mockImplementation(
			async (args: { where: { provider: string } }) => {
				if (args.where.provider === "GITHUB") {
					return {
						credentials: encryptApiKey(
							JSON.stringify({ apiKey: "ghp_valid_token" }),
						),
					};
				}
				if (args.where.provider === "GITLAB") {
					return {
						credentials: encryptApiKey(
							JSON.stringify({ apiToken: "glpat_bad_token" }),
						),
					};
				}
				return null;
			},
		);

		mockRepoIntegrationFindFirst.mockResolvedValue(null);
		mockVerifyRepositoryAccess.mockResolvedValueOnce({
			outcome: "accessible",
		});
		mockValidateGitLabPat.mockResolvedValueOnce({ ok: false, status: 404 });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: [
					"https://github.com/gh-org/gh-repo",
					"https://gitlab.com/gl-org/gl-repo",
				],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result).toEqual({
			workflowId: expect.any(String),
			status: "SCANNING",
			skippedRepos: ["GitLab: gl-org/gl-repo"],
		});
		expect(mockVerifyRepositoryAccess).toHaveBeenCalledWith({
			provider: "GITHUB",
			token: "ghp_valid_token",
			repositoryUrl: "https://github.com/gh-org/gh-repo",
			owner: "gh-org",
			repo: "gh-repo",
		});
		expect(mockValidateGitLabPat).toHaveBeenCalled();
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledTimes(1);
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				repositoryOwner: "gh-org",
				repositoryName: "gh-repo",
			}),
		);
		expect(mockSyncLegacyProjectRepoOnConnect).toHaveBeenCalled();
		expect(mockWorkflowStart).toHaveBeenCalled();
	});

	it("probes each GitHub repo separately, skipping only the one the credential cannot read", async () => {
		mockParseRepoUrl.mockImplementation((url: string) => {
			if (url.includes("repo-1")) {
				return { provider: "GITHUB", owner: "org-a", name: "repo-1" };
			}
			if (url.includes("repo-2")) {
				return { provider: "GITHUB", owner: "org-a", name: "repo-2" };
			}
			return null;
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ apiKey: "ghp_multi_pat" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);
		mockResolveDefaultBranch.mockResolvedValue("main");
		mockVerifyRepositoryAccess
			.mockResolvedValueOnce({ outcome: "accessible" })
			.mockResolvedValueOnce({ outcome: "not-found" });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: [
					"https://github.com/org-a/repo-1",
					"https://github.com/org-a/repo-2",
				],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result).toEqual({
			workflowId: expect.any(String),
			status: "SCANNING",
			skippedRepos: ["GitHub: org-a/repo-2"],
		});
		expect(mockVerifyRepositoryAccess).toHaveBeenCalledTimes(2);
		expect(mockVerifyRepositoryAccess).toHaveBeenNthCalledWith(1, {
			provider: "GITHUB",
			token: "ghp_multi_pat",
			repositoryUrl: "https://github.com/org-a/repo-1",
			owner: "org-a",
			repo: "repo-1",
		});
		expect(mockVerifyRepositoryAccess).toHaveBeenNthCalledWith(2, {
			provider: "GITHUB",
			token: "ghp_multi_pat",
			repositoryUrl: "https://github.com/org-a/repo-2",
			owner: "org-a",
			repo: "repo-2",
		});
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledTimes(1);
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				repositoryOwner: "org-a",
				repositoryName: "repo-1",
			}),
		);
		expect(mockSyncLegacyProjectRepoOnConnect).toHaveBeenCalled();
		expect(mockWorkflowStart).toHaveBeenCalled();
	});

	it("skips GitLab repo integration when createProjectRepoIntegration rejects, returning skippedRepos and continuing workflow start", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITLAB",
			owner: "my-org",
			name: "my-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ apiToken: "glpat_valid_token" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);
		mockValidateGitLabPat.mockResolvedValueOnce({ ok: true });
		mockCreateProjectRepoIntegration.mockRejectedValueOnce(
			new Error("DB write failure"),
		);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: ["https://gitlab.com/my-org/my-repo"],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result).toEqual({
			workflowId: expect.any(String),
			status: "SCANNING",
			skippedRepos: ["GitLab: my-org/my-repo"],
		});
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalled();
		expect(mockWorkflowStart).toHaveBeenCalled();
	});

	it("skips auto-population when a project repository integration row already exists", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "my-org",
			name: "my-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ apiKey: "ghp_valid_token" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue({
			id: "int_existing_1",
			status: "ACTIVE",
		});

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: ["https://github.com/my-org/my-repo"],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result.skippedRepos).toBeUndefined();
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
		expect(mockWorkflowStart).toHaveBeenCalled();
	});

	it("skips a self-hosted GitLab repo when the credential is a PAT", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITLAB",
			owner: "example-org",
			name: "example-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ apiToken: "glpat_valid_token" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: [
					"https://gitlab.example.com/example-org/example-repo",
				],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result.skippedRepos).toEqual([
			"GitLab: example-org/example-repo",
		]);
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
		expect(mockWorkflowStart).toHaveBeenCalled();
	});

	it("still connects a self-hosted GitLab repo over OAuth", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITLAB",
			owner: "example-org",
			name: "example-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ access_token: "gl_oauth_token" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: [
					"https://gitlab.example.com/example-org/example-repo",
				],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result.skippedRepos).toBeUndefined();
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITLAB",
				authMethod: "OAUTH",
			}),
		);
		expect(mockWorkflowStart).toHaveBeenCalled();
	});

	it("auto-populates GitHub PAT credential when only `pat` fallback key is present", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "example-org",
			name: "example-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ pat: "ghp_fallback_token" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: ["https://github.com/example-org/example-repo"],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result.skippedRepos).toBeUndefined();
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				authMethod: "PAT",
			}),
		);
	});

	it("auto-populates GitLab PAT credential when only `pat` fallback key is present", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITLAB",
			owner: "example-org",
			name: "example-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: encryptApiKey(
				JSON.stringify({ pat: "glpat_fallback_token" }),
			),
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: ["https://gitlab.com/example-org/example-repo"],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result.skippedRepos).toBeUndefined();
		expect(mockCreateProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITLAB",
				authMethod: "PAT",
			}),
		);
	});

	it("skips repos and continues setup when stored credential decryption or parsing fails", async () => {
		mockParseRepoUrl.mockReturnValue({
			provider: "GITHUB",
			owner: "example-org",
			name: "example-repo",
		});
		mockWorkflowIntegrationFindFirst.mockResolvedValue({
			credentials: "invalid_encrypted_data",
		});
		mockRepoIntegrationFindFirst.mockResolvedValue(null);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				repoUrls: ["https://github.com/example-org/example-repo"],
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: "Proj",
			},
			context: baseContext,
		});

		expect(result.skippedRepos).toEqual([
			"GitHub: example-org/example-repo",
		]);
		expect(mockCreateProjectRepoIntegration).not.toHaveBeenCalled();
		expect(mockWorkflowStart).toHaveBeenCalled();
	});
});
