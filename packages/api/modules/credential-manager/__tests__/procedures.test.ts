/**
 * Credential-manager procedures (phase 1): the flag gate, who may create,
 * change and delete what, that another member's private credential is
 * indistinguishable from a missing one, that responses never carry the
 * secret, and that audit rows name the credential without its secret.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FULL_SCOPES = "repo, workflow, admin:org, project, user";

/** GitHub's answer to `GET /user` (and `/user/repos`) for the stub. */
function githubResponse(
	status: number,
	scopes: string | null,
	body: unknown = { id: 42, login: "example-dev" },
) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		headers: {
			get: (name: string) =>
				name.toLowerCase() === "x-oauth-scopes" ? scopes : null,
		},
	};
}

const fetchMock = vi.fn();

const m = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	verifyMembership: vi.fn(),
	createCredential: vi.fn(),
	updateCredential: vi.fn(),
	deleteCredential: vi.fn(),
	getCredentialMetadata: vi.fn(),
	listVisibleCredentials: vi.fn(),
	recordAuditTx: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const access = await import(
		"../../../../database/prisma/queries/lib/credential-access"
	);
	return {
		...access,
		isFeatureEnabled: m.isFeatureEnabled,
		createCredential: m.createCredential,
		updateCredential: m.updateCredential,
		deleteCredential: m.deleteCredential,
		getCredentialMetadata: m.getCredentialMetadata,
		listVisibleCredentials: m.listVisibleCredentials,
		recordAuditTx: m.recordAuditTx,
		db: {
			$transaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }),
		},
	};
});
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

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string; email: string; name: string } };
}) => Promise<unknown>;
const handlerOf = (procedure: unknown) =>
	(procedure as { handler: Handler }).handler;

const context = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev Example" },
};

function meta(overrides: Record<string, unknown> = {}) {
	return {
		id: "cred-1",
		organizationId: "org-1",
		userId: "user-1",
		sharing: "PRIVATE",
		provider: "GITHUB",
		kind: "PAT",
		principal: "USER",
		label: "CI token",
		origin: "https://github.com",
		externalAccountId: null,
		externalAccountLogin: null,
		installationId: null,
		installation: null,
		scopes: [],
		generation: 1,
		status: "ACTIVE",
		expiresAt: null,
		refreshRejectedAt: null,
		lastCheckedAt: null,
		lastUsedAt: null,
		lastError: null,
		createdByUserId: "user-1",
		createdAt: new Date("2026-10-31T00:00:00Z"),
		updatedAt: new Date("2026-10-31T00:00:00Z"),
		...overrides,
	};
}

