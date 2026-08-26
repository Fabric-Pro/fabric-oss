import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getProjectReposForCodeSearch: vi.fn(),
	db: {
		project: { findUnique: vi.fn() },
		projectRepositoryIntegration: { findUnique: vi.fn(), update: vi.fn() },
		workflowIntegration: { findUnique: vi.fn(), update: vi.fn() },
	},
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((s: string) => `dec:${s}`),
}));
vi.mock("@repo/integrations/gitlab", () => ({
	getValidGitLabAccessToken: vi.fn(),
	refreshGitLabToken: vi.fn(),
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: vi.fn(),
}));

import { getValidGitLabAccessToken } from "@repo/integrations/gitlab";
import { resolveFreshRepoTokenForRow } from "@repo/integrations/repo-auth";
import { decryptApiKey } from "@repo/utils";
import {
	type RepoIntegrationRow,
	resolveRepoAuth,
} from "../src/activities/daily-brief/resolve-repo-auth";

// NOTE: @repo/connectors is NOT mocked — we use the real parseAdoRepositoryUrl
// (Task 1 prerequisite must already be on the branch).

const decryptApiKeyMock = vi.mocked(decryptApiKey);
const getValidGitLabAccessTokenMock = vi.mocked(getValidGitLabAccessToken);
const resolveFreshRepoTokenForRowMock = vi.mocked(resolveFreshRepoTokenForRow);

type RepoRow = RepoIntegrationRow;

function row(overrides: Partial<RepoRow>): RepoRow {
	return {
		integrationId: "int-1",
		provider: "GITHUB",
		owner: "o",
		repo: "r",
		branch: "main",
		repositoryUrl: "https://github.com/o/r",
		encryptedAccessToken: "enc-token",
		encryptedRefreshToken: null,
		tokenExpiresAt: null,
		updatedAt: new Date(),
		encryptedPat: null,
		azureOrganization: null,
		authMethod: "OAUTH",
		...overrides,
	} as RepoRow;
}

beforeEach(() => {
	vi.resetAllMocks();
	decryptApiKeyMock.mockImplementation((s: string) => `dec:${s}`);
	// The canonical resolver is what refreshes; a distinct prefix proves the
	// GitHub branch takes the token from it rather than decrypting the stored
	// (possibly 8h-dead) one itself.
	resolveFreshRepoTokenForRowMock.mockImplementation(async (r) => ({
		token: r.encryptedAccessToken
			? `fresh:${r.encryptedAccessToken}`
			: null,
		authMethod: r.authMethod,
		provider: r.provider,
	}));
	delete process.env.GITLAB_CLIENT_ID;
	delete process.env.GITLAB_CLIENT_SECRET;
});

