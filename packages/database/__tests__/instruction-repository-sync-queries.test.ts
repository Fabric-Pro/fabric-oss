import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	sync: {
		findFirst: vi.fn(),
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
}));

vi.mock("../prisma/client", () => ({
	db: { ...client, $transaction: m.$transaction },
	Prisma: {
		PrismaClientKnownRequestError: class extends Error {},
		JsonNull: "JsonNull",
	},
}));
vi.mock("../prisma/queries/audit-log", () => ({
	recordAuditTx: m.recordAuditTx,
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	canCreateProjectInstructions: m.canCreateProjectInstructions,
}));

import {
	completeInstructionRepositorySyncRun,
	deleteInstructionRepositorySync,
	getInstructionRepositorySyncRunReceipt,
	insertInstructionRepositorySyncRun,
	instructionSyncBackoffMs,
	listInstructionRepositorySyncRuns,
	upsertInstructionRepositorySync,
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
			{ automaticPausedReason: "REF_MISSING", automaticPausedAt: NOW },
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
});
