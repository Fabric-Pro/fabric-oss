import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	snapshot: { findFirst: vi.fn(), update: vi.fn() },
	project: { updateMany: vi.fn() },
	sync: { findFirst: vi.fn() },
	$queryRaw: vi.fn(),
	$transaction: vi.fn(),
	canCreateProjectInstructions: vi.fn(),
}));

const tx = {
	projectInstructionSnapshot: m.snapshot,
	project: m.project,
	projectInstructionRepositorySync: m.sync,
	$queryRaw: (...a: unknown[]) => m.$queryRaw(...a),
};

vi.mock("../prisma/client", () => ({
	db: { $transaction: m.$transaction },
	Prisma: {
		PrismaClientKnownRequestError: class extends Error {},
		JsonNull: "JsonNull",
	},
}));
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: vi.fn() }));
vi.mock("../prisma/queries/projects/projects", () => ({
	canCreateProjectInstructions: m.canCreateProjectInstructions,
}));

import { publishInstructionSnapshot } from "../prisma/queries/instructions";

const REF = {
	snapshotId: "snap_9",
	projectId: "proj_1",
	organizationId: "org_1",
};

function locked(sourceOfTruth: string | null) {
	m.$queryRaw.mockResolvedValueOnce([
		{
			pointerId: "snap_8",
			pointerVersion: 8,
			instructionSettings: sourceOfTruth ? { sourceOfTruth } : null,
		},
	]);
}

function repositorySnapshot(overrides: Record<string, unknown> = {}) {
	m.snapshot.findFirst.mockResolvedValue({
		id: "snap_9",
		status: "READY",
		proposalStatus: null,
		version: 9,
		baseSnapshotId: null,
		baseVersion: null,
		publishedAt: null,
		source: "REPOSITORY",
		userId: "delegate_1",
		settingsFrozen: {
			layer: "default",
			syncId: "sync_1",
			syncGeneration: 4,
		},
		...overrides,
	});
}

beforeEach(() => {
	for (const fn of [
		m.snapshot.findFirst,
		m.snapshot.update,
		m.project.updateMany,
		m.sync.findFirst,
		m.$queryRaw,
		m.canCreateProjectInstructions,
	])
		fn.mockReset();
	m.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) =>
		cb(tx),
	);
	m.project.updateMany.mockResolvedValue({ count: 1 });
	m.canCreateProjectInstructions.mockResolvedValue(true);
});

