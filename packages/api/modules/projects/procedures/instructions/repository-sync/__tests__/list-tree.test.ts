/**
 * `projects.instructions.repositorySync.listTree` — the Coding Instructions
 * configure dialog's folder browser (Fizzy #2725).
 *
 * Each call runs the procedure's REAL middleware chain in its declared order
 * — `projectNotFoundUnlessVisible`, then the real `requireProjectPermission`
 * — before the handler, so the refusals (NOT_FOUND for a project the caller
 * cannot discover, even one the org-role fallback would admit; FORBIDDEN for
 * a member without INSTRUCTION_CREATE) are what is pinned, not a mocked
 * stand-in.
 * The database, the credential resolver and the tree read are mocked;
 * `isRepositoryTreeProvider` and the folder rule (`validateRelativePath`
 * behind `normalizeRootPath`) are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	grantProjectAccess: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	resolveFreshRepoTokenForRow: vi.fn(),
	listRepositoryTree: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(),
	hasProjectAccess: m.hasProjectAccess,
	grantProjectAccess: m.grantProjectAccess,
	getProjectRepoIntegration: m.getProjectRepoIntegration,
}));
vi.mock("@repo/connectors", async () => ({
	listRepositoryTree: m.listRepositoryTree,
	// The real provider list: which providers `listTree` answers without a
	// credential is part of what is pinned.
	isRepositoryTreeProvider: (
		await vi.importActual<typeof import("@repo/connectors")>(
			"@repo/connectors",
		)
	).isRepositoryTreeProvider,
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: m.resolveFreshRepoTokenForRow,
}));
vi.mock("../../../../../../lib/audit", () => ({
	recordAuditFromRequest: m.recordAuditFromRequest,
}));
vi.mock("../../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.resolveEffectiveProjectPermissions,
}));

// Each `.use(...)` returns a builder carrying its own chain;
// `requireProjectPermission` is the real one.
vi.mock("../../../../../../orpc/procedures", async () => {
	const { requireProjectPermission } = await vi.importActual<
		typeof import("../../../../../../orpc/middleware/require-permission")
	>("../../../../../../orpc/middleware/require-permission");
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	function builder(chain: unknown[], schema?: unknown) {
		const b: Record<string, unknown> = {};
		b.use = (middleware: unknown) =>
			builder([...chain, middleware], schema);
		b.route = () => b;
		b.input = (next: unknown) => builder(chain, next);
		b.handler = (fn: unknown) => ({
			handler: fn,
			middlewares: chain,
			inputSchema: schema,
		});
		return b;
	}
	return {
		tenantProtectedProcedure: builder([]),
		requireProjectPermission,
		Permissions,
	};
});

import { listInstructionRepositoryTreeProcedure } from "../list-tree";

type Ctx = {
	user: { id: string; name: string; email: string };
	session: { id: string; activeOrganizationId: string | null };
};
type Middleware = (
	options: {
		context: Ctx;
		next: (options?: {
			context?: object;
		}) => Promise<{ output: unknown; context: object }>;
	},
	input: unknown,
) => Promise<{ output: unknown }>;
type Built = {
	handler: (args: { input: unknown; context: Ctx }) => Promise<unknown>;
	middlewares: Middleware[];
	inputSchema: {
		safeParse(v: unknown): { success: boolean; data?: unknown };
	};
};

const procedure = listInstructionRepositoryTreeProcedure as unknown as Built;

// The caller's session sits in org-session; the project lives in org-host.
const ctx: Ctx = {
	user: { id: "user-1", name: "Example Member", email: "dev@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-session" },
};

/** Run the procedure as oRPC would: its middlewares in order, then the handler. */
async function call(
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const parsed = procedure.inputSchema.safeParse(input);
	if (!parsed.success) {
		throw Object.assign(new Error("input validation failed"), {
			code: "BAD_REQUEST",
		});
	}
	const run = async (
		index: number,
		context: Ctx,
	): Promise<{ output: unknown; context: object }> => {
		const middleware = procedure.middlewares[index];
		if (!middleware) {
			return {
				output: await procedure.handler({
					input: parsed.data,
					context,
				}),
				context: {},
			};
		}
		return (await middleware(
			{
				context,
				next: (options) =>
					run(
						index + 1,
						options?.context
							? { ...context, ...options.context }
							: context,
					),
			},
			parsed.data,
		)) as { output: unknown; context: object };
	};
	return (await run(0, { ...ctx })).output as Record<string, unknown>;
}

