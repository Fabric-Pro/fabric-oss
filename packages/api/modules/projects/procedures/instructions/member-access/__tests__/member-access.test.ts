/**
 * "Plugin access": project members' read access to the coding-instructions
 * repository (spec 2026-11-04 §4.4, on request).
 *
 * The middleware chain is replaced by a recorder, so these tests read which
 * permission each procedure declares and drive the handlers directly. The
 * handlers re-check the permission against the same resolution, which is
 * what the viewer case exercises.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "example-repository-token";

const m = vi.hoisted(() => ({
	procedures: {} as Record<
		string,
		{ fn: (...a: unknown[]) => unknown; uses: unknown[] }
	>,
	resolveEffectiveProjectPermissions: vi.fn(),
	findProject: vi.fn(),
	isFeatureEnabled: vi.fn(),
	getInstructionRepositorySync: vi.fn(),
	getProjectMembers: vi.fn(),
	listMemberGitHubLogins: vi.fn(),
	listMemberGitHubCredentials: vi.fn(),
	backfillCredentialAccounts: vi.fn(),
	listInstructionsAccessGrants: vi.fn(),
	getInstructionsAccessGrant: vi.fn(),
	upsertInstructionsAccessGrant: vi.fn(),
	setInstructionsAccessGrantStatus: vi.fn(),
	resolveFreshRepoToken: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	github: {
		getRepositoryOwner: vi.fn(),
		ensureInstructionsTeam: vi.fn(),
		getTeamMembership: vi.fn(),
		addTeamMember: vi.fn(),
		removeTeamMember: vi.fn(),
		isRepositoryCollaborator: vi.fn(),
		findRepositoryInvitation: vi.fn(),
		addRepositoryCollaborator: vi.fn(),
		removeRepositoryCollaborator: vi.fn(),
		getCollaboratorPermission: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: { project: { findFirst: (...a: unknown[]) => m.findProject(...a) } },
	isFeatureEnabled: (...a: unknown[]) => m.isFeatureEnabled(...a),
	getInstructionRepositorySync: (...a: unknown[]) =>
		m.getInstructionRepositorySync(...a),
	getProjectMembers: (...a: unknown[]) => m.getProjectMembers(...a),
	listMemberGitHubLogins: (...a: unknown[]) => m.listMemberGitHubLogins(...a),
	listMemberGitHubCredentials: (...a: unknown[]) =>
		m.listMemberGitHubCredentials(...a),
	listInstructionsAccessGrants: (...a: unknown[]) =>
		m.listInstructionsAccessGrants(...a),
	getInstructionsAccessGrant: (...a: unknown[]) =>
		m.getInstructionsAccessGrant(...a),
	upsertInstructionsAccessGrant: (...a: unknown[]) =>
		m.upsertInstructionsAccessGrant(...a),
	setInstructionsAccessGrantStatus: (...a: unknown[]) =>
		m.setInstructionsAccessGrantStatus(...a),
}));
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: (...a: unknown[]) => m.resolveFreshRepoToken(...a),
}));
vi.mock("@repo/integrations/credential-manager", () => ({
	backfillCredentialAccounts: (...a: unknown[]) =>
		m.backfillCredentialAccounts(...a),
}));
vi.mock(
	"@repo/integrations/github/instructions-access",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("@repo/integrations/github/instructions-access")
			>();
		return {
			GitHubAccessError: real.GitHubAccessError,
			instructionsTeamSlug: real.instructionsTeamSlug,
			...m.github,
		};
	},
);
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => m.recordAuditFromRequest(...a),
}));
vi.mock("../../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../../orpc/middleware/project-visibility", () => ({
	projectNotFoundUnlessVisible: { visibility: "hasProjectAccess" },
}));
vi.mock("../../../../../../orpc/procedures", () => {
	type State = { uses: unknown[]; path: string };
	const chain = (state: State) => ({
		use: (mw: unknown) => chain({ ...state, uses: [...state.uses, mw] }),
		route: (route: { path: string }) =>
			chain({ ...state, path: route.path }),
		input: () => chain(state),
		handler: (fn: (...a: unknown[]) => unknown) => {
			m.procedures[state.path] = { fn, uses: state.uses };
			return fn;
		},
	});
	return {
		tenantProtectedProcedure: chain({ uses: [], path: "" }),
		requireProjectPermission: (permission: string) => ({ permission }),
		Permissions: {
			INSTRUCTION_READ: "instruction:read",
			PROJECT_SETTINGS_EDIT: "project:settings:edit",
		},
	};
});

import { GitHubAccessError } from "@repo/integrations/github/instructions-access";
import "../procedures";

const LIST = "/projects/:projectId/instructions/member-access";
const GRANT = "/projects/:projectId/instructions/member-access/grant";
const REVOKE = "/projects/:projectId/instructions/member-access/revoke";

const ctx = { user: { id: "user_admin" } };

function call(path: string, input: Record<string, unknown>, context = ctx) {
	const procedure = m.procedures[path];
	if (!procedure) {
		throw new Error(`no procedure at ${path}`);
	}
	return procedure.fn({ input, context }) as Promise<any>;
}

const members = [
	{ userId: "user_admin", user: { name: "Admin", image: null } },
	{ userId: "user_dev", user: { name: "Dev", image: null } },
	{ userId: "user_new", user: { name: "New", image: null } },
];

function credentialRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "cred_1",
		userId: "user_admin",
		kind: "PAT",
		origin: "https://github.com",
		generation: 1,
		externalAccountLogin: "example-admin",
		...overrides,
	};
}

function grantRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "grant_1",
		organizationId: "org_1",
		projectId: "proj_1",
		userId: "user_dev",
		githubLogin: "example-dev",
		repository: "example-org/example-instructions",
		teamSlug: "fabric-example-project-instructions",
		mode: "TEAM",
		status: "ACTIVE",
		lastError: null,
		createdByUserId: "user_admin",
		createdAt: new Date("2026-11-04T10:00:00Z"),
		updatedAt: new Date("2026-11-04T10:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		organizationId: "org_1",
		permissions: ["instruction:read", "project:settings:edit"],
		source: "member",
	});
	m.findProject.mockResolvedValue({ name: "Example Project" });
	m.isFeatureEnabled.mockResolvedValue(true);
	m.getInstructionRepositorySync.mockResolvedValue({
		user: { id: "user_admin" },
		repositoryIntegration: {
			id: "integration_1",
			provider: "GITHUB",
			repositoryUrl:
				"https://github.com/example-org/example-instructions",
			repositoryOwner: "example-org",
			repositoryName: "example-instructions",
		},
	});
	m.getProjectMembers.mockResolvedValue(members);
	m.listMemberGitHubLogins.mockResolvedValue(
		new Map([
			["user_admin", "example-admin"],
			["user_dev", "example-dev"],
		]),
	);
	m.listMemberGitHubCredentials.mockResolvedValue([
		credentialRow({ id: "cred_admin", userId: "user_admin" }),
		credentialRow({
			id: "cred_dev",
			userId: "user_dev",
			externalAccountLogin: "example-dev",
		}),
	]);
	m.backfillCredentialAccounts.mockResolvedValue(new Map());
	m.github.getCollaboratorPermission.mockResolvedValue("none");
	m.listInstructionsAccessGrants.mockResolvedValue([]);
	m.getInstructionsAccessGrant.mockResolvedValue(null);
	m.upsertInstructionsAccessGrant.mockImplementation(
		async (row: Record<string, unknown>) =>
			grantRow({ id: "grant_new", ...row }),
	);
	m.setInstructionsAccessGrantStatus.mockImplementation(
		async (row: Record<string, unknown>) => grantRow(row),
	);
	m.resolveFreshRepoToken.mockResolvedValue({ token: TOKEN });
	m.github.getRepositoryOwner.mockResolvedValue({
		type: "Organization",
		login: "example-org",
	});
	m.github.ensureInstructionsTeam.mockResolvedValue(
		"fabric-example-project-instructions",
	);
	m.github.getTeamMembership.mockResolvedValue(null);
	m.github.addTeamMember.mockResolvedValue("pending");
	m.github.isRepositoryCollaborator.mockResolvedValue(false);
	m.github.addRepositoryCollaborator.mockResolvedValue("invited");
	m.github.findRepositoryInvitation.mockResolvedValue(null);
});

function githubCalls() {
	return Object.values(m.github).reduce(
		(total, fn) => total + fn.mock.calls.length,
		0,
	);
}

describe("declared permissions", () => {
	it("list needs project visibility and instruction:read; grant and revoke need project settings edit", () => {
		expect(m.procedures[LIST]?.uses).toEqual([
			{ visibility: "hasProjectAccess" },
			{ permission: "instruction:read" },
		]);
		for (const path of [GRANT, REVOKE]) {
			expect(m.procedures[path]?.uses).toEqual([
				{ visibility: "hasProjectAccess" },
				{ permission: "project:settings:edit" },
			]);
		}
	});
});

describe("tenant boundary", () => {
	it("acts in the project's organization, never the one the caller names", async () => {
		await call(GRANT, {
			projectId: "proj_1",
			organizationId: "org_other",
			userIds: ["user_dev"],
		});
		expect(m.getInstructionRepositorySync).toHaveBeenCalledWith(
			"proj_1",
			"org_1",
		);
		expect(m.listMemberGitHubLogins).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_1" }),
		);
		expect(m.resolveFreshRepoToken).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org_1",
				projectId: "proj_1",
			}),
		);
		expect(m.upsertInstructionsAccessGrant).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_1" }),
		);
		expect(
			JSON.stringify(m.recordAuditFromRequest.mock.calls),
		).not.toContain("org_other");
	});

	it("refuses a caller with no tie to the project's organization before any GitHub call", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue(null);
		await expect(
			call(GRANT, { projectId: "proj_1", userIds: ["user_dev"] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(call(LIST, { projectId: "proj_1" })).rejects.toMatchObject(
			{
				code: "FORBIDDEN",
			},
		);
		expect(githubCalls()).toBe(0);
		expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
	});

	it("never grants someone who is not a member of the project", async () => {
		const { results } = await call(GRANT, {
			projectId: "proj_1",
			userIds: ["user_outsider"],
		});
		expect(results).toEqual([
			{ userId: "user_outsider", outcome: "NOT_A_MEMBER", message: null },
		]);
		expect(m.github.addTeamMember).not.toHaveBeenCalled();
		expect(m.upsertInstructionsAccessGrant).not.toHaveBeenCalled();
	});
});

describe("viewer", () => {
	beforeEach(() => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			organizationId: "org_1",
			permissions: ["instruction:read"],
			source: "member",
		});
	});

	it("sees the list without the right to grant", async () => {
		const list = await call(LIST, { projectId: "proj_1" });
		expect(list).toMatchObject({ available: true, canGrant: false });
	});

	it("cannot grant or revoke", async () => {
		await expect(
			call(GRANT, { projectId: "proj_1", all: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(REVOKE, { projectId: "proj_1", userId: "user_dev" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(githubCalls()).toBe(0);
		expect(m.upsertInstructionsAccessGrant).not.toHaveBeenCalled();
	});
});

describe("list", () => {
	it("is unavailable without a GitHub instructions repository", async () => {
		m.getInstructionRepositorySync.mockResolvedValue(null);
		await expect(call(LIST, { projectId: "proj_1" })).resolves.toEqual({
			available: false,
		});
		m.getInstructionRepositorySync.mockResolvedValue({
			user: { id: "user_admin" },
			repositoryIntegration: {
				id: "integration_1",
				provider: "GITLAB",
				repositoryUrl:
					"https://gitlab.com/example-org/example-instructions",
				repositoryOwner: "example-org",
				repositoryName: "example-instructions",
			},
		});
		await expect(call(LIST, { projectId: "proj_1" })).resolves.toEqual({
			available: false,
		});
	});

	it("is unavailable while the credential manager is off", async () => {
		m.isFeatureEnabled.mockResolvedValue(false);
		await expect(call(LIST, { projectId: "proj_1" })).resolves.toEqual({
			available: false,
		});
	});

	it("shows each member's login (or none), grant status and the owner type, and refreshes an accepted invitation", async () => {
		m.listInstructionsAccessGrants.mockResolvedValue([
			grantRow({ status: "INVITED" }),
		]);
		m.github.getTeamMembership.mockResolvedValue("active");
		const list = await call(LIST, { projectId: "proj_1" });
		expect(list).toMatchObject({
			available: true,
			repository: "example-org/example-instructions",
			ownerType: "organization",
			canGrant: true,
		});
		const byId = Object.fromEntries(
			list.members.map((member: { userId: string }) => [
				member.userId,
				member,
			]),
		);
		expect(byId.user_admin).toMatchObject({
			isCaller: true,
			githubLogin: "example-admin",
			grant: null,
		});
		expect(byId.user_new).toMatchObject({ githubLogin: null, grant: null });
		expect(byId.user_dev.grant).toMatchObject({ status: "ACTIVE" });
		expect(m.setInstructionsAccessGrantStatus).toHaveBeenCalledWith({
			id: "grant_1",
			organizationId: "org_1",
			status: "ACTIVE",
			lastError: null,
		});
		expect(JSON.stringify(list)).not.toContain(TOKEN);
	});
});

describe("list: where each member stands on GitHub", () => {
	function byUser(list: { members: { userId: string }[] }) {
		return Object.fromEntries(
			list.members.map((member) => [member.userId, member]),
		) as Record<string, Record<string, unknown>>;
	}

	it("the owner of a personal repository is OWNER; GitHub is not asked about them", async () => {
		m.github.getRepositoryOwner.mockResolvedValue({
			type: "User",
			login: "Example-Admin",
		});
		const members = byUser(await call(LIST, { projectId: "proj_1" }));
		expect(members.user_admin).toMatchObject({
			githubLogin: "example-admin",
			access: "OWNER",
		});
		expect(m.github.getCollaboratorPermission).not.toHaveBeenCalledWith(
			TOKEN,
			expect.objectContaining({ username: "example-admin" }),
		);
	});

	it("a member GitHub already gives access is HAS_ACCESS; one without is NO_ACCESS and can be granted", async () => {
		m.github.getCollaboratorPermission.mockImplementation(
			async (_token: string, input: { username: string }) =>
				input.username === "example-dev" ? "write" : "none",
		);
		const members = byUser(await call(LIST, { projectId: "proj_1" }));
		expect(members.user_dev).toMatchObject({ access: "HAS_ACCESS" });
		expect(members.user_admin).toMatchObject({ access: "NO_ACCESS" });
		expect(m.github.getCollaboratorPermission).toHaveBeenCalledWith(TOKEN, {
			repository: { owner: "example-org", name: "example-instructions" },
			username: "example-admin",
		});
	});

	it("a member whose permission GitHub will not tell stays grantable", async () => {
		m.github.getCollaboratorPermission.mockRejectedValue(
			new GitHubAccessError("forbidden", "no"),
		);
		const members = byUser(await call(LIST, { projectId: "proj_1" }));
		expect(members.user_dev).toMatchObject({ access: "NO_ACCESS" });
	});

	it("only a member with no GitHub credential at all is NOT_CONNECTED", async () => {
		const members = byUser(await call(LIST, { projectId: "proj_1" }));
		expect(members.user_new).toMatchObject({
			githubLogin: null,
			access: "NOT_CONNECTED",
		});
		expect(m.backfillCredentialAccounts).not.toHaveBeenCalled();
	});

	it("reads the account of a credential saved without one, once, then lists its login", async () => {
		m.listMemberGitHubCredentials.mockResolvedValue([
			credentialRow({
				id: "cred_new_a",
				userId: "user_new",
				externalAccountLogin: null,
			}),
			credentialRow({
				id: "cred_new_b",
				userId: "user_new",
				externalAccountLogin: null,
			}),
		]);
		m.backfillCredentialAccounts.mockResolvedValue(
			new Map([["cred_new_a", "example-new"]]),
		);
		m.listMemberGitHubLogins.mockResolvedValue(
			new Map([["user_new", "example-new"]]),
		);
		const members = byUser(await call(LIST, { projectId: "proj_1" }));
		expect(m.backfillCredentialAccounts).toHaveBeenCalledTimes(1);
		expect(m.backfillCredentialAccounts).toHaveBeenCalledWith({
			organizationId: "org_1",
			credentialIds: ["cred_new_a"],
		});
		expect(members.user_new).toMatchObject({
			githubLogin: "example-new",
			access: "NO_ACCESS",
		});
	});

	it("a credential GitHub still names no account for is ACCOUNT_UNKNOWN, and the list still answers", async () => {
		m.listMemberGitHubCredentials.mockResolvedValue([
			credentialRow({
				id: "cred_new",
				userId: "user_new",
				externalAccountLogin: null,
			}),
		]);
		m.backfillCredentialAccounts.mockRejectedValue(new Error("offline"));
		m.listMemberGitHubLogins.mockResolvedValue(new Map());
		const members = byUser(await call(LIST, { projectId: "proj_1" }));
		expect(members.user_new).toMatchObject({ access: "ACCOUNT_UNKNOWN" });
		expect(members.user_dev).toMatchObject({ access: "NOT_CONNECTED" });
	});

	it("reads credentials and backfills only in the project's organization", async () => {
		m.listMemberGitHubCredentials.mockResolvedValue([
			credentialRow({
				id: "cred_new",
				userId: "user_new",
				externalAccountLogin: null,
			}),
		]);
		await call(LIST, { projectId: "proj_1", organizationId: "org_other" });
		expect(m.listMemberGitHubCredentials).toHaveBeenCalledWith({
			organizationId: "org_1",
			userIds: ["user_admin", "user_dev", "user_new"],
		});
		expect(m.backfillCredentialAccounts).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_1" }),
		);
		expect(m.listMemberGitHubLogins).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_1" }),
		);
	});
});

describe("grant: organization repository (team)", () => {
	it("ensures the project's team and adds the member; a pending membership is an invitation", async () => {
		const { results } = await call(GRANT, {
			projectId: "proj_1",
			userIds: ["user_dev"],
		});
		expect(m.github.ensureInstructionsTeam).toHaveBeenCalledWith(
			TOKEN,
			expect.objectContaining({
				org: "example-org",
				teamSlug: "fabric-example-project-instructions",
				marker: "fabric-project:proj_1",
				repository: {
					owner: "example-org",
					name: "example-instructions",
				},
			}),
		);
		expect(m.github.addTeamMember).toHaveBeenCalledWith(TOKEN, {
			org: "example-org",
			teamSlug: "fabric-example-project-instructions",
			username: "example-dev",
		});
		expect(m.upsertInstructionsAccessGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user_dev",
				githubLogin: "example-dev",
				mode: "TEAM",
				status: "INVITED",
				teamSlug: "fabric-example-project-instructions",
				createdByUserId: "user_admin",
			}),
		);
		expect(results).toEqual([
			{ userId: "user_dev", outcome: "INVITED", message: null },
		]);
	});

	it("records nothing for a member already in the team: that access is not Fabric's", async () => {
		m.github.getTeamMembership.mockResolvedValue("active");
		const { results } = await call(GRANT, {
			projectId: "proj_1",
			userIds: ["user_dev"],
		});
		expect(results[0]).toMatchObject({ outcome: "ALREADY_HAD_ACCESS" });
		expect(m.github.addTeamMember).not.toHaveBeenCalled();
		expect(m.upsertInstructionsAccessGrant).not.toHaveBeenCalled();
	});

	it("records a failure with GitHub's reason and audits it", async () => {
		m.github.addTeamMember.mockRejectedValue(
			new GitHubAccessError("forbidden", "GitHub refused (403).", 403),
		);
		const { results } = await call(GRANT, {
			projectId: "proj_1",
			userIds: ["user_dev"],
		});
		expect(results[0]).toMatchObject({
			outcome: "FAILED",
			message: "GitHub refused (403).",
		});
		expect(m.upsertInstructionsAccessGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "FAILED",
				lastError: "GitHub refused (403).",
			}),
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions_access.failed",
				outcome: "failure",
			}),
		);
	});
});

describe("grant: personal repository (collaborator)", () => {
	beforeEach(() => {
		m.github.getRepositoryOwner.mockResolvedValue({
			type: "User",
			login: "example-org",
		});
	});

	it("is refused until the caller confirms that collaborators get write access", async () => {
		await expect(
			call(GRANT, { projectId: "proj_1", userIds: ["user_dev"] }),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "PERSONAL_REPOSITORY_WRITE_ACCESS" },
		});
		expect(m.github.addRepositoryCollaborator).not.toHaveBeenCalled();
	});

	it("invites the member as a collaborator once confirmed", async () => {
		const { results } = await call(GRANT, {
			projectId: "proj_1",
			userIds: ["user_dev"],
			confirmPersonalWriteAccess: true,
		});
		expect(m.github.ensureInstructionsTeam).not.toHaveBeenCalled();
		expect(m.github.addRepositoryCollaborator).toHaveBeenCalledWith(TOKEN, {
			repository: { owner: "example-org", name: "example-instructions" },
			username: "example-dev",
		});
		expect(m.upsertInstructionsAccessGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "COLLABORATOR",
				status: "INVITED",
				teamSlug: null,
			}),
		);
		expect(results[0]).toMatchObject({ outcome: "INVITED" });
	});

	it("never invites the repository's own owner", async () => {
		m.github.getRepositoryOwner.mockResolvedValue({
			type: "User",
			login: "example-dev",
		});
		const { results } = await call(GRANT, {
			projectId: "proj_1",
			userIds: ["user_dev"],
			confirmPersonalWriteAccess: true,
		});
		expect(results).toEqual([
			{
				userId: "user_dev",
				outcome: "ALREADY_HAD_ACCESS",
				message: null,
			},
		]);
		expect(m.github.addRepositoryCollaborator).not.toHaveBeenCalled();
		expect(m.upsertInstructionsAccessGrant).not.toHaveBeenCalled();
	});

	it("records nothing for an existing collaborator", async () => {
		m.github.isRepositoryCollaborator.mockResolvedValue(true);
		const { results } = await call(GRANT, {
			projectId: "proj_1",
			userIds: ["user_dev"],
			confirmPersonalWriteAccess: true,
		});
		expect(results[0]).toMatchObject({ outcome: "ALREADY_HAD_ACCESS" });
		expect(m.github.addRepositoryCollaborator).not.toHaveBeenCalled();
		expect(m.upsertInstructionsAccessGrant).not.toHaveBeenCalled();
	});
});

describe("grant: a member with no GitHub login", () => {
	it("is reported, never guessed, and nothing is sent to GitHub for them", async () => {
		const { results } = await call(GRANT, {
			projectId: "proj_1",
			all: true,
		});
		const byId = Object.fromEntries(
			results.map((r: { userId: string; outcome: string }) => [
				r.userId,
				r.outcome,
			]),
		);
		expect(byId.user_new).toBe("NO_GITHUB_LOGIN");
		const usernames = m.github.addTeamMember.mock.calls.map(
			(c) => (c[1] as { username: string }).username,
		);
		expect(usernames.sort()).toEqual(["example-admin", "example-dev"]);
		expect(m.upsertInstructionsAccessGrant).not.toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user_new" }),
		);
	});
});

describe("revoke", () => {
	it("refuses a member Fabric did not grant access to", async () => {
		await expect(
			call(REVOKE, { projectId: "proj_1", userId: "user_dev" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		m.getInstructionsAccessGrant.mockResolvedValue(
			grantRow({ status: "FAILED" }),
		);
		await expect(
			call(REVOKE, { projectId: "proj_1", userId: "user_dev" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.github.removeTeamMember).not.toHaveBeenCalled();
		expect(m.github.removeRepositoryCollaborator).not.toHaveBeenCalled();
	});

	it("removes exactly the team membership Fabric made and marks it revoked", async () => {
		m.getInstructionsAccessGrant.mockResolvedValue(grantRow());
		await expect(
			call(REVOKE, { projectId: "proj_1", userId: "user_dev" }),
		).resolves.toEqual({ status: "REVOKED" });
		expect(m.getInstructionsAccessGrant).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_1",
			userId: "user_dev",
		});
		expect(m.github.removeTeamMember).toHaveBeenCalledWith(TOKEN, {
			org: "example-org",
			teamSlug: "fabric-example-project-instructions",
			username: "example-dev",
		});
		expect(m.setInstructionsAccessGrantStatus).toHaveBeenCalledWith(
			expect.objectContaining({ id: "grant_1", status: "REVOKED" }),
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions_access.revoked",
			}),
		);
	});

	it("withdraws a collaborator invitation on the repository the grant was made on", async () => {
		m.getInstructionsAccessGrant.mockResolvedValue(
			grantRow({
				mode: "COLLABORATOR",
				status: "INVITED",
				teamSlug: null,
				repository: "example-user/old-instructions",
			}),
		);
		await call(REVOKE, { projectId: "proj_1", userId: "user_dev" });
		expect(m.github.removeRepositoryCollaborator).toHaveBeenCalledWith(
			TOKEN,
			{
				repository: { owner: "example-user", name: "old-instructions" },
				username: "example-dev",
			},
		);
	});
});

describe("audit", () => {
	it("records the GitHub login and repository only, never a token", async () => {
		await call(GRANT, { projectId: "proj_1", userIds: ["user_dev"] });
		expect(m.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const [, entry] = m.recordAuditFromRequest.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(entry).toMatchObject({
			action: "project.instructions_access.granted",
			category: "project",
			organizationId: "org_1",
			projectId: "proj_1",
		});
		expect(entry.metadata).toEqual({
			githubLogin: "example-dev",
			repository: "example-org/example-instructions",
		});
		expect(
			JSON.stringify(m.recordAuditFromRequest.mock.calls),
		).not.toContain(TOKEN);
	});
});
