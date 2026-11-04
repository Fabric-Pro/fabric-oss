/**
 * `integrations.github.callback` saves the grant in the credential manager
 * (ADR-026; GitHub access spec §4.2): while `CREDENTIAL_MANAGER` is on, a
 * connect upserts the member's GitHub credential in the organization the
 * signed state names, a reconnect of the same account updates that row
 * (generation +1, never a second row), the repository integration that
 * started the flow references it, and with the flag off nothing changes.
 *
 * The real `upsertAccountGrantCredential` runs against an in-memory
 * `credential` table standing in for the transaction client.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & {
	id: string;
	organizationId: string;
	generation: number;
	status: string;
};

const m = vi.hoisted(() => {
	process.env.ENCRYPTION_KEY = "test-encryption-key-for-oauth-state";
	process.env.FABRIC_GITHUB_CLIENT_ID = "gh-client-id";
	process.env.FABRIC_GITHUB_CLIENT_SECRET = "gh-client-secret";
	return {
		rows: [] as Row[],
		isFeatureEnabled: vi.fn(),
		recordAuditTx: vi.fn(),
		exchangeCodeForToken: vi.fn(),
		getGitHubUser: vi.fn(),
		getOrganizationMembership: vi.fn(),
		workflowIntegrationCreate: vi.fn(),
		workflowIntegrationUpdate: vi.fn(),
		createProjectRepoIntegration: vi.fn(),
		projectRepoFindFirst: vi.fn(),
		projectRepoUpdate: vi.fn(),
	};
});

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, condition]) => {
		const value = row[key];
		if (condition && typeof condition === "object") {
			const c = condition as { in?: unknown[]; not?: unknown };
			if (c.in) {
				return c.in.includes(value);
			}
			if ("not" in c) {
				return value !== c.not;
			}
		}
		return value === condition;
	});
}

const credentialTable = {
	findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
		const row = m.rows.find((r) => matches(r, where));
		return row ? { ...row } : null;
	}),
	findFirstOrThrow: vi.fn(
		async ({ where }: { where: Record<string, unknown> }) => {
			const row = m.rows.find((r) => matches(r, where));
			if (!row) {
				throw new Error("not found");
			}
			return { ...row };
		},
	),
	create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
		const row = {
			...data,
			id: `cred-${m.rows.length + 1}`,
			generation: 1,
			status: "ACTIVE",
		} as Row;
		m.rows.push(row);
		return { ...row };
	}),
	updateMany: vi.fn(
		async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			const hit = m.rows.filter((r) => matches(r, where));
			for (const row of hit) {
				for (const [key, value] of Object.entries(data)) {
					if (
						value &&
						typeof value === "object" &&
						"increment" in (value as object)
					) {
						row[key] =
							(row[key] as number) +
							(value as { increment: number }).increment;
					} else {
						row[key] = value;
					}
				}
			}
			return { count: hit.length };
		},
	),
};

vi.mock("@repo/connectors", () => ({
	integrationStatusForRepoAccess: () => ({
		status: "ACTIVE",
		lastError: null,
	}),
	resolveDefaultBranch: async () => "main",
	verifyRepositoryAccess: async () => ({ outcome: "accessible" }),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		isFeatureEnabled: m.isFeatureEnabled,
		recordAuditTx: m.recordAuditTx,
		db: {
			$transaction: (fn: (tx: unknown) => unknown) =>
				fn({ credential: credentialTable }),
			workflowIntegration: {
				findFirst: vi.fn().mockResolvedValue(null),
				create: m.workflowIntegrationCreate,
				update: m.workflowIntegrationUpdate,
			},
			dataConnection: { updateMany: vi.fn() },
			projectRepositoryIntegration: {
				findFirst: m.projectRepoFindFirst,
				create: vi.fn(),
				update: m.projectRepoUpdate,
			},
		},
		createProjectRepoIntegration: m.createProjectRepoIntegration,
		getOrganizationMembership: m.getOrganizationMembership,
		logRepoIntegrationActivity: vi.fn(),
		syncLegacyProjectRepoOnConnect: vi.fn(),
	};
});

vi.mock("@repo/integrations", () => ({ getGitHubToken: vi.fn() }));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace(/^enc_/, ""),
}));

vi.mock("../../../../lib/project-permissions", () => ({
	userHasProjectPermission: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../projects/lib/code-indexing-trigger", () => ({
	startCodeIndexingForProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../lib/redis-client", () => ({
	getRedisClient: () => null,
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

vi.mock("../../lib/github-oauth", () => ({
	exchangeCodeForToken: m.exchangeCodeForToken,
	getGitHubOAuthUrl: vi.fn(),
	getGitHubUser: m.getGitHubUser,
	listGitHubBranches: vi.fn(),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	});
	return {
		tenantProtectedProcedure: chain,
		protectedProcedure: chain,
		publicProcedure: chain,
		requirePermission: () => ({}),
		requireInputOrgPermission: () => ({}),
		requireOrganizationMembership: vi.fn(),
		resolveOrganizationIdForCaller: vi.fn(),
		Permissions: {
			INTEGRATION_USE: "integration:use",
			INTEGRATION_READ: "integration:read",
			INTEGRATION_DISCONNECT: "integration:disconnect",
			PROJECT_SETTINGS_EDIT: "project:settings:edit",
		},
	};
});

import { encodeOAuthState } from "../../lib/oauth-state";
import { __resetInMemoryOAuthStateStoreForTests } from "../../lib/oauth-state-store";
import { githubOAuthProcedures } from "../../procedures/github-oauth";

const callback = (
	githubOAuthProcedures.callback as unknown as {
		handler: (args: {
			input: { code?: string; state?: string };
			context: {
				user: { id: string; email: string; name: string };
				session: { id: string; activeOrganizationId: string | null };
			};
		}) => Promise<{ success: boolean; message: string }>;
	}
).handler;

const REDIRECT_URI =
	"https://app.example.com/api/integrations/github/oauth/callback";

const context = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev Example" },
	session: { id: "session-1", activeOrganizationId: "org-1" },
};

function personalState(organizationId = "org-1") {
	return encodeOAuthState({
		userId: "user-1",
		organizationId,
		provider: "github",
		redirectUri: REDIRECT_URI,
	});
}

function projectState() {
	return encodeOAuthState({
		userId: "user-1",
		organizationId: "org-1",
		provider: "github",
		redirectUri: REDIRECT_URI,
		targetType: "project",
		projectId: "proj-1",
		repositoryUrl: "https://github.com/example-org/widgets",
		repositoryOwner: "example-org",
		repositoryName: "widgets",
		defaultBranch: "main",
	});
}

function connect(state: string) {
	return callback({ input: { code: "code", state }, context });
}

beforeEach(() => {
	vi.clearAllMocks();
	__resetInMemoryOAuthStateStoreForTests();
	m.rows.length = 0;
	m.isFeatureEnabled.mockResolvedValue(true);
	m.getOrganizationMembership.mockImplementation(
		async (organizationId: string) => ({
			organization: { id: organizationId },
			role: "member",
		}),
	);
	m.exchangeCodeForToken.mockResolvedValue({
		access_token: "gh-access-1",
		token_type: "bearer",
		scope: "repo,read:user",
	});
	m.getGitHubUser.mockResolvedValue({
		id: 4242,
		login: "octo-example",
		name: "Octo",
		avatar_url: "",
		email: null,
	});
	m.workflowIntegrationCreate.mockResolvedValue({ id: "wi-1" });
	m.projectRepoFindFirst.mockResolvedValue(null);
	m.createProjectRepoIntegration.mockResolvedValue({ id: "pri-1" });
});

describe("GitHub connect saves the grant as a credential", () => {
	it("creates a private GitHub OAuth credential in the state's organization and audits it without the secret", async () => {
		await expect(connect(personalState())).resolves.toMatchObject({
			success: true,
		});

		expect(m.isFeatureEnabled).toHaveBeenCalledWith(
			"CREDENTIAL_MANAGER",
			"org-1",
		);
		expect(m.rows).toHaveLength(1);
		expect(m.rows[0]).toMatchObject({
			organizationId: "org-1",
			userId: "user-1",
			sharing: "PRIVATE",
			provider: "GITHUB",
			kind: "OAUTH",
			principal: "USER",
			origin: "https://github.com",
			externalAccountId: "4242",
			externalAccountLogin: "octo-example",
			scopes: ["repo", "read:user"],
			expiresAt: null,
			createdByUserId: "user-1",
		});
		expect(
			JSON.parse(String(m.rows[0].encryptedSecret).replace(/^enc_/, "")),
		).toEqual({ accessToken: "gh-access-1", issuer: "gh-client-id" });
		// The legacy store is still written.
		expect(m.workflowIntegrationCreate).toHaveBeenCalledTimes(1);

		expect(m.recordAuditTx).toHaveBeenCalledTimes(1);
		const audit = m.recordAuditTx.mock.calls[0][1];
		expect(audit).toMatchObject({
			action: "account.credential.created",
			organizationId: "org-1",
			resource: { type: "credential", id: "cred-1" },
		});
		expect(JSON.stringify(audit)).not.toContain("gh-access-1");
	});

	it("saves a GitHub App user token, with its refresh token and expiry", async () => {
		m.exchangeCodeForToken.mockResolvedValue({
			access_token: "ghu-access",
			token_type: "bearer",
			scope: "",
			refresh_token: "ghr-refresh",
			expires_in: 28800,
		});

		await connect(personalState());

		expect(m.rows[0]).toMatchObject({
			kind: "GITHUB_APP_USER",
			scopes: [],
		});
		expect(m.rows[0].expiresAt).toBeInstanceOf(Date);
		expect(
			JSON.parse(String(m.rows[0].encryptedSecret).replace(/^enc_/, "")),
		).toEqual({
			accessToken: "ghu-access",
			refreshToken: "ghr-refresh",
			issuer: "gh-client-id",
		});
	});

	it("updates the same row on a reconnect of the same account: generation +1, no second row", async () => {
		await connect(personalState());
		m.rows[0].status = "NEEDS_REAUTH";
		m.rows[0].lastError = "refresh-rejected";
		m.rows[0].label = "My GitHub";
		m.exchangeCodeForToken.mockResolvedValue({
			access_token: "gh-access-2",
			token_type: "bearer",
			scope: "repo,read:user,workflow",
		});

		await connect(personalState());

		expect(m.rows).toHaveLength(1);
		expect(m.rows[0]).toMatchObject({
			id: "cred-1",
			generation: 2,
			status: "ACTIVE",
			lastError: null,
			label: "My GitHub",
			scopes: ["repo", "read:user", "workflow"],
		});
		expect(String(m.rows[0].encryptedSecret)).toContain("gh-access-2");
		expect(m.recordAuditTx.mock.calls[1][1]).toMatchObject({
			action: "account.credential.updated",
			resource: { id: "cred-1" },
		});
	});

	it("creates the credential in the state's organization, not the session's active one", async () => {
		await callback({
			input: { code: "code", state: personalState("org-2") },
			context: {
				...context,
				session: { id: "session-1", activeOrganizationId: "org-1" },
			},
		});

		expect(m.isFeatureEnabled).toHaveBeenCalledWith(
			"CREDENTIAL_MANAGER",
			"org-2",
		);
		expect(m.rows).toHaveLength(1);
		expect(m.rows[0].organizationId).toBe("org-2");
		expect(m.recordAuditTx.mock.calls[0][1].organizationId).toBe("org-2");
	});

	it("keeps another organization's credential for the same account separate", async () => {
		await connect(personalState("org-1"));
		await connect(personalState("org-2"));

		expect(m.rows.map((r) => [r.organizationId, r.generation])).toEqual([
			["org-1", 1],
			["org-2", 1],
		]);
	});

	it("binds the repository integration that started the flow and keeps writing its token columns", async () => {
		await expect(connect(projectState())).resolves.toMatchObject({
			success: true,
		});

		expect(m.rows).toHaveLength(1);
		expect(m.createProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: "cred-1",
				encryptedAccessToken: "enc_gh-access-1",
				authMethod: "OAUTH",
			}),
		);
	});

	it("rebinds an existing repository integration on reconnect", async () => {
		m.projectRepoFindFirst.mockResolvedValue({ id: "pri-existing" });

		await connect(projectState());

		expect(m.projectRepoUpdate).toHaveBeenCalledWith({
			where: { id: "pri-existing" },
			data: expect.objectContaining({
				credentialId: "cred-1",
				encryptedAccessToken: "enc_gh-access-1",
			}),
		});
	});

	it("clears the repository binding when saving the credential fails, and still connects", async () => {
		m.projectRepoFindFirst.mockResolvedValue({ id: "pri-existing" });
		credentialTable.findFirst.mockRejectedValueOnce(
			Object.assign(new Error("db down"), { code: "P1001" }),
		);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await expect(connect(projectState())).resolves.toMatchObject({
			success: true,
		});

		expect(
			m.projectRepoUpdate.mock.calls[0][0].data.credentialId,
		).toBeNull();
		consoleError.mockRestore();
	});

	describe("flag off", () => {
		beforeEach(() => {
			m.isFeatureEnabled.mockResolvedValue(false);
		});

		it("creates no credential and writes no credential audit for a personal connect", async () => {
			await expect(connect(personalState())).resolves.toMatchObject({
				success: true,
			});

			expect(m.rows).toHaveLength(0);
			expect(credentialTable.create).not.toHaveBeenCalled();
			expect(m.recordAuditTx).not.toHaveBeenCalled();
			expect(m.workflowIntegrationCreate).toHaveBeenCalledTimes(1);
		});

		it("leaves the repository integration's credential binding untouched", async () => {
			m.projectRepoFindFirst.mockResolvedValue({ id: "pri-existing" });

			await connect(projectState());

			expect(m.rows).toHaveLength(0);
			expect(
				m.projectRepoUpdate.mock.calls[0][0].data,
			).not.toHaveProperty("credentialId");
		});
	});
});
