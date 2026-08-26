import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetProjectRepoIntegration = vi.fn();
const mockUpdate = vi.fn().mockResolvedValue({ id: "int-1", status: "ACTIVE" });
const mockProjectFindUnique = vi.fn();
const mockLogRepoIntegrationActivity = vi.fn();
const mockRecordAudit = vi.fn();

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	getProjectRepoIntegration: (...args: unknown[]) =>
		mockGetProjectRepoIntegration(...args),
	db: {
		project: {
			findUnique: (...args: unknown[]) => mockProjectFindUnique(...args),
		},
		projectRepositoryIntegration: {
			update: (...args: unknown[]) => mockUpdate(...args),
		},
	},
	logRepoIntegrationActivity: (...args: unknown[]) =>
		mockLogRepoIntegrationActivity(...args),
}));

const mockValidateGitHubPat = vi.fn().mockResolvedValue({ ok: true });
const mockValidateGitLabPat = vi.fn().mockResolvedValue({ ok: true });
const mockValidateAzureDevOpsPat = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@repo/connectors", () => ({
	validateGitHubPat: (...args: unknown[]) => mockValidateGitHubPat(...args),
	validateGitLabPat: (...args: unknown[]) => mockValidateGitLabPat(...args),
	validateAzureDevOpsPat: (...args: unknown[]) =>
		mockValidateAzureDevOpsPat(...args),
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	encryptApiKey: (v: string) => `enc_${v}`,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => mockRecordAudit(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
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

type Handler = (args: { input: Record<string, unknown> }) => Promise<{
	integration: { id: string; status: string };
}>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../attach-pat");
	const raw = (
		mod.attachPatToRepoIntegrationProcedure as unknown as {
			handler: (args: {
				input: Record<string, unknown>;
				context: unknown;
			}) => Promise<{ integration: { id: string; status: string } }>;
		}
	).handler;
	return (args: { input: Record<string, unknown> }) =>
		raw({
			input: args.input,
			context: {
				user: { id: "user-1", name: "User One" },
				session: { id: "session-1" },
			},
		});
}

const baseRow = {
	id: "int-1",
	status: "REPO_UNAVAILABLE",
	provider: "GITHUB",
	authMethod: "OAUTH",
	repositoryUrl: "https://github.com/acme/widgets",
	repositoryOwner: "acme",
	repositoryName: "widgets",
	azureOrganization: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	mockUpdate.mockResolvedValue({ id: "int-1", status: "ACTIVE" });
	mockValidateGitHubPat.mockResolvedValue({ ok: true });
	mockValidateGitLabPat.mockResolvedValue({ ok: true });
	mockValidateAzureDevOpsPat.mockResolvedValue({ ok: true });
	mockGetProjectRepoIntegration.mockResolvedValue({ ...baseRow });
});

describe("attachPatToRepoIntegrationProcedure — AC5 (Fizzy #2252)", () => {
	it("validates the PAT repo-scoped, then converts the row to PAT-backed and ACTIVE", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				integrationId: "int-1",
				patToken: "ghp_new",
			},
		});

		expect(mockValidateGitHubPat).toHaveBeenCalledWith({
			pat: "ghp_new",
			owner: "acme",
			repo: "widgets",
		});
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "int-1" },
				data: expect.objectContaining({
					authMethod: "PAT",
					encryptedPat: "enc_ghp_new",
					// Every OAuth column cleared so readers can never mix
					// credentials if authMethod ever flips back.
					encryptedAccessToken: null,
					encryptedRefreshToken: null,
					tokenExpiresAt: null,
					status: "ACTIVE",
					lastError: null,
					refreshTokenRejectedAt: null,
					// A recovered row must start with a full retirement budget.
					probeFailCount: 0,
				}),
			}),
		);
		expect(result).toEqual({
			integration: { id: "int-1", status: "ACTIVE" },
		});
		expect(mockLogRepoIntegrationActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				activityType: "repo_integration_pat_attached",
			}),
		);
	});

	it("rejects a refused token (403) with the install-app sentence and writes NOTHING", async () => {
		mockValidateGitHubPat.mockResolvedValueOnce({ ok: false, status: 403 });

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					integrationId: "int-1",
					patToken: "ghp_x",
				},
			}),
		).rejects.toMatchObject({
			message:
				"GitHub authenticated this token but refused this repository — it is missing read access (needs repo / Actions: read), or the app is not installed on it.",
		});
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("404 keeps its distinct not-visible sentence", async () => {
		mockValidateGitHubPat.mockResolvedValueOnce({ ok: false, status: 404 });

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					integrationId: "int-1",
					patToken: "ghp_x",
				},
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining("can't find this repository"),
		});
	});

	it("refuses a disconnected row — its tokens are wiped, nothing to rebind", async () => {
		mockGetProjectRepoIntegration.mockResolvedValue({
			...baseRow,
			status: "DISCONNECTED",
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					integrationId: "int-1",
					patToken: "ghp_x",
				},
			}),
		).rejects.toMatchObject({
			data: { code: "REPOSITORY_DISCONNECTED" },
		});
		expect(mockValidateGitHubPat).not.toHaveBeenCalled();
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("404s when the integration belongs to another project (tenant guard)", async () => {
		mockGetProjectRepoIntegration.mockResolvedValue(null);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "other",
					integrationId: "int-1",
					patToken: "x",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects a non-gitlab.com GitLab row before any fetch (SSRF pin)", async () => {
		mockGetProjectRepoIntegration.mockResolvedValue({
			...baseRow,
			provider: "GITLAB",
			repositoryUrl: "https://internal-host.attacker.tld/acme/widgets",
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					integrationId: "int-1",
					pat: "glpat",
				},
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining("Only gitlab.com"),
		});
		expect(mockValidateGitLabPat).not.toHaveBeenCalled();
	});

	it("attaches to a GitLab row via the pinned-host validator", async () => {
		mockGetProjectRepoIntegration.mockResolvedValue({
			...baseRow,
			provider: "GITLAB",
			repositoryUrl: "https://gitlab.com/acme/widgets",
		});

		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "p1",
				integrationId: "int-1",
				patToken: "glpat_1",
			},
		});

		expect(mockValidateGitLabPat).toHaveBeenCalledWith({
			pat: "glpat_1",
			host: "https://gitlab.com",
			projectPath: "acme/widgets",
		});
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					authMethod: "PAT",
					azureOrganization: null,
				}),
			}),
		);
	});

	it("ADO rows require an organization (input or stored)", async () => {
		mockGetProjectRepoIntegration.mockResolvedValue({
			...baseRow,
			provider: "AZURE_DEVOPS",
			repositoryUrl: "https://dev.azure.com/org/proj/_git/repo",
			azureOrganization: null,
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					projectId: "p1",
					integrationId: "int-1",
					patToken: "pat",
				},
			}),
		).rejects.toMatchObject({
			message: "Azure organization is required for Azure DevOps PAT",
		});
		expect(mockValidateAzureDevOpsPat).not.toHaveBeenCalled();
	});

	it("ADO rows reuse the stored organization when input omits it", async () => {
		mockGetProjectRepoIntegration.mockResolvedValue({
			...baseRow,
			provider: "AZURE_DEVOPS",
			repositoryUrl: "https://dev.azure.com/org/proj/_git/repo",
			azureOrganization: "stored-org",
		});

		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "p1",
				integrationId: "int-1",
				patToken: "ado-pat",
			},
		});

		expect(mockValidateAzureDevOpsPat).toHaveBeenCalledWith({
			organization: "stored-org",
			pat: "ado-pat",
		});
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					azureOrganization: "stored-org",
				}),
			}),
		);
	});
});
