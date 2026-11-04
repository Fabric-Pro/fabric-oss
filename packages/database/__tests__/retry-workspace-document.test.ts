import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	update: vi.fn(),
	deleteChunks: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		workspaceDocument: {
			findUnique: mocks.findUnique,
			update: mocks.update,
		},
		workspaceDocumentChunk: { deleteMany: mocks.deleteChunks },
	},
}));

vi.mock("../prisma/queries/workspaces/workspaces", () => ({
	canEditWorkspace: vi.fn(async () => true),
	canDeleteInWorkspace: vi.fn(),
	hasDocumentCapacity: vi.fn(),
}));

import { retryFailedDocument } from "../prisma/queries/workspaces/documents";

it("keeps existing vector ids and count when resetting a failed document for retry", async () => {
	const row = {
		id: "example-document",
		workspaceId: "example-workspace",
		status: "FAILED",
		qdrantPointIds: ["example-point-0", "example-point-1"],
		chunkCount: 2,
	};
	mocks.findUnique.mockResolvedValue({
		workspaceId: row.workspaceId,
		status: row.status,
	});
	mocks.deleteChunks.mockResolvedValue({ count: 0 });
	mocks.update.mockImplementation(async ({ data }) =>
		Object.assign(row, data),
	);

	const result = await retryFailedDocument(
		"example-document",
		"example-user",
	);

	expect(result.status).toBe("UPLOADED");
	expect(result.qdrantPointIds).toEqual([
		"example-point-0",
		"example-point-1",
	]);
	expect(result.chunkCount).toBe(2);
});