describe("publishInstructionSnapshot: repository-sync fence (spec §5.6)", () => {
	it("publishes when the configuration pair, the mode and the delegate's permission all still hold", async () => {
		locked("REPOSITORY");
		repositorySnapshot();
		m.sync.findFirst.mockResolvedValue({ id: "sync_1", generation: 4 });

		expect(
			await publishInstructionSnapshot({
				...REF,
				requireBaseUnmoved: true,
			}),
		).toEqual({
			published: true,
			changed: true,
		});
		// Evaluated on the TRANSACTION's client, under the project row lock.
		expect(m.canCreateProjectInstructions).toHaveBeenCalledWith(
			"proj_1",
			"delegate_1",
			tx,
		);
	});

	it.each([
		[
			"the generation moved (re-configured or ignore rules changed)",
			"REPOSITORY",
			{ id: "sync_1", generation: 5 },
		],
		[
			"the configuration was deleted and recreated (new syncId)",
			"REPOSITORY",
			{ id: "sync_2", generation: 4 },
		],
		["the configuration is gone", "REPOSITORY", null],
		[
			"the project was switched back to upload mode",
			"UPLOAD",
			{ id: "sync_1", generation: 4 },
		],
	] as const)(
		"refuses as configuration_changed when %s, and writes nothing",
		async (_l, mode, sync) => {
			locked(mode);
			repositorySnapshot();
			m.sync.findFirst.mockResolvedValue(sync);

			expect(
				await publishInstructionSnapshot({
					...REF,
					requireBaseUnmoved: true,
				}),
			).toEqual({
				published: false,
				changed: false,
				reason: "configuration_changed",
			});
			expect(m.project.updateMany).not.toHaveBeenCalled();
			expect(m.snapshot.update).not.toHaveBeenCalled();
		},
	);

	it("refuses as permission_revoked when the acting user lost instruction:create", async () => {
		locked("REPOSITORY");
		repositorySnapshot();
		m.sync.findFirst.mockResolvedValue({ id: "sync_1", generation: 4 });
		m.canCreateProjectInstructions.mockResolvedValue(false);

		expect(
			await publishInstructionSnapshot({
				...REF,
				requireBaseUnmoved: true,
			}),
		).toEqual({
			published: false,
			changed: false,
			reason: "permission_revoked",
		});
		expect(m.project.updateMany).not.toHaveBeenCalled();
	});

	it("does not fence History's manual publish: a person chose this version", async () => {
		locked("UPLOAD");
		repositorySnapshot();
		m.sync.findFirst.mockResolvedValue(null);

		const result = await publishInstructionSnapshot({
			...REF,
			allowRollback: true,
		});

		expect(result).toMatchObject({ published: true, changed: true });
		expect(m.sync.findFirst).not.toHaveBeenCalled();
		expect(m.canCreateProjectInstructions).not.toHaveBeenCalled();
	});

	// History's manual publish of an UPLOADED version would put files the
	// repository never had in front of agents, exactly as an upload would.
	it("refuses History's manual publish of an upload as repository_backed while the repository is the source of truth, and writes nothing", async () => {
		locked("REPOSITORY");
		repositorySnapshot({
			source: "UPLOAD",
			settingsFrozen: { layer: "default" },
		});

		expect(
			await publishInstructionSnapshot({
				...REF,
				allowRollback: true,
			}),
		).toEqual({
			published: false,
			changed: false,
			reason: "repository_backed",
		});
		expect(m.project.updateMany).not.toHaveBeenCalled();
		expect(m.snapshot.update).not.toHaveBeenCalled();
	});

	it("still lets History publish a synced version manually while the repository is the source of truth", async () => {
		locked("REPOSITORY");
		repositorySnapshot();

		expect(
			await publishInstructionSnapshot({
				...REF,
				allowRollback: true,
			}),
		).toMatchObject({ published: true, changed: true });
		expect(m.project.updateMany).toHaveBeenCalledTimes(1);
	});

	it("publishes an upload on an upload-mode project without consulting the sync fence", async () => {
		locked("UPLOAD");
		repositorySnapshot({
			source: "UPLOAD",
			settingsFrozen: { layer: "default" },
		});

		expect(
			await publishInstructionSnapshot({
				...REF,
				requireBaseUnmoved: true,
			}),
		).toEqual({
			published: true,
			changed: true,
		});
		expect(m.sync.findFirst).not.toHaveBeenCalled();
	});

	// Spec §4: while the repository is the source of truth, an upload or
	// edit begun before the mode flip must not take the pointer
	// automatically — agents would read files the repository never had.
	it("refuses an upload as configuration_changed while the repository is the source of truth, and writes nothing", async () => {
		locked("REPOSITORY");
		repositorySnapshot({
			source: "UPLOAD",
			settingsFrozen: { layer: "default" },
		});

		expect(
			await publishInstructionSnapshot({
				...REF,
				requireBaseUnmoved: true,
			}),
		).toEqual({
			published: false,
			changed: false,
			reason: "configuration_changed",
		});
		expect(m.project.updateMany).not.toHaveBeenCalled();
		expect(m.snapshot.update).not.toHaveBeenCalled();
		expect(m.sync.findFirst).not.toHaveBeenCalled();
	});

	it("answers an already-published repository snapshot idempotently before the fence", async () => {
		locked("UPLOAD");
		repositorySnapshot({ publishedAt: new Date() });
		expect(
			await publishInstructionSnapshot({
				...REF,
				requireBaseUnmoved: true,
			}),
		).toEqual({
			published: true,
			changed: false,
		});
		expect(m.sync.findFirst).not.toHaveBeenCalled();
	});
});
