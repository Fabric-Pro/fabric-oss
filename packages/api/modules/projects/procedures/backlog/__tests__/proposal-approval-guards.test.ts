/**
 * Approval guards that refuse a request before anything is claimed:
 *   - an update whose Fabric target is not a work item in this project;
 *   - an item already moved to Rejected, or already applied (except on a
 *     FAILED retry, which skips applied work).
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	getProposal: vi.fn(),
}));

vi.mock("../../../../../../database/prisma/client", () => ({ db: {} }));
vi.mock("@repo/database", async () => ({
	db: { userStory: { findMany: mocks.findMany } },
	getPendingBacklogProposal: mocks.getProposal,
	proposalRevision: (
		await import(
			"../../../../../../database/prisma/queries/projects/proposal-changes"
		)
	).proposalRevision,
	readRejectedChangeIndexes: (
		await import(
			"../../../../../../database/prisma/queries/projects/pending-proposal-item-state"
		)
	).readRejectedChangeIndexes,
}));

import { proposalRevision } from "../../../../../../database/prisma/queries/projects/proposal-changes";
import {
	assertProposalItemsUnresolved,
	assertProposalRevision,
	assertUpdateTargetsInProject,
	holdBackInvalidUpdateTargets,
	lostClaimConflict,
	PROPOSAL_ALREADY_ACTIONED_MESSAGE,
	PROPOSAL_CHANGED_MESSAGE,
} from "../proposal-approval-guards";

const FABRIC_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_FABRIC_ID = "c0000000000000000000000001";

function update(existingId: string | null, existingIdentifier?: string) {
	return {
		action: "update" as const,
		existingId,
		existingIdentifier,
		title: { to: "Example change" },
	};
}

beforeEach(() => {
	mocks.findMany.mockReset();
	mocks.getProposal.mockReset();
});

describe("assertProposalRevision", () => {
	const stored = { changes: [{ description: { to: "Merged text" } }] };

	it("passes the revision of the stored proposal, or no revision", () => {
		expect(() =>
			assertProposalRevision(stored, proposalRevision(stored)),
		).not.toThrow();
		expect(() => assertProposalRevision(stored, undefined)).not.toThrow();
	});

	it("refuses an approval built from an older version", () => {
		const loaded = { changes: [{ description: { to: "Text" } }] };
		expect(() =>
			assertProposalRevision(stored, proposalRevision(loaded)),
		).toThrow(PROPOSAL_CHANGED_MESSAGE);
	});
});

describe("lostClaimConflict", () => {
	it("says the proposal changed while it is still open for review", async () => {
		mocks.getProposal.mockResolvedValue({ status: "PENDING" });

		await expect(
			lostClaimConflict("example-proposal", ["PENDING", "FAILED"]),
		).resolves.toMatchObject({
			code: "CONFLICT",
			message: PROPOSAL_CHANGED_MESSAGE,
		});
	});

	it.each([{ status: "APPLYING" }, null])(
		"keeps the already-actioned message for %j",
		async (row) => {
			mocks.getProposal.mockResolvedValue(row);

			await expect(
				lostClaimConflict("example-proposal", ["PENDING", "FAILED"]),
			).resolves.toMatchObject({
				code: "CONFLICT",
				message: PROPOSAL_ALREADY_ACTIONED_MESSAGE,
			});
		},
	);
});

const SELECTED = { id: true, identifier: true, title: true, externalId: true };

describe("assertUpdateTargetsInProject", () => {
	it("passes when every Fabric target is a work item in the project", async () => {
		mocks.findMany.mockResolvedValue([{ id: FABRIC_ID }]);

		await expect(
			assertUpdateTargetsInProject("example-project", [
				update(FABRIC_ID),
			]),
		).resolves.toBeUndefined();
		expect(mocks.findMany).toHaveBeenCalledWith({
			where: {
				projectId: "example-project",
				OR: [{ id: { in: [FABRIC_ID] } }],
			},
			select: SELECTED,
		});
	});

	it("refuses a missing target, naming the item and its identifier", async () => {
		mocks.findMany.mockResolvedValue([{ id: FABRIC_ID }]);

		const error = await assertUpdateTargetsInProject("example-project", [
			update(FABRIC_ID, "F-1"),
			update(OTHER_FABRIC_ID, "F-2"),
		]).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			message:
				"“Example change” can't update F-2: it is not a work item in this project. Pick another target or create a new ticket.",
		});
	});

	it("names every invalid target, not only the first", async () => {
		mocks.findMany.mockResolvedValue([]);

		await expect(
			assertUpdateTargetsInProject("example-project", [
				update(FABRIC_ID, "F-1"),
				update(OTHER_FABRIC_ID, "F-2"),
			]),
		).rejects.toMatchObject({
			message: [
				"“Example change” can't update F-1: it is not a work item in this project. Pick another target or create a new ticket.",
				"“Example change” can't update F-2: it is not a work item in this project. Pick another target or create a new ticket.",
			].join("\n"),
		});
	});

	it("names the selected ticket when the update has no identifier", async () => {
		mocks.findMany.mockResolvedValue([]);

		await expect(
			assertUpdateTargetsInProject("example-project", [
				update(FABRIC_ID),
			]),
		).rejects.toMatchObject({
			message: expect.stringContaining(
				"can't update the selected ticket:",
			),
		});
	});

	it("leaves creates and updates that name no target to the apply", async () => {
		await assertUpdateTargetsInProject("example-project", [
			{ action: "create", title: { to: "New" } },
			update(null),
		]);

		expect(mocks.findMany).not.toHaveBeenCalled();
	});

	it("leaves a reference that is not a Fabric id to the apply's fallback", async () => {
		await expect(
			assertUpdateTargetsInProject("example-project", [
				{ ...update(null), existingExternalId: "ADO-1234" },
				update("F-7", "F-7"),
			]),
		).resolves.toBeUndefined();
		expect(mocks.findMany).not.toHaveBeenCalled();
	});
});

describe("holdBackInvalidUpdateTargets", () => {
	const create = { action: "create" as const, title: { to: "New" } };

	it("resolves a reference that is not a Fabric id the way the apply does, reading only the candidate tickets", async () => {
		mocks.findMany.mockResolvedValue([
			{
				id: FABRIC_ID,
				identifier: "F-7",
				title: "Existing ticket",
				externalId: "ADO-1234",
			},
		]);
		const byCard = { ...update(null), existingExternalId: "ADO-1234" };
		const byIdentifier = update("F-7", "F-7");

		await expect(
			holdBackInvalidUpdateTargets("example-project", [
				create,
				byCard,
				byIdentifier,
			]),
		).resolves.toEqual({ heldBack: new Set(), refusals: [] });
		expect(mocks.findMany).toHaveBeenCalledWith({
			where: {
				projectId: "example-project",
				OR: [
					{ identifier: { in: ["F-7"] } },
					{ externalId: { in: ["ADO-1234"] } },
					{
						title: {
							equals: "Example change",
							mode: "insensitive",
						},
					},
				],
			},
			select: SELECTED,
		});
	});

	it("holds back a reference that resolves to no ticket of the project", async () => {
		mocks.findMany.mockResolvedValue([]);
		const byCard = { ...update(null), existingExternalId: "ADO-1234" };

		const result = await holdBackInvalidUpdateTargets("example-project", [
			create,
			byCard,
		]);

		expect([...result.heldBack]).toEqual([byCard]);
		expect(result.refusals).toEqual([
			expect.stringContaining("“Example change” can't update ADO-1234:"),
		]);
	});

	it("holds back only the invalid updates and names each one", async () => {
		mocks.findMany.mockResolvedValue([{ id: FABRIC_ID }]);
		const valid = update(FABRIC_ID, "F-1");
		const invalid = update(OTHER_FABRIC_ID, "F-2");

		const result = await holdBackInvalidUpdateTargets("example-project", [
			create,
			valid,
			invalid,
		]);

		expect([...result.heldBack]).toEqual([invalid]);
		expect(result.refusals).toEqual([
			"“Example change” can't update F-2: it is not a work item in this project. Pick another target or create a new ticket.",
		]);
	});

	it("refuses the request when every pending item is held back", async () => {
		mocks.findMany.mockResolvedValue([]);

		await expect(
			holdBackInvalidUpdateTargets("example-project", [
				update(FABRIC_ID, "F-1"),
			]),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("can't update F-1"),
		});
	});

	it("holds nothing back when every target is valid", async () => {
		await expect(
			holdBackInvalidUpdateTargets("example-project", [create]),
		).resolves.toEqual({ heldBack: new Set(), refusals: [] });
	});
});

describe("assertProposalItemsUnresolved", () => {
	type GuardInput = Parameters<typeof assertProposalItemsUnresolved>[0];
	const thrownBy = (input: GuardInput): unknown => {
		try {
			assertProposalItemsUnresolved(input);
		} catch (error) {
			return error;
		}
		return undefined;
	};
	const conflict = {
		code: "CONFLICT",
		message: PROPOSAL_ALREADY_ACTIONED_MESSAGE,
	};

	it("refuses an item moved to Rejected, even on a retry", () => {
		expect(
			thrownBy({
				indexes: [0, 2],
				applied: new Set(),
				sourceMetadata: { rejectedChangeIndexes: [2] },
				allowApplied: true,
			}),
		).toMatchObject(conflict);
	});

	it("refuses an applied item outside a retry", () => {
		expect(
			thrownBy({
				indexes: [1],
				applied: new Set([1]),
				sourceMetadata: null,
				allowApplied: false,
			}),
		).toMatchObject(conflict);
	});

	it("lets a retry resubmit applied items and accepts undecided ones", () => {
		expect(
			thrownBy({
				indexes: [0, 1],
				applied: new Set([1]),
				sourceMetadata: { rejectedChangeIndexes: [2] },
				allowApplied: true,
			}),
		).toBeUndefined();
		expect(
			thrownBy({
				indexes: [0],
				applied: new Set([1]),
				sourceMetadata: { rejectedChangeIndexes: [2] },
				allowApplied: false,
			}),
		).toBeUndefined();
	});
});
