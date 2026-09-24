import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../prisma/client";

const m = vi.hoisted(() => ({
	sync: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		findUnique: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		delete: vi.fn(),
	},
	run: {
		createMany: vi.fn(),
		findFirst: vi.fn(),
		findUnique: vi.fn(),
		updateMany: vi.fn(),
		findMany: vi.fn(),
	},
	project: { update: vi.fn(), findFirst: vi.fn() },
	snapshot: { findMany: vi.fn(), findFirst: vi.fn() },
	integration: { deleteMany: vi.fn() },
	contextSync: { findFirst: vi.fn() },
	$queryRaw: vi.fn(),
	$executeRaw: vi.fn(),
	$transaction: vi.fn(),
	recordAuditTx: vi.fn(),
	canCreateProjectInstructions: vi.fn(),
}));

const client = vi.hoisted(() => ({
	projectInstructionRepositorySync: m.sync,
	projectInstructionRepositorySyncRun: m.run,
	project: m.project,
	projectInstructionSnapshot: m.snapshot,
	projectRepositoryIntegration: m.integration,
	projectContextRepositorySync: m.contextSync,
	$queryRaw: (...a: unknown[]) => m.$queryRaw(...a),
	$executeRaw: (...a: unknown[]) => m.$executeRaw(...a),
}));

vi.mock("../prisma/client", async () => {
	// The real tagged-template builders (`Prisma.sql` is `sqltag`), so the
	// lease fence reaches the fake client exactly as Postgres would get it.
	const { join, sqltag } = await vi.importActual<
		typeof import("@prisma/client/runtime/client")
	>("@prisma/client/runtime/client");
	return {
		db: { ...client, $transaction: m.$transaction },
		Prisma: {
			PrismaClientKnownRequestError: class extends Error {},
			JsonNull: "JsonNull",
			join,
			sql: sqltag,
		},
	};
});
vi.mock("../prisma/queries/audit-log", () => ({
	recordAuditTx: m.recordAuditTx,
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	canCreateProjectInstructions: m.canCreateProjectInstructions,
}));

import {
	claimDueInstructionSyncRows,
	completeInstructionRepositorySyncRun,
	computeSchedulingPatch,
	deleteInstructionRepositorySync,
	findInstructionSyncsForPush,
	getInstructionRepositorySyncRunReceipt,
	insertInstructionRepositorySyncRun,
	instructionSyncBackoffMs,
	instructionSyncLeaseHeld,
	listInstructionRepositorySyncRuns,
	recordInstructionSyncCheckFailure,
	upsertInstructionRepositorySync,
	writeBackInstructionSync,
} from "../prisma/queries/instruction-repository-sync";
import { updateProjectInstructionSettings } from "../prisma/queries/instructions";
import { deleteRepoIntegrationReleasingSyncs } from "../prisma/queries/projects/repository-integration-disconnect";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const MIN = 60 * 1000;

beforeEach(() => {
	for (const group of [
		m.sync,
		m.run,
		m.project,
		m.snapshot,
		m.integration,
		m.contextSync,
	]) {
		for (const fn of Object.values(group)) fn.mockReset();
	}
	// No Living Memory sync reads from the integration unless a test says so.
	m.contextSync.findFirst.mockResolvedValue(null);
	m.$queryRaw.mockReset();
	m.$executeRaw.mockReset();
	m.recordAuditTx.mockReset();
	m.$transaction.mockReset();
	m.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
		cb(client),
	);
});

/** The project row lock `writeProjectInstructionSettings` takes, answering with these settings. */
function lockedSettings(settings: Record<string, unknown> | null) {
	m.$queryRaw.mockResolvedValueOnce(
		settings === null ? [] : [{ instructionSettings: settings }],
	);
}

