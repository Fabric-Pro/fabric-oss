/**
 * The freeze a move from uploads into the repository puts on a project's
 * instructions (Fizzy #2878 §9): one refusal, `MIGRATION_OPEN`, 409, carrying
 * the move's state and its pull request. The pointer's presence is the freeze.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getProjectInstructionSettings: vi.fn(),
	getMemberProposalBranch: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectInstructionSettings: m.getProjectInstructionSettings,
	getMemberProposalBranch: m.getMemberProposalBranch,
	/** What the settings and configuration writers throw, under the project lock, for an open move. */
	InstructionMigrationOpenError: class InstructionMigrationOpenError extends Error {
		pointer: unknown;
		constructor(pointer: unknown) {
			super("a move is open");
			this.pointer = pointer;
		}
	},
}));

import { InstructionMigrationOpenError } from "@repo/database";
import {
	assertNoOpenMigration,
	assertNotMigrationSnapshot,
	migrationOpenError,
	migrationOpenFromRefusal,
	withMigrationFreeze,
} from "../migration-freeze";

const TENANT = { projectId: "proj_1", organizationId: "org_1" };

const pointer = (over: Record<string, unknown> = {}) => ({
	v: 1 as const,
	state: "PROPOSING" as const,
	branchId: "branch_1",
	snapshotId: "snap_move",
	syncId: "sync_1",
	pullRequestUrl: null,
	startedAt: "2026-10-03T10:00:00.000Z",
	userId: "user_1",
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	m.getMemberProposalBranch.mockResolvedValue({
		pullRequestUrl: "https://github.com/example-org/instructions/pull/7",
		pullRequestExternalId: "7",
	});
});

describe("assertNoOpenMigration", () => {
	it("lets a project with no move through", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({ migration: null });

		await expect(assertNoOpenMigration(TENANT)).resolves.toBeUndefined();

		expect(m.getProjectInstructionSettings).toHaveBeenCalledWith(
			"proj_1",
			"org_1",
		);
		expect(m.getMemberProposalBranch).not.toHaveBeenCalled();
	});

	it.each(["PROPOSING", "SWITCHING"] as const)(
		"refuses a move that is %s, with its state and its pull request",
		async (state) => {
			m.getProjectInstructionSettings.mockResolvedValue({
				migration: pointer({ state }),
			});

			await expect(assertNoOpenMigration(TENANT)).rejects.toMatchObject({
				code: "CONFLICT",
				status: 409,
				data: {
					reason: "MIGRATION_OPEN",
					state,
					pullRequest: {
						url: "https://github.com/example-org/instructions/pull/7",
						externalId: "7",
					},
				},
			});
			expect(m.getMemberProposalBranch).toHaveBeenCalledWith({
				branchId: "branch_1",
				projectId: "proj_1",
				organizationId: "org_1",
			});
		},
	);

	it("narrows to one state when asked: Sync now is refused while proposing and allowed while switching", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			migration: pointer({ state: "SWITCHING" }),
		});
		await expect(
			assertNoOpenMigration(TENANT, { onlyWhile: "PROPOSING" }),
		).resolves.toBeUndefined();

		m.getProjectInstructionSettings.mockResolvedValue({
			migration: pointer({ state: "PROPOSING" }),
		});
		await expect(
			assertNoOpenMigration(TENANT, { onlyWhile: "PROPOSING" }),
		).rejects.toMatchObject({ data: { reason: "MIGRATION_OPEN" } });
	});

	it("answers a null pull request for a move whose branch has none yet, or has no branch", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			migration: pointer({ branchId: null }),
		});
		await expect(assertNoOpenMigration(TENANT)).rejects.toMatchObject({
			data: { pullRequest: null },
		});
		expect(m.getMemberProposalBranch).not.toHaveBeenCalled();

		m.getProjectInstructionSettings.mockResolvedValue({
			migration: pointer(),
		});
		m.getMemberProposalBranch.mockResolvedValue({
			pullRequestUrl: null,
			pullRequestExternalId: null,
		});
		await expect(assertNoOpenMigration(TENANT)).rejects.toMatchObject({
			data: { pullRequest: null },
		});
	});
});

