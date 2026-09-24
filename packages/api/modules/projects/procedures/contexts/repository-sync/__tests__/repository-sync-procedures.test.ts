/**
 * `projects.contexts.repositorySync.{get,listTree,configure,syncNow,disable}`
 * — the Living Memory repository sync procedures (design 2026-09-23 §5.1,
 * §5.6, §8, Fizzy #2657, #2674), and the automatic-sync switch and state
 * they carry (§11.1, Fizzy #2673).
 *
 * Each call runs the procedure's REAL middleware chain in its declared order
 * — `projectNotFoundUnlessVisible`, then the real `requireProjectPermission`
 * — before the handler, so which gate answers first is part of what is
 * pinned: a project the caller cannot discover is NOT_FOUND before any
 * permission is evaluated; a read-only member may `get` and nothing else.
 * The database, the credential resolver, the branch check, the tree read
 * and Temporal are mocked; reconciliation (`../reconcile`) and the path rules (`../paths`)
 * are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	grantProjectAccess: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	getContextRepositorySync: vi.fn(),
	getNewestContextRepositorySyncRun: vi.fn(),
	getContextRepositorySyncRun: vi.fn(),
	countManagedContexts: vi.fn(),
	countAwaitingIndexContexts: vi.fn(),
	countContextRepositorySyncRunCleanupPending: vi.fn(),
	listProjectRepoIntegrations: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	upsertContextRepositorySync: vi.fn(),
	deleteContextRepositorySync: vi.fn(),
	listUnfinishedContextRepositorySyncRuns: vi.fn(),
	completeInterruptedContextRepositorySyncRuns: vi.fn(),
	verifyRepositoryBranch: vi.fn(),
	listRepositoryTree: vi.fn(),
	resolveFreshRepoTokenForRow: vi.fn(),
	startContextRepositorySync: vi.fn(),
	isContextRepositorySyncRunning: vi.fn(),
	describeContextSyncExecutions: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	// The path rules are the real ones: canonical spelling is part of what
	// `configure` promises.
	const path = await import(
		"@repo/database/prisma/queries/projects/context-source-path"
	);
	return {
		...path,
		db: {},
		hasProjectAccess: m.hasProjectAccess,
		grantProjectAccess: m.grantProjectAccess,
		getContextRepositorySync: m.getContextRepositorySync,
		getNewestContextRepositorySyncRun: m.getNewestContextRepositorySyncRun,
		getContextRepositorySyncRun: m.getContextRepositorySyncRun,
		countManagedContexts: m.countManagedContexts,
		countAwaitingIndexContexts: m.countAwaitingIndexContexts,
		countContextRepositorySyncRunCleanupPending:
			m.countContextRepositorySyncRunCleanupPending,
		listProjectRepoIntegrations: m.listProjectRepoIntegrations,
		getProjectRepoIntegration: m.getProjectRepoIntegration,
		upsertContextRepositorySync: m.upsertContextRepositorySync,
		deleteContextRepositorySync: m.deleteContextRepositorySync,
		listUnfinishedContextRepositorySyncRuns:
			m.listUnfinishedContextRepositorySyncRuns,
		completeInterruptedContextRepositorySyncRuns:
			m.completeInterruptedContextRepositorySyncRuns,
	};
});
vi.mock("@repo/connectors", async () => ({
	verifyRepositoryBranch: m.verifyRepositoryBranch,
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
vi.mock("../../../../lib/context-repository-sync-workflow", () => ({
	startContextRepositorySync: m.startContextRepositorySync,
	isContextRepositorySyncRunning: m.isContextRepositorySyncRunning,
	describeContextSyncExecutions: m.describeContextSyncExecutions,
}));

// Each `.use(...)` returns a builder carrying its own chain, so the four
// procedures loaded here keep separate chains; `requireProjectPermission`
// is the real one.
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

import { configureContextRepositorySyncProcedure } from "../configure";
import { disableContextRepositorySyncProcedure } from "../disable";
import { getContextRepositorySyncProcedure } from "../get";
import { listContextRepositoryTreeProcedure } from "../list-tree";
import { syncContextRepositoryNowProcedure } from "../sync-now";

type Ctx = {
	user: { id: string; name: string; email: string };
	session: { id: string; activeOrganizationId: string | null };
};
type Built = {
	handler: (args: { input: unknown; context: Ctx }) => Promise<unknown>;
	middlewares: Middleware[];
	inputSchema: {
		safeParse(v: unknown): { success: boolean; data?: unknown };
	};
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

const procedures = {
	get: getContextRepositorySyncProcedure,
	listTree: listContextRepositoryTreeProcedure,
	configure: configureContextRepositorySyncProcedure,
	syncNow: syncContextRepositoryNowProcedure,
	disable: disableContextRepositorySyncProcedure,
} as unknown as Record<
	"get" | "listTree" | "configure" | "syncNow" | "disable",
	Built
>;

// The caller's session sits in org-session; the project lives in org-host.
const ctx: Ctx = {
	user: { id: "user-1", name: "Example Member", email: "dev@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-session" },
};

/** Run the procedure as oRPC would: its middlewares in order, then the handler. */
async function call(
	name: keyof typeof procedures,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const procedure = procedures[name];
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
const RUN = "sync-1:run-a";

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

const syncRow = {
	id: "sync-1",
	projectId: "proj-1",
	organizationId: "org-host",
	userId: "user-2",
	repositoryIntegrationId: "int-1",
	ref: "main",
	paths: ["docs", "notes/team.md"],
	generation: 4,
	activeRunKey: null as string | null,
	lastAppliedCommitSha: "abc1234",
	lastAppliedRunId: "sync-1:run-0",
	automatic: true,
	automaticPausedReason: "REF_MISSING" as string | null,
	automaticPausedAt: new Date("2026-09-22T12:00:00.000Z") as Date | null,
	nextCheckAt: new Date("2026-09-22T12:15:00.000Z"),
	failureCount: 2,
	// The poll's cursors: never part of what `get` answers.
	suppressedCommitSha: "sup1234",
	lastEvaluatedCommitSha: "eva1234",
	createdAt: new Date("2026-09-20T00:00:00.000Z"),
	updatedAt: new Date("2026-09-22T00:00:00.000Z"),
	user: { id: "user-2", name: "Configuring Member" },
	repositoryIntegration: {
		id: "int-1",
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "memory",
		defaultBranch: "main",
		status: "ACTIVE",
	},
};

function receipt(overrides: Record<string, unknown> = {}) {
	return {
		id: "sync-1:run-0",
		syncId: "sync-1",
		projectId: "proj-1",
		organizationId: "org-host",
		generation: 4,
		trigger: "MANUAL",
		startedAt: new Date("2026-09-23T10:00:00.000Z"),
		finishedAt: new Date("2026-09-23T10:02:00.000Z"),
		status: "PARTIAL",
		error: null,
		commitSha: "abc1234",
		plan: {
			keptCount: 4,
			excludedCount: 1,
			attentionCount: 1,
			attention: [{ key: "docs/big.md", reason: "too-large" }],
			protectedPrefixes: [],
			missingPaths: [],
			keptKeys: ["docs/a.md", "docs/b.md", "docs/c.md", "notes/team.md"],
			protectedKeys: ["docs/big.md"],
		},
		outcomes: {
			"docs/a.md": "created",
			"docs/b.md": "path-in-use",
			"docs/c.md": "conflict",
			"notes/team.md": "unchanged",
		},
		removedCount: 2,
		pruneConflicts: { keys: ["docs/old.md"], overflow: 1 },
		userName: "Configuring Member",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.hasProjectAccess.mockResolvedValue(true);
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: EDITOR,
		source: "project-member",
		organizationId: "org-host",
	});
	m.getContextRepositorySync.mockResolvedValue({ ...syncRow });
	m.getNewestContextRepositorySyncRun.mockResolvedValue(null);
	m.getContextRepositorySyncRun.mockResolvedValue(null);
	m.countManagedContexts.mockResolvedValue(0);
	m.countAwaitingIndexContexts.mockResolvedValue(0);
	m.countContextRepositorySyncRunCleanupPending.mockResolvedValue(0);
	m.listProjectRepoIntegrations.mockResolvedValue([
		integration,
		{ ...integration, id: "int-2", status: "TOKEN_EXPIRED" },
	]);
	m.isContextRepositorySyncRunning.mockResolvedValue(false);
	m.getProjectRepoIntegration.mockResolvedValue(integration);
	m.resolveFreshRepoTokenForRow.mockResolvedValue({ token: SECRET_TOKEN });
	m.verifyRepositoryBranch.mockResolvedValue("exists");
	m.listRepositoryTree.mockResolvedValue({
		ok: true,
		entries: [
			{ path: "docs", type: "dir" },
			{ path: "docs/guide.md", type: "file" },
		],
		truncated: false,
	});
	m.upsertContextRepositorySync.mockResolvedValue({
		status: "configured",
		sync: {
			id: "sync-1",
			generation: 5,
			repositoryIntegrationId: "int-1",
			ref: "develop",
			paths: ["docs", "notes/team.md"],
			automatic: false,
		},
		previous: {
			repositoryIntegrationId: "int-1",
			ref: "main",
			paths: ["docs", "notes/team.md"],
		},
	});
	m.listUnfinishedContextRepositorySyncRuns.mockResolvedValue([]);
	m.describeContextSyncExecutions.mockResolvedValue(new Map());
	m.completeInterruptedContextRepositorySyncRuns.mockResolvedValue({
		status: "ok",
		completed: [],
		activeRunKey: null,
	});
	m.startContextRepositorySync.mockResolvedValue(true);
	m.deleteContextRepositorySync.mockResolvedValue({
		deleted: true,
		syncId: "sync-1",
		managedCount: 7,
		repositoryIntegrationId: "int-1",
		activeRunKey: RUN,
	});
});