describe("upsertInstructionRepositorySync", () => {
	const input = {
		projectId: "proj_1",
		organizationId: "org_1",
		userId: "user_2",
		repositoryIntegrationId: "int_1",
		ref: "main",
		rootPath: "agents",
	};

	it("creates the row with automatic off and flips the project to REPOSITORY in the same transaction", async () => {
		lockedSettings({ ignoreGlobs: ["dist/**"] });
		m.sync.findFirst.mockResolvedValue(null);
		m.sync.create.mockResolvedValue({
			id: "sync_1",
			generation: 1,
			ref: "main",
			rootPath: "agents",
			automatic: false,
		});

		const result = await upsertInstructionRepositorySync(input);

		expect(m.sync.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					projectId: "proj_1",
					organizationId: "org_1",
					userId: "user_2",
					repositoryIntegrationId: "int_1",
					ref: "main",
					rootPath: "agents",
					automatic: false,
				}),
			}),
		);
		expect(m.project.update).toHaveBeenCalledWith({
			where: { id: "proj_1", organizationId: "org_1" },
			data: {
				instructionSettings: {
					ignoreGlobs: ["dist/**"],
					sourceOfTruth: "REPOSITORY",
				},
			},
		});
		expect(result).toEqual({
			sync: {
				id: "sync_1",
				generation: 1,
				ref: "main",
				rootPath: "agents",
				automatic: false,
			},
			previous: null,
		});
	});

	it("re-configuring bumps the generation, re-delegates to the caller and clears every scheduling cursor", async () => {
		lockedSettings({ sourceOfTruth: "REPOSITORY" });
		m.sync.findFirst.mockResolvedValue({
			id: "sync_1",
			ref: "develop",
			rootPath: "",
			repositoryIntegrationId: "int_1",
			automatic: true,
		});
		m.sync.update.mockResolvedValue({
			id: "sync_1",
			generation: 5,
			ref: "main",
			rootPath: "agents",
			automatic: true,
		});

		const result = await upsertInstructionRepositorySync(input);

		const data = m.sync.update.mock.calls[0]?.[0].data;
		expect(data).toMatchObject({
			userId: "user_2",
			ref: "main",
			rootPath: "agents",
			// Omitted by the caller, so the stored value stands.
			automatic: true,
			generation: { increment: 1 },
			automaticPausedReason: null,
			automaticPausedAt: null,
			suppressedCommitSha: null,
			suppressedGeneration: null,
			lastEvaluatedCommitSha: null,
			lastEvaluatedGeneration: null,
			failureCount: 0,
		});
		expect(data.nextCheckAt).toBeInstanceOf(Date);
		expect(result?.previous).toEqual({
			ref: "develop",
			rootPath: "",
			repositoryIntegrationId: "int_1",
		});
	});

	it("writes nothing for a project outside the organization", async () => {
		lockedSettings(null);
		expect(await upsertInstructionRepositorySync(input)).toBeNull();
		expect(m.sync.create).not.toHaveBeenCalled();
		expect(m.sync.update).not.toHaveBeenCalled();
	});

	it("makes a re-configured sync due now, so the next poll tick evaluates it (Decision 9)", async () => {
		lockedSettings({ sourceOfTruth: "REPOSITORY" });
		m.sync.findFirst.mockResolvedValue({
			id: "sync_1",
			ref: "main",
			rootPath: "agents",
			repositoryIntegrationId: "int_1",
			automatic: true,
		});
		m.sync.update.mockResolvedValue({
			id: "sync_1",
			generation: 6,
			ref: "main",
			rootPath: "agents",
			automatic: true,
		});

		const before = Date.now();
		await upsertInstructionRepositorySync({ ...input, automatic: true });
		const after = Date.now();

		const { nextCheckAt } = m.sync.update.mock.calls[0]?.[0].data as {
			nextCheckAt: Date;
		};
		expect(nextCheckAt.getTime()).toBeGreaterThanOrEqual(before);
		expect(nextCheckAt.getTime()).toBeLessThanOrEqual(after);
	});
});

describe("deleteInstructionRepositorySync", () => {
	it("deletes the row and flips the project back to UPLOAD atomically", async () => {
		lockedSettings({ sourceOfTruth: "REPOSITORY" });
		m.sync.findFirst.mockResolvedValue({
			id: "sync_1",
			repositoryIntegrationId: "int_1",
		});

		expect(
			await deleteInstructionRepositorySync({
				projectId: "proj_1",
				organizationId: "org_1",
			}),
		).toEqual({ deleted: true, repositoryIntegrationId: "int_1" });
		expect(m.sync.delete).toHaveBeenCalledWith({ where: { id: "sync_1" } });
		expect(m.project.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { instructionSettings: { sourceOfTruth: "UPLOAD" } },
			}),
		);
	});

	it("still flips to UPLOAD when the row is already gone, so a disconnected project is never locked", async () => {
		lockedSettings({ sourceOfTruth: "REPOSITORY" });
		m.sync.findFirst.mockResolvedValue(null);
		expect(
			await deleteInstructionRepositorySync({
				projectId: "proj_1",
				organizationId: "org_1",
			}),
		).toEqual({ deleted: false, repositoryIntegrationId: null });
		expect(m.project.update).toHaveBeenCalled();
	});
});

describe("deleteRepoIntegrationReleasingSyncs: the coding-instructions release", () => {
	it("releases the sync configuration and flips the mode when the disconnected integration is its source", async () => {
		m.$queryRaw.mockResolvedValueOnce([{ organizationId: "org_1" }]); // project lock
		m.sync.findFirst.mockResolvedValue({
			id: "sync_1",
			organizationId: "org_1",
		});
		lockedSettings({ sourceOfTruth: "REPOSITORY" });
		m.integration.deleteMany.mockResolvedValue({ count: 1 });

		expect(
			await deleteRepoIntegrationReleasingSyncs({
				integrationId: "int_1",
				projectId: "proj_1",
			}),
		).toEqual({
			deletedIntegration: true,
			releasedInstructionSync: { organizationId: "org_1" },
			releasedContextSync: null,
		});
		// The project row lock comes first, before any read of the sync.
		expect(String(m.$queryRaw.mock.calls[0]?.[0])).toContain(
			'FROM "project" WHERE "id" =',
		);
		// NO KEY: a sync run's inserts take KEY SHARE on the project row while
		// holding its configuration lock; plain FOR UPDATE would deadlock.
		expect(String(m.$queryRaw.mock.calls[0]?.[0])).toContain(
			"FOR NO KEY UPDATE",
		);
		expect(m.sync.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "proj_1",
					repositoryIntegrationId: "int_1",
				},
			}),
		);
		expect(m.sync.delete).toHaveBeenCalledWith({ where: { id: "sync_1" } });
		expect(m.integration.deleteMany).toHaveBeenCalledWith({
			where: { id: "int_1", projectId: "proj_1" },
		});
	});

	it("leaves a sync that reads from a different integration alone", async () => {
		m.$queryRaw.mockResolvedValueOnce([{ organizationId: "org_1" }]);
		m.sync.findFirst.mockResolvedValue(null);
		m.integration.deleteMany.mockResolvedValue({ count: 1 });

		expect(
			await deleteRepoIntegrationReleasingSyncs({
				integrationId: "int_2",
				projectId: "proj_1",
			}),
		).toEqual({
			deletedIntegration: true,
			releasedInstructionSync: null,
			releasedContextSync: null,
		});
		expect(m.sync.delete).not.toHaveBeenCalled();
		expect(m.project.update).not.toHaveBeenCalled();
	});
});

