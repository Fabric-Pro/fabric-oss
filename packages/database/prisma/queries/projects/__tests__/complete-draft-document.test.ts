/**
 * `completeDraftDocument` — the way a document written by hand leaves DRAFT.
 *
 * A generation run was the only writer that moved a document to COMPLETE, so
 * one written by hand stayed a draft however often it was saved. Its author
 * now completes it, with the editor's explicit Save or the list's Mark as
 * complete.
 *
 * These tests pin the mechanism, not just the outcome. The decision to
 * complete is taken from a row read earlier, and a generation may have picked
 * the document up since. So the status has to be in the WHERE clause: an
 * implementation that checks the status in memory and then writes by id passes
 * a naive outcome test and still overwrites that run's status.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateManyMock } = vi.hoisted(() => ({
	updateManyMock: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		projectDocument: { updateMany: updateManyMock },
	},
}));

import { completeDraftDocument } from "../documents";

beforeEach(() => {
	vi.clearAllMocks();
	updateManyMock.mockResolvedValue({ count: 1 });
});

describe("completeDraftDocument", () => {
	it("writes COMPLETE only where the document is still a draft, so the database arbitrates", async () => {
		await completeDraftDocument("doc_1");

		expect(updateManyMock).toHaveBeenCalledTimes(1);
		expect(updateManyMock).toHaveBeenCalledWith({
			where: {
				id: "doc_1",
				status: "DRAFT",
				type: { not: "INTEGRATION_CONTRACT" },
			},
			data: { status: "COMPLETE" },
		});
	});

	it("reports that this call completed the draft", async () => {
		await expect(completeDraftDocument("doc_1")).resolves.toBe(true);
	});

	it("reports that it changed nothing when the document had already left DRAFT", async () => {
		// A generation queued it, someone else completed it, or it is an
		// integration contract: the guarded write matches no row.
		updateManyMock.mockResolvedValue({ count: 0 });

		await expect(completeDraftDocument("doc_1")).resolves.toBe(false);
	});
});
