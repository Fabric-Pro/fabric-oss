/**
 * `projects.repositoryIntegrations.updateBranch` — monitored-branch change.
 *
 * Locks the external contract:
 *   - integration must belong to the addressed project (NOT_FOUND otherwise).
 *   - the branch is verified on the remote BEFORE any write; not-found /
 *     unauthorized / unreachable map to three distinct errors.
 *   - same-branch saves are idempotent no-ops (no write, no remote call).
 *   - expired GitHub OAuth credentials get a forced refresh first.
 *   - a successful save writes `defaultBranch`, logs a
 *     `repo_integration_branch_changed` activity, and records the
 *     `atlas.branch.changed` audit row with previous/new branch metadata.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------
const mockVerifyRepositoryBranch = vi.fn();
const mockEnsureFreshRepoCredentials = vi.fn();
const mockGetProjectRepoIntegration = vi.fn();
const mockIntegrationUpdate = vi.fn();
const mockLogRepoIntegrationActivity = vi.fn();
const mockDecryptApiKey = vi.fn();
const mockRecordAuditFromRequest = vi.fn();
const capturedPermissions: unknown[] = [];

vi.mock("@repo/connectors", () => ({
	verifyRepositoryBranch: (...args: unknown[]) =>
		mockVerifyRepositoryBranch(...args),
}));

vi.mock("@repo/atlas", () => ({
	ensureFreshRepoCredentials: (...args: unknown[]) =>
		mockEnsureFreshRepoCredentials(...args),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			update: (...args: unknown[]) => mockIntegrationUpdate(...args),
		},
	},
	getProjectRepoIntegration: (...args: unknown[]) =>
		mockGetProjectRepoIntegration(...args),
	logRepoIntegrationActivity: (...args: unknown[]) =>
		mockLogRepoIntegrationActivity(...args),
}));

vi.mock("@repo/utils", () => ({
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
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: (permission: unknown) => {
			capturedPermissions.push(permission);
			return (c: unknown) => c;
		},
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: {
		user: { id: string; name: string };
		session: { id: string };
	};
}) => Promise<{ integration: { id: string; defaultBranch: string } }>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../update-branch");
	return (
		mod.updateRepoIntegrationBranchProcedure as unknown as {
			handler: Handler;
		}
	).handler;
}

function makeIntegration(overrides: Record<string, unknown> = {}) {
	return {
		id: "int-1",
		projectId: "p1",
		provider: "GITHUB",
		authMethod: "OAUTH",
		repositoryUrl: "https://github.com/acme/widgets",
		repositoryOwner: "acme",
		repositoryName: "widgets",
		defaultBranch: "main",
		status: "ACTIVE",
		encryptedAccessToken: "enc:token",
		encryptedRefreshToken: "enc:refresh",
		encryptedPat: null,
		azureOrganization: null,
		tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
		...overrides,
	};
}

const baseInput = {
	projectId: "p1",
	organizationId: null,
	integrationId: "int-1",
	branch: "develop",
};

const baseContext = {
	user: { id: "user-1", name: "User One" },
	session: { id: "session-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockGetProjectRepoIntegration.mockResolvedValue(makeIntegration());
	mockDecryptApiKey.mockReturnValue("plain-token");
	mockVerifyRepositoryBranch.mockResolvedValue("exists");
	mockIntegrationUpdate.mockResolvedValue({
		id: "int-1",
		defaultBranch: "develop",
	});
	mockLogRepoIntegrationActivity.mockResolvedValue(undefined);
	mockEnsureFreshRepoCredentials.mockResolvedValue({
		status: "ACTIVE",
		canAutoRefresh: true,
	});
});

describe("updateRepoIntegrationBranchProcedure", () => {
	it("verifies the branch remotely, writes defaultBranch, and records activity + audit", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});

		expect(mockVerifyRepositoryBranch).toHaveBeenCalledWith({
			provider: "GITHUB",
			token: "plain-token",
			repositoryUrl: "https://github.com/acme/widgets",
			owner: "acme",
			repo: "widgets",
			azureOrganization: null,
			branch: "develop",
		});
		expect(mockIntegrationUpdate).toHaveBeenCalledWith({
			where: { id: "int-1" },
			data: { defaultBranch: "develop" },
			select: { id: true, defaultBranch: true },
		});
		expect(mockLogRepoIntegrationActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				activityType: "repo_integration_branch_changed",
				projectId: "p1",
				integrationId: "int-1",
				repositoryName: "acme/widgets",
				metadata: expect.objectContaining({
					previousBranch: "main",
					branch: "develop",
				}),
			}),
		);
		expect(mockRecordAuditFromRequest).toHaveBeenCalledWith(
			baseContext,
			expect.objectContaining({
				action: "atlas.branch.changed",
				category: "atlas",
				projectId: "p1",
				resource: expect.objectContaining({
					type: "repository_integration",
					id: "int-1",
					name: "acme/widgets",
				}),
				metadata: expect.objectContaining({
					previousBranch: "main",
					branch: "develop",
					provider: "GITHUB",
				}),
			}),
		);
		expect(result).toEqual({
			integration: { id: "int-1", defaultBranch: "develop" },
		});
		// The token never leaks into the response.
		expect(JSON.stringify(result)).not.toContain("plain-token");
	});

	it("throws NOT_FOUND when the integration does not belong to the addressed project", async () => {
		mockGetProjectRepoIntegration.mockResolvedValue(null);

		const handler = await loadHandler();
		await expect(
			handler({ input: baseInput, context: baseContext }),
		).rejects.toMatchObject({
			message: "Repository integration not found",
		});
		expect(mockVerifyRepositoryBranch).not.toHaveBeenCalled();
		expect(mockIntegrationUpdate).not.toHaveBeenCalled();
	});

	it("maps a not-found branch to BAD_REQUEST with the branch name and writes nothing", async () => {
		mockVerifyRepositoryBranch.mockResolvedValue("not-found");

		const handler = await loadHandler();
		await expect(
			handler({ input: baseInput, context: baseContext }),
		).rejects.toMatchObject({
			message: 'Branch "develop" wasn\'t found on the remote.',
		});
		expect(mockIntegrationUpdate).not.toHaveBeenCalled();
		expect(mockRecordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("maps an unauthorized verification to the credentials message", async () => {
		mockVerifyRepositoryBranch.mockResolvedValue("unauthorized");

		const handler = await loadHandler();
		await expect(
			handler({ input: baseInput, context: baseContext }),
		).rejects.toMatchObject({
			message:
				"Repository credentials have expired — reconnect the repository to change the branch.",
		});
		expect(mockIntegrationUpdate).not.toHaveBeenCalled();
	});

	it("maps an unreachable remote to the network message and writes nothing", async () => {
		mockVerifyRepositoryBranch.mockResolvedValue("unreachable");

		const handler = await loadHandler();
		await expect(
			handler({ input: baseInput, context: baseContext }),
		).rejects.toMatchObject({
			message:
				"Couldn't reach the repository to verify the branch. Try again in a moment.",
		});
		expect(mockIntegrationUpdate).not.toHaveBeenCalled();
	});

	it("treats saving the current branch as an idempotent no-op (no write, no remote call)", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: { ...baseInput, branch: "main" },
			context: baseContext,
		});

		expect(result).toEqual({
			integration: { id: "int-1", defaultBranch: "main" },
		});
		expect(mockVerifyRepositoryBranch).not.toHaveBeenCalled();
		expect(mockIntegrationUpdate).not.toHaveBeenCalled();
		expect(mockRecordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("rejects a DISCONNECTED integration before touching credentials", async () => {
		mockGetProjectRepoIntegration.mockResolvedValue(
			makeIntegration({ status: "DISCONNECTED" }),
		);

		const handler = await loadHandler();
		await expect(
			handler({ input: baseInput, context: baseContext }),
		).rejects.toMatchObject({
			message:
				"This repository is disconnected. Reconnect it before changing the branch.",
		});
		expect(mockDecryptApiKey).not.toHaveBeenCalled();
	});

	it("forces a credential refresh for an expired GitHub OAuth integration before verifying", async () => {
		const expired = makeIntegration({
			status: "TOKEN_EXPIRED",
			tokenExpiresAt: new Date(Date.now() - 60_000),
		});
		const healed = makeIntegration({
			status: "ACTIVE",
			encryptedAccessToken: "enc:rotated",
		});
		mockGetProjectRepoIntegration
			.mockResolvedValueOnce(expired)
			.mockResolvedValueOnce(healed);

		const handler = await loadHandler();
		await handler({ input: baseInput, context: baseContext });

		expect(mockEnsureFreshRepoCredentials).toHaveBeenCalledWith({
			integrationId: "int-1",
			userId: "user-1",
			organizationId: null,
			force: true,
		});
		// The rotated token (from the re-read) is what gets decrypted.
		expect(mockDecryptApiKey).toHaveBeenCalledWith("enc:rotated");
		expect(mockVerifyRepositoryBranch).toHaveBeenCalledTimes(1);
	});

	it("fails with the credentials message when the forced refresh could not heal the row", async () => {
		const expired = makeIntegration({
			status: "TOKEN_EXPIRED",
			tokenExpiresAt: new Date(Date.now() - 60_000),
		});
		mockGetProjectRepoIntegration.mockResolvedValue(expired);
		mockEnsureFreshRepoCredentials.mockResolvedValue({
			status: "TOKEN_EXPIRED",
			canAutoRefresh: true,
		});

		const handler = await loadHandler();
		await expect(
			handler({ input: baseInput, context: baseContext }),
		).rejects.toMatchObject({
			message:
				"Repository credentials have expired — reconnect the repository to change the branch.",
		});
		expect(mockVerifyRepositoryBranch).not.toHaveBeenCalled();
	});

	it("never attempts a refresh for PAT providers (ADO) — the PAT is used as stored", async () => {
		mockGetProjectRepoIntegration.mockResolvedValue(
			makeIntegration({
				provider: "AZURE_DEVOPS",
				authMethod: "PAT",
				encryptedAccessToken: null,
				encryptedPat: "enc:pat",
				azureOrganization: "my-org",
			}),
		);

		const handler = await loadHandler();
		await handler({ input: baseInput, context: baseContext });

		expect(mockEnsureFreshRepoCredentials).not.toHaveBeenCalled();
		expect(mockDecryptApiKey).toHaveBeenCalledWith("enc:pat");
		expect(mockVerifyRepositoryBranch).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "AZURE_DEVOPS",
				azureOrganization: "my-org",
			}),
		);
	});

	it("is registered behind the PROJECT_SETTINGS_EDIT project permission (server-enforced FORBIDDEN)", async () => {
		await loadHandler();
		expect(capturedPermissions).toContain("PROJECT_SETTINGS_EDIT");
	});
});
