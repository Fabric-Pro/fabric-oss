import { Context } from "@temporalio/activity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findIntegration: vi.fn(),
	findApp: vi.fn(),
	transaction: vi.fn(),
	getRepos: vi.fn(),
	refresh: vi.fn(),
	clone: vi.fn(),
	listRemote: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	db: {
		projectRepositoryIntegration: { findFirst: mocks.findIntegration },
		workflowIntegration: { findFirst: mocks.findApp },
		$transaction: mocks.transaction,
	},
	getProjectReposForCodeSearch: mocks.getRepos,
	getProjectScanConfig: vi.fn().mockResolvedValue({ scanBranch: "main" }),
	getScanCheckpoint: vi.fn().mockResolvedValue(null),
}));
vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	decryptApiKey: (value: string) => value,
	encryptApiKey: (value: string) => value,
}));
vi.mock("@repo/utils/oauth-refresh", () => ({
	refreshOAuthToken: mocks.refresh,
	sanitizeCredential: (value: string) => value.trim(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	rm: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("simple-git", () => ({
	simpleGit: () => ({ clone: mocks.clone, listRemote: mocks.listRemote }),
}));

import { resolveRepoTokenActivity } from "../../code-indexing";
import { runGitHistorySecretScanActivity } from "../git-history-scan";
import { resolveScanCommitActivity } from "../resolve-scan-commit";
import { runSemgrepScanActivity } from "../semgrep-scan";

const integration = {
	id: "repo-a",
	projectId: "project-a",
	configuredByUserId: "user-a",
	project: { organizationId: "org-a" },
	provider: "GITHUB",
	authMethod: "OAUTH",
	encryptedAccessToken: "stale-access",
	encryptedRefreshToken: "caller-refresh",
	encryptedPat: null,
	tokenExpiresAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
};
const repo = {
	...integration,
	integrationId: "repo-a",
	owner: "example-owner",
	repo: "example-repo",
	branch: "main",
	repositoryUrl: "https://github.com/example-owner/example-repo.git",
	azureOrganization: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("FABRIC_GITHUB_CLIENT_ID", "");
	vi.stubEnv("FABRIC_GITHUB_CLIENT_SECRET", "");
	vi.spyOn(Context, "current").mockReturnValue({
		heartbeat: vi.fn(),
	} as never);
	mocks.findIntegration.mockImplementation(async ({ where }) =>
		where.id === integration.id && where.projectId === integration.projectId
			? integration
			: null,
	);
	const apps = [
		{
			userId: "user-b",
			organizationId: "org-b",
			provider: "GITHUB",
			name: "GITHUB_OAUTH_APP",
			isActive: true,
			credentials: JSON.stringify({
				client_id: "foreign-client",
				client_secret: "foreign-secret",
			}),
		},
		{
			userId: "user-a",
			organizationId: "org-a",
			provider: "GITHUB",
			name: "GITHUB_OAUTH_APP",
			isActive: true,
			credentials: JSON.stringify({
				client_id: "org-client",
				client_secret: "org-secret",
			}),
		},
	];
	mocks.findApp.mockImplementation(
		async ({ where }: { where: Record<string, unknown> }) =>
			apps.find((app) =>
				Object.entries(where).every(
					([key, value]) =>
						value === undefined ||
						app[key as keyof typeof app] === value,
				),
			) ?? null,
	);
	mocks.getRepos.mockResolvedValue([repo]);
	mocks.transaction.mockImplementation(
		async (callback: (tx: unknown) => unknown) =>
			callback({
				$executeRaw: vi.fn().mockResolvedValue(1),
				projectRepositoryIntegration: {
					findUnique: vi.fn().mockResolvedValue(integration),
					updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				},
			}),
	);
	mocks.refresh.mockResolvedValue({
		ok: true,
		accessToken: "rotated-access",
		refreshToken: "rotated-refresh",
		expiresIn: 28800,
	});
	// Stop after observing the clone URL: no scanner binaries or disk clone.
	mocks.clone.mockRejectedValue(new Error("test clone stopped"));
	mocks.listRemote.mockResolvedValue(
		"abc123def4567890abc123def4567890abc12345\trefs/heads/main",
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const scanInput = {
	projectId: "project-a",
	userId: "user-a",
	organizationId: "org-a",
	workflowRunId: "oauth-scope-test",
	branch: "main",
};

describe.each([
	{
		name: "Semgrep",
		run: (organizationId: string) =>
			runSemgrepScanActivity({ ...scanInput, organizationId }),
		network: mocks.clone,
	},
	{
		name: "git history",
		run: (organizationId: string) =>
			runGitHistorySecretScanActivity({ ...scanInput, organizationId }),
		network: mocks.clone,
	},
	{
		name: "scan commit",
		run: (organizationId: string) =>
			resolveScanCommitActivity({
				...scanInput,
				organizationId,
				mode: "FULL",
			}),
		network: mocks.listRemote,
	},
])("$name repository OAuth context", ({ run, network }) => {
	it("refreshes with the project's stored OAuth app before authenticating", async () => {
		await run("org-a");
		expect(mocks.refresh).toHaveBeenCalledWith(
			expect.objectContaining({
				clientId: "org-client",
				clientSecret: "org-secret",
				refreshToken: "caller-refresh",
			}),
		);
		expect(network).toHaveBeenCalled();
		const url =
			network === mocks.listRemote
				? network.mock.calls[0][0][0]
				: network.mock.calls[0][0];
		expect(new URL(url).password).toBe("rotated-access");
	});

	it("does not resolve or use credentials for an organization that does not own the project", async () => {
		await run("org-b");
		expect(mocks.findApp).not.toHaveBeenCalled();
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(network).not.toHaveBeenCalled();
	});
});

describe("code-index token activity", () => {
	it("derives the repository's organization for historical identity-free activity input", async () => {
		expect(
			await resolveRepoTokenActivity({
				integrationId: "repo-a",
				projectId: "project-a",
			}),
		).toEqual({ token: "rotated-access", authMethod: "OAUTH" });
		expect(mocks.refresh).toHaveBeenCalledWith(
			expect.objectContaining({
				clientId: "org-client",
				clientSecret: "org-secret",
			}),
		);
	});

	it("does not resolve credentials for an integration outside the requested project", async () => {
		expect(
			await resolveRepoTokenActivity({
				integrationId: "repo-a",
				projectId: "project-b",
			}),
		).toEqual({ token: null, authMethod: null });
		expect(mocks.findApp).not.toHaveBeenCalled();
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
});
