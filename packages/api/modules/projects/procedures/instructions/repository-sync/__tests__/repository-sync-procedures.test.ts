import { keyIsSensitive } from "@repo/utils/sensitive-keys";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	requireProjectPermission: vi.fn((permission: string) => ({ permission })),
	resolveEffectiveProjectPermissions: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	getInstructionRepositorySync: vi.fn(),
	getMemberProposalBranch: vi.fn(),
	getInstructionSyncRunSnapshotProgress: vi.fn(),
	getLatestInstructionRepositorySyncRun: vi.fn(),
	listInstructionRepositorySyncRuns: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	listProjectRepoIntegrations: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	upsertInstructionRepositorySync: vi.fn(),
	deleteInstructionRepositorySync: vi.fn(),
	updateInstructionRepositorySyncProposalSettings: vi.fn(),
	verifyRepositoryBranch: vi.fn(),
	resolveFreshRepoTokenForRow: vi.fn(),
	startInstructionRepositorySync: vi.fn(),
	isInstructionRepositorySyncRunning: vi.fn(),
	queueRepositorySyncFollowUp: vi.fn(),
	readMove: vi.fn(),
	/** What the configuration writer throws, under the project lock, for an open move. */
	MigrationOpenError: class MigrationOpenError extends Error {
		pointer = {
			v: 1,
			state: "PROPOSING",
			branchId: null,
			snapshotId: null,
			syncId: "sync_move",
			pullRequestUrl: null,
			startedAt: "2026-10-03T10:00:00.000Z",
			userId: "user_2",
		};
	},
}));

/**
 * Every key in `value`, at any depth, that the audit writer's key denylist
 * would redact (Fizzy #2746). A content-free key that happens to contain a
 * denylisted substring — `secret` as a reason, `otp` inside `rootPath` —
 * silently becomes "[REDACTED]" in the stored row.
 */
function redactedKeys(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap(redactedKeys);
	}
	if (value === null || typeof value !== "object") {
		return [];
	}
	return Object.entries(value).flatMap(([key, child]) => [
		...(keyIsSensitive(key) ? [key] : []),
		...redactedKeys(child),
	]);
}

vi.mock("@repo/database", async () => ({
	// The real parser, from its own module: the run view's `limit` is what it
	// returns. Importing the whole package would load the Prisma client, which
	// pushed this file's beforeAll toward its timeout under a busy run.
	parseInstructionSyncLimitDetail: (
		await vi.importActual<
			typeof import("../../../../../../../database/prisma/queries/instruction-sync-limit-detail")
		>(
			"../../../../../../../database/prisma/queries/instruction-sync-limit-detail",
		)
	).parseInstructionSyncLimitDetail,
	getInstructionRepositorySync: m.getInstructionRepositorySync,
	getMemberProposalBranch: m.getMemberProposalBranch,
	getInstructionSyncRunSnapshotProgress:
		m.getInstructionSyncRunSnapshotProgress,
	getLatestInstructionRepositorySyncRun:
		m.getLatestInstructionRepositorySyncRun,
	listInstructionRepositorySyncRuns: m.listInstructionRepositorySyncRuns,
	getProjectInstructionSettings: m.getProjectInstructionSettings,
	listProjectRepoIntegrations: m.listProjectRepoIntegrations,
	getProjectRepoIntegration: m.getProjectRepoIntegration,
	upsertInstructionRepositorySync: m.upsertInstructionRepositorySync,
	deleteInstructionRepositorySync: m.deleteInstructionRepositorySync,
	updateInstructionRepositorySyncProposalSettings:
		m.updateInstructionRepositorySyncProposalSettings,
	InstructionMigrationOpenError: m.MigrationOpenError,
}));
// What the move looks like to `disable`, without the pull request machinery
// that reading it pulls in (`migration-read.ts` has its own suite).
vi.mock("../migration-read", () => ({ readMove: m.readMove }));
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
vi.mock("../../../../lib/repository-sync-follow-up", () => ({
	queueRepositorySyncFollowUp: m.queueRepositorySyncFollowUp,
}));
vi.mock("../start-sync-workflow", () => ({
	startInstructionRepositorySync: m.startInstructionRepositorySync,
	isInstructionRepositorySyncRunning: m.isInstructionRepositorySyncRunning,
}));
vi.mock("../../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => fn;
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: m.requireProjectPermission,
		Permissions: {
			INSTRUCTION_READ: "instruction:read",
			INSTRUCTION_CREATE: "instruction:create",
		},
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: unknown;
}) => Promise<unknown>;
const handlers: Record<string, Handler> = {};
const declared: Record<string, string> = {};

beforeAll(async () => {
	for (const [name, load] of [
		["get", () => import("../get")],
		["listRuns", () => import("../list-runs")],
		["configure", () => import("../configure")],
		["syncNow", () => import("../sync-now")],
		["disable", () => import("../disable")],
		["updateProposalSettings", () => import("../update-proposal-settings")],
	] as const) {
		const before = m.requireProjectPermission.mock.calls.length;
		const mod = (await load()) as Record<string, unknown>;
		handlers[name] = Object.values(mod).find(
			(v) => typeof v === "function",
		) as Handler;
		declared[name] = m.requireProjectPermission.mock.calls[
			before
		]?.[0] as string;
	}
});