const configureInput = {
	projectId: "proj-1",
	repositoryIntegrationId: "int-1",
	ref: "develop",
	paths: ["notes/team.md", "docs"],
};

const listTreeInput = {
	projectId: "proj-1",
	repositoryIntegrationId: "int-1",
	ref: "develop",
};

const inputs = {
	get: { projectId: "proj-1" },
	listTree: listTreeInput,
	configure: configureInput,
	syncNow: { projectId: "proj-1" },
	disable: { projectId: "proj-1" },
} as const;

const NO_WRITES = () => {
	expect(m.upsertContextRepositorySync).not.toHaveBeenCalled();
	expect(m.startContextRepositorySync).not.toHaveBeenCalled();
	expect(m.deleteContextRepositorySync).not.toHaveBeenCalled();
	expect(
		m.completeInterruptedContextRepositorySyncRuns,
	).not.toHaveBeenCalled();
	expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
};

// =============================================================================
// Authorization
// =============================================================================

describe("authorization: visibility first, then CONTEXT_READ / CONTEXT_CREATE", () => {
	it("lets a read-only member get the status", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: VIEWER,
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(call("get", inputs.get)).resolves.toMatchObject({
			canConfigure: false,
		});
	});

	it.each(["listTree", "configure", "syncNow", "disable"] as const)(
		"refuses %s to a member without CONTEXT_CREATE, before anything is read or written",
		async (name) => {
			m.resolveEffectiveProjectPermissions.mockResolvedValue({
				permissions: VIEWER,
				source: "project-member",
				organizationId: "org-host",
			});

			await expect(call(name, inputs[name])).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: "Missing required permission: context:create",
			});
			expect(m.getContextRepositorySync).not.toHaveBeenCalled();
			expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
			expect(m.listRepositoryTree).not.toHaveBeenCalled();
			NO_WRITES();
		},
	);

	it.each(["get", "listTree", "configure", "syncNow", "disable"] as const)(
		"answers %s on a project the caller cannot see NOT_FOUND, before any permission is evaluated",
		async (name) => {
			// An org member the org-role fallback would grant CONTEXT_CREATE
			// on a project they have no standing on.
			m.hasProjectAccess.mockResolvedValue(false);
			m.resolveEffectiveProjectPermissions.mockResolvedValue({
				permissions: EDITOR,
				source: "org",
				organizationId: "org-host",
			});

			await expect(call(name, inputs[name])).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: "Project not found",
			});
			expect(m.hasProjectAccess).toHaveBeenCalledWith("proj-1", "user-1");
			expect(m.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
			expect(m.listRepositoryTree).not.toHaveBeenCalled();
			NO_WRITES();
		},
	);

	it.each(["get", "listTree", "configure", "syncNow", "disable"] as const)(
		"refuses %s on a personal project (no organization) rather than using the fail-closed arm",
		async (name) => {
			m.resolveEffectiveProjectPermissions.mockResolvedValue({
				permissions: EDITOR,
				source: "owner",
				organizationId: null,
			});

			await expect(call(name, inputs[name])).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			NO_WRITES();
		},
	);

	it("acts in the project's hosting organization, never a client-supplied or session one", async () => {
		await call("configure", {
			...configureInput,
			organizationId: "org-evil",
		});
		await call("disable", {
			projectId: "proj-1",
			organizationId: "org-evil",
		});
		await call("syncNow", {
			projectId: "proj-1",
			organizationId: "org-evil",
		});
		await call("get", { projectId: "proj-1", organizationId: "org-evil" });
		await call("listTree", {
			...listTreeInput,
			organizationId: "org-evil",
		});

		expect(m.upsertContextRepositorySync).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-host" }),
		);
		expect(m.deleteContextRepositorySync).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
		});
		expect(m.startContextRepositorySync).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-host" }),
		);
		for (const [, organizationId] of m.getContextRepositorySync.mock
			.calls) {
			expect(organizationId).toBe("org-host");
		}
		for (const [, options] of m.resolveFreshRepoTokenForRow.mock.calls) {
			expect(options).toEqual({
				userId: "user-1",
				organizationId: "org-host",
			});
		}
	});
});

