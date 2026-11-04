/**
 * `projects.contexts.repositorySync.readIgnoreFiles` — each ticked folder's
 * `.contextignore`, for the Living Memory configure dialog's preview of what
 * the sync skips.
 *
 * Each call runs the procedure's REAL middleware chain in its declared order
 * — `projectNotFoundUnlessVisible`, then the real `requireProjectPermission`
 * — before the handler, as the sibling procedure tests do, so the refusals
 * are what is pinned. The database, the credential resolver and the file
 * read are mocked; `isRepositoryTreeProvider`, the path spelling rule, the
 * decoder, the `**` rule check and `MAX_CONTEXT_IGNORE_BYTES` are real.
 */
import { MAX_CONTEXT_IGNORE_BYTES } from "@repo/instructions/context-sync-rules";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	grantProjectAccess: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	resolveFreshRepoTokenForRow: vi.fn(),
	readRepositoryFile: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	// `./paths` (imported for its bound) reads these two real rules.
	const selection = await import(
		"@repo/database/prisma/queries/projects/context-repository-sync-selection"
	);
	return {
		...selection,
		db: {},
		getOrganizationMembership: vi.fn(),
		getTenantContext: vi.fn(),
		hasProjectAccess: m.hasProjectAccess,
		grantProjectAccess: m.grantProjectAccess,
		getProjectRepoIntegration: m.getProjectRepoIntegration,
	};
});
vi.mock("@repo/connectors", async () => ({
	readRepositoryFile: m.readRepositoryFile,
	// The real provider list: which providers are answered without a
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

import { projectNotFoundUnlessVisible } from "../../../../../../orpc/middleware/project-visibility";
import { readContextRepositoryIgnoreFilesProcedure } from "../read-ignore-files";

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

const procedure = readContextRepositoryIgnoreFilesProcedure as unknown as Built;

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

const EDITOR = ["context:read", "context:create"];
const VIEWER = ["context:read"];
// Distinctive and token-shaped, so a leak assertion cannot pass by accident.
const SECRET_TOKEN = "ghs_example_secret_token";

const integration = {
	id: "int-1",
	projectId: "proj-1",
	provider: "GITHUB",
	authMethod: "OAUTH",
	repositoryUrl: "https://github.com/example-org/memory.git",
	repositoryOwner: "example-org",
	repositoryName: "memory",
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
	folders: ["docs", ""],
};

const encode = (text: string) => new TextEncoder().encode(text);

const NOTHING_READ = () => {
	expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
	expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
	expect(m.readRepositoryFile).not.toHaveBeenCalled();
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
	m.readRepositoryFile.mockImplementation(async ({ path }) =>
		path === "docs/.contextignore"
			? { ok: true, state: "found", bytes: encode("drafts/\n*.tmp.md\n") }
			: { ok: true, state: "absent" },
	);
});

describe("authorization: visibility first, then CONTEXT_CREATE in the hosting organization, as listTree", () => {
	it("composes listTree's chain in listTree's order: visibility, then the CONTEXT_CREATE gate", () => {
		expect(procedure.middlewares).toHaveLength(2);
		expect(procedure.middlewares[0]).toBe(projectNotFoundUnlessVisible);
	});

	it("answers a project the caller cannot discover NOT_FOUND, even when the org-role fallback would grant CONTEXT_CREATE", async () => {
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
		expect(m.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		NOTHING_READ();
	});

	it("refuses a member without CONTEXT_CREATE before anything is read", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: VIEWER,
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(call(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Missing required permission: context:create",
		});
		NOTHING_READ();
	});

	it("refuses a personal project (no organization) rather than using the fail-closed arm", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: EDITOR,
			source: "owner",
			organizationId: null,
		});

		await expect(call(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
		NOTHING_READ();
	});

	it("refuses a client-supplied organization other than the host's, before any credential is read", async () => {
		await expect(
			call({ ...input, organizationId: "org-evil" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
	});

	it("resolves the credential in the project's hosting organization, never the session's", async () => {
		await call(input);

		expect(m.resolveFreshRepoTokenForRow).toHaveBeenCalledWith(
			expect.objectContaining({ integrationId: "int-1" }),
			{ userId: "user-1", organizationId: "org-host" },
		);
	});
});

describe("repositorySync.readIgnoreFiles (living memory)", () => {
	it("reads each folder's own .contextignore, capped as the run reads it, and returns its text as written, auditing nothing", async () => {
		const result = await call(input);

		expect(result).toEqual({
			supported: true,
			files: [
				{ folder: "docs", state: "rules", text: "drafts/\n*.tmp.md\n" },
				{ folder: "", state: "absent" },
			],
		});
		expect(m.readRepositoryFile).toHaveBeenCalledWith({
			provider: "GITHUB",
			token: SECRET_TOKEN,
			repositoryUrl: "https://github.com/example-org/memory.git",
			owner: "example-org",
			repo: "memory",
			azureOrganization: null,
			branch: "develop",
			path: "docs/.contextignore",
			maxBytes: MAX_CONTEXT_IGNORE_BYTES,
		});
		// The whole repository's policy is the root-level file.
		expect(m.readRepositoryFile).toHaveBeenCalledWith(
			expect.objectContaining({ path: ".contextignore" }),
		);
		expect(MAX_CONTEXT_IGNORE_BYTES).toBe(64 * 1024);
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});

	it("reads a folder named twice once", async () => {
		await call({ ...input, folders: ["docs", "docs"] });

		expect(m.readRepositoryFile).toHaveBeenCalledTimes(1);
	});

	it("says a file over 64 KiB is too large, and never returns any of it", async () => {
		m.readRepositoryFile.mockResolvedValue({ ok: true, state: "tooLarge" });

		const result = await call({ ...input, folders: ["docs"] });

		expect(result).toEqual({
			supported: true,
			files: [{ folder: "docs", state: "tooLarge" }],
		});
	});

	it("says a file that is not UTF-8 text is an encoding problem, as the run cannot evaluate it", async () => {
		m.readRepositoryFile.mockResolvedValue({
			ok: true,
			state: "found",
			bytes: new Uint8Array([0x64, 0x72, 0xff, 0xfe, 0x0a]),
		});

		const result = await call({ ...input, folders: ["docs"] });

		expect(result).toEqual({
			supported: true,
			files: [{ folder: "docs", state: "encoding" }],
		});
	});

	it("names the line of a rule the run refuses to evaluate, and never returns the text", async () => {
		m.readRepositoryFile.mockResolvedValue({
			ok: true,
			state: "found",
			bytes: encode("drafts/\n**/a/**/b/**/c\n"),
		});

		const result = await call({ ...input, folders: ["docs"] });

		expect(result).toEqual({
			supported: true,
			files: [{ folder: "docs", state: "ruleRejected", line: 2 }],
		});
	});

	it("refuses a folder not in its plain spelling before any credential is read", async () => {
		await expect(
			call({ ...input, folders: ["docs/"] }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "INVALID_PATH", path: "docs/" },
		});
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
		expect(m.readRepositoryFile).not.toHaveBeenCalled();
	});

	it("refuses more folders than a sync can select", async () => {
		await expect(
			call({
				...input,
				folders: Array.from({ length: 51 }, (_, i) => `f${i}`),
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		NOTHING_READ();
	});

	it("answers a provider it cannot read unsupported, before any credential is resolved", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			provider: "GITLAB",
		});

		expect(await call(input)).toEqual({ supported: false, files: [] });
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
		expect(m.readRepositoryFile).not.toHaveBeenCalled();
	});

	it("reads nothing, and resolves no credential, for no folders", async () => {
		expect(await call({ ...input, folders: [] })).toEqual({
			supported: true,
			files: [],
		});
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
	});

	it("refuses an integration that belongs to another project before any credential is read", async () => {
		m.getProjectRepoIntegration.mockResolvedValue(null);

		await expect(call(input)).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { code: "REPOSITORY_NOT_FOUND" },
		});
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
	});

	it.each([
		["unauthorized", "BAD_REQUEST", "REPOSITORY_CREDENTIALS_EXPIRED"],
		["unreachable", "INTERNAL_SERVER_ERROR", "REPOSITORY_UNREACHABLE"],
	])(
		"throws configure's %s error (%s/%s), never an absent file",
		async (outcome, code, dataCode) => {
			m.readRepositoryFile.mockResolvedValue({ ok: false, outcome });

			const caught = (await call(input).then(
				(value) => ({ resolvedWith: value }),
				(error: unknown) => error,
			)) as { code: string; message: string; data: unknown };

			expect(caught).not.toHaveProperty("resolvedWith");
			expect(caught).toMatchObject({ code, data: { code: dataCode } });
			expect(caught.message).not.toContain(SECRET_TOKEN);
			expect(JSON.stringify(caught.data)).not.toContain(SECRET_TOKEN);
		},
	);
});