const ctx = { user: { id: "user_1", name: "Example Member" }, session: {} };
// Distinctive and shaped like a real GitHub token, so a leak assertion that
// greps for it cannot pass by accident the way the old two-character "tok"
// fixture could (review round 1, S2d).
const SECRET_TOKEN = "ghs_example_secret_token";
const integration = {
	id: "int_1",
	projectId: "proj_1",
	provider: "GITHUB",
	authMethod: "OAUTH",
	repositoryUrl: "https://github.com/example-org/instructions.git",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	defaultBranch: "main",
	status: "ACTIVE",
	azureOrganization: null,
	encryptedAccessToken: "enc",
	encryptedRefreshToken: null,
	encryptedPat: null,
	tokenExpiresAt: null,
	updatedAt: new Date("2026-09-23T00:00:00.000Z"),
};
const syncRow = {
	id: "sync_1",
	projectId: "proj_1",
	organizationId: "org_1",
	repositoryIntegrationId: "int_1",
	ref: "main",
	rootPath: "agents",
	automatic: false,
	generation: 2,
	automaticPausedReason: null,
	automaticPausedAt: null,
	allowReaderProposals: false,
	user: { id: "user_2", name: "Delegate Person" },
	repositoryIntegration: {
		id: "int_1",
		provider: "GITHUB",
		repositoryUrl: "https://github.com/example-org/instructions.git",
		repositoryOwner: "example-org",
		repositoryName: "instructions",
		defaultBranch: "main",
		status: "ACTIVE",
	},
};

beforeEach(() => {
	for (const [key, fn] of Object.entries(m)) {
		if (
			key !== "requireProjectPermission" &&
			key !== "MigrationOpenError"
		) {
			(fn as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	// No move of the project's uploads into its repository is open.
	m.readMove.mockResolvedValue(null);
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["instruction:read", "instruction:create"],
		source: "project-member",
		organizationId: "org_1",
	});
	m.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: "REPOSITORY",
	});
	m.getInstructionRepositorySync.mockResolvedValue(syncRow);
	m.getLatestInstructionRepositorySyncRun.mockResolvedValue(null);
	m.getInstructionSyncRunSnapshotProgress.mockResolvedValue(null);
	m.listProjectRepoIntegrations.mockResolvedValue([
		integration,
		{ ...integration, id: "int_2", status: "TOKEN_EXPIRED" },
	]);
	m.isInstructionRepositorySyncRunning.mockResolvedValue(false);
	m.queueRepositorySyncFollowUp.mockResolvedValue(true);
	m.getProjectRepoIntegration.mockResolvedValue(integration);
	m.resolveFreshRepoTokenForRow.mockResolvedValue({ token: SECRET_TOKEN });
	m.verifyRepositoryBranch.mockResolvedValue("exists");
	m.upsertInstructionRepositorySync.mockResolvedValue({
		sync: {
			id: "sync_1",
			generation: 3,
			repositoryIntegrationId: "int_1",
			ref: "develop",
			rootPath: "agents",
			automatic: false,
		},
		previous: {
			ref: "main",
			rootPath: "agents",
			repositoryIntegrationId: "int_1",
		},
		ignoreGlobsChanged: false,
	});
	m.startInstructionRepositorySync.mockResolvedValue(true);
	m.deleteInstructionRepositorySync.mockResolvedValue({
		deleted: true,
		repositoryIntegrationId: "int_1",
	});
});

describe("declared permissions (spec §8.5)", () => {
	it("reads need instruction:read; every mutation needs instruction:create", () => {
		expect(declared).toEqual({
			get: "instruction:read",
			listRuns: "instruction:read",
			configure: "instruction:create",
			syncNow: "instruction:create",
			disable: "instruction:create",
			updateProposalSettings: "instruction:create",
		});
	});
});