describe("migrationOpenError", () => {
	it("says in words what to wait for", async () => {
		const error = await migrationOpenError(pointer(), TENANT);

		expect(error.message).toMatch(/moved into its repository/);
		expect(error.message).toMatch(/merged and synced, or canceled/);
	});
});

describe("withMigrationFreeze: the freeze a writer decides under the project lock", () => {
	it("answers the writer's refusal as the same MIGRATION_OPEN the pre-check gives, with the pointer the lock found", async () => {
		const refusal = new InstructionMigrationOpenError(
			pointer({ state: "SWITCHING" }),
		);

		await expect(
			withMigrationFreeze(TENANT, () => Promise.reject(refusal)),
		).rejects.toMatchObject({
			code: "CONFLICT",
			status: 409,
			data: {
				reason: "MIGRATION_OPEN",
				state: "SWITCHING",
				pullRequest: {
					url: "https://github.com/example-org/instructions/pull/7",
					externalId: "7",
				},
			},
		});
	});

	it("returns what the write returned when no move is open", async () => {
		await expect(
			withMigrationFreeze(TENANT, async () => ({ written: true })),
		).resolves.toEqual({ written: true });
	});

	it("leaves every other failure of the write as it is", async () => {
		await expect(
			withMigrationFreeze(TENANT, () =>
				Promise.reject(new Error("the database is unreachable")),
			),
		).rejects.toThrow("the database is unreachable");
	});
});

describe("migrationOpenFromRefusal: a publish or approval the database refused as migration_open", () => {
	it("uses the pointer the refusal carries, without asking again", async () => {
		const error = await migrationOpenFromRefusal(
			{ migration: pointer({ branchId: null }) },
			TENANT,
		);

		expect(error).toMatchObject({
			code: "CONFLICT",
			data: {
				reason: "MIGRATION_OPEN",
				state: "PROPOSING",
				pullRequest: null,
			},
		});
		expect(m.getProjectInstructionSettings).not.toHaveBeenCalled();
	});

	it("reads the pointer when the refusal does not carry one", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			migration: pointer({ state: "SWITCHING", branchId: null }),
		});

		const error = await migrationOpenFromRefusal({}, TENANT);

		expect(error).toMatchObject({ data: { state: "SWITCHING" } });
	});

	it("says to try again when the move it named has ended since: nothing is open", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({ migration: null });

		await expect(
			migrationOpenFromRefusal({}, TENANT),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "MIGRATION_CHANGED" },
		});
	});
});

describe("assertNotMigrationSnapshot", () => {
	it("refuses to delete the move's own proposal", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			migration: pointer({ snapshotId: "snap_move" }),
		});

		await expect(
			assertNotMigrationSnapshot({ ...TENANT, snapshotId: "snap_move" }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "MIGRATION_OPEN" },
		});
	});

	it("lets any other snapshot of a project with a move open be deleted", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			migration: pointer({ snapshotId: "snap_move" }),
		});

		await expect(
			assertNotMigrationSnapshot({ ...TENANT, snapshotId: "snap_old" }),
		).resolves.toBeUndefined();
	});

	it("lets a move that has no proposal yet, and a project with no move, through", async () => {
		m.getProjectInstructionSettings.mockResolvedValueOnce({
			migration: pointer({ snapshotId: null }),
		});
		await expect(
			assertNotMigrationSnapshot({ ...TENANT, snapshotId: "snap_old" }),
		).resolves.toBeUndefined();

		m.getProjectInstructionSettings.mockResolvedValueOnce({
			migration: null,
		});
		await expect(
			assertNotMigrationSnapshot({ ...TENANT, snapshotId: "snap_old" }),
		).resolves.toBeUndefined();
	});
});