// =============================================================================
// get
// =============================================================================

describe("repositorySync.get", () => {
	it("returns the configuration minus internals, both receipts, the live counts and the integrations for a configurer", async () => {
		m.isContextRepositorySyncRunning.mockResolvedValue(true);
		m.getNewestContextRepositorySyncRun.mockResolvedValue(
			receipt({
				id: RUN,
				finishedAt: null,
				status: null,
				outcomes: {},
				plan: null,
				pruneConflicts: { keys: [], overflow: 0 },
			}),
		);
		m.getContextRepositorySyncRun.mockResolvedValue(receipt());
		m.countManagedContexts.mockResolvedValue(12);
		m.countAwaitingIndexContexts.mockResolvedValue(3);
		m.countContextRepositorySyncRunCleanupPending.mockResolvedValue(1);

		const result = await call("get", inputs.get);

		expect(result).toEqual({
			canConfigure: true,
			running: true,
			configured: {
				syncId: "sync-1",
				repositoryIntegrationId: "int-1",
				ref: "main",
				paths: ["docs", "notes/team.md"],
				automatic: true,
				automaticPausedReason: "REF_MISSING",
				automaticPausedAt: syncRow.automaticPausedAt,
				nextCheckAt: syncRow.nextCheckAt,
				failureCount: 2,
				lastAppliedCommitSha: "abc1234",
				configuredByName: "Configuring Member",
				createdAt: syncRow.createdAt,
				updatedAt: syncRow.updatedAt,
				integration: {
					provider: "GITHUB",
					repositoryOwner: "example-org",
					repositoryName: "memory",
					status: "ACTIVE",
				},
			},
			latestRun: expect.objectContaining({ id: RUN, status: null }),
			lastAppliedRun: {
				id: "sync-1:run-0",
				trigger: "MANUAL",
				startedAt: new Date("2026-09-23T10:00:00.000Z"),
				finishedAt: new Date("2026-09-23T10:02:00.000Z"),
				status: "PARTIAL",
				error: null,
				commitSha: "abc1234",
				userName: "Configuring Member",
				counts: {
					created: 1,
					updated: 0,
					adopted: 0,
					unchanged: 1,
					conflict: 1,
					pathInUse: 1,
					removed: 2,
					pruneConflicts: 2,
				},
				plan: {
					keptCount: 4,
					excludedCount: 1,
					attentionCount: 1,
					attention: [{ key: "docs/big.md", reason: "too-large" }],
					missingPaths: [],
					protectedPrefixes: [],
				},
				applyAttention: [
					{ key: "docs/b.md", reason: "path-in-use" },
					{ key: "docs/c.md", reason: "conflict" },
				],
				pruneConflicts: { keys: ["docs/old.md"], overflow: 1 },
			},
			managedCount: 12,
			awaitingIndexCount: 3,
			cleanupPending: 1,
			availableIntegrations: [
				{
					id: "int-1",
					provider: "GITHUB",
					repositoryOwner: "example-org",
					repositoryName: "memory",
					defaultBranch: "main",
					status: "ACTIVE",
				},
				{
					id: "int-2",
					provider: "GITHUB",
					repositoryOwner: "example-org",
					repositoryName: "memory",
					defaultBranch: "main",
					status: "TOKEN_EXPIRED",
				},
			],
		});
		// Counted in the resolved tenant, never by project and sync id alone.
		const tenant = { projectId: "proj-1", organizationId: "org-host" };
		expect(m.countManagedContexts).toHaveBeenCalledWith(
			expect.anything(),
			tenant,
			"sync-1",
		);
		expect(m.countAwaitingIndexContexts).toHaveBeenCalledWith(
			tenant,
			"sync-1",
		);
		// Reads bound to the hosting organization; the live cleanup count is
		// asked about the LAST APPLIED run, by its key, project and tenant.
		expect(m.getNewestContextRepositorySyncRun).toHaveBeenCalledWith(
			"sync-1",
			{ projectId: "proj-1", organizationId: "org-host" },
		);
		expect(m.getContextRepositorySyncRun).toHaveBeenCalledWith(
			"sync-1:run-0",
			{ projectId: "proj-1", organizationId: "org-host" },
		);
		expect(
			m.countContextRepositorySyncRunCleanupPending,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "sync-1:run-0",
				projectId: "proj-1",
				organizationId: "org-host",
			}),
		);
		const text = JSON.stringify(result);
		for (const secret of ["user-2", "enc-access", "enc-refresh"]) {
			expect(text).not.toContain(secret);
		}
		expect(text).not.toContain("keptKeys");
		expect(text).not.toContain("protectedKeys");
		expect(text).not.toContain("activeRunKey");
		// The poll's cursors stay server-side.
		for (const cursor of ["sup1234", "eva1234"]) {
			expect(text).not.toContain(cursor);
		}
	});

	it("answers automatic sync's state as stored: off, never paused, and every field present", async () => {
		m.getContextRepositorySync.mockResolvedValue({
			...syncRow,
			automatic: false,
			automaticPausedReason: null,
			automaticPausedAt: null,
			failureCount: 0,
		});

		const result = await call("get", inputs.get);
		const configured = result.configured as Record<string, unknown>;

		expect(configured).toMatchObject({
			automatic: false,
			automaticPausedReason: null,
			automaticPausedAt: null,
			nextCheckAt: syncRow.nextCheckAt,
			failureCount: 0,
		});
		// Present as null, not missing: the tab reads "not paused" from it.
		for (const field of [
			"automatic",
			"automaticPausedReason",
			"automaticPausedAt",
			"nextCheckAt",
			"failureCount",
		]) {
			expect(configured).toHaveProperty(field);
		}
	});

	it("shows a read-only member the status but no integrations", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: VIEWER,
			source: "project-member",
			organizationId: "org-host",
		});

		expect(await call("get", inputs.get)).toMatchObject({
			canConfigure: false,
			availableIntegrations: [],
		});
		expect(m.listProjectRepoIntegrations).not.toHaveBeenCalled();
	});

	it("answers an unconfigured project with zeros and no Temporal describe", async () => {
		m.getContextRepositorySync.mockResolvedValue(null);

		expect(await call("get", inputs.get)).toMatchObject({
			configured: null,
			running: false,
			latestRun: null,
			lastAppliedRun: null,
			managedCount: 0,
			awaitingIndexCount: 0,
			cleanupPending: 0,
		});
		expect(m.isContextRepositorySyncRunning).not.toHaveBeenCalled();
	});

	it("reads no applied receipt and reports no cleanup before a run has applied", async () => {
		m.getContextRepositorySync.mockResolvedValue({
			...syncRow,
			lastAppliedRunId: null,
			lastAppliedCommitSha: null,
		});

		expect(await call("get", inputs.get)).toMatchObject({
			lastAppliedRun: null,
			cleanupPending: 0,
		});
		expect(m.getContextRepositorySyncRun).not.toHaveBeenCalled();
		expect(
			m.countContextRepositorySyncRunCleanupPending,
		).not.toHaveBeenCalled();
	});
});