describe("resolveRepoAuth", () => {
	it("GITHUB+OAUTH → github kind with a REFRESH-AWARE token", async () => {
		expect(await resolveRepoAuth(row({}))).toEqual({
			kind: "github",
			token: "fresh:enc-token",
		});
		// The whole point of the fix: this branch must delegate, never decrypt.
		expect(resolveFreshRepoTokenForRowMock).toHaveBeenCalledWith(
			expect.objectContaining({ integrationId: "int-1" }),
			undefined,
		);
		expect(decryptApiKeyMock).not.toHaveBeenCalled();
	});

	// Without ctx the GITHUB_OAUTH_APP client-credential lookup falls back to
	// env vars + the global admin record, so a deployment that configures its
	// OAuth app per-org in the DB cannot refresh at all.
	it("forwards userId/organizationId to the resolver", async () => {
		await resolveRepoAuth(row({}), {
			userId: "u1",
			organizationId: "org1",
		});
		expect(resolveFreshRepoTokenForRowMock).toHaveBeenCalledWith(
			expect.objectContaining({ integrationId: "int-1" }),
			{ userId: "u1", organizationId: "org1" },
		);
	});

	it("GITHUB without token → unsupported with the legacy wording", async () => {
		expect(
			await resolveRepoAuth(row({ encryptedAccessToken: null })),
		).toEqual({
			kind: "unsupported",
			reason: "No access token on integration (not yet authorized?)",
		});
	});

	it("GITHUB token that cannot be resolved → unsupported", async () => {
		resolveFreshRepoTokenForRowMock.mockResolvedValueOnce({
			token: null,
			authMethod: "OAUTH",
			provider: "GITHUB",
		});
		expect(await resolveRepoAuth(row({}))).toMatchObject({
			kind: "unsupported",
		});
	});

	it("GITLAB+OAUTH with env creds + refresh token → refresh-aware getToken", async () => {
		process.env.GITLAB_CLIENT_ID = "cid";
		process.env.GITLAB_CLIENT_SECRET = "cs";
		getValidGitLabAccessTokenMock.mockResolvedValue("fresh-token");
		const auth = await resolveRepoAuth(
			row({ provider: "GITLAB", encryptedRefreshToken: "enc-rt" }),
		);
		expect(auth.kind).toBe("gitlab");
		await expect(
			(auth as { getToken: () => Promise<string> }).getToken(),
		).resolves.toBe("fresh-token");
		expect(getValidGitLabAccessTokenMock).toHaveBeenCalledWith(
			expect.objectContaining({
				integrationId: "int-1",
				source: "project",
				// FR-7: prisma MUST be forwarded — it enables the cross-process
				// advisory-lock single-flight; without it refresh degrades to a
				// process-local map.
				prisma: expect.anything(),
			}),
		);
	});

	it("GITLAB without env creds → degraded getToken returns stored decrypt", async () => {
		delete process.env.GITLAB_CLIENT_ID;
		delete process.env.GITLAB_CLIENT_SECRET;
		const auth = await resolveRepoAuth(row({ provider: "GITLAB" }));
		await expect(
			(auth as { getToken: () => Promise<string> }).getToken(),
		).resolves.toBe("dec:enc-token");
		expect(getValidGitLabAccessTokenMock).not.toHaveBeenCalled();
	});

	it("GITLAB without token → unsupported", async () => {
		expect(
			await resolveRepoAuth(
				row({ provider: "GITLAB", encryptedAccessToken: null }),
			),
		).toMatchObject({ kind: "unsupported" });
	});

	it("AZURE_DEVOPS+PAT → ado kind with Basic auth, org from column, project from URL", async () => {
		const auth = await resolveRepoAuth(
			row({
				provider: "AZURE_DEVOPS",
				authMethod: "PAT",
				encryptedAccessToken: null,
				encryptedPat: "enc-pat",
				azureOrganization: "my-org",
				repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/r",
			}),
		);
		expect(auth).toEqual({
			kind: "ado",
			basicAuth: `Basic ${Buffer.from(":dec:enc-pat").toString("base64")}`,
			organization: "my-org",
			project: "Proj",
		});
	});

	it("ADO falls back to URL organization when column is null", async () => {
		const auth = await resolveRepoAuth(
			row({
				provider: "AZURE_DEVOPS",
				authMethod: "PAT",
				encryptedAccessToken: null,
				encryptedPat: "enc-pat",
				azureOrganization: null,
				repositoryUrl: "https://dev.azure.com/url-org/Proj/_git/r",
			}),
		);
		expect(auth).toMatchObject({
			kind: "ado",
			organization: "url-org",
			project: "Proj",
		});
	});

	it("ADO unparseable URL → unsupported 'Cannot parse Azure DevOps repository URL'", async () => {
		expect(
			await resolveRepoAuth(
				row({
					provider: "AZURE_DEVOPS",
					authMethod: "PAT",
					encryptedAccessToken: null,
					encryptedPat: "enc-pat",
					azureOrganization: "org",
					repositoryUrl: "https://example.com/not-ado",
				}),
			),
		).toEqual({
			kind: "unsupported",
			reason: "Cannot parse Azure DevOps repository URL",
		});
	});

	it("ADO missing PAT → unsupported", async () => {
		expect(
			await resolveRepoAuth(
				row({
					provider: "AZURE_DEVOPS",
					authMethod: "PAT",
					encryptedAccessToken: null,
					encryptedPat: null,
					azureOrganization: "org",
					repositoryUrl: "https://dev.azure.com/org/Proj/_git/r",
				}),
			),
		).toEqual({
			kind: "unsupported",
			reason: "No PAT on integration (not yet authorized?)",
		});
	});

	// PAT-connect for GitHub/GitLab shipped without teaching this resolver about
	// it, so those rows fell through to "unsupported" and every daily-brief
	// collector and security scan silently skipped the repo.
	it("GITHUB+PAT → github kind (not unsupported)", async () => {
		resolveFreshRepoTokenForRowMock.mockResolvedValueOnce({
			token: "gh-pat",
			authMethod: "PAT",
			provider: "GITHUB",
		});
		expect(
			await resolveRepoAuth(
				row({ authMethod: "PAT", encryptedPat: "enc-pat" }),
			),
		).toEqual({ kind: "github", token: "gh-pat" });
	});

	it("GITLAB+PAT → gitlab kind whose getToken yields the PAT", async () => {
		resolveFreshRepoTokenForRowMock.mockResolvedValueOnce({
			token: "gl-pat",
			authMethod: "PAT",
			provider: "GITLAB",
		});
		const auth = await resolveRepoAuth(
			row({
				provider: "GITLAB",
				authMethod: "PAT",
				encryptedPat: "enc-pat",
			}),
		);
		expect(auth.kind).toBe("gitlab");
		await expect(
			(auth as { getToken: () => Promise<string> }).getToken(),
		).resolves.toBe("gl-pat");
	});

	// GITLAB/PAT used to land here; it is now a supported combination, so this
	// asserts on one that genuinely is not (Azure DevOps has no OAuth path).
	it("unknown combo → unsupported with provider/method in reason", async () => {
		expect(
			await resolveRepoAuth(
				row({ provider: "AZURE_DEVOPS", authMethod: "OAUTH" }),
			),
		).toEqual({
			kind: "unsupported",
			reason: "Unsupported provider/auth combination: AZURE_DEVOPS/OAUTH",
		});
	});
});
