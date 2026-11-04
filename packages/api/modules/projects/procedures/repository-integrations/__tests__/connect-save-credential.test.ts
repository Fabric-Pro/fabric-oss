/**
 * "Connect with a token (PAT)" saving the pasted GitHub token in the
 * credential manager (spec 2026-11-04 §4.3, ADR-026):
 *
 *   - flag off: `saveCredential` is ignored and the token goes to
 *     `encryptedPat`, exactly as before;
 *   - a new account: a private PAT credential is created and the repository
 *     is bound to it by `credentialId`, with no `encryptedPat`, audited
 *     without the token;
 *   - an account already saved: nothing is written and the answer names it;
 *   - `saveAsNew` saves a second one;
 *   - "Use it" (`credentialId`) binds the saved one;
 *   - the match is looked up in the project's organization for the caller.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	validateGitHubPat: vi.fn(),
	resolveDefaultBranch: vi.fn(),
	readGitHubTokenAccount: vi.fn(),
	canGitHubTokenListRepositories: vi.fn(),
	verifyRepositoryAccess: vi.fn(),
	createProjectRepoIntegration: vi.fn(),
	syncLegacy: vi.fn(),
	logActivity: vi.fn(),
	parseRepoUrl: vi.fn(),
	isFeatureEnabled: vi.fn(),
	createCredential: vi.fn(),
	findOwnPat: vi.fn(),
	recordAuditTx: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	projectFindUnique: vi.fn(),
	repoFindFirst: vi.fn(),
	verifyMembership: vi.fn(),
	resolveCredential: vi.fn(),
	encryptApiKey: vi.fn(),
	startIndexing: vi.fn(),
}));

vi.mock("@repo/connectors", () => ({
	validateGitHubPat: m.validateGitHubPat,
	validateGitLabPat: vi.fn(),
	validateAzureDevOpsPat: vi.fn(),
	resolveDefaultBranch: m.resolveDefaultBranch,
	readGitHubTokenAccount: m.readGitHubTokenAccount,
	canGitHubTokenListRepositories: m.canGitHubTokenListRepositories,
	verifyRepositoryAccess: m.verifyRepositoryAccess,
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: m.projectFindUnique },
		projectRepositoryIntegration: {
			findFirst: m.repoFindFirst,
			findMany: async () => [],
		},
		$transaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }),
	},
	createProjectRepoIntegration: m.createProjectRepoIntegration,
	syncLegacyProjectRepoOnConnect: m.syncLegacy,
	logRepoIntegrationActivity: m.logActivity,
	parseRepoUrl: m.parseRepoUrl,
	isFeatureEnabled: m.isFeatureEnabled,
	createCredential: m.createCredential,
	findOwnPatCredentialForAccount: m.findOwnPat,
	recordAuditTx: m.recordAuditTx,
	canManageCredential: () => true,
}));

vi.mock("@repo/integrations/github", () => ({
	getGitHubWorkflowCredential: async () => null,
}));
vi.mock("@repo/integrations/credential-manager", async () => ({
	...(await import(
		"../../../../../../integrations/src/credential-manager/requirement"
	)),
	resolveCredential: m.resolveCredential,
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	REPOSITORY_CREDENTIAL_KINDS: ["PAT", "OAUTH"],
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: m.encryptApiKey,
	decryptApiKey: (k: string) => k,
}));
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: m.verifyMembership,
}));
vi.mock("../../../lib/code-indexing-trigger", () => ({
	startCodeIndexingForProject: m.startIndexing,
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: m.recordAuditFromRequest,
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
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Result = Record<string, unknown>;
type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<Result>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../connect");
	return (
		mod.connectRepoIntegrationProcedure as unknown as { handler: Handler }
	).handler;
}

const TOKEN = "ghp_example_token_value";

const context = {
	user: { id: "user-1", name: "Dev Example", email: "dev@example.com" },
	session: { id: "session-1" },
};

const githubInput = {
	projectId: "p1",
	organizationId: "org-1",
	provider: "GITHUB",
	authMethod: "PAT",
	repositoryUrl: "https://github.com/example-org/booking-app",
	repositoryOwner: "example-org",
	repositoryName: "booking-app",
	pat: TOKEN,
};

function savedCredential(overrides: Record<string, unknown> = {}) {
	return {
		id: "cred-new",
		organizationId: "org-1",
		userId: "user-1",
		sharing: "PRIVATE",
		provider: "GITHUB",
		kind: "PAT",
		principal: "USER",
		label: "GitHub token · example-dev",
		origin: "https://github.com",
		externalAccountId: "42",
		externalAccountLogin: "example-dev",
		scopes: ["repo"],
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	m.encryptApiKey.mockImplementation((k: string) => `enc_${k}`);
	m.parseRepoUrl.mockReturnValue({
		provider: "GITHUB",
		owner: "example-org",
		name: "booking-app",
		url: "https://github.com/example-org/booking-app",
	});
	m.validateGitHubPat.mockResolvedValue({ ok: true });
	m.resolveDefaultBranch.mockResolvedValue("main");
	m.createProjectRepoIntegration.mockResolvedValue({ id: "int-1" });
	m.repoFindFirst.mockResolvedValue(null);
	m.projectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	m.verifyMembership.mockResolvedValue({ role: "member" });
	m.isFeatureEnabled.mockResolvedValue(true);
	m.readGitHubTokenAccount.mockResolvedValue({
		ok: true,
		id: "42",
		login: "example-dev",
		scopes: ["repo", "workflow", "admin:org", "project", "user"],
		tokenType: "classic",
	});
	m.findOwnPat.mockResolvedValue(null);
	m.createCredential.mockImplementation(
		async (input: Record<string, unknown>) =>
			savedCredential({ label: input.label, scopes: input.scopes }),
	);
	m.recordAuditTx.mockResolvedValue(undefined);
	m.startIndexing.mockResolvedValue(undefined);
	m.syncLegacy.mockResolvedValue(undefined);
	m.logActivity.mockResolvedValue(undefined);
});

describe("connect: save a pasted GitHub token in the credential manager", () => {
	it("flag off: ignores saveCredential and stores the token as before", async () => {
		m.isFeatureEnabled.mockResolvedValue(false);
		const handler = await loadHandler();
		const result = await handler({
			input: { ...githubInput, saveCredential: { saveAsNew: false } },
			context,
		});

		expect(m.readGitHubTokenAccount).not.toHaveBeenCalled();
		expect(m.createCredential).not.toHaveBeenCalled();
		expect(m.createProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				encryptedPat: `enc_${TOKEN}`,
				credentialId: undefined,
			}),
		);
		expect(result).toEqual({ integration: { id: "int-1" }, success: true });
	});

	it("without saveCredential: never consults the flag or the credential manager", async () => {
		const handler = await loadHandler();
		await handler({ input: githubInput, context });

		expect(m.isFeatureEnabled).not.toHaveBeenCalled();
		expect(m.createCredential).not.toHaveBeenCalled();
		expect(m.createProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({ encryptedPat: `enc_${TOKEN}` }),
		);
	});

	it("a new account: creates a private PAT credential and binds it without encryptedPat", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: { ...githubInput, saveCredential: { saveAsNew: false } },
			context,
		});

		expect(m.validateGitHubPat).toHaveBeenCalledWith({
			pat: TOKEN,
			owner: "example-org",
			repo: "booking-app",
		});
		expect(m.createCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				userId: "user-1",
				sharing: "PRIVATE",
				provider: "GITHUB",
				kind: "PAT",
				label: "GitHub token · example-dev",
				externalAccountId: "42",
				externalAccountLogin: "example-dev",
				scopes: ["repo", "workflow", "admin:org", "project", "user"],
				secret: { token: TOKEN },
				createdByUserId: "user-1",
			}),
			{ tx: true },
		);
		const created = m.createProjectRepoIntegration.mock.calls[0]?.[0];
		expect(created.credentialId).toBe("cred-new");
		expect(created.encryptedPat).toBeUndefined();
		expect(result).toEqual({
			integration: { id: "int-1" },
			success: true,
			savedCredential: {
				id: "cred-new",
				label: "GitHub token · example-dev",
				externalAccountLogin: "example-dev",
			},
		});
	});

	it("audits the new credential with account.credential.created and no token", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: { ...githubInput, saveCredential: { saveAsNew: false } },
			context,
		});

		expect(m.recordAuditTx).toHaveBeenCalledTimes(1);
		const [, audit] = m.recordAuditTx.mock.calls[0] ?? [];
		expect(audit).toMatchObject({
			action: "account.credential.created",
			organizationId: "org-1",
			resource: { type: "credential", id: "cred-new" },
		});
		expect(JSON.stringify(m.recordAuditTx.mock.calls)).not.toContain(TOKEN);
		expect(
			JSON.stringify(m.recordAuditFromRequest.mock.calls),
		).not.toContain(TOKEN);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("uses the label the person typed", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				...githubInput,
				saveCredential: { label: "CI token", saveAsNew: false },
			},
			context,
		});
		expect(m.createCredential).toHaveBeenCalledWith(
			expect.objectContaining({ label: "CI token" }),
			{ tx: true },
		);
	});

	it("an account already saved: returns existingCredential and writes nothing", async () => {
		m.findOwnPat.mockResolvedValue(
			savedCredential({ id: "cred-old", label: "My laptop token" }),
		);
		const handler = await loadHandler();
		const result = await handler({
			input: { ...githubInput, saveCredential: { saveAsNew: false } },
			context,
		});

		expect(result).toEqual({
			existingCredential: {
				id: "cred-old",
				label: "My laptop token",
				externalAccountLogin: "example-dev",
			},
		});
		expect(m.createCredential).not.toHaveBeenCalled();
		expect(m.recordAuditTx).not.toHaveBeenCalled();
		expect(m.createProjectRepoIntegration).not.toHaveBeenCalled();
		expect(m.syncLegacy).not.toHaveBeenCalled();
		expect(m.logActivity).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("looks for the match in the project's organization for the caller, never the input's", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				...githubInput,
				organizationId: "org-other",
				saveCredential: { saveAsNew: false },
			},
			context,
		});
		expect(m.findOwnPat).toHaveBeenCalledWith({
			organizationId: "org-1",
			userId: "user-1",
			provider: "GITHUB",
			externalAccountId: "42",
		});
		expect(m.isFeatureEnabled).toHaveBeenCalledWith(
			"CREDENTIAL_MANAGER",
			"org-1",
		);
	});

	it("saveAsNew: creates a second credential without looking for a match", async () => {
		m.findOwnPat.mockResolvedValue(savedCredential({ id: "cred-old" }));
		const handler = await loadHandler();
		await handler({
			input: { ...githubInput, saveCredential: { saveAsNew: true } },
			context,
		});

		expect(m.findOwnPat).not.toHaveBeenCalled();
		expect(m.createCredential).toHaveBeenCalledTimes(1);
		expect(m.createProjectRepoIntegration).toHaveBeenCalledWith(
			expect.objectContaining({ credentialId: "cred-new" }),
		);
	});

	it("an already connected repository is refused before anything is saved", async () => {
		m.repoFindFirst.mockResolvedValue({ id: "int-existing" });
		const handler = await loadHandler();
		await expect(
			handler({
				input: { ...githubInput, saveCredential: { saveAsNew: false } },
				context,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.createCredential).not.toHaveBeenCalled();
	});

	it("a token GitHub will not name an account for is refused, nothing saved", async () => {
		m.readGitHubTokenAccount.mockResolvedValue({ ok: false, status: 401 });
		const handler = await loadHandler();
		await expect(
			handler({
				input: { ...githubInput, saveCredential: { saveAsNew: false } },
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.createCredential).not.toHaveBeenCalled();
		expect(m.createProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("a classic token missing a scope is refused before anything is saved or connected", async () => {
		m.readGitHubTokenAccount.mockResolvedValue({
			ok: true,
			id: "42",
			login: "example-dev",
			scopes: ["repo"],
			tokenType: "classic",
		});
		const handler = await loadHandler();
		await expect(
			handler({
				input: { ...githubInput, saveCredential: { saveAsNew: false } },
				context,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "GITHUB_TOKEN_MISSING_SCOPES" },
		});
		expect(m.createCredential).not.toHaveBeenCalled();
		expect(m.createProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("a fine-grained token is saved only once its permissions are confirmed", async () => {
		m.readGitHubTokenAccount.mockResolvedValue({
			ok: true,
			id: "42",
			login: "example-dev",
			scopes: [],
			tokenType: "fine-grained",
		});
		m.canGitHubTokenListRepositories.mockResolvedValue(true);
		const handler = await loadHandler();
		await expect(
			handler({
				input: { ...githubInput, saveCredential: { saveAsNew: false } },
				context,
			}),
		).rejects.toMatchObject({
			data: { reason: "GITHUB_TOKEN_CONFIRM_PERMISSIONS" },
		});
		expect(m.createCredential).not.toHaveBeenCalled();

		await handler({
			input: {
				...githubInput,
				saveCredential: {
					saveAsNew: false,
					confirmFineGrainedPermissions: true,
				},
			},
			context,
		});
		expect(m.createCredential).toHaveBeenCalledWith(
			expect.objectContaining({ scopes: [] }),
			{ tx: true },
		);
	});

	it("'Use it': binds the saved credential after probing the repository", async () => {
		m.resolveCredential.mockResolvedValue({
			ok: true,
			value: {
				credential: savedCredential({ id: "cred-old" }),
				token: "resolved-token",
				expiresAt: null,
			},
		});
		m.verifyRepositoryAccess.mockResolvedValue({ outcome: "accessible" });
		const handler = await loadHandler();
		const { pat: _pat, ...withoutPat } = githubInput;
		await handler({
			input: { ...withoutPat, credentialId: "cred-old" },
			context,
		});

		expect(m.resolveCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: "cred-old",
				actor: expect.objectContaining({
					type: "user",
					userId: "user-1",
					organizationId: "org-1",
				}),
			}),
		);
		expect(m.validateGitHubPat).not.toHaveBeenCalled();
		expect(m.createCredential).not.toHaveBeenCalled();
		const created = m.createProjectRepoIntegration.mock.calls[0]?.[0];
		expect(created.credentialId).toBe("cred-old");
		expect(created.encryptedPat).toBeUndefined();
	});

	it("'Use it' with a credential the caller may not use is refused", async () => {
		m.resolveCredential.mockResolvedValue({
			ok: false,
			failure: { code: "forbidden" },
		});
		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					...githubInput,
					pat: undefined,
					credentialId: "cred-x",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.createProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it("credentialId while the credential manager is off is refused", async () => {
		m.isFeatureEnabled.mockResolvedValue(false);
		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					...githubInput,
					pat: undefined,
					credentialId: "cred-x",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.resolveCredential).not.toHaveBeenCalled();
		expect(m.createProjectRepoIntegration).not.toHaveBeenCalled();
	});
});