describe("resolveHostingOrganizationAccess FORBIDDEN arm (a personal project, or an unresolvable one)", () => {
	it.each([
		["no resolvable access at all", null],
		[
			"resolved access with no organization (personal project)",
			{ permissions: [], source: "owner", organizationId: null },
		],
	])(
		"every handler throws FORBIDDEN when the resolver returns %s",
		async (_label, resolved) => {
			m.resolveEffectiveProjectPermissions.mockResolvedValue(resolved);
			for (const name of [
				"get",
				"listRuns",
				"configure",
				"syncNow",
				"disable",
				"updateProposalSettings",
			] as const) {
				await expect(
					handlers[name]?.({
						input: {
							projectId: "proj_1",
							allowReaderProposals: true,
						},
						context: ctx,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			}
		},
	);
});

describe("repositorySync.get", () => {
	it("returns the configuration with the delegate as a display name only, and ACTIVE integrations for a configurer", async () => {
		const result = (await handlers.get?.({
			input: { projectId: "proj_1" },
			context: ctx,
		})) as Record<string, unknown>;
		// `toEqual` on the whole object, not `toMatchObject`, so a field added
		// to `configured` without also being added here would fail rather
		// than pass silently — the same reason `repositoryUrl` had to be
		// added below when it joined the mapping (Fizzy #2721).
		expect(result).toEqual({
			sourceOfTruth: "REPOSITORY",
			migration: null,
			canConfigure: true,
			running: false,
			configured: {
				syncId: "sync_1",
				repositoryIntegrationId: "int_1",
				provider: "GITHUB",
				repositoryOwner: "example-org",
				repositoryName: "instructions",
				repositoryUrl:
					"https://github.com/example-org/instructions.git",
				integrationStatus: "ACTIVE",
				ref: "main",
				rootPath: "agents",
				automatic: false,
				automaticPausedReason: null,
				automaticPausedAt: null,
				allowReaderProposals: false,
				delegateName: "Delegate Person",
			},
			latestRun: null,
			inFlightSnapshot: null,
			availableIntegrations: [
				{
					id: "int_1",
					provider: "GITHUB",
					repositoryOwner: "example-org",
					repositoryName: "instructions",
					defaultBranch: "main",
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain("user_2");
	});

	it("shows a read-only member the status but no integrations to configure with", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:read"],
			source: "project-member",
			organizationId: "org_1",
		});
		const result = (await handlers.get?.({
			input: { projectId: "proj_1" },
			context: ctx,
		})) as Record<string, unknown>;
		expect(result).toMatchObject({
			canConfigure: false,
			availableIntegrations: [],
		});
		expect(m.listProjectRepoIntegrations).not.toHaveBeenCalled();
	});

	it("marks the latest run by whether it came from the current configuration, never exposing its sync id (Fizzy #2672)", async () => {
		const latest = {
			id: "sync_1:run_a",
			syncId: "sync_1",
			trigger: "MANUAL",
			generation: 2,
			startedAt: new Date("2026-09-23T10:00:00.000Z"),
			finishedAt: new Date("2026-09-23T10:01:00.000Z"),
			status: "NOT_PUBLISHED",
			error: "CONFIGURATION_CHANGED",
			note: null,
			commitSha: null,
			snapshotId: null,
			snapshotVersion: null,
			user: { id: "user_1", name: "Example Member" },
		};
		m.getLatestInstructionRepositorySyncRun.mockResolvedValue(latest);
		const current = (await handlers.get?.({
			input: { projectId: "proj_1" },
			context: ctx,
		})) as { latestRun: Record<string, unknown> };
		expect(current.latestRun).toMatchObject({
			id: "sync_1:run_a",
			fromCurrentConfiguration: true,
		});
		expect(current.latestRun).not.toHaveProperty("syncId");

		// Switched to upload mode: the row is gone, the receipt is not.
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "UPLOAD",
		});
		m.getInstructionRepositorySync.mockResolvedValue(null);
		const switchedOff = (await handlers.get?.({
			input: { projectId: "proj_1" },
			context: ctx,
		})) as {
			configured: unknown;
			latestRun: Record<string, unknown>;
		};
		expect(switchedOff.configured).toBeNull();
		expect(switchedOff.latestRun).toMatchObject({
			id: "sync_1:run_a",
			fromCurrentConfiguration: false,
		});
	});

	it("reports an open run's phase and count, and its snapshot's own progress by the run's key", async () => {
		m.getLatestInstructionRepositorySyncRun.mockResolvedValue({
			id: "sync_1:run_a",
			syncId: "sync_1",
			trigger: "MANUAL",
			generation: 2,
			startedAt: new Date("2026-09-23T10:00:00.000Z"),
			finishedAt: null,
			status: null,
			error: null,
			note: null,
			commitSha: null,
			snapshotId: null,
			snapshotVersion: null,
			limitDetail: null,
			progressPhase: "COPYING",
			progressDone: 3,
			progressTotal: 8,
			user: { id: "user_1", name: "Example Member" },
		});
		m.getInstructionSyncRunSnapshotProgress.mockResolvedValue({
			id: "snap_1",
			version: 4,
			status: "VALIDATING",
			deferredScanStatus: null,
			progressPhase: "CHECKING",
			progressDone: 5,
			progressTotal: 8,
		});

		const result = (await handlers.get?.({
			input: { projectId: "proj_1" },
			context: ctx,
		})) as {
			latestRun: { progress: unknown };
			inFlightSnapshot: unknown;
		};

		expect(m.getInstructionSyncRunSnapshotProgress).toHaveBeenCalledWith(
			"sync_1:run_a",
			"proj_1",
			"org_1",
		);
		expect(result.latestRun.progress).toEqual({
			phase: "COPYING",
			done: 3,
			total: 8,
		});
		expect(result.inFlightSnapshot).toEqual({
			status: "VALIDATING",
			version: 4,
			scanPending: false,
			progress: { phase: "CHECKING", done: 5, total: 8 },
		});
	});

	it("reads no snapshot, and reports no run progress, for a run that has finished", async () => {
		m.getLatestInstructionRepositorySyncRun.mockResolvedValue({
			id: "sync_1:run_a",
			syncId: "sync_1",
			trigger: "MANUAL",
			generation: 2,
			startedAt: new Date("2026-09-23T10:00:00.000Z"),
			finishedAt: new Date("2026-09-23T10:01:00.000Z"),
			status: "SUCCEEDED",
			error: null,
			note: null,
			commitSha: "c0ffee",
			snapshotId: "snap_1",
			snapshotVersion: 4,
			limitDetail: null,
			progressPhase: "COPYING",
			progressDone: 8,
			progressTotal: 8,
			user: { id: "user_1", name: "Example Member" },
		});

		const result = (await handlers.get?.({
			input: { projectId: "proj_1" },
			context: ctx,
		})) as { latestRun: { progress: unknown }; inFlightSnapshot: unknown };

		expect(m.getInstructionSyncRunSnapshotProgress).not.toHaveBeenCalled();
		expect(result.latestRun.progress).toBeNull();
		expect(result.inFlightSnapshot).toBeNull();
	});

	it("treats a missing mode as upload mode", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: null,
		});
		m.getInstructionRepositorySync.mockResolvedValue(null);
		expect(
			await handlers.get?.({
				input: { projectId: "proj_1" },
				context: ctx,
			}),
		).toMatchObject({
			sourceOfTruth: "UPLOAD",
			configured: null,
		});
	});
});

