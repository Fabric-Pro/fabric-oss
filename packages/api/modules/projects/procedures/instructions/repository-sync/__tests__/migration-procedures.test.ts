/**
 * `repositorySync.migrate`, `getMigration`, `cancelMigration` and
 * `retryMigration` — the move of an upload-backed project's published tree
 * into a repository (Fizzy #2878 §9).
 *
 * Each call runs the procedure's REAL middleware chain (visibility, then the
 * real `requireProjectPermission`, and the handler's real
 * `assertProjectPermission`) before the handler. The database, the credential
 * resolver, the connectors, the admission and the branch workflow are mocked;
 * what is pinned is the order of the steps, what each refusal writes (nothing),
 * and what a failed start closes out. Every identifier is synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	resolveFreshRepoTokenForRow: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	startInstructionMigration: vi.fn(),
	attachInstructionMigrationProposal: vi.fn(),
	abandonInstructionMigration: vi.fn(),
	completeInstructionMigration: vi.fn(),
	createDerivedInstructionSnapshot: vi.fn(),
	joinProposalBranch: vi.fn(),
	rejectAbandonedInstructionSnapshot: vi.fn(),
	getInstructionRepositorySync: vi.fn(),
	getMemberProposalBranch: vi.fn(),
	closeProposalBranch: vi.fn(),
	requestProposalBranchRetry: vi.fn(),
	expediteMigrationBranch: vi.fn(),
	proposalBranchIdOf: vi.fn(),
	verifyRepositoryBranch: vi.fn(),
	listRepositoryCommits: vi.fn(),
	listRepositoryTree: vi.fn(),
	admit: vi.fn(),
	finalize: vi.fn(),
	wake: vi.fn(),
	readProposalPullRequest: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	order: [] as string[],
}));

vi.mock("@repo/database", async () => ({
	// The real reading of a pull request's observation, from its own module:
	// the retry and the settlement hook must decide a merge into the wrong
	// branch by the same rule.
	mergedElsewhere: (
		await vi.importActual<
			typeof import("../../../../../../../database/prisma/queries/instruction-migration-pointer")
		>(
			"../../../../../../../database/prisma/queries/instruction-migration-pointer",
		)
	).mergedElsewhere,
	db: {},
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(),
	hasProjectAccess: m.hasProjectAccess,
	grantProjectAccess: vi.fn(),
	getProjectRepoIntegration: m.getProjectRepoIntegration,
	getProjectInstructionSettings: m.getProjectInstructionSettings,
	getPublishedInstructionSnapshot: m.getPublishedInstructionSnapshot,
	listInstructionFiles: m.listInstructionFiles,
	startInstructionMigration: m.startInstructionMigration,
	attachInstructionMigrationProposal: m.attachInstructionMigrationProposal,
	abandonInstructionMigration: m.abandonInstructionMigration,
	completeInstructionMigration: m.completeInstructionMigration,
	createDerivedInstructionSnapshot: m.createDerivedInstructionSnapshot,
	joinProposalBranch: m.joinProposalBranch,
	rejectAbandonedInstructionSnapshot: m.rejectAbandonedInstructionSnapshot,
	getInstructionRepositorySync: m.getInstructionRepositorySync,
	getMemberProposalBranch: m.getMemberProposalBranch,
	closeProposalBranch: m.closeProposalBranch,
	requestProposalBranchRetry: m.requestProposalBranchRetry,
	expediteMigrationBranch: m.expediteMigrationBranch,
	proposalBranchIdOf: m.proposalBranchIdOf,
}));
vi.mock("@repo/connectors", () => ({
	verifyRepositoryBranch: m.verifyRepositoryBranch,
	listRepositoryCommits: m.listRepositoryCommits,
	listRepositoryTree: m.listRepositoryTree,
	isRepositoryTreeProvider: (provider: string) => provider !== "GITLAB",
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: m.resolveFreshRepoTokenForRow,
}));
vi.mock("../../../../../../lib/audit", () => ({
	recordAuditFromRequest: m.recordAuditFromRequest,
	auditRequestFields: () => ({ ipAddress: null, userAgent: null }),
	resolveActor: () => ({ type: "user", userId: "user-1" }),
}));
vi.mock("../../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.resolveEffectiveProjectPermissions,
}));
vi.mock("../../proposal-admission", () => ({
	admitInstructionProposal: m.admit,
	repositoryDestination: (admission: unknown, template: unknown) => ({
		kind: "REPOSITORY",
		admission,
		template,
	}),
	uploadStartedAuditTemplate: (_context: unknown, i: unknown) => i,
	commitTextRefused: (code: string) => {
		throw Object.assign(new Error(code), { code: "UNPROCESSABLE_CONTENT" });
	},
}));
vi.mock("../../finalize", () => ({
	finalizeInstructionSnapshot: m.finalize,
}));
vi.mock("../../proposal-branch", () => ({
	proposalBranchNaming: { memberBranchRef: () => "ref" },
	wakeProposalBranchWorkflow: m.wake,
}));
vi.mock("../../proposal-pull-request", () => ({
	readProposalPullRequest: m.readProposalPullRequest,
}));
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

import { folderIsNotEmpty, migrateRepositorySyncProcedure } from "../migrate";
import {
	cancelRepositoryMigrationProcedure,
	getRepositoryMigrationProcedure,
	retryRepositoryMigrationProcedure,
} from "../migration";

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

const ctx: Ctx = {
	user: { id: "user-1", name: "Example Member", email: "dev@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-session" },
};

async function call(
	procedure: unknown,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const built = procedure as Built;
	const parsed = built.inputSchema.safeParse(input);
	if (!parsed.success) {
		throw Object.assign(new Error("input validation failed"), {
			code: "BAD_REQUEST",
		});
	}
	const run = async (
		index: number,
		context: Ctx,
	): Promise<{ output: unknown; context: object }> => {
		const middleware = built.middlewares[index];
		if (!middleware) {
			return {
				output: await built.handler({ input: parsed.data, context }),
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

const SELECTION = {
	projectId: "proj-1",
	repositoryIntegrationId: "int-1",
	ref: "main",
	rootPath: ".claude",
};
const callMigrate = (over: Record<string, unknown> = {}) =>
	call(migrateRepositorySyncProcedure, { ...SELECTION, ...over });
const callGet = () =>
	call(getRepositoryMigrationProcedure, { projectId: "proj-1" });
const callCancel = () =>
	call(cancelRepositoryMigrationProcedure, { projectId: "proj-1" });
const callRetry = () =>
	call(retryRepositoryMigrationProcedure, { projectId: "proj-1" });

const ADMIN = ["instruction:read", "instruction:create", "instruction:update"];
const TIP = "a".repeat(40);
const SECRET_TOKEN = "ghs_example_migration_secret";

const integration = {
	id: "int-1",
	projectId: "proj-1",
	provider: "GITHUB",
	authMethod: "OAUTH",
	repositoryUrl: "https://github.com/example-org/instructions",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	defaultBranch: "main",
	status: "ACTIVE",
	azureOrganization: null,
	encryptedAccessToken: "enc-access",
	encryptedRefreshToken: "enc-refresh",
	encryptedPat: null,
	tokenExpiresAt: null,
	updatedAt: new Date("2026-10-01T00:00:00.000Z"),
};

const POINTER = {
	v: 1,
	state: "PROPOSING",
	branchId: "branch-1",
	snapshotId: "snap-move",
	syncId: "sync-move",
	pullRequestUrl: null,
	startedAt: "2026-10-03T10:00:00.000Z",
	userId: "user-1",
} as const;

function branch(over: Record<string, unknown> = {}) {
	return {
		id: "branch-1",
		state: "OPEN",
		attempt: 3,
		failure: null,
		pullRequestUrl: "https://github.com/example-org/instructions/pull/7",
		pullRequestExternalId: "7",
		...over,
	};
}

function proposalView(over: Record<string, unknown> = {}) {
	return {
		operationId: "op-1",
		state: "OPEN",
		url: "https://github.com/example-org/instructions/pull/7",
		externalId: "7",
		failure: null,
		lastCheckedAt: null,
		branch: null,
		append: null,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.order.length = 0;
	m.hasProjectAccess.mockResolvedValue(true);
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ADMIN,
		source: "project-member",
		organizationId: "org-host",
	});
	m.getProjectInstructionSettings.mockResolvedValue({
		sourceOfTruth: "UPLOAD",
		ignoreGlobs: null,
		migration: null,
	});
	m.getPublishedInstructionSnapshot.mockResolvedValue({
		id: "snap-published",
		version: 7,
		organizationId: "org-host",
		status: "READY",
	});
	m.listInstructionFiles.mockResolvedValue([
		{ path: "CLAUDE.md" },
		{ path: "rules/a.md" },
	]);
	m.getProjectRepoIntegration.mockResolvedValue(integration);
	m.resolveFreshRepoTokenForRow.mockResolvedValue({ token: SECRET_TOKEN });
	m.verifyRepositoryBranch.mockResolvedValue("exists");
	m.listRepositoryCommits.mockResolvedValue({
		ok: true,
		hasMore: false,
		commits: [{ sha: TIP }],
	});
	m.listRepositoryTree.mockResolvedValue({
		ok: true,
		truncated: false,
		entries: [
			{ path: "src", type: "dir" },
			{ path: "src/index.ts", type: "file" },
		],
	});
	m.startInstructionMigration.mockImplementation(async () => {
		m.order.push("start");
		return {
			ok: true,
			sync: { id: "sync-move", generation: 1 },
			pointer: POINTER,
			publishedSnapshotId: "snap-published",
		};
	});
	m.admit.mockResolvedValue({
		destination: "REPOSITORY",
		note: { title: "Move coding instructions into the repository" },
		operationId: "op-1",
		syncId: "sync-move",
		syncGeneration: 1,
		context: { v: 2 },
	});
	m.createDerivedInstructionSnapshot.mockImplementation(async () => {
		m.order.push("create");
		return {
			ok: true,
			id: "snap-move",
			version: 8,
			fileCount: 2,
			inheritedCount: 2,
			staged: [],
		};
	});
	m.attachInstructionMigrationProposal.mockResolvedValue(true);
	m.joinProposalBranch.mockImplementation(async () => {
		m.order.push("join");
		return { kind: "joined", branchId: "branch-1" };
	});
	m.finalize.mockImplementation(async () => {
		m.order.push("finalize");
		return { status: "VALIDATING" };
	});
	m.wake.mockImplementation(async () => {
		m.order.push("wake");
	});
	m.abandonInstructionMigration.mockResolvedValue("abandoned");
	m.rejectAbandonedInstructionSnapshot.mockResolvedValue({ changed: true });
	m.getInstructionRepositorySync.mockResolvedValue({
		id: "sync-move",
		ref: "main",
		rootPath: ".claude",
		repositoryIntegration: {
			provider: "GITHUB",
			repositoryOwner: "example-org",
			repositoryName: "instructions",
		},
	});
	m.proposalBranchIdOf.mockResolvedValue("branch-1");
	m.getMemberProposalBranch.mockResolvedValue(branch());
	m.readProposalPullRequest.mockResolvedValue(proposalView());
	m.closeProposalBranch.mockResolvedValue({
		kind: "done",
		changed: true,
		attempt: 4,
	});
	m.requestProposalBranchRetry.mockResolvedValue({
		kind: "done",
		changed: true,
		attempt: 4,
	});
	m.expediteMigrationBranch.mockResolvedValue(true);
	m.completeInstructionMigration.mockResolvedValue("completed");
});

describe("folderIsNotEmpty", () => {
	const published = ["CLAUDE.md", "rules/a.md"];

	it("refuses a named folder that holds any file on the branch", () => {
		expect(
			folderIsNotEmpty({
				rootPath: ".claude",
				tipFiles: ["README.md", ".claude/notes.txt"],
				publishedPaths: published,
			}),
		).toBe(true);
	});

	it("accepts a named folder that holds nothing, whatever else the repository has", () => {
		expect(
			folderIsNotEmpty({
				rootPath: ".claude",
				tipFiles: ["README.md", ".claudeish/file.md", "src/a.ts"],
				publishedPaths: published,
			}),
		).toBe(false);
	});

	it("does not mistake a sibling whose name starts like the folder for its content", () => {
		expect(
			folderIsNotEmpty({
				rootPath: "docs/ai",
				tipFiles: ["docs/ai-notes.md", "docs/air/x.md"],
				publishedPaths: published,
			}),
		).toBe(false);
	});

	it("at the repository root refuses only a path the move would meet, on folded collision keys", () => {
		expect(
			folderIsNotEmpty({
				rootPath: "",
				tipFiles: ["README.md", "src/a.ts"],
				publishedPaths: published,
			}),
		).toBe(false);
		expect(
			folderIsNotEmpty({
				rootPath: "",
				tipFiles: ["claude.md"],
				publishedPaths: published,
			}),
		).toBe(true);
	});

	it("at the root refuses a file where the move needs a folder, and a folder where it needs a file", () => {
		expect(
			folderIsNotEmpty({
				rootPath: "",
				tipFiles: ["rules"],
				publishedPaths: published,
			}),
		).toBe(true);
		expect(
			folderIsNotEmpty({
				rootPath: "",
				tipFiles: ["CLAUDE.md/inside.md"],
				publishedPaths: published,
			}),
		).toBe(true);
	});
});

describe("migrate: who may ask", () => {
	it("answers a project the caller cannot discover NOT_FOUND before anything is read", async () => {
		m.hasProjectAccess.mockResolvedValue(false);

		await expect(callMigrate()).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		expect(m.getProjectInstructionSettings).not.toHaveBeenCalled();
		expect(m.startInstructionMigration).not.toHaveBeenCalled();
	});

	it("refuses a viewer", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:read"],
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(callMigrate()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
		expect(m.startInstructionMigration).not.toHaveBeenCalled();
	});

	it("refuses a member who can create but not update: the move publishes a version's worth of files", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:read", "instruction:create"],
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(callMigrate()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		expect(m.getProjectInstructionSettings).not.toHaveBeenCalled();
		expect(m.startInstructionMigration).not.toHaveBeenCalled();
	});

	it("refuses an organization id in the input other than the host's, writing nothing", async () => {
		// Fizzy #2904 review: refused by `requireProjectPermission` before the
		// handler body runs, rather than ignored by the handler.
		await expect(
			callMigrate({ organizationId: "org-attacker" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.startInstructionMigration).not.toHaveBeenCalled();
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("acts in the project's host when no organization is named, never the session's", async () => {
		await callMigrate();

		expect(m.startInstructionMigration).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				organizationId: "org-host",
			}),
		);
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-host" }),
		);
	});

	it("binds the integration to this project before reading a credential", async () => {
		m.getProjectRepoIntegration.mockResolvedValue(null);

		await expect(callMigrate()).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		expect(m.getProjectRepoIntegration).toHaveBeenCalledWith(
			"int-1",
			"proj-1",
		);
		expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
		expect(m.startInstructionMigration).not.toHaveBeenCalled();
	});
});

describe("migrate: what it refuses, writing nothing", () => {
	const nothingWritten = () => {
		expect(m.startInstructionMigration).not.toHaveBeenCalled();
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.abandonInstructionMigration).not.toHaveBeenCalled();
	};

	it("is only for an upload-backed project", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "REPOSITORY",
			ignoreGlobs: null,
			migration: null,
		});

		await expect(callMigrate()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "NOT_UPLOAD_SOURCED" },
		});
		nothingWritten();
	});

	it("refuses while a move is open, naming its state and pull request", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: POINTER,
		});

		await expect(callMigrate()).rejects.toMatchObject({
			code: "CONFLICT",
			data: {
				reason: "MIGRATION_OPEN",
				state: "PROPOSING",
				pullRequest: {
					url: "https://github.com/example-org/instructions/pull/7",
					externalId: "7",
				},
			},
		});
		nothingWritten();
	});

	it.each([
		["no published version", null],
		[
			"a published version of another organization",
			{
				id: "s",
				version: 1,
				organizationId: "org-other",
				status: "READY",
			},
		],
		[
			"a published version that is not ready",
			{
				id: "s",
				version: 1,
				organizationId: "org-host",
				status: "FAILED",
			},
		],
	])("refuses a project with %s", async (_label, published) => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(published);

		await expect(callMigrate()).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { reason: "NOTHING_PUBLISHED" },
		});
		nothingWritten();
	});

	it("refuses a published version with no files", async () => {
		m.listInstructionFiles.mockResolvedValue([]);

		await expect(callMigrate()).rejects.toMatchObject({
			data: { reason: "NOTHING_PUBLISHED" },
		});
		nothingWritten();
	});

	it("refuses a folder that is not a folder inside the repository", async () => {
		await expect(
			callMigrate({ rootPath: "../outside" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "INVALID_ROOT_PATH" },
		});
		nothingWritten();
	});

	it("answers a branch that does not exist as the configure dialog does", async () => {
		m.verifyRepositoryBranch.mockResolvedValue("not-found");

		await expect(callMigrate()).rejects.toMatchObject({
			data: { code: "BRANCH_NOT_FOUND" },
		});
		nothingWritten();
	});

	it("answers a folder that already holds files FOLDER_NOT_EMPTY, 409", async () => {
		m.listRepositoryTree.mockResolvedValue({
			ok: true,
			truncated: false,
			entries: [
				{ path: ".claude", type: "dir" },
				{ path: ".claude/settings.json", type: "file" },
			],
		});

		await expect(callMigrate()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "FOLDER_NOT_EMPTY" },
		});
		nothingWritten();
	});

	it("goes on when the provider has no listing: the branch machinery's per-path rule still refuses an overwrite", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			provider: "GITLAB",
			authMethod: "OAUTH",
		});

		await expect(callMigrate()).resolves.toMatchObject({
			state: "PROPOSING",
		});
		expect(m.listRepositoryTree).not.toHaveBeenCalled();
	});

	it("goes on when the listing says it is unsupported", async () => {
		m.listRepositoryTree.mockResolvedValue({
			ok: false,
			outcome: "unsupported",
		});

		await expect(callMigrate()).resolves.toMatchObject({
			state: "PROPOSING",
		});
	});

	it.each([
		["migration_open", "MIGRATION_OPEN"],
		["sync_exists", "SYNC_CONFIGURED"],
	])("answers the start's own refusal %s as %s", async (reason, code) => {
		m.startInstructionMigration.mockResolvedValue({ ok: false, reason });

		await expect(callMigrate()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: code },
		});
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.abandonInstructionMigration).not.toHaveBeenCalled();
	});
});

describe("migrate: the move", () => {
	it("opens the move, carries the published tree whole, starts the branch and answers with the contract", async () => {
		const answer = await callMigrate();

		expect(answer).toEqual({
			state: "PROPOSING",
			branchId: "branch-1",
			snapshotId: "snap-move",
		});
		expect(m.startInstructionMigration).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			userId: "user-1",
			repositoryIntegrationId: "int-1",
			ref: "main",
			rootPath: ".claude",
		});
		expect(m.admit).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				organizationId: "org-host",
				userId: "user-1",
				mode: "migration",
				baseCommitSha: TIP,
				fileCount: 2,
				proposerName: "Example Member",
			}),
		);
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				baseSnapshotId: "snap-published",
				proposal: true,
				publishOnReady: false,
				migration: true,
				changes: [],
			}),
		);
		expect(m.order).toEqual([
			"start",
			"create",
			"join",
			"wake",
			"finalize",
		]);
		expect(m.attachInstructionMigrationProposal).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			syncId: "sync-move",
			snapshotId: "snap-move",
		});
		expect(m.attachInstructionMigrationProposal).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			syncId: "sync-move",
			branchId: "branch-1",
		});
	});

	it("reads the tip from the branch's whole history, not the folder's", async () => {
		await callMigrate();

		expect(m.listRepositoryCommits).toHaveBeenCalledWith(
			expect.objectContaining({
				branch: "main",
				path: "",
				page: 1,
				token: SECRET_TOKEN,
			}),
		);
	});

	it("audits the start with counts and ids only, in keys the writer does not redact", async () => {
		await callMigrate();

		const [, audit] = m.recordAuditFromRequest.mock.calls[0] as [
			unknown,
			{ action: string; metadata: Record<string, unknown> },
		];
		expect(audit.action).toBe(
			"project.instructions.repository_migration_started",
		);
		expect(audit.metadata).toEqual({
			provider: "GITHUB",
			ref: "main",
			folder: ".claude",
			fileCount: 2,
			snapshotId: "snap-move",
			branchId: "branch-1",
		});
		expect(JSON.stringify(audit)).not.toContain(SECRET_TOKEN);
	});

	it("answers branchId null when the join left the proposal for the sweeper, and still finalizes it", async () => {
		m.joinProposalBranch.mockResolvedValue({ kind: "not_joinable" });

		const answer = await callMigrate();

		expect(answer).toMatchObject({ state: "PROPOSING", branchId: null });
		expect(m.finalize).toHaveBeenCalledTimes(1);
		expect(m.wake).not.toHaveBeenCalled();
	});

	describe("a failure after the move opened closes it out, so the project is never left frozen", () => {
		it("when admission refuses: the move ends as a start that failed, with no proposal to reject", async () => {
			m.admit.mockRejectedValue(new Error("admission refused"));

			await expect(callMigrate()).rejects.toThrow("admission refused");

			expect(m.abandonInstructionMigration).toHaveBeenCalledWith({
				projectId: "proj-1",
				organizationId: "org-host",
				syncId: "sync-move",
				reason: "start_failed",
			});
			expect(m.rejectAbandonedInstructionSnapshot).not.toHaveBeenCalled();
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		});

		it("when the author's name cannot be used: refused as the commit message is, and closed out", async () => {
			m.admit.mockResolvedValue({
				destination: "REPOSITORY",
				note: {},
				operationId: "op-1",
				syncId: "sync-move",
				syncGeneration: 1,
				context: { v: 2 },
				blocked: { code: "ATTRIBUTION_REJECTED" },
			});

			await expect(callMigrate()).rejects.toMatchObject({
				code: "UNPROCESSABLE_CONTENT",
			});

			expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
			expect(m.abandonInstructionMigration).toHaveBeenCalledWith(
				expect.objectContaining({ reason: "start_failed" }),
			);
		});

		it("when the proposal cannot be created: the database's refusal, and closed out", async () => {
			m.createDerivedInstructionSnapshot.mockResolvedValue({
				ok: false,
				reason: "proposal_proposer_limit",
			});

			await expect(callMigrate()).rejects.toMatchObject({
				data: { reason: "PROPOSAL_PROPOSER_LIMIT" },
			});

			expect(m.abandonInstructionMigration).toHaveBeenCalledWith(
				expect.objectContaining({ reason: "start_failed" }),
			);
		});

		it("when validation cannot be started: the proposal is rejected, then the move ends", async () => {
			m.finalize.mockRejectedValue(new Error("temporal is down"));

			await expect(callMigrate()).rejects.toThrow("temporal is down");

			expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					snapshotId: "snap-move",
					projectId: "proj-1",
					organizationId: "org-host",
				}),
			);
			expect(m.abandonInstructionMigration).toHaveBeenCalledWith(
				expect.objectContaining({
					syncId: "sync-move",
					reason: "start_failed",
				}),
			);
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		});

		it("when the move was canceled while the proposal was being prepared: refused, closed out", async () => {
			m.attachInstructionMigrationProposal.mockResolvedValue(false);

			await expect(callMigrate()).rejects.toMatchObject({
				data: { reason: "MIGRATION_CANCELED" },
			});

			expect(m.joinProposalBranch).not.toHaveBeenCalled();
			expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalled();
		});
	});
});

describe("getMigration", () => {
	it("answers null when no move is open", async () => {
		await expect(callGet()).resolves.toEqual({
			migration: null,
			repository: null,
		});
	});

	it("lets a read-only member see where the move stands", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:read"],
			source: "project-member",
			organizationId: "org-host",
		});
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: POINTER,
		});

		const answer = await callGet();

		expect(answer).toEqual({
			migration: {
				state: "OPEN",
				closing: false,
				startedAt: POINTER.startedAt,
				startedByUserId: "user-1",
				snapshotId: "snap-move",
				branchId: "branch-1",
				syncId: "sync-move",
				pullRequest: {
					url: "https://github.com/example-org/instructions/pull/7",
					externalId: "7",
					state: "OPEN",
				},
				targetMismatch: false,
				failure: null,
			},
			repository: {
				provider: "GITHUB",
				owner: "example-org",
				name: "instructions",
				ref: "main",
				folder: ".claude",
			},
		});
	});

	it("reads the branch the proposal is on now, not the one the pointer started on", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: POINTER,
		});
		m.proposalBranchIdOf.mockResolvedValue("branch-2");

		const answer = (await callGet()) as {
			migration: { branchId: string };
		};

		expect(answer.migration.branchId).toBe("branch-2");
	});

	it("reads a move whose project was flipped to the repository behind it as BLOCKED, SOURCE_FLIPPED, and no retry helps", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "REPOSITORY",
			ignoreGlobs: null,
			migration: POINTER,
		});

		const answer = (await callGet()) as {
			migration: {
				state: string;
				failure: { code: string; retryable: boolean };
			};
		};

		expect(answer.migration.state).toBe("BLOCKED");
		expect(answer.migration.failure).toEqual({
			code: "SOURCE_FLIPPED",
			retryable: false,
		});
	});

	it("reads a pull request that merged into another branch than the sync reads as ABANDONED, and says why", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: POINTER,
		});
		m.readProposalPullRequest.mockResolvedValue(
			proposalView({ state: "MERGED" }),
		);
		m.getMemberProposalBranch.mockResolvedValue(
			branch({
				state: "MERGED",
				pullRequestObservation: {
					targetRef: "release",
					targetMismatch: true,
				},
			}),
		);

		const answer = (await callGet()) as {
			migration: {
				state: string;
				targetMismatch: boolean;
				pullRequest: { state: string };
			};
		};

		expect(answer.migration).toMatchObject({
			state: "ABANDONED",
			targetMismatch: true,
			pullRequest: { state: "MERGED" },
		});
	});

	it("is switching once the project has switched, with the merged pull request", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "REPOSITORY",
			ignoreGlobs: null,
			migration: {
				...POINTER,
				state: "SWITCHING",
				pullRequestUrl: "https://example.com/pull/7",
			},
		});
		m.readProposalPullRequest.mockResolvedValue(
			proposalView({ state: "MERGED" }),
		);

		const answer = (await callGet()) as {
			migration: { state: string; pullRequest: { state: string } };
		};

		expect(answer.migration.state).toBe("SWITCHING");
		expect(answer.migration.pullRequest.state).toBe("MERGED");
	});
});

describe("cancelMigration", () => {
	beforeEach(() => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: POINTER,
		});
	});

	it("is for a member who can create AND update", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:read", "instruction:create"],
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(callCancel()).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(m.closeProposalBranch).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when no move is open", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: null,
		});

		await expect(callCancel()).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { reason: "MIGRATION_NOT_OPEN" },
		});
	});

	it("closes the pull request through the branch's own close command, at the attempt it read, and wakes the branch", async () => {
		const answer = await callCancel();

		expect(answer).toEqual({ state: "CANCELING" });
		expect(m.closeProposalBranch).toHaveBeenCalledWith(
			expect.objectContaining({
				branchId: "branch-1",
				projectId: "proj-1",
				organizationId: "org-host",
				expectedAttempt: 3,
			}),
		);
		expect(m.wake).toHaveBeenCalledWith(
			expect.objectContaining({ branchId: "branch-1" }),
		);
		expect(
			m.abandonInstructionMigration,
			"the move ends when the branch settles, not before",
		).not.toHaveBeenCalled();
	});

	it("answers a stale branch as a conflict the client refreshes from", async () => {
		m.closeProposalBranch.mockResolvedValue({ kind: "stale" });

		await expect(callCancel()).rejects.toMatchObject({
			data: { reason: "MIGRATION_CHANGED" },
		});
	});

	it.each(["MERGED", "SWITCHING"])(
		"cannot cancel a move that is %s: the files are in the repository",
		async (state) => {
			if (state === "SWITCHING") {
				m.getProjectInstructionSettings.mockResolvedValue({
					sourceOfTruth: "REPOSITORY",
					ignoreGlobs: null,
					migration: { ...POINTER, state: "SWITCHING" },
				});
			} else {
				m.readProposalPullRequest.mockResolvedValue(
					proposalView({ state: "MERGED" }),
				);
			}

			await expect(callCancel()).rejects.toMatchObject({
				code: "CONFLICT",
				data: { reason: "MIGRATION_MERGED" },
			});
			expect(m.closeProposalBranch).not.toHaveBeenCalled();
		},
	);

	it("ends a move whose pull request already ended, here and now: the lost settlement step is repeated", async () => {
		m.readProposalPullRequest.mockResolvedValue(
			proposalView({ state: "CLOSED" }),
		);

		const answer = await callCancel();

		expect(answer).toEqual({ state: "ABANDONED" });
		expect(m.abandonInstructionMigration).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			syncId: "sync-move",
			reason: "pull_request_closed",
			actorUserId: "user-1",
		});
		expect(m.closeProposalBranch).not.toHaveBeenCalled();
	});

	it("cancels a move that never joined a branch by rejecting the proposal being received, then ending the move", async () => {
		m.proposalBranchIdOf.mockResolvedValue(null);
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: { ...POINTER, branchId: null },
		});
		m.readProposalPullRequest.mockResolvedValue(null);

		const answer = await callCancel();

		expect(answer).toEqual({ state: "ABANDONED" });
		expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalled();
		expect(m.abandonInstructionMigration).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "canceled" }),
		);
	});

	it("refuses to cancel a move whose project was flipped to the repository behind it, closing nothing: switch to upload mode instead", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "REPOSITORY",
			ignoreGlobs: null,
			migration: POINTER,
		});

		await expect(callCancel()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "MIGRATION_SOURCE_FLIPPED" },
		});

		expect(m.closeProposalBranch).not.toHaveBeenCalled();
		expect(m.abandonInstructionMigration).not.toHaveBeenCalled();
	});

	it("does not report a move ended when the writer found the project flipped after the read", async () => {
		m.readProposalPullRequest.mockResolvedValue(
			proposalView({ state: "CLOSED" }),
		);
		m.abandonInstructionMigration.mockResolvedValue("source_flipped");

		await expect(callCancel()).rejects.toMatchObject({
			data: { reason: "MIGRATION_SOURCE_FLIPPED" },
		});
	});

	it("asks to try again while a proposal that is past receiving waits for its branch", async () => {
		m.proposalBranchIdOf.mockResolvedValue(null);
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: { ...POINTER, branchId: null },
		});
		m.readProposalPullRequest.mockResolvedValue(null);
		m.rejectAbandonedInstructionSnapshot.mockResolvedValue({
			changed: false,
		});

		await expect(callCancel()).rejects.toMatchObject({
			data: { reason: "MIGRATION_PREPARING" },
		});
		expect(m.abandonInstructionMigration).not.toHaveBeenCalled();
	});
});

describe("retryMigration", () => {
	beforeEach(() => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: POINTER,
		});
	});

	const blocked = (code: string, retryable: boolean, over = {}) => {
		m.readProposalPullRequest.mockResolvedValue(
			proposalView({
				state: "BLOCKED",
				failure: { code, retryable, phase: "create" },
			}),
		);
		m.getMemberProposalBranch.mockResolvedValue(
			branch({ state: "BLOCKED", ...over }),
		);
	};

	it("retries a pull request the repository refused to open through the branch's own command", async () => {
		blocked("PR_CREATION_REFUSED", false);

		await expect(callRetry()).resolves.toEqual({ retried: true });

		expect(m.requestProposalBranchRetry).toHaveBeenCalledWith(
			expect.objectContaining({
				branchId: "branch-1",
				expectedAttempt: 3,
			}),
		);
		expect(m.wake).toHaveBeenCalled();
	});

	it("makes a refused push that is waiting out its backoff due now", async () => {
		m.readProposalPullRequest.mockResolvedValue(
			proposalView({
				state: "QUEUED",
				failure: { code: "BRANCH_WRITE_REFUSED", retryable: true },
			}),
		);
		m.getMemberProposalBranch.mockResolvedValue(
			branch({
				state: "PENDING",
				failure: { code: "BRANCH_WRITE_REFUSED" },
			}),
		);

		await expect(callRetry()).resolves.toEqual({ retried: true });

		expect(m.expediteMigrationBranch).toHaveBeenCalledWith({
			branchId: "branch-1",
			organizationId: "org-host",
			expectedAttempt: 3,
		});
		expect(m.wake).toHaveBeenCalled();
	});

	it("says a retry cannot fix a name Fabric cannot use as an author, and points at cancel", async () => {
		blocked("ATTRIBUTION_REJECTED", false);

		await expect(callRetry()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: {
				reason: "MIGRATION_NOT_RETRYABLE",
				failure: { code: "ATTRIBUTION_REJECTED", retryable: false },
			},
		});
		expect(m.requestProposalBranchRetry).not.toHaveBeenCalled();
		expect(m.expediteMigrationBranch).not.toHaveBeenCalled();
	});

	it("repeats the switch for a merge whose settlement step was lost", async () => {
		m.readProposalPullRequest.mockResolvedValue(
			proposalView({ state: "MERGED" }),
		);

		await expect(callRetry()).resolves.toEqual({ retried: true });

		expect(m.completeInstructionMigration).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			branchId: "branch-1",
			pullRequestUrl:
				"https://github.com/example-org/instructions/pull/7",
		});
	});

	it("does not switch the project for a merge into another branch than the sync reads: it ends the move, as the settlement hook does", async () => {
		m.readProposalPullRequest.mockResolvedValue(
			proposalView({ state: "MERGED" }),
		);
		m.getMemberProposalBranch.mockResolvedValue(
			branch({
				state: "MERGED",
				pullRequestObservation: {
					targetRef: "release",
					targetMismatch: true,
				},
			}),
		);

		await expect(callRetry()).resolves.toEqual({ retried: true });

		expect(
			m.completeInstructionMigration,
			"its files are where the sync never looks",
		).not.toHaveBeenCalled();
		expect(m.abandonInstructionMigration).toHaveBeenCalledWith(
			expect.objectContaining({
				syncId: "sync-move",
				reason: "pull_request_closed",
			}),
		);
	});

	it("will not end a move whose project was flipped to the repository behind it, and points at switching back to upload mode", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "REPOSITORY",
			ignoreGlobs: null,
			migration: POINTER,
		});

		await expect(callRetry()).rejects.toMatchObject({
			data: { reason: "MIGRATION_NOT_RETRYABLE" },
		});

		expect(m.requestProposalBranchRetry).not.toHaveBeenCalled();
		expect(m.expediteMigrationBranch).not.toHaveBeenCalled();
		expect(m.completeInstructionMigration).not.toHaveBeenCalled();
		expect(m.abandonInstructionMigration).not.toHaveBeenCalled();
	});

	it("does not report a cleanup done when the writer found the project flipped after the read", async () => {
		m.readProposalPullRequest.mockResolvedValue(
			proposalView({ state: "CANCELED" }),
		);
		m.abandonInstructionMigration.mockResolvedValue("source_flipped");

		await expect(callRetry()).rejects.toMatchObject({
			data: { reason: "MIGRATION_SOURCE_FLIPPED" },
		});
	});

	it("repeats the cleanup of an ended pull request", async () => {
		m.readProposalPullRequest.mockResolvedValue(
			proposalView({ state: "CANCELED" }),
		);

		await expect(callRetry()).resolves.toEqual({ retried: true });

		expect(m.abandonInstructionMigration).toHaveBeenCalledWith(
			expect.objectContaining({ syncId: "sync-move" }),
		);
	});

	it("has nothing to retry for a move that has no failure", async () => {
		await expect(callRetry()).rejects.toMatchObject({
			data: { reason: "MIGRATION_NOT_RETRYABLE" },
		});
	});

	it("answers NOT_FOUND when no move is open", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: null,
		});

		await expect(callRetry()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
