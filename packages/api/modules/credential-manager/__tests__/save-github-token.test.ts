/**
 * `credentialManager.saveGitHubToken`, the repository import form's
 * "Save in the credential manager": refused while the flag is off, validated
 * against the repository before anything is saved, the caller's own token
 * for the same account offered instead of a duplicate, `saveAsNew` saving a
 * second one, and neither the answer nor the audit row carrying the token.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	verifyMembership: vi.fn(),
	createCredential: vi.fn(),
	findOwnPat: vi.fn(),
	recordAuditTx: vi.fn(),
	validateGitHubPat: vi.fn(),
	readGitHubTokenAccount: vi.fn(),
	canGitHubTokenListRepositories: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: m.isFeatureEnabled,
	createCredential: m.createCredential,
	findOwnPatCredentialForAccount: m.findOwnPat,
	recordAuditTx: m.recordAuditTx,
	canManageCredential: () => true,
	db: {
		$transaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }),
	},
}));
vi.mock("@repo/connectors", () => ({
	validateGitHubPat: m.validateGitHubPat,
	readGitHubTokenAccount: m.readGitHubTokenAccount,
	canGitHubTokenListRepositories: m.canGitHubTokenListRepositories,
}));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: m.verifyMembership,
}));
vi.mock("../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		requireInputOrgPermission: () => (c: unknown) => c,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

import { saveGitHubTokenProcedure } from "../procedures/save-github-token";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string; email: string; name: string } };
}) => Promise<Record<string, unknown>>;
const handler = (saveGitHubTokenProcedure as unknown as { handler: Handler })
	.handler;

const TOKEN = "github_pat_example_value";
const context = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev Example" },
};
const input = {
	organizationId: "org-1",
	token: TOKEN,
	owner: "example-org",
	repo: "booking-app",
	saveAsNew: false,
	// The token below is fine-grained; its permissions are confirmed.
	confirmFineGrainedPermissions: true,
};

function credential(overrides: Record<string, unknown> = {}) {
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
		scopes: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	m.isFeatureEnabled.mockResolvedValue(true);
	m.verifyMembership.mockResolvedValue({ role: "member" });
	m.validateGitHubPat.mockResolvedValue({ ok: true });
	// A fine-grained token: no classic scopes.
	m.readGitHubTokenAccount.mockResolvedValue({
		ok: true,
		id: "42",
		login: "example-dev",
		scopes: [],
		tokenType: "fine-grained",
	});
	m.canGitHubTokenListRepositories.mockResolvedValue(true);
	m.findOwnPat.mockResolvedValue(null);
	m.createCredential.mockImplementation(async (data: { label: string }) =>
		credential({ label: data.label }),
	);
	m.recordAuditTx.mockResolvedValue(undefined);
});

describe("credentialManager.saveGitHubToken", () => {
	it("is NOT_FOUND while the credential manager is off", async () => {
		m.isFeatureEnabled.mockResolvedValue(false);
		await expect(handler({ input, context })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(m.validateGitHubPat).not.toHaveBeenCalled();
		expect(m.createCredential).not.toHaveBeenCalled();
	});

	it("refuses a token that cannot read the repository, saving nothing", async () => {
		m.validateGitHubPat.mockResolvedValue({ ok: false, status: 404 });
		await expect(handler({ input, context })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(m.readGitHubTokenAccount).not.toHaveBeenCalled();
		expect(m.createCredential).not.toHaveBeenCalled();
	});

	it("saves a new account's token as a private PAT with an empty scope list", async () => {
		const result = await handler({ input, context });

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
				kind: "PAT",
				scopes: [],
				externalAccountId: "42",
				externalAccountLogin: "example-dev",
				secret: { token: TOKEN },
			}),
			{ tx: true },
		);
		expect(result).toEqual({
			credential: {
				id: "cred-new",
				label: "GitHub token · example-dev",
				externalAccountLogin: "example-dev",
			},
		});
		const [, audit] = m.recordAuditTx.mock.calls[0] ?? [];
		expect(audit).toMatchObject({ action: "account.credential.created" });
		expect(JSON.stringify(m.recordAuditTx.mock.calls)).not.toContain(TOKEN);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("names the caller's saved token for the same account and writes nothing", async () => {
		m.findOwnPat.mockResolvedValue(
			credential({ id: "cred-old", label: "Laptop token" }),
		);
		const result = await handler({ input, context });

		expect(m.findOwnPat).toHaveBeenCalledWith({
			organizationId: "org-1",
			userId: "user-1",
			provider: "GITHUB",
			externalAccountId: "42",
		});
		expect(result).toEqual({
			existingCredential: {
				id: "cred-old",
				label: "Laptop token",
				externalAccountLogin: "example-dev",
			},
		});
		expect(m.createCredential).not.toHaveBeenCalled();
		expect(m.recordAuditTx).not.toHaveBeenCalled();
	});

	it("saveAsNew saves a second credential for the same account", async () => {
		m.findOwnPat.mockResolvedValue(credential({ id: "cred-old" }));
		const result = await handler({
			input: { ...input, saveAsNew: true, label: "Second token" },
			context,
		});

		expect(m.findOwnPat).not.toHaveBeenCalled();
		expect(m.createCredential).toHaveBeenCalledWith(
			expect.objectContaining({ label: "Second token" }),
			{ tx: true },
		);
		expect(result.credential).toMatchObject({ label: "Second token" });
	});

	it("refuses a fine-grained token until its permissions are confirmed", async () => {
		await expect(
			handler({
				input: { ...input, confirmFineGrainedPermissions: false },
				context,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "GITHUB_TOKEN_CONFIRM_PERMISSIONS" },
		});
		expect(m.canGitHubTokenListRepositories).toHaveBeenCalled();
		expect(m.createCredential).not.toHaveBeenCalled();
	});

	it("refuses a classic token missing a scope, as the credential manager's form does", async () => {
		m.readGitHubTokenAccount.mockResolvedValue({
			ok: true,
			id: "42",
			login: "example-dev",
			scopes: ["repo"],
			tokenType: "classic",
		});
		await expect(handler({ input, context })).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: {
				reason: "GITHUB_TOKEN_MISSING_SCOPES",
				missing: [
					"workflow",
					"admin:org",
					"project",
					"read:user",
					"user:email",
				],
			},
		});
		expect(m.createCredential).not.toHaveBeenCalled();
	});

	it("saves a classic token holding every required scope", async () => {
		m.readGitHubTokenAccount.mockResolvedValue({
			ok: true,
			id: "42",
			login: "example-dev",
			scopes: ["repo", "workflow", "admin:org", "project", "user"],
			tokenType: "classic",
		});
		await handler({
			input: { ...input, confirmFineGrainedPermissions: false },
			context,
		});
		expect(m.createCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				scopes: ["repo", "workflow", "admin:org", "project", "user"],
			}),
			{ tx: true },
		);
	});

	it("refuses a non-member before reading anything", async () => {
		m.verifyMembership.mockResolvedValue(null);
		await expect(handler({ input, context })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(m.validateGitHubPat).not.toHaveBeenCalled();
	});
});