describe("insertInstructionRepositorySyncRun", () => {
	const run = {
		id: "sync_1:run_a",
		syncId: "sync_1",
		projectId: "proj_1",
		organizationId: "org_1",
		userId: "user_1",
		generation: 3,
		trigger: "MANUAL" as const,
		startedAt: NOW,
	};

	it("inserts once, with ON CONFLICT DO NOTHING semantics", async () => {
		m.run.createMany.mockResolvedValue({ count: 1 });
		expect(await insertInstructionRepositorySyncRun(run)).toEqual({
			inserted: true,
			generation: 3,
		});
		expect(m.run.createMany).toHaveBeenCalledWith({
			data: [run],
			skipDuplicates: true,
		});
	});

	it("an activity retry leaves the stored row alone and reports the generation it was inserted under", async () => {
		m.run.createMany.mockResolvedValue({ count: 0 });
		m.run.findUnique.mockResolvedValue({ generation: 2 });
		expect(await insertInstructionRepositorySyncRun(run)).toEqual({
			inserted: false,
			generation: 2,
		});
	});
});

describe("getInstructionRepositorySyncRunReceipt", () => {
	it("reads one receipt by run key, scoped to the project and organization", async () => {
		const receipt = {
			syncId: "sync_1",
			userId: "user_1",
			generation: 3,
			trigger: "MANUAL",
			finishedAt: null,
		};
		m.run.findFirst.mockResolvedValue(receipt);
		expect(
			await getInstructionRepositorySyncRunReceipt(
				"sync_1:run_a",
				"proj_1",
				"org_1",
			),
		).toEqual(receipt);
		expect(m.run.findFirst).toHaveBeenCalledWith({
			where: {
				id: "sync_1:run_a",
				projectId: "proj_1",
				organizationId: "org_1",
			},
			select: {
				syncId: true,
				userId: true,
				generation: true,
				trigger: true,
				finishedAt: true,
			},
		});
	});
});