const EDITOR = ["instruction:read", "instruction:create"];
const VIEWER = ["instruction:read"];
// Distinctive and token-shaped, so a leak assertion cannot pass by accident.
const SECRET_TOKEN = "ghs_example_secret_token";

const integration = {
	id: "int-1",
	projectId: "proj-1",
	provider: "GITHUB",
	authMethod: "OAUTH",
	repositoryUrl: "https://github.com/example-org/instructions.git",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	defaultBranch: "main",
	status: "ACTIVE",
	azureOrganization: null,
	encryptedAccessToken: "enc-access",
	encryptedRefreshToken: "enc-refresh",
	encryptedPat: null,
	tokenExpiresAt: null,
	updatedAt: new Date("2026-09-23T00:00:00.000Z"),
};

const input = {
	projectId: "proj-1",
	repositoryIntegrationId: "int-1",
	ref: "develop",
};

const NOTHING_READ = () => {
	expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
	expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
	expect(m.listRepositoryTree).not.toHaveBeenCalled();
};

beforeEach(() => {
	vi.clearAllMocks();
	m.hasProjectAccess.mockResolvedValue(true);
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: EDITOR,
		source: "project-member",
		organizationId: "org-host",
	});
	m.getProjectRepoIntegration.mockResolvedValue(integration);
	m.resolveFreshRepoTokenForRow.mockResolvedValue({ token: SECRET_TOKEN });
	m.listRepositoryTree.mockResolvedValue({
		ok: true,
		entries: [
			{ path: "agents", type: "dir" },
			{ path: "agents/CLAUDE.md", type: "file" },
			{ path: "AGENTS.md", type: "file" },
		],
		truncated: false,
	});
});

describe("authorization: visibility first, then INSTRUCTION_CREATE in the hosting organization", () => {
	it("answers a project the caller cannot discover NOT_FOUND, even when the org-role fallback would grant INSTRUCTION_CREATE", async () => {
		// A host-organization member with no ProjectMember row who did not
		// create the project: the permission gate would admit them, but
		// browsing the repository is limited to what they can see.
		m.hasProjectAccess.mockResolvedValue(false);
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: EDITOR,
			source: "org",
			organizationId: "org-host",
		});

		await expect(call(input)).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		expect(m.hasProjectAccess).toHaveBeenCalledWith("proj-1", "user-1");
		expect(m.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		NOTHING_READ();
	});

	it("refuses a member without INSTRUCTION_CREATE before anything is read", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: VIEWER,
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(call(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Missing required permission: instruction:create",
		});
		NOTHING_READ();
	});

	it.each([
		[
			"a caller with no tie to the project",
			{ permissions: [], source: "none", organizationId: null },
		],
		["a project id that names no project", null],
	])(
		"answers %s NOT_FOUND, never FORBIDDEN, before anything is read",
		async (_label, resolved) => {
			m.resolveEffectiveProjectPermissions.mockResolvedValue(resolved);

			await expect(call(input)).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: "Project not found",
			});
			NOTHING_READ();
		},
	);

	it("refuses a personal project (no organization) rather than using the fail-closed arm", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: EDITOR,
			source: "owner",
			organizationId: null,
		});

		await expect(call(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
		NOTHING_READ();
	});

	it("resolves the credential in the project's hosting organization, never a client-supplied or session one", async () => {
		await call({ ...input, organizationId: "org-evil" });

		expect(m.resolveFreshRepoTokenForRow).toHaveBeenCalledWith(
			expect.objectContaining({ integrationId: "int-1" }),
			{ userId: "user-1", organizationId: "org-host" },
		);
	});
});