// =============================================================================
// listTree
// =============================================================================

describe("repositorySync.listTree", () => {
	it("lists the branch through the integration's fresh credential and returns the provider's entries", async () => {
		const result = await call("listTree", listTreeInput);

		expect(result).toEqual({
			supported: true,
			entries: [
				{ path: "docs", type: "dir" },
				{ path: "docs/guide.md", type: "file" },
			],
			truncated: false,
		});
		expect(m.getProjectRepoIntegration).toHaveBeenCalledWith(
			"int-1",
			"proj-1",
		);
		expect(m.resolveFreshRepoTokenForRow).toHaveBeenCalledWith(
			expect.objectContaining({ integrationId: "int-1" }),
			{ userId: "user-1", organizationId: "org-host" },
		);
		expect(m.listRepositoryTree).toHaveBeenCalledWith({
			provider: "GITHUB",
			token: SECRET_TOKEN,
			repositoryUrl: "https://github.com/example-org/memory.git",
			owner: "example-org",
			repo: "memory",
			azureOrganization: null,
			branch: "develop",
		});
		// A read of structure: nothing written, nothing audited.
		NO_WRITES();
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});

	it("refuses an integration that belongs to another project (tenant boundary) before any credential is read", async () => {
		m.getProjectRepoIntegration.mockResolvedValue(null);

		await expect(
			call("listTree", {
				...listTreeInput,
				repositoryIntegrationId: "int-of-proj-2",
			}),
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

		await expect(call("listTree", listTreeInput)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "REPOSITORY_UNAVAILABLE" },
		});
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
		expect(m.listRepositoryTree).not.toHaveBeenCalled();
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

			await expect(call("listTree", listTreeInput)).rejects.toMatchObject(
				{
					code,
					data: { code: dataCode },
				},
			);
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

			const caught = (await call("listTree", listTreeInput).then(
				(value) => ({ resolvedWith: value }),
				(error: unknown) => error,
			)) as { code: string; message: string; data: unknown };

			expect(caught).not.toHaveProperty("resolvedWith");
			expect(caught).toMatchObject({ code, data: { code: dataCode } });
			expect(caught.message).not.toContain(SECRET_TOKEN);
			expect(JSON.stringify(caught.data)).not.toContain(SECRET_TOKEN);
			NO_WRITES();
		},
	);

	it("maps an unauthorized read after OUR failed refresh to REPOSITORY_UNREACHABLE, never 'reconnect'", async () => {
		m.resolveFreshRepoTokenForRow.mockResolvedValue({
			token: SECRET_TOKEN,
			refreshFault: "PROVIDER_UNAVAILABLE",
		});
		m.listRepositoryTree.mockResolvedValue({
			ok: false,
			outcome: "unauthorized",
		});

		const caught = (await call("listTree", listTreeInput).catch(
			(error: unknown) => error,
		)) as { code: string; message: string; data: unknown };

		expect(caught).toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			data: { code: "REPOSITORY_UNREACHABLE" },
		});
		expect(caught.message).not.toContain(SECRET_TOKEN);
		expect(JSON.stringify(caught.data)).not.toContain(SECRET_TOKEN);
	});

	it.each(["GITLAB", "BITBUCKET"])(
		"answers a %s integration supported: false with no error and no credential resolved, so the dialog keeps typed paths",
		async (provider) => {
			m.getProjectRepoIntegration.mockResolvedValue({
				...integration,
				provider,
			});

			expect(await call("listTree", listTreeInput)).toEqual({
				supported: false,
				entries: [],
				truncated: false,
			});
			expect(m.getProjectRepoIntegration).toHaveBeenCalledWith(
				"int-1",
				"proj-1",
			);
			expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
			expect(m.listRepositoryTree).not.toHaveBeenCalled();
			NO_WRITES();
		},
	);

	it("still refuses an inactive GitLab integration before answering unsupported", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			provider: "GITLAB",
			status: "TOKEN_EXPIRED",
		});

		await expect(call("listTree", listTreeInput)).rejects.toMatchObject({
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

		expect(await call("listTree", listTreeInput)).toEqual({
			supported: false,
			entries: [],
			truncated: false,
		});
	});

	it("leaves out the .fabric directory, everything under it and the coding-instructions files, keeping folders the defaults name", async () => {
		m.listRepositoryTree.mockResolvedValue({
			ok: true,
			entries: [
				{ path: ".fabric", type: "dir" },
				{ path: ".fabric/instructions.lock", type: "file" },
				{ path: "docs", type: "dir" },
				{ path: "docs/.Fabric", type: "dir" },
				{ path: "docs/.Fabric/state.json", type: "file" },
				{ path: "docs/guide.md", type: "file" },
				{ path: "docs/AGENTS.md", type: "file" },
				{ path: "CLAUDE.md", type: "file" },
				{ path: "notes/gemini.md", type: "file" },
				{ path: "notes/.contextignore", type: "file" },
				{ path: "skills", type: "dir" },
				{ path: ".claude", type: "dir" },
				{ path: "docs/fabric.md", type: "file" },
				{ path: "docs/./odd.md", type: "file" },
				{ path: ".FABRIC/x.md", type: "file" },
			],
			truncated: false,
		});

		const result = await call("listTree", listTreeInput);

		expect(result.entries).toEqual([
			{ path: "docs", type: "dir" },
			{ path: "docs/guide.md", type: "file" },
			{ path: "skills", type: "dir" },
			{ path: ".claude", type: "dir" },
			{ path: "docs/fabric.md", type: "file" },
		]);
	});

	it("drops a directory named after an excluded file, with everything under it, listed or not", async () => {
		m.listRepositoryTree.mockResolvedValue({
			ok: true,
			entries: [
				{ path: "AGENTS.md", type: "dir" },
				{ path: "AGENTS.md/notes.md", type: "file" },
				{ path: "AGENTS.md/deep", type: "dir" },
				{ path: "AGENTS.md/deep/more.md", type: "file" },
				// The folder itself is not listed: its contents go all the same.
				{ path: "docs/claude.md/inner.md", type: "file" },
				{ path: "docs", type: "dir" },
				{ path: "docs/guide.md", type: "file" },
			],
			truncated: false,
		});

		const result = await call("listTree", listTreeInput);

		expect(result.entries).toEqual([
			{ path: "docs", type: "dir" },
			{ path: "docs/guide.md", type: "file" },
		]);
	});

	it("drops a path longer than configure's 1024-character limit", async () => {
		// The canonical spelling already stops at the storage key's 512
		// characters, so that is the longest path offered.
		const longest = `docs/${"a".repeat(512 - "docs/".length)}`;
		const tooLong = `docs/${"b".repeat(1025 - "docs/".length)}`;
		m.listRepositoryTree.mockResolvedValue({
			ok: true,
			entries: [
				{ path: "docs", type: "dir" },
				{ path: longest, type: "file" },
				{ path: tooLong, type: "file" },
			],
			truncated: false,
		});

		const result = await call("listTree", listTreeInput);

		expect(result.entries).toEqual([
			{ path: "docs", type: "dir" },
			{ path: longest, type: "file" },
		]);
	});

	it("returns an empty repository's empty tree as a supported, empty listing", async () => {
		m.listRepositoryTree.mockResolvedValue({
			ok: true,
			entries: [],
			truncated: false,
		});

		expect(await call("listTree", listTreeInput)).toEqual({
			supported: true,
			entries: [],
			truncated: false,
		});
	});

	it("passes the listing's truncated flag through", async () => {
		m.listRepositoryTree.mockResolvedValue({
			ok: true,
			entries: [{ path: "docs", type: "dir" }],
			truncated: true,
		});

		expect(await call("listTree", listTreeInput)).toEqual({
			supported: true,
			entries: [{ path: "docs", type: "dir" }],
			truncated: true,
		});
	});

	it.each(["refs/heads/main", "feature branch", "a..b", ""])(
		"refuses the branch name %j before the handler runs",
		async (ref) => {
			await expect(
				call("listTree", { ...listTreeInput, ref }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
			expect(m.listRepositoryTree).not.toHaveBeenCalled();
		},
	);
});