describe("completeInstructionRepositorySyncRun", () => {
	const base = {
		runKey: "sync_1:run_a",
		syncId: "sync_1",
		generation: 3,
		projectId: "proj_1",
		organizationId: "org_1",
		userId: "user_1",
		trigger: "MANUAL" as const,
		status: "SUCCEEDED" as const,
		error: null,
		note: null,
		commitSha: "c0ffee",
		snapshotId: "snap_1",
		scheduling: { kind: "success", commitSha: "c0ffee" } as const,
		now: NOW,
	};

	it("completes the run row once, applies the scheduling fenced on the generation, and audits in the same transaction", async () => {
		m.run.updateMany.mockResolvedValue({ count: 1 });
		m.$queryRaw.mockResolvedValueOnce([{ generation: 3, failureCount: 2 }]);

		expect(await completeInstructionRepositorySyncRun(base)).toEqual({
			completed: true,
			configurationCurrent: true,
		});
		// The sync row is LOCKED FIRST, tenant-scoped, before the run row is
		// touched (design review B1, B2) — the same order the delete paths
		// use before their cascade delete of the run rows, so a completion
		// racing a disable/disconnect cannot deadlock. Asserted on the actual
		// SQL/params, not just the mocked return, so dropping the tenant scope
		// or the generation column here would fail this test rather than pass
		// it silently (design review B3).
		const [strings, ...values] = m.$queryRaw.mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		const sql = strings.join(" ");
		expect(sql).toContain('"generation"');
		expect(sql).toContain('"projectId" =');
		expect(sql).toContain('"organizationId" =');
		expect(values).toEqual(["sync_1", "proj_1", "org_1"]);
		expect(m.run.updateMany).toHaveBeenCalledWith({
			where: {
				id: "sync_1:run_a",
				projectId: "proj_1",
				organizationId: "org_1",
				finishedAt: null,
			},
			data: {
				finishedAt: NOW,
				status: "SUCCEEDED",
				error: null,
				note: null,
				commitSha: "c0ffee",
				snapshotId: "snap_1",
			},
		});
		expect(m.sync.update).toHaveBeenCalledWith({
			where: {
				id: "sync_1",
				projectId: "proj_1",
				organizationId: "org_1",
			},
			data: {
				failureCount: 0,
				nextCheckAt: new Date(NOW.getTime() + 15 * MIN),
				lastEvaluatedCommitSha: "c0ffee",
				lastEvaluatedGeneration: 3,
			},
		});
		expect(m.recordAuditTx).toHaveBeenCalledTimes(1);
		expect(m.recordAuditTx).toHaveBeenCalledWith(
			client,
			expect.objectContaining({
				action: "project.instructions.repository_sync_completed",
				actor: { type: "user", userId: "user_1" },
				organizationId: "org_1",
				projectId: "proj_1",
				resource: {
					type: "project_instruction_repository_sync",
					id: "sync_1",
				},
				metadata: expect.objectContaining({
					status: "SUCCEEDED",
					trigger: "MANUAL",
					generation: 3,
				}),
			}),
		);
	});

	it("a second delivery, or a late attempt of an older run, still locks the sync row (same order as a disable) but writes nothing else", async () => {
		m.run.updateMany.mockResolvedValue({ count: 0 });
		m.$queryRaw.mockResolvedValueOnce([{ generation: 3, failureCount: 0 }]);
		expect(await completeInstructionRepositorySyncRun(base)).toEqual({
			completed: false,
			configurationCurrent: false,
		});
		expect(m.$queryRaw).toHaveBeenCalledTimes(1);
		expect(m.sync.update).not.toHaveBeenCalled();
		expect(m.recordAuditTx).not.toHaveBeenCalled();
	});

	it("completes the run row but leaves the configuration alone when the generation moved on", async () => {
		m.run.updateMany.mockResolvedValue({ count: 1 });
		// The row still exists — a re-configure bumped it past the generation
		// this run was started under — which is the case the code-level fence
		// (`current.generation === input.generation`) must catch now that the
		// comparison is no longer a SQL predicate (design review B1).
		m.$queryRaw.mockResolvedValueOnce([
			{ generation: 99, failureCount: 0 },
		]);
		expect(await completeInstructionRepositorySyncRun(base)).toEqual({
			completed: true,
			configurationCurrent: false,
		});
		expect(m.sync.update).not.toHaveBeenCalled();
		expect(m.recordAuditTx).toHaveBeenCalledTimes(1);
	});

	it("completes the run row but leaves the configuration alone when the row is gone entirely", async () => {
		m.run.updateMany.mockResolvedValue({ count: 1 });
		m.$queryRaw.mockResolvedValueOnce([]);
		expect(await completeInstructionRepositorySyncRun(base)).toEqual({
			completed: true,
			configurationCurrent: false,
		});
		expect(m.sync.update).not.toHaveBeenCalled();
		expect(m.recordAuditTx).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"suppress",
			{ kind: "suppress", commitSha: "bad1" },
			0,
			{
				failureCount: 0,
				nextCheckAt: new Date(NOW.getTime() + 15 * MIN),
				suppressedCommitSha: "bad1",
				suppressedGeneration: 3,
			},
		],
		[
			"backoff (post-increment count)",
			{ kind: "backoff" },
			2,
			{
				failureCount: 3,
				nextCheckAt: new Date(NOW.getTime() + 40 * MIN),
			},
		],
		[
			"pause",
			{ kind: "pause", reason: "REF_MISSING" },
			0,
			{
				nextCheckAt: null,
				automaticPausedReason: "REF_MISSING",
				automaticPausedAt: NOW,
			},
		],
	] as const)(
		"applies the %s effect",
		async (_label, scheduling, failureCount, expected) => {
			m.run.updateMany.mockResolvedValue({ count: 1 });
			m.$queryRaw.mockResolvedValueOnce([
				{ generation: 3, failureCount },
			]);
			await completeInstructionRepositorySyncRun({ ...base, scheduling });
			expect(m.sync.update).toHaveBeenCalledWith({
				where: {
					id: "sync_1",
					projectId: "proj_1",
					organizationId: "org_1",
				},
				data: expected,
			});
		},
	);

	it("the none effect touches no scheduling column", async () => {
		m.run.updateMany.mockResolvedValue({ count: 1 });
		m.$queryRaw.mockResolvedValueOnce([{ generation: 3, failureCount: 0 }]);
		await completeInstructionRepositorySyncRun({
			...base,
			status: "SKIPPED",
			scheduling: { kind: "none" },
		});
		expect(m.sync.update).not.toHaveBeenCalled();
	});
});

describe("instructionSyncBackoffMs", () => {
	it("doubles from five minutes and caps at six hours", () => {
		expect(instructionSyncBackoffMs(1)).toBe(10 * MIN);
		expect(instructionSyncBackoffMs(3)).toBe(40 * MIN);
		expect(instructionSyncBackoffMs(12)).toBe(6 * 60 * MIN);
	});
});

describe("listInstructionRepositorySyncRuns", () => {
	it("returns the newest runs with the version of the snapshot each produced, read in the same tenant", async () => {
		m.run.findMany.mockResolvedValue([
			{ id: "r2", snapshotId: "snap_2" },
			{ id: "r1", snapshotId: null },
		]);
		m.snapshot.findMany.mockResolvedValue([{ id: "snap_2", version: 9 }]);

		expect(
			await listInstructionRepositorySyncRuns("proj_1", "org_1", 20),
		).toEqual([
			{ id: "r2", snapshotId: "snap_2", snapshotVersion: 9 },
			{ id: "r1", snapshotId: null, snapshotVersion: null },
		]);
		expect(m.run.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "proj_1", organizationId: "org_1" },
				orderBy: { startedAt: "desc" },
				take: 20,
			}),
		);
		expect(m.snapshot.findMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["snap_2"] },
				projectId: "proj_1",
				organizationId: "org_1",
			},
			select: { id: true, version: true },
		});
	});
});