async function call(
	file: "create" | "update" | "delete" | "list",
	input: Record<string, unknown>,
) {
	const mod = await import(`../procedures/${file}`);
	const procedure = Object.values(mod)[0];
	return handlerOf(procedure)({
		input: { organizationId: "org-1", ...input },
		context,
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

beforeEach(() => {
	vi.clearAllMocks();
	// No test reaches GitHub: a classic token with every scope by default.
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(githubResponse(200, FULL_SCOPES));
	vi.stubGlobal("fetch", fetchMock);
	m.isFeatureEnabled.mockResolvedValue(true);
	m.verifyMembership.mockResolvedValue({ role: "member" });
	m.createCredential.mockImplementation(async (data) =>
		meta({ userId: data.userId, sharing: data.sharing, label: data.label }),
	);
});

describe("gate", () => {
	it("answers NOT_FOUND while the flag is off, before touching data", async () => {
		m.isFeatureEnabled.mockResolvedValue(false);
		await expect(call("list", {})).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(m.isFeatureEnabled).toHaveBeenCalledWith(
			"CREDENTIAL_MANAGER",
			"org-1",
		);
		expect(m.listVisibleCredentials).not.toHaveBeenCalled();
	});

	it("refuses a caller who is not a member", async () => {
		m.verifyMembership.mockResolvedValue(null);
		await expect(call("list", {})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("create", () => {
	const base = {
		owner: "me",
		shareWithOrganization: false,
		provider: "GITHUB",
		kind: "PAT",
		label: "CI token",
		secret: "ghp_example_secret_value",
	};

	it("saves a member's own token, encrypted by the query layer, and never returns it", async () => {
		const result = (await call("create", base)) as {
			credential: Record<string, unknown>;
		};
		expect(m.createCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				userId: "user-1",
				sharing: "PRIVATE",
				origin: "https://github.com",
				secret: { token: "ghp_example_secret_value" },
			}),
			{ tx: true },
		);
		expect(JSON.stringify(result)).not.toContain(
			"ghp_example_secret_value",
		);
		expect(result.credential).toMatchObject({
			ownedByMe: true,
			canManage: true,
		});
	});

	it("audits the creation in the same transaction without the secret", async () => {
		await call("create", base);
		expect(m.recordAuditTx).toHaveBeenCalledWith(
			{ tx: true },
			expect.objectContaining({
				action: "account.credential.created",
				organizationId: "org-1",
				resource: expect.objectContaining({ type: "credential" }),
			}),
		);
		expect(JSON.stringify(m.recordAuditTx.mock.calls)).not.toContain(
			"ghp_example_secret_value",
		);
	});

	it("lets only integration managers add an organization credential", async () => {
		await expect(
			call("create", { ...base, owner: "organization" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.createCredential).not.toHaveBeenCalled();

		m.verifyMembership.mockResolvedValue({ role: "admin" });
		await call("create", { ...base, owner: "organization" });
		expect(m.createCredential).toHaveBeenCalledWith(
			expect.objectContaining({ userId: null, sharing: "ORGANIZATION" }),
			{ tx: true },
		);
		expect(m.recordAuditTx).toHaveBeenCalledWith(
			{ tx: true },
			expect.objectContaining({ action: "org.credential.created" }),
		);
	});

	it("requires an instance URL for a provider without a default", async () => {
		await expect(
			call("create", { ...base, provider: "CUSTOM" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("create: a GitHub token", () => {
	const base = {
		owner: "me",
		shareWithOrganization: false,
		provider: "GITHUB",
		kind: "PAT",
		label: "Full Fabric",
		secret: "ghp_example_secret_value",
	};

	it("stores the account id, login and scopes GitHub reports for the token", async () => {
		await call("create", base);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.github.com/user");
		expect(init.headers.Authorization).toBe(
			"Bearer ghp_example_secret_value",
		);
		expect(m.createCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				externalAccountId: "42",
				externalAccountLogin: "example-dev",
				scopes: ["repo", "workflow", "admin:org", "project", "user"],
			}),
			{ tx: true },
		);
	});

	it("refuses a token GitHub rejects (401) and saves nothing", async () => {
		fetchMock.mockResolvedValue(githubResponse(401, null, {}));
		await expect(call("create", base)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("GitHub rejected this token"),
		});
		expect(m.createCredential).not.toHaveBeenCalled();
	});

	it("saves without the account when GitHub cannot be reached", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));
		await call("create", base);
		expect(m.createCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				externalAccountId: null,
				externalAccountLogin: null,
			}),
			{ tx: true },
		);
	});

	it("saves without the account when GitHub answers 5xx", async () => {
		fetchMock.mockResolvedValue(githubResponse(502, null, {}));
		await call("create", base);
		expect(m.createCredential).toHaveBeenCalledWith(
			expect.objectContaining({ externalAccountLogin: null }),
			{ tx: true },
		);
	});

	it("refuses a classic token missing a required scope, naming exactly what to add", async () => {
		fetchMock.mockResolvedValue(githubResponse(200, "repo, read:org"));
		const error = await call("create", base).catch((e: unknown) => e);
		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			data: {
				reason: "GITHUB_TOKEN_MISSING_SCOPES",
				tokenType: "classic",
				missing: [
					"workflow",
					"admin:org",
					"project",
					"read:user",
					"user:email",
				],
			},
		});
		expect((error as Error).message).toBe(
			"This token is missing: workflow, admin:org, project, read:user, user:email. Edit it on GitHub (Settings → Developer settings → Personal access tokens) and add them, then save again.",
		);
		expect(JSON.stringify(error)).not.toContain("ghp_example_secret_value");
		expect(m.createCredential).not.toHaveBeenCalled();
	});

	it("counts implied scopes: admin:org covers read:org, user covers read:user and user:email", async () => {
		fetchMock.mockResolvedValue(
			githubResponse(200, "repo, workflow, admin:org, project, user"),
		);
		await call("create", base);
		expect(m.createCredential).toHaveBeenCalled();
	});

	it("asks to confirm a fine-grained token's permissions, then saves it once confirmed", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			url.includes("/user/repos")
				? githubResponse(200, null, [])
				: githubResponse(200, null),
		);
		await expect(call("create", base)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: {
				reason: "GITHUB_TOKEN_CONFIRM_PERMISSIONS",
				tokenType: "fine-grained",
				canListRepositories: true,
				permissions: expect.arrayContaining([
					{ name: "Contents", access: "write" },
					{ name: "Metadata", access: "read" },
				]),
			},
		});
		expect(m.createCredential).not.toHaveBeenCalled();
		expect(fetchMock.mock.calls.map((c) => c[0])).toContain(
			"https://api.github.com/user/repos?per_page=1",
		);

		await call("create", { ...base, confirmFineGrainedPermissions: true });
		expect(m.createCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				externalAccountLogin: "example-dev",
				scopes: [],
			}),
			{ tx: true },
		);
	});

	it("asks GitHub nothing for a GitHub Enterprise origin or another kind", async () => {
		await call("create", {
			...base,
			origin: "https://github.example.com",
		});
		await call("create", { ...base, kind: "API_KEY" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("replacing the secret checks the new token and records its account", async () => {
		m.getCredentialMetadata.mockResolvedValue(meta());
		m.updateCredential.mockResolvedValue(meta());
		await call("update", { id: "cred-1", secret: "ghp_new_value" });
		expect(m.updateCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				secret: { token: "ghp_new_value" },
				account: {
					externalAccountId: "42",
					externalAccountLogin: "example-dev",
				},
			}),
			{ tx: true },
		);

		fetchMock.mockResolvedValue(githubResponse(401, null, {}));
		m.updateCredential.mockClear();
		await expect(
			call("update", { id: "cred-1", secret: "ghp_bad_value" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.updateCredential).not.toHaveBeenCalled();
	});
});

describe("update and delete", () => {
	it("hides another member's private credential behind NOT_FOUND", async () => {
		m.getCredentialMetadata.mockResolvedValue(meta({ userId: "user-2" }));
		await expect(
			call("update", { id: "cred-1", label: "mine now" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(call("delete", { id: "cred-1" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(m.updateCredential).not.toHaveBeenCalled();
		expect(m.deleteCredential).not.toHaveBeenCalled();
	});

	it("does not let an admin role change a member's credential, even a shared one", async () => {
		m.verifyMembership.mockResolvedValue({ role: "owner" });
		m.getCredentialMetadata.mockResolvedValue(
			meta({ userId: "user-2", sharing: "ORGANIZATION" }),
		);
		await expect(call("delete", { id: "cred-1" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("audits sharing as an organization event", async () => {
		m.getCredentialMetadata.mockResolvedValue(meta());
		m.updateCredential.mockResolvedValue(meta({ sharing: "ORGANIZATION" }));
		await call("update", { id: "cred-1", shareWithOrganization: true });
		expect(m.recordAuditTx).toHaveBeenCalledTimes(1);
		expect(m.recordAuditTx).toHaveBeenCalledWith(
			{ tx: true },
			expect.objectContaining({ action: "org.credential.shared" }),
		);
	});

	it("refuses to replace the secret of a sign-in grant", async () => {
		m.getCredentialMetadata.mockResolvedValue(meta({ kind: "OAUTH" }));
		await expect(
			call("update", { id: "cred-1", secret: "x" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("never makes an organization credential private", async () => {
		m.verifyMembership.mockResolvedValue({ role: "admin" });
		m.getCredentialMetadata.mockResolvedValue(
			meta({ userId: null, sharing: "ORGANIZATION" }),
		);
		await expect(
			call("update", { id: "cred-1", shareWithOrganization: false }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("deletes a credential its owner manages, with an audit row", async () => {
		m.getCredentialMetadata.mockResolvedValue(meta());
		m.deleteCredential.mockResolvedValue(true);
		await expect(call("delete", { id: "cred-1" })).resolves.toEqual({
			success: true,
		});
		expect(m.recordAuditTx).toHaveBeenCalledWith(
			{ tx: true },
			expect.objectContaining({ action: "account.credential.deleted" }),
		);
	});
});

describe("list", () => {
	it("ranks app installations first and marks what the caller manages", async () => {
		m.listVisibleCredentials.mockResolvedValue([
			meta({ id: "pat", kind: "PAT", label: "a" }),
			meta({
				id: "app",
				kind: "APP_INSTALLATION",
				principal: "APP",
				userId: null,
				sharing: "ORGANIZATION",
				label: "z",
			}),
		]);
		const result = (await call("list", {})) as {
			credentials: { id: string; canManage: boolean }[];
		};
		expect(result.credentials.map((c) => [c.id, c.canManage])).toEqual([
			["app", false],
			["pat", true],
		]);
		expect(m.listVisibleCredentials).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				userId: "user-1",
			}),
		);
	});
});
