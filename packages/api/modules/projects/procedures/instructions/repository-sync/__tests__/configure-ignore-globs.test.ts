/**
 * `projects.instructions.repositorySync.configure` with `ignoreGlobs` — the
 * configure dialog's folder exclusions, written with the configuration in
 * one transaction (Fizzy #2726).
 *
 * Each call runs the procedure's REAL middleware chain in its declared order
 * — `projectNotFoundUnlessVisible`, then the real `requireProjectPermission`
 * — and the handler's own real `assertProjectPermission`, so the extra
 * INSTRUCTION_UPDATE requirement is what is pinned, not a mocked stand-in.
 * The database, the credential resolver and the branch check are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	grantProjectAccess: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	upsertInstructionRepositorySync: vi.fn(),
	resolveFreshRepoTokenForRow: vi.fn(),
	verifyRepositoryBranch: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(),
	hasProjectAccess: m.hasProjectAccess,
	grantProjectAccess: m.grantProjectAccess,
	getProjectRepoIntegration: m.getProjectRepoIntegration,
	upsertInstructionRepositorySync: m.upsertInstructionRepositorySync,
}));
vi.mock("@repo/connectors", () => ({
	verifyRepositoryBranch: m.verifyRepositoryBranch,
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
// `requireProjectPermission` and `assertProjectPermission` are the real ones.
vi.mock("../../../../../../orpc/procedures", async () => {
	const { assertProjectPermission, requireProjectPermission } =
		await vi.importActual<
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
		assertProjectPermission,
		requireProjectPermission,
		Permissions,
	};
});

import { configureRepositorySyncProcedure } from "../configure";

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

const procedure = configureRepositorySyncProcedure as unknown as Built;

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

const CREATE_AND_UPDATE = [
	"instruction:read",
	"instruction:create",
	"instruction:update",
];
const CREATE_ONLY = ["instruction:read", "instruction:create"];
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
	rootPath: "agents",
};

function grant(permissions: string[]) {
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions,
		source: "project-member",
		organizationId: "org-host",
	});
}

const settingsAudits = () =>
	m.recordAuditFromRequest.mock.calls.filter(
		([, entry]) =>
			(entry as { action: string }).action ===
			"project.instructions.settings_updated",
	);

beforeEach(() => {
	vi.clearAllMocks();
	m.hasProjectAccess.mockResolvedValue(true);
	grant(CREATE_AND_UPDATE);
	m.getProjectRepoIntegration.mockResolvedValue(integration);
	m.resolveFreshRepoTokenForRow.mockResolvedValue({ token: SECRET_TOKEN });
	m.verifyRepositoryBranch.mockResolvedValue("exists");
	m.upsertInstructionRepositorySync.mockResolvedValue({
		sync: {
			id: "sync-1",
			generation: 4,
			ref: "develop",
			rootPath: "agents",
			automatic: false,
		},
		previous: {
			ref: "main",
			rootPath: "",
			repositoryIntegrationId: "int-1",
		},
		ignoreGlobsChanged: true,
	});
});

describe("configure with ignoreGlobs: authorization never broader than the two procedures", () => {
	it("refuses a caller with INSTRUCTION_CREATE but not INSTRUCTION_UPDATE FORBIDDEN, as updateSettings would, before anything is read or written", async () => {
		grant(CREATE_ONLY);

		await expect(
			call({ ...input, ignoreGlobs: ["skills/**"] }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Missing required permission: instruction:update",
		});
		expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
		expect(m.verifyRepositoryBranch).not.toHaveBeenCalled();
		expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses clearing the rules (null) without INSTRUCTION_UPDATE too", async () => {
		grant(CREATE_ONLY);

		await expect(
			call({ ...input, ignoreGlobs: null }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
	});

	it("still lets a caller with only INSTRUCTION_CREATE configure without rules, leaving them untouched", async () => {
		grant(CREATE_ONLY);
		m.upsertInstructionRepositorySync.mockResolvedValue({
			sync: {
				id: "sync-1",
				generation: 4,
				ref: "develop",
				rootPath: "agents",
				automatic: false,
			},
			previous: null,
			ignoreGlobsChanged: false,
		});

		await call(input);

		const [written] = m.upsertInstructionRepositorySync.mock.calls[0] as [
			Record<string, unknown>,
		];
		expect(written).not.toHaveProperty("ignoreGlobs");
		expect(settingsAudits()).toHaveLength(0);
	});

	it("still answers a caller who cannot discover the project NOT_FOUND first", async () => {
		m.hasProjectAccess.mockResolvedValue(false);
		grant(CREATE_ONLY);

		await expect(
			call({ ...input, ignoreGlobs: ["skills/**"] }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
	});
});

describe("configure with ignoreGlobs: one write or none", () => {
	it("hands the rules to the configuration's own transaction and audits the rule change as updateSettings does", async () => {
		const result = await call({ ...input, ignoreGlobs: ["skills/**"] });

		expect(result).toEqual({ syncId: "sync-1", generation: 4 });
		expect(m.upsertInstructionRepositorySync).toHaveBeenCalledTimes(1);
		expect(m.upsertInstructionRepositorySync).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			userId: "user-1",
			repositoryIntegrationId: "int-1",
			ref: "develop",
			rootPath: "agents",
			ignoreGlobs: ["skills/**"],
		});
		expect(settingsAudits()).toEqual([
			[
				expect.anything(),
				{
					action: "project.instructions.settings_updated",
					category: "project",
					organizationId: "org-host",
					projectId: "proj-1",
					resource: { type: "project", id: "proj-1", name: null },
					metadata: { ignoreGlobCount: 1 },
				},
			],
		]);
		// The configuration's own audit row is still written.
		expect(
			m.recordAuditFromRequest.mock.calls.map(
				([, entry]) => (entry as { action: string }).action,
			),
		).toEqual([
			"project.instructions.repository_sync_configured",
			"project.instructions.settings_updated",
		]);
	});

	it("writes the rules with a FIRST configuration too", async () => {
		m.upsertInstructionRepositorySync.mockResolvedValue({
			sync: {
				id: "sync-1",
				generation: 1,
				ref: "develop",
				rootPath: "agents",
				automatic: true,
			},
			previous: null,
			ignoreGlobsChanged: true,
		});

		await call({
			...input,
			automatic: true,
			ignoreGlobs: ["skills/**", "drafts/**"],
		});

		expect(m.upsertInstructionRepositorySync).toHaveBeenCalledWith(
			expect.objectContaining({
				ignoreGlobs: ["skills/**", "drafts/**"],
				automatic: true,
			}),
		);
		expect(settingsAudits()).toHaveLength(1);
		expect(settingsAudits()[0]?.[1]).toMatchObject({
			metadata: { ignoreGlobCount: 2 },
		});
	});

	it("passes null through to clear the rules", async () => {
		await call({ ...input, ignoreGlobs: null });

		expect(m.upsertInstructionRepositorySync).toHaveBeenCalledWith(
			expect.objectContaining({ ignoreGlobs: null }),
		);
		expect(settingsAudits()[0]?.[1]).toMatchObject({
			metadata: { ignoreGlobCount: 0 },
		});
	});

	it("audits no rule change when the stored rules were already these", async () => {
		m.upsertInstructionRepositorySync.mockResolvedValue({
			sync: {
				id: "sync-1",
				generation: 4,
				ref: "develop",
				rootPath: "agents",
				automatic: false,
			},
			previous: null,
			ignoreGlobsChanged: false,
		});

		await call({ ...input, ignoreGlobs: ["skills/**"] });

		expect(settingsAudits()).toHaveLength(0);
	});

	it.each([
		["not-found", "BRANCH_NOT_FOUND"],
		["unauthorized", "REPOSITORY_CREDENTIALS_EXPIRED"],
		["unreachable", "REPOSITORY_UNREACHABLE"],
	])(
		"writes neither the configuration nor the rules when the branch check answers %s",
		async (outcome, dataCode) => {
			m.verifyRepositoryBranch.mockResolvedValue(outcome);

			await expect(
				call({ ...input, ignoreGlobs: ["skills/**"] }),
			).rejects.toMatchObject({ data: { code: dataCode } });
			expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		},
	);

	it("writes neither when the integration is not usable", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			status: "TOKEN_EXPIRED",
		});

		await expect(
			call({ ...input, ignoreGlobs: ["skills/**"] }),
		).rejects.toMatchObject({ data: { code: "REPOSITORY_UNAVAILABLE" } });
		expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
	});

	it("audits nothing when the transaction wrote nothing (project not in this organization)", async () => {
		m.upsertInstructionRepositorySync.mockResolvedValue(null);

		await expect(
			call({ ...input, ignoreGlobs: ["skills/**"] }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});

describe("configure with ignoreGlobs: updateSettings' bounds", () => {
	it.each([
		[
			"more than 200 rules",
			Array.from({ length: 201 }, (_, i) => `r${i}/**`),
		],
		["a rule over 256 characters", [`${"a".repeat(254)}/**`]],
		["an empty rule", [""]],
	])("refuses %s before the handler runs", async (_label, ignoreGlobs) => {
		await expect(call({ ...input, ignoreGlobs })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(m.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
	});

	it("accepts exactly 200 rules of exactly 256 characters", async () => {
		const rule = `${"a".repeat(253)}/**`;
		expect(rule).toHaveLength(256);
		await call({
			...input,
			ignoreGlobs: Array.from({ length: 200 }, () => rule),
		});
		expect(m.upsertInstructionRepositorySync).toHaveBeenCalled();
	});
});