describe("updateProjectInstructionSettings (spec §4.4)", () => {
	it("bumps the sync generation and clears the poll cursor when the ignore rules change", async () => {
		lockedSettings({
			ignoreGlobs: ["dist/**"],
			sourceOfTruth: "REPOSITORY",
		});
		m.sync.updateMany.mockResolvedValue({ count: 1 });

		expect(
			await updateProjectInstructionSettings("proj_1", "org_1", {
				ignoreGlobs: ["build/**"],
			}),
		).toEqual({ syncGenerationBumped: true });
		// The project row lock is tenant-scoped; asserted on the actual
		// SQL/params so dropping `AND "organizationId" = ...` here would fail
		// this test rather than pass it silently (design review B3).
		const [strings, ...values] = m.$queryRaw.mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		expect(strings.join(" ")).toContain('"organizationId" =');
		expect(values).toEqual(["proj_1", "org_1"]);
		expect(m.sync.updateMany).toHaveBeenCalledWith({
			where: { projectId: "proj_1", organizationId: "org_1" },
			data: {
				generation: { increment: 1 },
				lastEvaluatedCommitSha: null,
				lastEvaluatedGeneration: null,
				nextCheckAt: expect.any(Date),
			},
		});
		expect(m.project.update).toHaveBeenCalledWith({
			where: { id: "proj_1", organizationId: "org_1" },
			data: {
				instructionSettings: {
					ignoreGlobs: ["build/**"],
					sourceOfTruth: "REPOSITORY",
				},
			},
		});
	});

	it("leaves the generation alone when the rules are unchanged", async () => {
		lockedSettings({ ignoreGlobs: ["dist/**"] });
		expect(
			await updateProjectInstructionSettings("proj_1", "org_1", {
				ignoreGlobs: ["dist/**"],
			}),
		).toEqual({ syncGenerationBumped: false });
		expect(m.sync.updateMany).not.toHaveBeenCalled();
	});

	it("a generation bump makes the sync due now, so a run it fenced is replaced at the next tick (Decision 9)", async () => {
		lockedSettings({ ignoreGlobs: [], sourceOfTruth: "REPOSITORY" });
		m.sync.updateMany.mockResolvedValue({ count: 1 });

		const before = Date.now();
		await updateProjectInstructionSettings("proj_1", "org_1", {
			ignoreGlobs: ["build/**"],
		});
		const after = Date.now();

		const { nextCheckAt } = m.sync.updateMany.mock.calls[0]?.[0].data as {
			nextCheckAt: Date;
		};
		expect(nextCheckAt.getTime()).toBeGreaterThanOrEqual(before);
		expect(nextCheckAt.getTime()).toBeLessThanOrEqual(after);
	});
});

/** The fake client, as the `tx` every store function takes. */
const tx = client as unknown as Prisma.TransactionClient;
const HEAD = "c".repeat(40);
const REPO_URL = "https://github.com/example-org/example-repo";

describe("computeSchedulingPatch (spec §5.4, §6.1, Decision 46)", () => {
	it.each([
		[
			"reschedule moves only the clock",
			{ kind: "reschedule", delayMs: 2 * MIN },
			2,
			{ nextCheckAt: new Date(NOW.getTime() + 2 * MIN) },
		],
		[
			"success with a head resets the count and records the cursor",
			{ kind: "success", commitSha: HEAD },
			2,
			{
				failureCount: 0,
				nextCheckAt: new Date(NOW.getTime() + 15 * MIN),
				lastEvaluatedCommitSha: HEAD,
				lastEvaluatedGeneration: 3,
			},
		],
		[
			"success without a head leaves the cursor alone",
			{ kind: "success", commitSha: null },
			2,
			{
				failureCount: 0,
				nextCheckAt: new Date(NOW.getTime() + 15 * MIN),
			},
		],
		[
			"suppress records the suppressed head",
			{ kind: "suppress", commitSha: HEAD },
			0,
			{
				failureCount: 0,
				nextCheckAt: new Date(NOW.getTime() + 15 * MIN),
				suppressedCommitSha: HEAD,
				suppressedGeneration: 3,
			},
		],
		[
			"backoff counts from the failure count it is given",
			{ kind: "backoff" },
			2,
			{
				failureCount: 3,
				nextCheckAt: new Date(NOW.getTime() + 40 * MIN),
			},
		],
		[
			"pause stamps the reason and the time and clears the schedule",
			{ kind: "pause", reason: "REF_MISSING" },
			1,
			{
				nextCheckAt: null,
				automaticPausedReason: "REF_MISSING",
				automaticPausedAt: NOW,
			},
		],
	] as const)("%s", (_label, effect, failureCount, expected) => {
		expect(
			computeSchedulingPatch(effect, {
				now: NOW,
				failureCount,
				generation: 3,
			}),
		).toEqual(expected);
	});

	it("writes nothing for the none effect", () => {
		expect(
			computeSchedulingPatch(
				{ kind: "none" },
				{ now: NOW, failureCount: 0, generation: 3 },
			),
		).toBeNull();
	});
});