describe("repositorySync.listRuns", () => {
	it("reads runs in the hosting organization, capped, with the member's display name", async () => {
		m.listInstructionRepositorySyncRuns.mockResolvedValue([
			{
				id: "sync_1:run_a",
				syncId: "sync_1",
				trigger: "MANUAL",
				generation: 2,
				startedAt: new Date("2026-09-23T10:00:00.000Z"),
				finishedAt: null,
				status: null,
				error: null,
				note: null,
				commitSha: null,
				snapshotId: null,
				snapshotVersion: null,
				user: { id: "user_1", name: "Example Member" },
			},
		]);
		const result = (await handlers.listRuns?.({
			input: { projectId: "proj_1", limit: 500 },
			context: ctx,
		})) as {
			runs: Array<Record<string, unknown>>;
		};
		expect(m.listInstructionRepositorySyncRuns).toHaveBeenCalledWith(
			"proj_1",
			"org_1",
			50,
		);
		expect(result.runs[0]).toMatchObject({
			id: "sync_1:run_a",
			userName: "Example Member",
		});
		expect(result.runs[0]).not.toHaveProperty("user");
	});

	it("exposes a run's recorded limit as `limit`, and null for a value that is not a valid detail", async () => {
		const run = (id: string, limitDetail: unknown) => ({
			id,
			syncId: "sync_1",
			trigger: "MANUAL",
			generation: 2,
			startedAt: new Date("2026-09-23T10:00:00.000Z"),
			finishedAt: new Date("2026-09-23T10:01:00.000Z"),
			status: "FAILED",
			error: "LIMITS_EXCEEDED",
			note: null,
			commitSha: null,
			snapshotId: null,
			snapshotVersion: null,
			limitDetail,
			user: { id: "user_1", name: "Example Member" },
		});
		m.listInstructionRepositorySyncRuns.mockResolvedValue([
			run("a", { kind: "fileCount", actual: 6000, max: 5000 }),
			run("b", { kind: "inventory", max: 200000 }),
			run("c", { kind: "unknown", max: 1 }),
			run("d", { kind: "fileSize", max: "5" }),
			run("e", { kind: "fileSize", max: 5, path: "docs/secret.md" }),
			run("f", null),
		]);
		const result = (await handlers.listRuns?.({
			input: { projectId: "proj_1" },
			context: ctx,
		})) as { runs: Array<{ limit: unknown }> };
		expect(result.runs.map((r) => r.limit)).toEqual([
			{ kind: "fileCount", actual: 6000, max: 5000 },
			{ kind: "inventory", max: 200000 },
			null,
			null,
			{ kind: "fileSize", max: 5 },
			null,
		]);
		expect(result.runs[0]).not.toHaveProperty("limitDetail");
	});

	describe("runs of a switched-off configuration (Fizzy #2672)", () => {
		const runOf = (id: string, syncId: string) => ({
			id,
			syncId,
			trigger: "MANUAL",
			generation: 1,
			startedAt: new Date("2026-09-23T10:00:00.000Z"),
			finishedAt: new Date("2026-09-23T10:01:00.000Z"),
			status: "SUCCEEDED",
			error: null,
			note: null,
			commitSha: null,
			snapshotId: null,
			snapshotVersion: null,
			user: { id: "user_1", name: "Example Member" },
		});

		it("marks a run from the current configuration true and one from a replaced configuration false, reading the current row in the hosting organization", async () => {
			m.listInstructionRepositorySyncRuns.mockResolvedValue([
				runOf("sync_1:run_b", "sync_1"),
				runOf("sync_old:run_a", "sync_old"),
			]);
			const result = (await handlers.listRuns?.({
				input: { projectId: "proj_1" },
				context: ctx,
			})) as { runs: Array<Record<string, unknown>> };
			expect(m.getInstructionRepositorySync).toHaveBeenCalledWith(
				"proj_1",
				"org_1",
			);
			expect(
				result.runs.map((r) => [r.id, r.fromCurrentConfiguration]),
			).toEqual([
				["sync_1:run_b", true],
				["sync_old:run_a", false],
			]);
			for (const run of result.runs) {
				expect(run).not.toHaveProperty("syncId");
			}
		});

		it("marks every run false once no configuration is left (upload mode)", async () => {
			m.getInstructionRepositorySync.mockResolvedValue(null);
			m.listInstructionRepositorySyncRuns.mockResolvedValue([
				runOf("sync_1:run_b", "sync_1"),
				runOf("sync_1:run_a", "sync_1"),
			]);
			const result = (await handlers.listRuns?.({
				input: { projectId: "proj_1" },
				context: ctx,
			})) as { runs: Array<Record<string, unknown>> };
			expect(result.runs.map((r) => r.fromCurrentConfiguration)).toEqual([
				false,
				false,
			]);
		});
	});
});

