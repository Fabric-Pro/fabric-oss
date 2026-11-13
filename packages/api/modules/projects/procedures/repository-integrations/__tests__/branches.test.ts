/**
 * `projects.repositoryIntegrations.branches` — a connected repository's live
 * provider default branch plus its branch names, read only.
 *
 * Each call runs the procedure's REAL middleware chain in its declared order
 * (`projectNotFoundUnlessVisible`, then the real `requireProjectPermission`)
 * before the handler. The database, the credential resolver and the provider
 * reads are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	grantProjectAccess: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	resolveFreshRepoTokenForRow: vi.fn(),
	listRepositoryBranches: vi.fn(),
	fetchProviderDefaultBranch: vi.fn(),
	integrationUpdate: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { projectRepositoryIntegration: { update: m.integrationUpdate } },
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(),
	hasProjectAccess: m.hasProjectAccess,
	grantProjectAccess: m.grantProjectAccess,
	getProjectRepoIntegration: m.getProjectRepoIntegration,
}));
vi.mock("@repo/connectors", () => ({
	listRepositoryBranches: m.listRepositoryBranches,
	fetchProviderDefaultBranch: m.fetchProviderDefaultBranch,
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: m.resolveFreshRepoTokenForRow,
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: m.recordAuditFromRequest,
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.resolveEffectiveProjectPermissions,
}));

vi.mock("../../../../../orpc/procedures", async () => {
	const { requireProjectPermission } = await vi.importActual<
		typeof import("../../../../../orpc/middleware/require-permission")
	>("../../../../../orpc/middleware/require-permission");
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

import { listRepoIntegrationBranchesProcedure } from "../branches";

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

const procedure = listRepoIntegrationBranchesProcedure as unknown as Built;

const ctx: Ctx = {
	user: { id: "user-1", name: "Example Member", email: "dev@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-session" },
};

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

const VIEWER = ["project:read", "project:settings:read"];
const SECRET_TOKEN = "ghs_example_secret_token";

const integration = {
	id: "int-1",
	projectId: "proj-1",
	provider: "GITHUB",
	authMethod: "OAUTH",
	credentialId: null,
	repositoryUrl: "https://github.com/example-org/instructions.git",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	// Stored when the repository was connected; the provider now says "main".
	defaultBranch: "master",
	status: "ACTIVE",
	azureOrganization: null,
	encryptedAccessToken: "enc-access",
	encryptedRefreshToken: "enc-refresh",
	encryptedPat: null,
	tokenExpiresAt: null,
	updatedAt: new Date("2026-09-23T00:00:00.000Z"),
};

const input = { projectId: "proj-1", repositoryIntegrationId: "int-1" };

const NOTHING_READ = () => {
	expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
	expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
	expect(m.listRepositoryBranches).not.toHaveBeenCalled();
	expect(m.fetchProviderDefaultBranch).not.toHaveBeenCalled();
};

beforeEach(() => {
	vi.clearAllMocks();
	m.hasProjectAccess.mockResolvedValue(true);
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: VIEWER,
		source: "project-member",
		organizationId: "org-host",
	});
	m.getProjectRepoIntegration.mockResolvedValue(integration);
	m.resolveFreshRepoTokenForRow.mockResolvedValue({ token: SECRET_TOKEN });
	m.listRepositoryBranches.mockResolvedValue({
		ok: true,
		branches: [
			{ name: "main", commitSha: "a1" },
			{ name: "release/1.0", commitSha: "b2" },
		],
	});
	m.fetchProviderDefaultBranch.mockResolvedValue("main");
});

describe("authorization", () => {
	it("answers a project the caller cannot discover NOT_FOUND, before anything is read", async () => {
		// An org member with no tie to the project: the permission gate's
		// org-role fallback would admit them, discovery does not.
		m.hasProjectAccess.mockResolvedValue(false);
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: VIEWER,
			source: "org",
			organizationId: "org-host",
		});

		await expect(call(input)).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		NOTHING_READ();
	});

	it("answers a caller from another organization NOT_FOUND, never FORBIDDEN", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "none",
			organizationId: null,
		});

		await expect(call(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
		NOTHING_READ();
	});

	it("refuses a client-supplied organization other than the host's", async () => {
		await expect(
			call({ ...input, organizationId: "org-evil" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
	});

	it("refuses another project's integration NOT_FOUND before any credential is read", async () => {
		m.getProjectRepoIntegration.mockResolvedValue(null);

		await expect(call(input)).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { code: "REPOSITORY_NOT_FOUND" },
		});
		expect(m.getProjectRepoIntegration).toHaveBeenCalledWith(
			"int-1",
			"proj-1",
		);
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
	});

	it("resolves the credential in the hosting organization, never the session's", async () => {
		await call(input);

		expect(m.resolveFreshRepoTokenForRow).toHaveBeenCalledWith(
			expect.objectContaining({ integrationId: "int-1" }),
			{ userId: "user-1", organizationId: "org-host" },
		);
	});
});

describe("repositoryIntegrations.branches", () => {
	it("returns the provider's live default and the branch names, without the token", async () => {
		const result = await call(input);

		expect(result).toEqual({
			defaultBranch: "main",
			branches: ["main", "release/1.0"],
			truncated: false,
		});
		expect(m.listRepositoryBranches).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				token: SECRET_TOKEN,
				owner: "example-org",
				repo: "instructions",
			}),
		);
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});

	it("never rewrites the stored branch, even when the provider default differs", async () => {
		await call(input);

		expect(m.integrationUpdate).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("answers a null default when the provider will not name one", async () => {
		m.fetchProviderDefaultBranch.mockResolvedValue(null);

		await expect(call(input)).resolves.toMatchObject({
			defaultBranch: null,
			branches: ["main", "release/1.0"],
		});
	});

	it("marks a listing that reached the bound as truncated", async () => {
		m.listRepositoryBranches.mockResolvedValue({
			ok: true,
			branches: Array.from({ length: 300 }, (_, i) => ({
				name: `b-${i}`,
				commitSha: null,
			})),
		});

		await expect(call(input)).resolves.toMatchObject({ truncated: true });
	});

	it("authenticates a GitLab PAT with PRIVATE-TOKEN", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			provider: "GITLAB",
			authMethod: "PAT",
		});

		await call(input);

		expect(m.listRepositoryBranches).toHaveBeenCalledWith(
			expect.objectContaining({ gitlabAuth: "private-token" }),
		);
		expect(m.fetchProviderDefaultBranch).toHaveBeenCalledWith(
			expect.objectContaining({ gitlabAuth: "private-token" }),
		);
	});

	it.each([
		["unauthorized", "REPOSITORY_CREDENTIALS_EXPIRED"],
		["unreachable", "REPOSITORY_UNREACHABLE"],
		["not-found", "REPOSITORY_UNREACHABLE"],
	])(
		"maps a provider listing failure (%s) to %s, never an empty listing",
		async (outcome, code) => {
			m.listRepositoryBranches.mockResolvedValue({ ok: false, outcome });

			await expect(call(input)).rejects.toMatchObject({
				data: { code },
			});
		},
	);

	it("refuses an expired connection before any provider read", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			status: "TOKEN_EXPIRED",
		});

		await expect(call(input)).rejects.toMatchObject({
			data: { code: "REPOSITORY_CREDENTIALS_EXPIRED" },
		});
		expect(m.listRepositoryBranches).not.toHaveBeenCalled();
	});
});