describe("claimDueInstructionSyncRows (spec §6.1)", () => {
	const LEASE_UNTIL = new Date(NOW.getTime() + 2 * MIN);
	const claimed = [
		{
			id: "sync_1",
			projectId: "proj_1",
			organizationId: "org_1",
			userId: "user_1",
			generation: 3,
			repositoryIntegrationId: "int_1",
			ref: "main",
			lastEvaluatedCommitSha: null,
			lastEvaluatedGeneration: null,
			suppressedCommitSha: null,
			suppressedGeneration: null,
			failureCount: 0,
			leaseUntil: LEASE_UNTIL,
		},
	];

	it("protocol: leases the oldest-due rows of active integrations in one statement that skips locked rows, and returns each lease", async () => {
		m.$queryRaw.mockResolvedValueOnce(claimed);

		expect(
			await claimDueInstructionSyncRows(tx, {
				limit: 8,
				leaseUntil: LEASE_UNTIL,
				now: NOW,
			}),
		).toEqual(claimed);

		// One statement, no interactive transaction: the claim and the lease
		// are the same UPDATE, so two overlapping ticks cannot claim one row.
		expect(m.$transaction).not.toHaveBeenCalled();
		expect(m.$queryRaw).toHaveBeenCalledTimes(1);
		const [strings, ...values] = m.$queryRaw.mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		const sql = strings.join("?").replace(/\s+/g, " ");
		expect(sql).toContain(
			'UPDATE "project_instruction_repository_sync" AS s SET "nextCheckAt" = ?',
		);
		expect(sql).toContain('WHERE s."id" = ANY (ARRAY(');
		expect(sql).toContain(
			'JOIN "project_repository_integration" AS i ON i."id" = s2."repositoryIntegrationId"',
		);
		expect(sql).toContain('s2."automatic" = true');
		expect(sql).toContain('s2."automaticPausedReason" IS NULL');
		expect(sql).toContain('s2."nextCheckAt" <= ?');
		expect(sql).toContain(`i."status" = 'ACTIVE'`);
		// Oldest due first: an unprocessed lease (now + 2 min) sorts ahead of
		// every row a finished check pushed to now + 15 min.
		expect(sql).toContain(
			'ORDER BY s2."nextCheckAt" ASC, s2."id" ASC LIMIT ?',
		);
		expect(sql).toContain("FOR UPDATE OF s2 SKIP LOCKED");
		// The subject-neutral row shape (Decision 46).
		for (const column of [
			'"id"',
			'"projectId"',
			'"organizationId"',
			'"userId"',
			'"generation"',
			'"repositoryIntegrationId"',
			'"ref"',
			'"lastEvaluatedCommitSha"',
			'"lastEvaluatedGeneration"',
			'"suppressedCommitSha"',
			'"suppressedGeneration"',
			'"failureCount"',
		]) {
			expect(sql).toContain(`s.${column}`);
		}
		// The lease's identity is the value the claim wrote (Decision 31).
		expect(sql).toContain('s."nextCheckAt" AS "leaseUntil"');
		expect(values).toEqual([LEASE_UNTIL, NOW, 8]);
	});

	it("protocol: returns an empty batch when nothing is due", async () => {
		m.$queryRaw.mockResolvedValueOnce([]);
		expect(
			await claimDueInstructionSyncRows(tx, {
				limit: 8,
				leaseUntil: LEASE_UNTIL,
			}),
		).toEqual([]);
	});
});

/** A row as the claim above returned it (Decision 46). */
const ROW = {
	id: "sync_1",
	projectId: "proj_1",
	organizationId: "org_1",
	userId: "user_1",
	generation: 3,
	repositoryIntegrationId: "int_1",
	ref: "main",
	lastEvaluatedCommitSha: null,
	lastEvaluatedGeneration: null,
	suppressedCommitSha: null,
	suppressedGeneration: null,
	failureCount: 1,
	leaseUntil: new Date(NOW.getTime() + 2 * MIN),
};
const FENCE = { id: "sync_1", generation: 3, leaseUntil: ROW.leaseUntil };

/**
 * The fence every lease read and write sends, with its first placeholder at
 * `$first` (Decisions 31 and 48). These are protocol pins: they fix what
 * reaches Postgres. What the fence does to a row, expiry by the database's
 * clock included, is pinned against the stateful row store in
 * instruction-repository-sync-lease.test.ts (Decision 54).
 */
function fenceSql(first: number): string {
	return `"id" = $${first} AND "generation" = $${first + 1} AND "nextCheckAt" = $${first + 2} AND "nextCheckAt" > (clock_timestamp() AT TIME ZONE 'UTC') AND "automatic" = true AND "automaticPausedReason" IS NULL`;
}
const FENCE_VALUES = ["sync_1", 3, ROW.leaseUntil];

/** The one raw statement a client method received, whitespace squashed. */
function sent(method: ReturnType<typeof vi.fn>): {
	text: string;
	values: unknown[];
} {
	expect(method).toHaveBeenCalledTimes(1);
	const [query] = method.mock.calls[0] as [
		{ text: string; values: unknown[] },
	];
	return {
		text: query.text.replace(/\s+/g, " ").trim(),
		values: query.values,
	};
}