describe("repositorySync.listTree (instructions)", () => {
	it("lists the branch through the integration's fresh credential, folders and files alike, auditing nothing", async () => {
		const result = await call(input);

		expect(result).toEqual({
			supported: true,
			entries: [
				{ path: "agents", type: "dir" },
				{ path: "agents/CLAUDE.md", type: "file" },
				{ path: "AGENTS.md", type: "file" },
			],
			truncated: false,
		});
		expect(m.getProjectRepoIntegration).toHaveBeenCalledWith(
			"int-1",
			"proj-1",
		);
		expect(m.listRepositoryTree).toHaveBeenCalledWith({
			provider: "GITHUB",
			token: SECRET_TOKEN,
			repositoryUrl: "https://github.com/example-org/instructions.git",
			owner: "example-org",
			repo: "instructions",
			azureOrganization: null,
			branch: "develop",
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});

	it("refuses another project's integration (tenant boundary) NOT_FOUND before any credential is read", async () => {
		m.getProjectRepoIntegration.mockResolvedValue(null);

		await expect(
			call({ ...input, repositoryIntegrationId: "int-of-proj-2" }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { code: "REPOSITORY_NOT_FOUND" },
		});
		expect(m.getProjectRepoIntegration).toHaveBeenCalledWith(
			"int-of-proj-2",
			"proj-1",
		);
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
		expect(m.listRepositoryTree).not.toHaveBeenCalled();
	});

	it("refuses an integration that is not ACTIVE before any credential is read", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			status: "TOKEN_EXPIRED",
		});

		await expect(call(input)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "REPOSITORY_UNAVAILABLE" },
		});
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
		expect(m.listRepositoryTree).not.toHaveBeenCalled();
	});

	it.each(["GITLAB", "BITBUCKET"])(
		"answers a %s integration supported: false with no error and no credential resolved",
		async (provider) => {
			m.getProjectRepoIntegration.mockResolvedValue({
				...integration,
				provider,
			});

			expect(await call(input)).toEqual({
				supported: false,
				entries: [],
				truncated: false,
			});
			expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
			expect(m.listRepositoryTree).not.toHaveBeenCalled();
		},
	);

	it("still refuses an inactive GitLab integration before answering unsupported", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			provider: "GITLAB",
			status: "TOKEN_EXPIRED",
		});

		await expect(call(input)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "REPOSITORY_UNAVAILABLE" },
		});
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
	});

	it("answers the connector's own unsupported outcome supported: false too", async () => {
		m.listRepositoryTree.mockResolvedValue({
			ok: false,
			outcome: "unsupported",
		});

		expect(await call(input)).toEqual({
			supported: false,
			entries: [],
			truncated: false,
		});
	});

	it.each([
		[
			"an absent credential",
			{ token: null },
			"BAD_REQUEST",
			"REPOSITORY_CREDENTIALS_EXPIRED",
		],
		[
			"a credential that failed to decrypt",
			{ token: null, credentialFault: "DECRYPT_FAILED" },
			"INTERNAL_SERVER_ERROR",
			"REPOSITORY_UNREACHABLE",
		],
	])(
		"maps %s to %s/%s without reading the tree",
		async (_label, resolved, code, dataCode) => {
			m.resolveFreshRepoTokenForRow.mockResolvedValue(resolved);

			await expect(call(input)).rejects.toMatchObject({
				code,
				data: { code: dataCode },
			});
			expect(m.listRepositoryTree).not.toHaveBeenCalled();
		},
	);

	it.each([
		["not-found", "BAD_REQUEST", "BRANCH_NOT_FOUND"],
		["unauthorized", "BAD_REQUEST", "REPOSITORY_CREDENTIALS_EXPIRED"],
		["unreachable", "INTERNAL_SERVER_ERROR", "REPOSITORY_UNREACHABLE"],
	])(
		"throws configure's %s error (%s/%s), never an empty listing",
		async (outcome, code, dataCode) => {
			m.listRepositoryTree.mockResolvedValue({ ok: false, outcome });

			const caught = (await call(input).then(
				(value) => ({ resolvedWith: value }),
				(error: unknown) => error,
			)) as { code: string; message: string; data: unknown };

			expect(caught).not.toHaveProperty("resolvedWith");
			expect(caught).toMatchObject({ code, data: { code: dataCode } });
			expect(caught.message).not.toContain(SECRET_TOKEN);
			expect(JSON.stringify(caught.data)).not.toContain(SECRET_TOKEN);
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		},
	);

	it("names the missing branch in BRANCH_NOT_FOUND's message, as configure does", async () => {
		m.listRepositoryTree.mockResolvedValue({
			ok: false,
			outcome: "not-found",
		});

		await expect(call(input)).rejects.toMatchObject({
			message: 'Branch "develop" wasn\'t found on the remote.',
		});
	});

	it("maps an unauthorized read after OUR failed refresh to REPOSITORY_UNREACHABLE, never 'reconnect'", async () => {
		m.resolveFreshRepoTokenForRow.mockResolvedValue({
			token: SECRET_TOKEN,
			refreshFault: "PROVIDER_UNAVAILABLE",
		});
		m.listRepositoryTree.mockResolvedValue({
			ok: false,
			outcome: "unauthorized",
		});

		await expect(call(input)).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			data: { code: "REPOSITORY_UNREACHABLE" },
		});
	});

	it("keeps only paths configure would store as a rootPath, dropping a rejected folder with everything under it", async () => {
		const deepest = Array.from({ length: 32 }, (_, i) => `d${i}`).join("/");
		const tooDeep = `${deepest}/d32`;
		const tooLong = `long/${"a".repeat(600)}`;
		m.listRepositoryTree.mockResolvedValue({
			ok: true,
			entries: [
				{ path: "agents", type: "dir" },
				{ path: "agents/skills", type: "dir" },
				{ path: "agents/CLAUDE.md", type: "file" },
				// Not in configure's stored spelling: dropped, and so is
				// everything under it, even what would pass on its own.
				{ path: "trailing ", type: "dir" },
				{ path: "trailing /inner", type: "dir" },
				{ path: "trailing /inner/AGENTS.md", type: "file" },
				{ path: "back\\slash", type: "dir" },
				{ path: "back\\slash/notes.md", type: "file" },
				// A rejected folder the provider did not list itself.
				{ path: "odd//x/file.md", type: "file" },
				{ path: "ctl\u0001dir", type: "dir" },
				{ path: tooLong, type: "dir" },
				{ path: deepest, type: "dir" },
				{ path: tooDeep, type: "dir" },
				{ path: "README.md", type: "file" },
			],
			truncated: false,
		});

		const result = await call(input);

		expect(result.entries).toEqual([
			{ path: "agents", type: "dir" },
			{ path: "agents/skills", type: "dir" },
			{ path: "agents/CLAUDE.md", type: "file" },
			{ path: deepest, type: "dir" },
			{ path: "README.md", type: "file" },
		]);
	});

	it("returns an empty repository's empty tree as a supported, empty listing", async () => {
		m.listRepositoryTree.mockResolvedValue({
			ok: true,
			entries: [],
			truncated: false,
		});

		expect(await call(input)).toEqual({
			supported: true,
			entries: [],
			truncated: false,
		});
	});

	it("passes the listing's truncated flag through", async () => {
		m.listRepositoryTree.mockResolvedValue({
			ok: true,
			entries: [{ path: "agents", type: "dir" }],
			truncated: true,
		});

		expect(await call(input)).toEqual({
			supported: true,
			entries: [{ path: "agents", type: "dir" }],
			truncated: true,
		});
	});

	it.each(["refs/heads/main", "feature branch", "a..b", ""])(
		"refuses the branch name %j before the handler runs, as configure does",
		async (ref) => {
			await expect(call({ ...input, ref })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			NOTHING_READ();
		},
	);
});