// =============================================================================
// configure
// =============================================================================

describe("repositorySync.configure", () => {
	it("verifies the branch, stores the canonical sorted paths with the caller as the member runs act as, audits, and starts nothing", async () => {
		const result = await call("configure", {
			...configureInput,
			paths: ["notes/team.md", "docs", "docs"],
		});

		expect(result).toEqual({ syncId: "sync-1", generation: 5 });
		expect(m.verifyRepositoryBranch).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				token: SECRET_TOKEN,
				branch: "develop",
				owner: "example-org",
				repo: "memory",
			}),
		);
		expect(m.upsertContextRepositorySync).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			userId: "user-1",
			repositoryIntegrationId: "int-1",
			ref: "develop",
			paths: ["docs", "notes/team.md"],
		});
		// Omitted, the stored value is kept: the key is not sent at all.
		expect(
			m.upsertContextRepositorySync.mock.calls[0]?.[0],
		).not.toHaveProperty("automatic");
		expect(m.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.objectContaining({ user: ctx.user }),
			{
				action: "project.context.repository_sync_configured",
				category: "project",
				organizationId: "org-host",
				projectId: "proj-1",
				resource: {
					type: "project_context_repository_sync",
					id: "sync-1",
					name: "example-org/memory",
				},
				metadata: {
					provider: "GITHUB",
					automatic: false,
					pathCount: 2,
					refChanged: true,
					pathsChanged: false,
					generation: 5,
				},
			},
		);
		expect(m.startContextRepositorySync).not.toHaveBeenCalled();
		for (const value of [result, ...m.recordAuditFromRequest.mock.calls]) {
			expect(JSON.stringify(value)).not.toContain(SECRET_TOKEN);
		}
	});

	it.each([true, false])(
		"turns automatic sync %s when the caller says so, and audits the value stored",
		async (automatic) => {
			m.upsertContextRepositorySync.mockResolvedValue({
				status: "configured",
				sync: {
					id: "sync-1",
					generation: 5,
					repositoryIntegrationId: "int-1",
					ref: "develop",
					paths: ["docs", "notes/team.md"],
					automatic,
				},
				previous: null,
			});

			await call("configure", { ...configureInput, automatic });

			expect(m.upsertContextRepositorySync).toHaveBeenCalledWith(
				expect.objectContaining({ automatic }),
			);
			const audit = m.recordAuditFromRequest.mock.calls[0]?.[1];
			expect(audit).toMatchObject({
				action: "project.context.repository_sync_configured",
				metadata: { automatic },
			});
			// Configure starts nothing, automatic or not: the poll or the
			// client's `syncNow` does.
			expect(m.startContextRepositorySync).not.toHaveBeenCalled();
		},
	);

	it("audits the stored automatic value when the caller leaves it out", async () => {
		m.upsertContextRepositorySync.mockResolvedValue({
			status: "configured",
			sync: {
				id: "sync-1",
				generation: 5,
				repositoryIntegrationId: "int-1",
				ref: "develop",
				paths: ["docs", "notes/team.md"],
				automatic: true,
			},
			previous: null,
		});

		await call("configure", configureInput);

		expect(m.recordAuditFromRequest.mock.calls[0]?.[1]).toMatchObject({
			metadata: { automatic: true },
		});
	});

	it.each(["yes", 1, null])(
		"refuses automatic: %j as input, before anything is read or written",
		async (automatic) => {
			await expect(
				call("configure", { ...configureInput, automatic }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
			NO_WRITES();
		},
	);

	it("refuses turning automatic sync on to a member without CONTEXT_CREATE", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: VIEWER,
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(
			call("configure", { ...configureInput, automatic: true }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Missing required permission: context:create",
		});
		NO_WRITES();
	});

	it("answers turning automatic sync on in a project the caller cannot see NOT_FOUND", async () => {
		// A member of another organization: the project is not visible.
		m.hasProjectAccess.mockResolvedValue(false);

		await expect(
			call("configure", {
				...configureInput,
				automatic: true,
				organizationId: "org-evil",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		NO_WRITES();
	});

	it("audits a first configuration as changing both ref and paths", async () => {
		m.upsertContextRepositorySync.mockResolvedValue({
			status: "configured",
			sync: {
				id: "sync-1",
				generation: 1,
				repositoryIntegrationId: "int-1",
				ref: "develop",
				paths: ["docs"],
				automatic: false,
			},
			previous: null,
		});

		await call("configure", { ...configureInput, paths: ["docs"] });

		expect(m.recordAuditFromRequest.mock.calls[0]?.[1]).toMatchObject({
			metadata: {
				provider: "GITHUB",
				automatic: false,
				pathCount: 1,
				refChanged: true,
				pathsChanged: true,
				generation: 1,
			},
		});
	});

	it("refuses an integration that belongs to another project (tenant boundary) before any credential is read", async () => {
		// Bound to THIS project: another project's integration is not found.
		m.getProjectRepoIntegration.mockResolvedValue(null);

		await expect(
			call("configure", {
				...configureInput,
				repositoryIntegrationId: "int-of-proj-2",
			}),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { code: "REPOSITORY_NOT_FOUND" },
		});
		expect(m.getProjectRepoIntegration).toHaveBeenCalledWith(
			"int-of-proj-2",
			"proj-1",
		);
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
		NO_WRITES();
	});

	it("refuses an integration that is not ACTIVE", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			status: "TOKEN_EXPIRED",
		});

		await expect(call("configure", configureInput)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "REPOSITORY_UNAVAILABLE" },
		});
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
		NO_WRITES();
	});

	it.each([
		["not-found", "BAD_REQUEST", "BRANCH_NOT_FOUND"],
		["unauthorized", "BAD_REQUEST", "REPOSITORY_CREDENTIALS_EXPIRED"],
		["unreachable", "INTERNAL_SERVER_ERROR", "REPOSITORY_UNREACHABLE"],
	])(
		"maps a %s branch check to %s/%s and writes nothing",
		async (outcome, code, dataCode) => {
			m.verifyRepositoryBranch.mockResolvedValue(outcome);

			await expect(
				call("configure", configureInput),
			).rejects.toMatchObject({ code, data: { code: dataCode } });
			NO_WRITES();
		},
	);

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
		"maps %s to %s/%s without checking the branch",
		async (_label, resolved, code, dataCode) => {
			m.resolveFreshRepoTokenForRow.mockResolvedValue(resolved);

			await expect(
				call("configure", configureInput),
			).rejects.toMatchObject({ code, data: { code: dataCode } });
			expect(m.verifyRepositoryBranch).not.toHaveBeenCalled();
			NO_WRITES();
		},
	);

	it("maps an unauthorized branch check made after OUR failed refresh to REPOSITORY_UNREACHABLE, never 'reconnect', without leaking the token", async () => {
		m.resolveFreshRepoTokenForRow.mockResolvedValue({
			token: SECRET_TOKEN,
			refreshFault: "PROVIDER_UNAVAILABLE",
		});
		m.verifyRepositoryBranch.mockResolvedValue("unauthorized");

		const caught = (await call("configure", configureInput).catch(
			(error: unknown) => error,
		)) as { code: string; message: string; data: unknown };

		expect(caught).toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			data: { code: "REPOSITORY_UNREACHABLE" },
		});
		expect(caught.message).not.toContain(SECRET_TOKEN);
		expect(JSON.stringify(caught.data)).not.toContain(SECRET_TOKEN);
		NO_WRITES();
	});

	it.each([
		"refs/heads/main",
		"feature branch",
		"a..b",
		"release/",
		"x.lock",
		"",
	])("refuses the branch name %j before the handler runs", async (ref) => {
		await expect(
			call("configure", { ...configureInput, ref }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
	});

	describe("path rules (§5.1)", () => {
		async function refused(paths: unknown[]) {
			const caught = (await call("configure", {
				...configureInput,
				paths,
			}).catch((error: unknown) => error)) as {
				code: string;
				data?: { code?: string; path?: string };
			};
			// Pure validation: nothing reached the integration or the network.
			expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
			expect(m.verifyRepositoryBranch).not.toHaveBeenCalled();
			NO_WRITES();
			return caught;
		}

		it.each([
			[" docs"],
			["docs "],
			["docs\\guides"],
			["docs/"],
			["./docs"],
			["docs//guides"],
			["/docs"],
			["docs/../secrets"],
			["docs/."],
			["café.md"],
			["docs/​hidden.md"],
		])(
			"refuses the non-canonical path %j as INVALID_PATH",
			async (path) => {
				expect(await refused([path])).toMatchObject({
					code: "BAD_REQUEST",
					data: { code: "INVALID_PATH", path },
				});
			},
		);

		it.each([
			["CLAUDE.md"],
			["docs/AGENTS.md"],
			["notes/gemini.md"],
			["docs/.contextignore"],
			[".fabric"],
			[".fabric/notes.md"],
			[".FABRIC/x.md"],
			["docs/.Fabric/state.json"],
		])(
			"refuses the directly selected coding-instructions file or .fabric path %j as EXCLUDED_PATH",
			async (path) => {
				expect(await refused(["docs", path])).toMatchObject({
					code: "BAD_REQUEST",
					data: { code: "EXCLUDED_PATH", path },
				});
			},
		);

		it("does not refuse a FOLDER the defaults exclude by name: the run applies them inside it", async () => {
			await call("configure", {
				...configureInput,
				paths: ["skills", ".claude", "docs/agents"],
			});

			expect(m.upsertContextRepositorySync).toHaveBeenCalledWith(
				expect.objectContaining({
					paths: [".claude", "docs/agents", "skills"],
				}),
			);
		});

		it.each([
			[["docs", "docs/guides"], "docs/guides"],
			[["docs/guides/a.md", "docs/guides"], "docs/guides/a.md"],
			[["", "docs"], ""],
		])("refuses %j as PATH_PREFIX_OVERLAP", async (paths, path) => {
			expect(await refused(paths)).toMatchObject({
				code: "BAD_REQUEST",
				data: { code: "PATH_PREFIX_OVERLAP", path },
			});
		});

		it("treats a shared name that is not a whole segment as no overlap", async () => {
			await call("configure", {
				...configureInput,
				paths: ["docs-archive", "docs"],
			});

			expect(m.upsertContextRepositorySync).toHaveBeenCalledWith(
				expect.objectContaining({ paths: ["docs", "docs-archive"] }),
			);
		});

		it("accepts the whole repository alone", async () => {
			await call("configure", { ...configureInput, paths: ["", ""] });

			expect(m.upsertContextRepositorySync).toHaveBeenCalledWith(
				expect.objectContaining({ paths: [""] }),
			);
		});

		it("refuses more than 50 distinct paths, counting after duplicates are dropped", async () => {
			const fifty = Array.from({ length: 50 }, (_, i) => `docs/f${i}.md`);

			expect(await refused([...fifty, "docs/f50.md"])).toMatchObject({
				code: "BAD_REQUEST",
				data: { code: "TOO_MANY_PATHS" },
			});

			await call("configure", {
				...configureInput,
				paths: [...fifty, ...fifty],
			});
			expect(
				m.upsertContextRepositorySync.mock.calls[0]?.[0].paths,
			).toHaveLength(50);
		});

		it("refuses an empty selection", async () => {
			await expect(
				call("configure", { ...configureInput, paths: [] }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			NO_WRITES();
		});
	});

	it("maps a repository change refused inside the lock to REPOSITORY_CHANGE_REQUIRES_DISCONNECT with the managed count, and audits nothing", async () => {
		m.upsertContextRepositorySync.mockResolvedValue({
			status: "repository-change-requires-disconnect",
			managedCount: 9,
			currentRepositoryIntegrationId: "int-9",
		});

		await expect(call("configure", configureInput)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: {
				code: "REPOSITORY_CHANGE_REQUIRES_DISCONNECT",
				managedCount: 9,
			},
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("maps the write-time integration check to REPOSITORY_UNAVAILABLE, and audits nothing", async () => {
		m.upsertContextRepositorySync.mockResolvedValue({
			status: "integration-unavailable",
		});

		await expect(call("configure", configureInput)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "REPOSITORY_UNAVAILABLE" },
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});

// =============================================================================
// syncNow
// =============================================================================

describe("repositorySync.syncNow", () => {
	it("starts a MANUAL run as the caller and audits the start", async () => {
		expect(await call("syncNow", inputs.syncNow)).toEqual({
			started: true,
		});

		expect(m.startContextRepositorySync).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			trigger: "MANUAL",
			requesterUserId: "user-1",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.objectContaining({ user: ctx.user }),
			{
				action: "project.context.repository_sync_started",
				category: "project",
				organizationId: "org-host",
				projectId: "proj-1",
				resource: {
					type: "project_context_repository_sync",
					id: "sync-1",
					name: "example-org/memory",
				},
				metadata: { trigger: "MANUAL" },
			},
		);
	});

	it("answers not_configured without starting", async () => {
		m.getContextRepositorySync.mockResolvedValue(null);

		expect(await call("syncNow", inputs.syncNow)).toEqual({
			started: false,
			reason: "not_configured",
		});
		NO_WRITES();
	});

	it("answers integration_unavailable without reconciling or starting", async () => {
		m.getContextRepositorySync.mockResolvedValue({
			...syncRow,
			repositoryIntegration: {
				...syncRow.repositoryIntegration,
				status: "TOKEN_EXPIRED",
			},
		});

		expect(await call("syncNow", inputs.syncNow)).toEqual({
			started: false,
			reason: "integration_unavailable",
		});
		expect(
			m.listUnfinishedContextRepositorySyncRuns,
		).not.toHaveBeenCalled();
		NO_WRITES();
	});

	it("answers already_running when Temporal refuses the duplicate id (conflict policy FAIL), and audits nothing", async () => {
		m.startContextRepositorySync.mockResolvedValue(false);

		expect(await call("syncNow", inputs.syncNow)).toEqual({
			started: false,
			reason: "already_running",
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("takes no lock when nothing is unfinished and nothing holds the configuration", async () => {
		await call("syncNow", inputs.syncNow);

		expect(m.listUnfinishedContextRepositorySyncRuns).toHaveBeenCalledWith(
			"sync-1",
		);
		expect(m.describeContextSyncExecutions).not.toHaveBeenCalled();
		expect(
			m.completeInterruptedContextRepositorySyncRuns,
		).not.toHaveBeenCalled();
	});

	describe("reconciliation (§5.6)", () => {
		beforeEach(() => {
			m.getContextRepositorySync.mockResolvedValue({
				...syncRow,
				activeRunKey: RUN,
			});
			m.listUnfinishedContextRepositorySyncRuns.mockResolvedValue([
				{ id: RUN },
			]);
		});

		it("completes a predecessor Temporal reports closed — describes first, outside the lock — then starts", async () => {
			m.describeContextSyncExecutions.mockResolvedValue(
				new Map([[RUN, "closed"]]),
			);
			m.completeInterruptedContextRepositorySyncRuns.mockResolvedValue({
				status: "ok",
				completed: [RUN],
				activeRunKey: null,
			});

			expect(await call("syncNow", inputs.syncNow)).toEqual({
				started: true,
			});
			expect(m.describeContextSyncExecutions).toHaveBeenCalledWith({
				projectId: "proj-1",
				syncId: "sync-1",
				runKeys: [RUN],
			});
			expect(
				m.completeInterruptedContextRepositorySyncRuns,
			).toHaveBeenCalledWith({
				syncId: "sync-1",
				projectId: "proj-1",
				organizationId: "org-host",
				observedUnfinished: [RUN],
				closed: [RUN],
			});
			const [describeOrder] =
				m.describeContextSyncExecutions.mock.invocationCallOrder;
			const [lockOrder] =
				m.completeInterruptedContextRepositorySyncRuns.mock
					.invocationCallOrder;
			const [startOrder] =
				m.startContextRepositorySync.mock.invocationCallOrder;
			expect(describeOrder).toBeLessThan(lockOrder as number);
			expect(lockOrder).toBeLessThan(startOrder as number);
		});

		it("completes a predecessor Temporal no longer knows (not found) the same way", async () => {
			m.describeContextSyncExecutions.mockResolvedValue(
				new Map([[RUN, "not-found"]]),
			);

			await call("syncNow", inputs.syncNow);

			expect(
				m.completeInterruptedContextRepositorySyncRuns,
			).toHaveBeenCalledWith(expect.objectContaining({ closed: [RUN] }));
			expect(m.startContextRepositorySync).toHaveBeenCalled();
		});

		it.each(["running", "unknown"])(
			"refuses with already_running when a predecessor is %s, completing nothing and starting nothing",
			async (state) => {
				m.describeContextSyncExecutions.mockResolvedValue(
					new Map([[RUN, state]]),
				);
				m.completeInterruptedContextRepositorySyncRuns.mockResolvedValue(
					{
						status: "ok",
						completed: [],
						activeRunKey: RUN,
					},
				);

				expect(await call("syncNow", inputs.syncNow)).toEqual({
					started: false,
					reason: "already_running",
				});
				expect(
					m.completeInterruptedContextRepositorySyncRuns,
				).toHaveBeenCalledWith(expect.objectContaining({ closed: [] }));
				expect(m.startContextRepositorySync).not.toHaveBeenCalled();
				expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
			},
		);

		it("refuses while an unknown predecessor blocks even when another one was completed", async () => {
			const other = "sync-1:run-b";
			m.listUnfinishedContextRepositorySyncRuns.mockResolvedValue([
				{ id: RUN },
				{ id: other },
			]);
			m.describeContextSyncExecutions.mockResolvedValue(
				new Map([
					[RUN, "closed"],
					[other, "unknown"],
				]),
			);
			m.completeInterruptedContextRepositorySyncRuns.mockResolvedValue({
				status: "ok",
				completed: [RUN],
				activeRunKey: null,
			});

			expect(await call("syncNow", inputs.syncNow)).toEqual({
				started: false,
				reason: "already_running",
			});
			expect(m.startContextRepositorySync).not.toHaveBeenCalled();
		});

		it("reads and describes again when the state moved between the read and the lock, then starts", async () => {
			m.describeContextSyncExecutions.mockResolvedValue(
				new Map([[RUN, "closed"]]),
			);
			m.completeInterruptedContextRepositorySyncRuns
				.mockResolvedValueOnce({ status: "changed" })
				.mockResolvedValueOnce({
					status: "ok",
					completed: [RUN],
					activeRunKey: null,
				});

			expect(await call("syncNow", inputs.syncNow)).toEqual({
				started: true,
			});
			expect(
				m.listUnfinishedContextRepositorySyncRuns,
			).toHaveBeenCalledTimes(2);
			expect(m.describeContextSyncExecutions).toHaveBeenCalledTimes(2);
			expect(
				m.completeInterruptedContextRepositorySyncRuns,
			).toHaveBeenCalledTimes(2);
		});

		it("gives up on the safe side after three moved passes", async () => {
			m.describeContextSyncExecutions.mockResolvedValue(
				new Map([[RUN, "closed"]]),
			);
			m.completeInterruptedContextRepositorySyncRuns.mockResolvedValue({
				status: "changed",
			});

			expect(await call("syncNow", inputs.syncNow)).toEqual({
				started: false,
				reason: "already_running",
			});
			expect(
				m.completeInterruptedContextRepositorySyncRuns,
			).toHaveBeenCalledTimes(3);
			expect(m.startContextRepositorySync).not.toHaveBeenCalled();
		});

		it("answers not_configured when the configuration disappeared under reconciliation", async () => {
			m.describeContextSyncExecutions.mockResolvedValue(
				new Map([[RUN, "closed"]]),
			);
			m.completeInterruptedContextRepositorySyncRuns.mockResolvedValue({
				status: "not-configured",
			});

			expect(await call("syncNow", inputs.syncNow)).toEqual({
				started: false,
				reason: "not_configured",
			});
			expect(m.startContextRepositorySync).not.toHaveBeenCalled();
		});

		it("locks to release a key held with no unfinished receipt", async () => {
			m.listUnfinishedContextRepositorySyncRuns.mockResolvedValue([]);

			expect(await call("syncNow", inputs.syncNow)).toEqual({
				started: true,
			});
			expect(
				m.completeInterruptedContextRepositorySyncRuns,
			).toHaveBeenCalledWith(
				expect.objectContaining({ observedUnfinished: [], closed: [] }),
			);
		});
	});
});

// =============================================================================
// disable
// =============================================================================

describe("repositorySync.disable", () => {
	it("deletes the configuration even while a run holds it, audits the released count, and answers it", async () => {
		m.getContextRepositorySync.mockResolvedValue({
			...syncRow,
			activeRunKey: RUN,
		});
		m.isContextRepositorySyncRunning.mockResolvedValue(true);

		expect(await call("disable", inputs.disable)).toEqual({
			disabled: true,
			managedCount: 7,
		});
		expect(m.deleteContextRepositorySync).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.objectContaining({ user: ctx.user }),
			{
				action: "project.context.repository_sync_disabled",
				category: "project",
				organizationId: "org-host",
				projectId: "proj-1",
				resource: {
					type: "project_context_repository_sync",
					id: "sync-1",
					name: null,
				},
				metadata: { reason: "user", managedCount: 7 },
			},
		);
	});

	it("answers disabled: false and audits nothing when there was no configuration", async () => {
		m.deleteContextRepositorySync.mockResolvedValue({
			deleted: false,
			syncId: null,
			managedCount: 0,
			repositoryIntegrationId: null,
			activeRunKey: null,
		});

		expect(await call("disable", inputs.disable)).toEqual({
			disabled: false,
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});