describe("instructionSyncLeaseHeld (Decisions 31 and 48)", () => {
	it("protocol: reads the lease with one raw SELECT on the fence, on the caller's client", async () => {
		m.$queryRaw.mockResolvedValueOnce([{ id: "sync_1" }]);
		expect(await instructionSyncLeaseHeld(tx, FENCE)).toBe(true);
		expect(sent(m.$queryRaw)).toEqual({
			text: `SELECT "id" FROM "project_instruction_repository_sync" WHERE ${fenceSql(1)}`,
			values: FENCE_VALUES,
		});
		expect(m.sync.findFirst).not.toHaveBeenCalled();
	});

	it("protocol: no row back means the lease is lost", async () => {
		m.$queryRaw.mockResolvedValueOnce([]);
		expect(await instructionSyncLeaseHeld(tx, FENCE)).toBe(false);
	});
});

describe("writeBackInstructionSync (spec §6.1, Decisions 31, 46 and 48)", () => {
	const PATCH = { nextCheckAt: new Date(NOW.getTime() + 15 * MIN) };

	it("protocol: one raw UPDATE of the patch's columns and updatedAt on the fence, with no transaction", async () => {
		m.$executeRaw.mockResolvedValueOnce(1);
		expect(await writeBackInstructionSync(tx, FENCE, PATCH)).toEqual({
			applied: true,
		});
		expect(sent(m.$executeRaw)).toEqual({
			text: `UPDATE "project_instruction_repository_sync" SET "nextCheckAt" = $1, "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC') WHERE ${fenceSql(2)}`,
			values: [PATCH.nextCheckAt, ...FENCE_VALUES],
		});
		expect(m.$transaction).not.toHaveBeenCalled();
		expect(m.sync.updateMany).not.toHaveBeenCalled();
	});

	it("protocol: sets every contract column a patch names, in a fixed order, casting the pause to its enum", async () => {
		m.$executeRaw.mockResolvedValueOnce(1);
		await writeBackInstructionSync(tx, FENCE, {
			nextCheckAt: PATCH.nextCheckAt,
			failureCount: 0,
			automaticPausedReason: "REF_MISSING",
			automaticPausedAt: NOW,
			suppressedCommitSha: null,
			suppressedGeneration: 3,
			lastEvaluatedCommitSha: HEAD,
			lastEvaluatedGeneration: 3,
		});
		expect(sent(m.$executeRaw)).toEqual({
			text: `UPDATE "project_instruction_repository_sync" SET "nextCheckAt" = $1, "failureCount" = $2, "automaticPausedReason" = $3::"ProjectInstructionSyncPause", "automaticPausedAt" = $4, "suppressedCommitSha" = $5, "suppressedGeneration" = $6, "lastEvaluatedCommitSha" = $7, "lastEvaluatedGeneration" = $8, "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC') WHERE ${fenceSql(9)}`,
			values: [
				PATCH.nextCheckAt,
				0,
				"REF_MISSING",
				NOW,
				null,
				3,
				HEAD,
				3,
				...FENCE_VALUES,
			],
		});
	});

	it("protocol: no row updated means nothing applied", async () => {
		m.$executeRaw.mockResolvedValueOnce(0);
		expect(await writeBackInstructionSync(tx, FENCE, PATCH)).toEqual({
			applied: false,
		});
	});
});