describe("repositorySync.configure", () => {
	const input = {
		projectId: "proj_1",
		repositoryIntegrationId: "int_1",
		ref: "develop",
		rootPath: "agents/",
	};

	it("verifies the branch, upserts with the caller as delegate and a normalised root, and audits", async () => {
		const result = await handlers.configure?.({ input, context: ctx });
		expect(result).toEqual({
			syncId: "sync_1",
			generation: 3,
		});
		expect(m.verifyRepositoryBranch).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				token: SECRET_TOKEN,
				branch: "develop",
			}),
		);
		expect(m.upsertInstructionRepositorySync).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_1",
			userId: "user_1",
			repositoryIntegrationId: "int_1",
			ref: "develop",
			rootPath: "agents",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.repository_sync_configured",
				organizationId: "org_1",
				metadata: {
					provider: "GITHUB",
					automatic: false,
					repositoryChanged: false,
					refChanged: true,
					rootChanged: false,
					ignoreGlobsChanged: false,
					generation: 3,
				},
			}),
		);
		// Fizzy #2746: every flag is stored as written, none as "[REDACTED]".
		const [, auditRow] = m.recordAuditFromRequest.mock.calls[0] as [
			unknown,
			{ metadata: unknown },
		];
		expect(redactedKeys(auditRow.metadata)).toEqual([]);
		expect(m.startInstructionRepositorySync).not.toHaveBeenCalled();
		// The resolved credential must reach neither the response nor the
		// audit row (review round 1, S2d).
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
		for (const call of m.recordAuditFromRequest.mock.calls) {
			expect(JSON.stringify(call)).not.toContain(SECRET_TOKEN);
		}
	});

	it("answers MIGRATION_OPEN when the writer refuses under the project lock after the pre-check passed: a move started while the branch was being verified (Fizzy #2878 §9)", async () => {
		m.upsertInstructionRepositorySync.mockRejectedValue(
			new m.MigrationOpenError("a move is open"),
		);

		await expect(
			handlers.configure?.({ input, context: ctx }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: {
				reason: "MIGRATION_OPEN",
				state: "PROPOSING",
				pullRequest: null,
			},
		});

		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("audits the automatic toggle as a configure that changed nothing synced, with the generation it kept (Fizzy #2744)", async () => {
		const stored = {
			repositoryIntegrationId: "int_1",
			ref: "develop",
			rootPath: "agents",
		};
		m.upsertInstructionRepositorySync.mockResolvedValue({
			sync: { id: "sync_1", generation: 3, automatic: true, ...stored },
			previous: stored,
			ignoreGlobsChanged: false,
		});

		expect(
			await handlers.configure?.({
				input: { ...input, automatic: true },
				context: ctx,
			}),
		).toEqual({ syncId: "sync_1", generation: 3 });

		expect(m.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(m.recordAuditFromRequest.mock.calls[0]?.[1]).toMatchObject({
			action: "project.instructions.repository_sync_configured",
			metadata: {
				automatic: true,
				repositoryChanged: false,
				refChanged: false,
				rootChanged: false,
				ignoreGlobsChanged: false,
				generation: 3,
			},
		});
	});

	describe("queueing the run a changed selection asked for", () => {
		const stored = {
			repositoryIntegrationId: "int_1",
			ref: "develop",
			rootPath: "agents",
		};
		const written = (previous: typeof stored | null, generation = 4) => ({
			sync: { id: "sync_1", generation, automatic: false, ...stored },
			previous,
			ignoreGlobsChanged: false,
		});

		it("queues a follow-up for the caller, and says so, when a changed selection meets an open run", async () => {
			m.isInstructionRepositorySyncRunning.mockResolvedValue(true);
			m.upsertInstructionRepositorySync.mockResolvedValue(
				written({ ...stored, ref: "main" }),
			);

			const result = await handlers.configure?.({ input, context: ctx });

			expect(m.queueRepositorySyncFollowUp).toHaveBeenCalledWith({
				subject: "instructions",
				projectId: "proj_1",
				organizationId: "org_1",
				requesterUserId: "user_1",
			});
			expect(result).toEqual({
				syncId: "sync_1",
				generation: 4,
				syncQueued: true,
			});
		});

		it("queues one for a changed ignore list too", async () => {
			m.isInstructionRepositorySyncRunning.mockResolvedValue(true);
			m.upsertInstructionRepositorySync.mockResolvedValue({
				...written(stored),
				ignoreGlobsChanged: true,
			});

			expect(
				await handlers.configure?.({ input, context: ctx }),
			).toMatchObject({ syncQueued: true });
		});

		it("queues nothing when no run is open", async () => {
			m.isInstructionRepositorySyncRunning.mockResolvedValue(false);
			m.upsertInstructionRepositorySync.mockResolvedValue(
				written({ ...stored, ref: "main" }),
			);

			const result = await handlers.configure?.({ input, context: ctx });

			expect(m.queueRepositorySyncFollowUp).not.toHaveBeenCalled();
			expect(result).toEqual({ syncId: "sync_1", generation: 4 });
		});

		it("queues nothing when what is synced did not change, which leaves an open run to finish", async () => {
			m.isInstructionRepositorySyncRunning.mockResolvedValue(true);
			m.upsertInstructionRepositorySync.mockResolvedValue(
				written(stored),
			);

			await handlers.configure?.({
				input: { ...input, automatic: true },
				context: ctx,
			});

			expect(m.queueRepositorySyncFollowUp).not.toHaveBeenCalled();
		});

		it("queues nothing for a first configure, which has no run to fence", async () => {
			m.isInstructionRepositorySyncRunning.mockResolvedValue(true);
			m.upsertInstructionRepositorySync.mockResolvedValue(
				written(null, 1),
			);

			await handlers.configure?.({ input, context: ctx });

			expect(m.queueRepositorySyncFollowUp).not.toHaveBeenCalled();
		});

		it("saves the configuration and claims nothing queued when queueing failed", async () => {
			m.isInstructionRepositorySyncRunning.mockResolvedValue(true);
			m.queueRepositorySyncFollowUp.mockResolvedValue(false);
			m.upsertInstructionRepositorySync.mockResolvedValue(
				written({ ...stored, ref: "main" }),
			);

			expect(await handlers.configure?.({ input, context: ctx })).toEqual(
				{
					syncId: "sync_1",
					generation: 4,
				},
			);
		});
	});

	it("audits a repository change", async () => {
		m.upsertInstructionRepositorySync.mockResolvedValue({
			sync: {
				id: "sync_1",
				generation: 4,
				repositoryIntegrationId: "int_1",
				ref: "develop",
				rootPath: "agents",
				automatic: false,
			},
			previous: {
				repositoryIntegrationId: "int_0",
				ref: "develop",
				rootPath: "agents",
			},
			ignoreGlobsChanged: false,
		});

		await handlers.configure?.({ input, context: ctx });

		expect(m.recordAuditFromRequest.mock.calls[0]?.[1]).toMatchObject({
			metadata: {
				repositoryChanged: true,
				refChanged: false,
				rootChanged: false,
			},
		});
	});

	it("audits a first configure as changing everything", async () => {
		m.upsertInstructionRepositorySync.mockResolvedValue({
			sync: {
				id: "sync_1",
				generation: 1,
				repositoryIntegrationId: "int_1",
				ref: "develop",
				rootPath: "agents",
				automatic: false,
			},
			previous: null,
			ignoreGlobsChanged: false,
		});

		await handlers.configure?.({ input, context: ctx });

		expect(m.recordAuditFromRequest.mock.calls[0]?.[1]).toMatchObject({
			metadata: {
				repositoryChanged: true,
				refChanged: true,
				rootChanged: true,
			},
		});
	});

	it("refuses an integration that is not this project's (tenant boundary)", async () => {
		m.getProjectRepoIntegration.mockResolvedValue(null);
		await expect(
			handlers.configure?.({ input, context: ctx }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { code: "REPOSITORY_NOT_FOUND" },
		});
		expect(m.getProjectRepoIntegration).toHaveBeenCalledWith(
			"int_1",
			"proj_1",
		);
		expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
	});

	it("refuses an integration that is not ACTIVE", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			status: "TOKEN_EXPIRED",
		});
		await expect(
			handlers.configure?.({ input, context: ctx }),
		).rejects.toMatchObject({
			data: { code: "REPOSITORY_UNAVAILABLE" },
		});
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
				handlers.configure?.({ input, context: ctx }),
			).rejects.toMatchObject({ code, data: { code: dataCode } });
			expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
		},
	);

	describe("distinguishing a platform fault from an expired credential (review round 1, S1)", () => {
		it("maps a null token with no fault (genuinely absent credential) to REPOSITORY_CREDENTIALS_EXPIRED", async () => {
			m.resolveFreshRepoTokenForRow.mockResolvedValue({ token: null });
			await expect(
				handlers.configure?.({ input, context: ctx }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				data: { code: "REPOSITORY_CREDENTIALS_EXPIRED" },
			});
			expect(m.verifyRepositoryBranch).not.toHaveBeenCalled();
			expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
		});

		it("maps a null token with credentialFault DECRYPT_FAILED (a lost/rotated encryption key) to REPOSITORY_UNREACHABLE, never 'reconnect'", async () => {
			m.resolveFreshRepoTokenForRow.mockResolvedValue({
				token: null,
				credentialFault: "DECRYPT_FAILED",
			});
			await expect(
				handlers.configure?.({ input, context: ctx }),
			).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
				data: { code: "REPOSITORY_UNREACHABLE" },
			});
			expect(m.verifyRepositoryBranch).not.toHaveBeenCalled();
			expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
		});

		it("maps an 'unauthorized' branch check with NO refreshFault (a genuine rejection) to REPOSITORY_CREDENTIALS_EXPIRED", async () => {
			m.resolveFreshRepoTokenForRow.mockResolvedValue({
				token: SECRET_TOKEN,
			});
			m.verifyRepositoryBranch.mockResolvedValue("unauthorized");
			await expect(
				handlers.configure?.({ input, context: ctx }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				data: { code: "REPOSITORY_CREDENTIALS_EXPIRED" },
			});
			expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
		});

		it("maps an 'unauthorized' branch check WITH a refreshFault (our failed refresh, stale token sent) to REPOSITORY_UNREACHABLE, never 'reconnect'", async () => {
			m.resolveFreshRepoTokenForRow.mockResolvedValue({
				token: SECRET_TOKEN,
				refreshFault: "PROVIDER_UNAVAILABLE",
			});
			m.verifyRepositoryBranch.mockResolvedValue("unauthorized");
			await expect(
				handlers.configure?.({ input, context: ctx }),
			).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
				data: { code: "REPOSITORY_UNREACHABLE" },
			});
			expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
		});

		it("never lets the resolved credential leak into a thrown error's message, data, or any audit call", async () => {
			m.resolveFreshRepoTokenForRow.mockResolvedValue({
				token: SECRET_TOKEN,
				refreshFault: "PROVIDER_UNAVAILABLE",
			});
			m.verifyRepositoryBranch.mockResolvedValue("unauthorized");
			let caught: { message?: string; data?: unknown } | undefined;
			try {
				await handlers.configure?.({ input, context: ctx });
			} catch (error) {
				caught = error as { message?: string; data?: unknown };
			}
			expect(caught).toBeDefined();
			expect(caught?.message ?? "").not.toContain(SECRET_TOKEN);
			expect(JSON.stringify(caught?.data ?? null)).not.toContain(
				SECRET_TOKEN,
			);
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		});
	});

	it("configure's upsert resolving null (project not in this organization) is NOT_FOUND", async () => {
		m.upsertInstructionRepositorySync.mockResolvedValue(null);
		await expect(
			handlers.configure?.({ input, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it.each(["../escape", "/abs", "a/../../b"])(
		"refuses root path %j",
		async (rootPath) => {
			await expect(
				handlers.configure?.({
					input: { ...input, rootPath },
					context: ctx,
				}),
			).rejects.toMatchObject({
				data: { code: "INVALID_ROOT_PATH" },
			});
			expect(m.verifyRepositoryBranch).not.toHaveBeenCalled();
		},
	);

	it("accepts an empty root path as the repository root", async () => {
		await handlers.configure?.({
			input: { ...input, rootPath: "" },
			context: ctx,
		});
		expect(m.upsertInstructionRepositorySync).toHaveBeenCalledWith(
			expect.objectContaining({ rootPath: "" }),
		);
	});
});

/** The pointer of an open move from uploads into a repository (Fizzy #2878 §9). */
const openMove = (state: "PROPOSING" | "SWITCHING") => ({
	v: 1,
	state,
	branchId: "branch_1",
	snapshotId: "snap_move",
	syncId: "sync_1",
	pullRequestUrl: null,
	startedAt: "2026-10-03T10:00:00.000Z",
	userId: "user_1",
});

describe("while a move from uploads into the repository is open (Fizzy #2878 §9)", () => {
	beforeEach(() => {
		m.getMemberProposalBranch.mockResolvedValue({
			pullRequestUrl:
				"https://github.com/example-org/instructions/pull/7",
			pullRequestExternalId: "7",
		});
	});

	const refused = {
		code: "CONFLICT",
		data: {
			reason: "MIGRATION_OPEN",
			state: "PROPOSING",
			pullRequest: {
				url: "https://github.com/example-org/instructions/pull/7",
				externalId: "7",
			},
		},
	};

	it("refuses Sync now while the move is proposing, starting nothing", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "UPLOAD",
			migration: openMove("PROPOSING"),
		});

		await expect(
			handlers.syncNow?.({
				input: { projectId: "proj_1" },
				context: ctx,
			}),
		).rejects.toMatchObject(refused);

		expect(m.startInstructionRepositorySync).not.toHaveBeenCalled();
	});

	it("lets Sync now hurry a move that is switching", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "REPOSITORY",
			migration: openMove("SWITCHING"),
		});

		await expect(
			handlers.syncNow?.({
				input: { projectId: "proj_1" },
				context: ctx,
			}),
		).resolves.toEqual({ started: true });
	});

	it.each(["PROPOSING", "SWITCHING"] as const)(
		"refuses to re-configure the sync while the move is %s",
		async (state) => {
			m.getProjectInstructionSettings.mockResolvedValue({
				ignoreGlobs: null,
				sourceOfTruth: "UPLOAD",
				migration: openMove(state),
			});

			await expect(
				handlers.configure?.({
					input: {
						projectId: "proj_1",
						repositoryIntegrationId: "int_1",
						ref: "develop",
						rootPath: "agents/",
					},
					context: ctx,
				}),
			).rejects.toMatchObject({
				data: { reason: "MIGRATION_OPEN", state },
			});

			expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
			expect(m.verifyRepositoryBranch).not.toHaveBeenCalled();
		},
	);

	it("reports the open move on the sync state the tab reads, beside the paused row", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "UPLOAD",
			migration: openMove("PROPOSING"),
		});

		const result = (await handlers.get?.({
			input: { projectId: "proj_1" },
			context: ctx,
		})) as Record<string, unknown>;

		expect(result).toMatchObject({
			sourceOfTruth: "UPLOAD",
			migration: { state: "PROPOSING" },
		});
	});
});

