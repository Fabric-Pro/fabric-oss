/**
 * `getInstructionSnapshotWithPublishedPointer` — the combined read
 * `submitInstructionChange`'s final response is built from (Fizzy #2606,
 * third delta review).
 *
 * Two things pinned here, both from that review:
 *
 *  - the lookup is tenant-scoped on BOTH reads: the project row itself
 *    (`id` AND `organizationId`) and the snapshot relation it nests
 *    (`id` AND `organizationId` again), the same convention
 *    `getInstructionProposal` uses;
 *  - `publishedInstructionSnapshotId` is a foreign key to a snapshot id
 *    alone, with no query-level constraint tying that snapshot back to the
 *    project or organization it is read through — so a malformed or
 *    cross-tenant row must be caught by the function itself rather than
 *    handed back as if it belonged to this project. A pointer whose
 *    `projectId` or `organizationId` does not match the requested tenant
 *    comes back `null`.
 *
 * This is a unit test of the query module alone: `db.project.findFirst` is
 * mocked directly, following the pattern in `instructions-queries.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	project: { findFirst: vi.fn() },
}));

vi.mock("../prisma/client", () => ({
	db: { project: mocks.project },
}));

import { getInstructionSnapshotWithPublishedPointer } from "../prisma/queries/instructions";

const PROJECT = "proj_1";
const ORG = "org_1";
const SNAPSHOT_ID = "snap_new";

/** A `summarySelect`-shaped row, trimmed to the fields this module reads. */
function summaryRow(overrides: Record<string, unknown> = {}) {
	return {
		id: SNAPSHOT_ID,
		projectId: PROJECT,
		organizationId: ORG,
		version: 8,
		status: "READY",
		proposalStatus: null,
		baseVersion: 7,
		publishedAt: null,
		...overrides,
	};
}

beforeEach(() => {
	mocks.project.findFirst.mockReset();
});

describe("tenant scoping", () => {
	it("passes organizationId on both the project lookup and the snapshot relation filter", async () => {
		mocks.project.findFirst.mockResolvedValue({
			publishedInstructionSnapshot: null,
			instructionSnapshots: [],
		});

		await getInstructionSnapshotWithPublishedPointer(
			SNAPSHOT_ID,
			PROJECT,
			ORG,
		);

		expect(mocks.project.findFirst).toHaveBeenCalledTimes(1);
		const call = mocks.project.findFirst.mock.calls[0]?.[0];
		expect(call.where).toEqual({ id: PROJECT, organizationId: ORG });
		expect(call.select.instructionSnapshots.where).toEqual({
			id: SNAPSHOT_ID,
			organizationId: ORG,
		});
	});
});

describe("the cross-tenant pointer guard", () => {
	it("returns the published pointer when its projectId and organizationId both match", async () => {
		mocks.project.findFirst.mockResolvedValue({
			publishedInstructionSnapshot: summaryRow({
				id: "snap_pointer",
				version: 9,
			}),
			instructionSnapshots: [summaryRow()],
		});

		const result = await getInstructionSnapshotWithPublishedPointer(
			SNAPSHOT_ID,
			PROJECT,
			ORG,
		);

		expect(result.publishedPointer?.id).toBe("snap_pointer");
	});

	// The case the review added: the relation has no query-level tenant
	// constraint of its own, so a row whose OWN projectId disagrees with the
	// project it was read through must not be trusted just because Prisma
	// followed the foreign key there.
	it("returns null for a pointer whose projectId does not match the requested project", async () => {
		mocks.project.findFirst.mockResolvedValue({
			publishedInstructionSnapshot: summaryRow({
				id: "snap_pointer",
				projectId: "proj_other",
			}),
			instructionSnapshots: [summaryRow()],
		});

		const result = await getInstructionSnapshotWithPublishedPointer(
			SNAPSHOT_ID,
			PROJECT,
			ORG,
		);

		expect(result.publishedPointer).toBeNull();
	});

	it("returns null for a pointer whose organizationId does not match the requested organization", async () => {
		mocks.project.findFirst.mockResolvedValue({
			publishedInstructionSnapshot: summaryRow({
				id: "snap_pointer",
				organizationId: "org_other",
			}),
			instructionSnapshots: [summaryRow()],
		});

		const result = await getInstructionSnapshotWithPublishedPointer(
			SNAPSHOT_ID,
			PROJECT,
			ORG,
		);

		expect(result.publishedPointer).toBeNull();
	});
});

describe("a project the lookup cannot find", () => {
	it("yields both snapshot and publishedPointer as null", async () => {
		mocks.project.findFirst.mockResolvedValue(null);

		const result = await getInstructionSnapshotWithPublishedPointer(
			SNAPSHOT_ID,
			PROJECT,
			ORG,
		);

		expect(result).toEqual({ snapshot: null, publishedPointer: null });
	});
});