describe("recordInstructionSyncCheckFailure (spec §6.1, Decision 35)", () => {
	const failure = {
		row: ROW,
		pollRunId: "poll_run_1",
		error: "REF_MISSING" as const,
		pause: "REF_MISSING" as const,
		now: NOW,
	};

	it("protocol: pauses on the fence first, then writes the FAILED POLL run row and the completion audit, all on the caller's client", async () => {
		m.$executeRaw.mockResolvedValueOnce(1);
		m.run.createMany.mockResolvedValue({ count: 1 });

		expect(await recordInstructionSyncCheckFailure(tx, failure)).toEqual({
			applied: true,
		});

		// The caller owns the transaction (Decision 46).
		expect(m.$transaction).not.toHaveBeenCalled();
		expect(sent(m.$executeRaw)).toEqual({
			// The pause clears the schedule: the claim's lease must not be
			// left behind as an overdue `nextCheckAt` on a row nothing claims.
			text: `UPDATE "project_instruction_repository_sync" SET "nextCheckAt" = $1, "automaticPausedReason" = $2::"ProjectInstructionSyncPause", "automaticPausedAt" = $3, "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC') WHERE ${fenceSql(4)}`,
			values: [null, "REF_MISSING", NOW, ...FENCE_VALUES],
		});
		expect(m.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
			m.run.createMany.mock.invocationCallOrder[0] ?? 0,
		);
		expect(m.run.createMany).toHaveBeenCalledWith({
			data: [
				{
					// The generation is part of the key: one poll run can claim
					// the same sync again after a re-configure (Decision 35).
					id: "sync_1:poll_run_1:3",
					syncId: "sync_1",
					projectId: "proj_1",
					organizationId: "org_1",
					userId: "user_1",
					generation: 3,
					trigger: "POLL",
					startedAt: NOW,
					finishedAt: NOW,
					status: "FAILED",
					error: "REF_MISSING",
				},
			],
			skipDuplicates: true,
		});
		// Exactly the audit `completeInstructionRepositorySyncRun` writes.
		expect(m.recordAuditTx).toHaveBeenCalledTimes(1);
		expect(m.recordAuditTx).toHaveBeenCalledWith(tx, {
			action: "project.instructions.repository_sync_completed",
			category: "project",
			severity: "warning",
			outcome: "failure",
			actor: { type: "user", userId: "user_1" },
			organizationId: "org_1",
			projectId: "proj_1",
			resource: {
				type: "project_instruction_repository_sync",
				id: "sync_1",
			},
			metadata: {
				trigger: "POLL",
				status: "FAILED",
				error: "REF_MISSING",
				note: null,
				commitSha: null,
				snapshotId: null,
				generation: 3,
			},
		});
	});

	it("protocol: records a revoked delegate the same way, pausing with PERMISSION_REVOKED (Decision 33)", async () => {
		m.$executeRaw.mockResolvedValueOnce(1);
		m.run.createMany.mockResolvedValue({ count: 1 });

		await recordInstructionSyncCheckFailure(tx, {
			...failure,
			error: "PERMISSION_DENIED",
			pause: "PERMISSION_REVOKED",
		});

		expect(sent(m.$executeRaw).values.slice(0, 3)).toEqual([
			null,
			"PERMISSION_REVOKED",
			NOW,
		]);
		expect(m.run.createMany.mock.calls[0]?.[0].data[0]).toMatchObject({
			status: "FAILED",
			error: "PERMISSION_DENIED",
		});
		expect(m.recordAuditTx).toHaveBeenCalledWith(
			tx,
			expect.objectContaining({
				metadata: expect.objectContaining({
					error: "PERMISSION_DENIED",
				}),
			}),
		);
	});

	it("protocol: stops after a pause that matched no row", async () => {
		m.$executeRaw.mockResolvedValueOnce(0);
		expect(await recordInstructionSyncCheckFailure(tx, failure)).toEqual({
			applied: false,
		});
		expect(m.run.createMany).not.toHaveBeenCalled();
		expect(m.recordAuditTx).not.toHaveBeenCalled();
	});
});

describe("findInstructionSyncsForPush (spec §6.2, Decision 46)", () => {
	function stored(overrides: Record<string, unknown> = {}) {
		return {
			id: "sync_1",
			projectId: "proj_1",
			organizationId: "org_1",
			generation: 3,
			ref: "main",
			automatic: true,
			automaticPausedReason: null,
			lastEvaluatedCommitSha: HEAD,
			lastEvaluatedGeneration: 3,
			suppressedCommitSha: null,
			suppressedGeneration: null,
			repositoryIntegration: {
				projectId: "proj_1",
				project: { organizationId: "org_1" },
			},
			...overrides,
		};
	}

	it("reads the syncs that follow the pushed branch on the repository's active integrations, oldest first", async () => {
		m.sync.findMany.mockResolvedValue([stored()]);

		expect(
			await findInstructionSyncsForPush({
				repositoryUrl: REPO_URL,
				ref: "main",
			}),
		).toEqual([
			{
				id: "sync_1",
				projectId: "proj_1",
				organizationId: "org_1",
				generation: 3,
				ref: "main",
				automatic: true,
				automaticPausedReason: null,
				lastEvaluatedCommitSha: HEAD,
				lastEvaluatedGeneration: 3,
				suppressedCommitSha: null,
				suppressedGeneration: null,
			},
		]);
		expect(m.sync.findMany).toHaveBeenCalledWith({
			where: {
				ref: "main",
				repositoryIntegration: {
					repositoryUrl: REPO_URL,
					status: "ACTIVE",
				},
			},
			orderBy: { createdAt: "asc" },
			select: expect.objectContaining({
				id: true,
				organizationId: true,
				automatic: true,
				automaticPausedReason: true,
				lastEvaluatedCommitSha: true,
				lastEvaluatedGeneration: true,
				suppressedCommitSha: true,
				suppressedGeneration: true,
				repositoryIntegration: {
					select: {
						projectId: true,
						project: { select: { organizationId: true } },
					},
				},
			}),
		});
	});

	it.each([
		[
			"a push naming another project's organization starts nothing (Review Focus 1)",
			{
				repositoryIntegration: {
					projectId: "proj_1",
					project: { organizationId: "org_2" },
				},
			},
		],
		[
			"a row whose integration belongs to another project is dropped",
			{
				repositoryIntegration: {
					projectId: "proj_2",
					project: { organizationId: "org_1" },
				},
			},
		],
		[
			"a row whose integration's project has no organization is dropped",
			{
				repositoryIntegration: {
					projectId: "proj_1",
					project: { organizationId: null },
				},
			},
		],
	])("%s", async (_label, overrides) => {
		m.sync.findMany.mockResolvedValue([
			stored(overrides),
			stored({
				id: "sync_2",
				projectId: "proj_2",
				repositoryIntegration: {
					projectId: "proj_2",
					project: { organizationId: "org_1" },
				},
			}),
		]);
		const rows = await findInstructionSyncsForPush({
			repositoryUrl: REPO_URL,
			ref: "main",
		});
		// The consistent row still counts; the other is dropped.
		expect(rows.map((row) => row.id)).toEqual(["sync_2"]);
	});
});
