/**
 * `updateDocument` refuses to change an INTEGRATION_CONTRACT's status
 * (plan Slice 4): contract status is owned by the Discovery run and only
 * `projects.discovery.markContractComplete` may set COMPLETE. Enforced in
 * the query so the oRPC procedure, the v1 REST route and the MCP tool are
 * all covered.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const docFindUniqueMock = vi.fn();
const docUpdateMock = vi.fn();
const versionFindFirstMock = vi.fn();
const versionCreateMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		projectDocument: {
			findUnique: (...args: unknown[]) => docFindUniqueMock(...args),
			update: (...args: unknown[]) => docUpdateMock(...args),
		},
		documentVersion: {
			findFirst: (...args: unknown[]) => versionFindFirstMock(...args),
			create: (...args: unknown[]) => versionCreateMock(...args),
		},
	},
}));

import {
	IntegrationContractStatusManagedError,
	updateDocument,
} from "../prisma/queries/projects/documents";

const contract = {
	id: "doc-1",
	type: "INTEGRATION_CONTRACT",
	status: "REVIEW",
	content: "# contract",
	version: 1,
};

describe("updateDocument — integration contract status guard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		docFindUniqueMock.mockResolvedValue(contract);
		docUpdateMock.mockImplementation(async ({ data }) => ({
			...contract,
			...data,
		}));
		versionFindFirstMock.mockResolvedValue({ id: "v1" });
	});

	it("rejects a status change on an INTEGRATION_CONTRACT before writing", async () => {
		await expect(
			updateDocument("doc-1", { status: "COMPLETE", userId: "u1" }),
		).rejects.toBeInstanceOf(IntegrationContractStatusManagedError);
		expect(docUpdateMock).not.toHaveBeenCalled();
	});

	it("allows content edits on a contract and never writes an unchanged status", async () => {
		await updateDocument("doc-1", {
			content: "# contract, edited",
			status: "REVIEW",
			userId: "u1",
		});
		expect(docUpdateMock).toHaveBeenCalledTimes(1);
		// Not written: a save racing `markContractComplete` must not put
		// REVIEW back over COMPLETE.
		expect(docUpdateMock.mock.calls[0][0].data).not.toHaveProperty(
			"status",
		);
		expect(docUpdateMock.mock.calls[0][0].data.content).toBe(
			"# contract, edited",
		);
	});

	it("cannot put REVIEW back when a completion lands between the pre-read and the write", async () => {
		// Sequence: generic save reads REVIEW → markContractComplete writes
		// COMPLETE → generic save writes. Because the (unchanged) status is
		// never part of the generic write, the row stays COMPLETE.
		let row = { ...contract };
		docFindUniqueMock.mockImplementation(async () => ({ ...row }));
		docUpdateMock.mockImplementation(async ({ data }) => {
			row = { ...row, ...data };
			return row;
		});
		const pending = updateDocument("doc-1", {
			content: "# contract, edited",
			status: "REVIEW",
			userId: "u1",
		});
		// The completion wins the race after the pre-read.
		row = { ...row, status: "COMPLETE" };
		await pending;
		expect(row.status).toBe("COMPLETE");
		expect(row.content).toBe("# contract, edited");
	});

	it("lets other document types change status", async () => {
		docFindUniqueMock.mockResolvedValue({ ...contract, type: "PRD" });
		await updateDocument("doc-1", { status: "COMPLETE", userId: "u1" });
		expect(docUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "COMPLETE" }),
			}),
		);
	});
});