describe("repositorySync.syncNow", () => {
	it("starts a MANUAL run as the caller and audits", async () => {
		expect(
			await handlers.syncNow?.({
				input: { projectId: "proj_1" },
				context: ctx,
			}),
		).toEqual({ started: true });
		expect(m.startInstructionRepositorySync).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_1",
			trigger: "MANUAL",
			requesterUserId: "user_1",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.repository_sync_started",
				metadata: { trigger: "MANUAL" },
			}),
		);
	});

	it("reports already_running without auditing a start", async () => {
		m.startInstructionRepositorySync.mockResolvedValue(false);
		expect(
			await handlers.syncNow?.({
				input: { projectId: "proj_1" },
				context: ctx,
			}),
		).toEqual({
			started: false,
			reason: "already_running",
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("reports not_configured and integration_unavailable without starting", async () => {
		m.getInstructionRepositorySync.mockResolvedValueOnce(null);
		expect(
			await handlers.syncNow?.({
				input: { projectId: "proj_1" },
				context: ctx,
			}),
		).toEqual({
			started: false,
			reason: "not_configured",
		});
		m.getInstructionRepositorySync.mockResolvedValueOnce({
			...syncRow,
			repositoryIntegration: {
				...syncRow.repositoryIntegration,
				status: "TOKEN_EXPIRED",
			},
		});
		expect(
			await handlers.syncNow?.({
				input: { projectId: "proj_1" },
				context: ctx,
			}),
		).toEqual({
			started: false,
			reason: "integration_unavailable",
		});
		expect(m.startInstructionRepositorySync).not.toHaveBeenCalled();
	});
});

describe("repositorySync.disable", () => {
	it("deletes the configuration and flips to upload mode even while a run is in flight (the run is fenced)", async () => {
		m.isInstructionRepositorySyncRunning.mockResolvedValue(true);
		expect(
			await handlers.disable?.({
				input: { projectId: "proj_1" },
				context: ctx,
			}),
		).toEqual({
			disabled: true,
			hadConfiguration: true,
		});
		expect(m.deleteInstructionRepositorySync).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_1",
			actorUserId: "user_1",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.repository_sync_disabled",
				metadata: { reason: "user", hadConfiguration: true },
			}),
		);
	});

	describe("while a move of the project's uploads into its repository is open (Fizzy #2878 §9)", () => {
		const pointer = (state: "PROPOSING" | "SWITCHING") => ({
			v: 1,
			state,
			branchId: "branch_1",
			snapshotId: "snap_move",
			syncId: "sync_move",
			pullRequestUrl: null,
			startedAt: "2026-10-03T10:00:00.000Z",
			userId: "user_2",
		});
		const openMove = (stored: "PROPOSING" | "SWITCHING", shown: string) => {
			m.readMove.mockResolvedValue({
				pointer: pointer(stored),
				proposal: null,
				branchId: "branch_1",
				evidence: { sourceFlipped: false, targetMismatch: false },
				view: { state: shown },
			});
		};

		it.each([
			["a move that has switched", "SWITCHING" as const, "SWITCHING"],
			["a move that is blocked", "PROPOSING" as const, "BLOCKED"],
		])(
			"is the way out of %s: it switches back to upload mode, ends the move and records who did",
			async (_label, stored, shown) => {
				openMove(stored, shown);

				expect(
					await handlers.disable?.({
						input: { projectId: "proj_1" },
						context: ctx,
					}),
				).toEqual({ disabled: true, hadConfiguration: true });

				expect(m.deleteInstructionRepositorySync).toHaveBeenCalledWith({
					projectId: "proj_1",
					organizationId: "org_1",
					actorUserId: "user_1",
				});
				expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
					ctx,
					expect.objectContaining({
						action: "project.instructions.repository_sync_disabled",
						metadata: {
							reason: "user",
							hadConfiguration: true,
							endedMigration: shown,
						},
					}),
				);
			},
		);

		it.each([
			["is proposing", "PROPOSING" as const, "PROPOSING"],
			["is open", "PROPOSING" as const, "OPEN"],
			["has merged and not yet switched", "PROPOSING" as const, "MERGED"],
			[
				"has ended and not been cleaned up",
				"PROPOSING" as const,
				"ABANDONED",
			],
		])(
			"is refused while the move %s: its own commands end it",
			async (_label, stored, shown) => {
				openMove(stored, shown);

				await expect(
					handlers.disable?.({
						input: { projectId: "proj_1" },
						context: ctx,
					}),
				).rejects.toMatchObject({
					code: "CONFLICT",
					data: { reason: "MIGRATION_OPEN", state: stored },
				});

				expect(
					m.deleteInstructionRepositorySync,
				).not.toHaveBeenCalled();
				expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
			},
		);

		it("is as it always was when no move is open", async () => {
			await handlers.disable?.({
				input: { projectId: "proj_1" },
				context: ctx,
			});

			expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
				ctx,
				expect.objectContaining({
					metadata: { reason: "user", hadConfiguration: true },
				}),
			);
		});
	});

	it("flips a disconnected project back to upload mode when no row is left", async () => {
		m.deleteInstructionRepositorySync.mockResolvedValue({
			deleted: false,
			repositoryIntegrationId: null,
		});
		expect(
			await handlers.disable?.({
				input: { projectId: "proj_1" },
				context: ctx,
			}),
		).toEqual({
			disabled: true,
			hadConfiguration: false,
		});
	});

	it("is NOT_FOUND when the delete resolves null (project not in this organization)", async () => {
		m.deleteInstructionRepositorySync.mockResolvedValue(null);
		await expect(
			handlers.disable?.({
				input: { projectId: "proj_1" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});

describe("repositorySync.updateProposalSettings (Fizzy #2563 Decision 4)", () => {
	const written = {
		id: "sync_1",
		generation: 2,
		allowReaderProposals: true,
		repositoryIntegration: {
			provider: "GITHUB",
			repositoryOwner: "example-org",
			repositoryName: "instructions",
		},
	};

	it("writes only allowReaderProposals in the hosting organization, leaves the generation, and audits the change", async () => {
		m.updateInstructionRepositorySyncProposalSettings.mockResolvedValue(
			written,
		);

		expect(
			await handlers.updateProposalSettings?.({
				input: {
					projectId: "proj_1",
					organizationId: "attacker_org",
					allowReaderProposals: true,
				},
				context: ctx,
			}),
		).toEqual({ allowReaderProposals: true, generation: 2 });
		expect(
			m.updateInstructionRepositorySyncProposalSettings,
		).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_1",
			allowReaderProposals: true,
		});
		// Nothing that re-points the configuration or bumps the generation.
		expect(m.upsertInstructionRepositorySync).not.toHaveBeenCalled();
		expect(m.startInstructionRepositorySync).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(ctx, {
			action: "project.instructions.repository_sync_configured",
			category: "project",
			organizationId: "org_1",
			projectId: "proj_1",
			resource: {
				type: "project_instruction_repository_sync",
				id: "sync_1",
				name: "example-org/instructions",
			},
			metadata: {
				change: "allow_reader_proposals",
				allowReaderProposals: true,
				provider: "GITHUB",
				generation: 2,
			},
		});
	});

	it("is NOT_FOUND when the project has no repository configuration in this organization", async () => {
		m.updateInstructionRepositorySyncProposalSettings.mockResolvedValue(
			null,
		);

		await expect(
			handlers.updateProposalSettings?.({
				input: { projectId: "proj_1", allowReaderProposals: false },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});
