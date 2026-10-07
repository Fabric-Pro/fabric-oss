import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadInstructionChangeDelta } from "../instruction-change-delta";

const h = vi.hoisted(() => ({ files: vi.fn(), intent: vi.fn() }));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	listInstructionFiles: h.files,
	loadGitIntent: h.intent,
}));

const operation = {
	id: "operation_example",
	projectId: "project_example",
	organizationId: "org_example",
	contentKind: "GIT_INTENT" as const,
	baseSnapshotId: null,
};

describe("instruction change sources", () => {
	beforeEach(() => vi.resetAllMocks());
	it("uses only native changed paths, including deletion without stored base bytes", async () => {
		h.intent.mockResolvedValue({
			status: "READY",
			gitIntentEntries: [
				{
					operation: "PUT",
					path: "new.md",
					baseObjectId: null,
					mode: 0o100644,
					storageKey: "changed/new",
					sha256: "a".repeat(64),
				},
				{
					operation: "PUT",
					path: "run.sh",
					baseObjectId: "b".repeat(40),
					mode: 0o100755,
					storageKey: "changed/run",
					sha256: "c".repeat(64),
				},
				{ operation: "DELETE", path: "old.md", baseMode: 0o100644 },
			],
		});
		const delta = await loadInstructionChangeDelta(operation);
		expect(delta.added.map((row) => row.path)).toEqual(["new.md"]);
		expect(delta.modified).toEqual([
			{
				path: "run.sh",
				mode: 0o100755,
				storageKey: "changed/run",
				sha256: "c".repeat(64),
			},
		]);
		expect(delta.deleted).toEqual([{ path: "old.md", mode: 0o100644 }]);
		expect(h.files).not.toHaveBeenCalled();
		expect(h.intent).toHaveBeenCalledWith({
			snapshotId: operation.id,
			projectId: operation.projectId,
			organizationId: operation.organizationId,
		});
	});
	it("refuses native bytes before the receipt is sealed", async () => {
		h.intent.mockResolvedValue({
			status: "RECEIVING",
			gitIntentEntries: [],
		});
		await expect(loadInstructionChangeDelta(operation)).rejects.toThrow();
		expect(h.files).not.toHaveBeenCalled();
	});
	it("preserves the uploaded snapshot's full-tree diff", async () => {
		const before = {
			path: "a.md",
			sha256: "a".repeat(64),
			storageKey: "base/a",
			mode: 0o100644,
		};
		const after = {
			...before,
			sha256: "b".repeat(64),
			storageKey: "changed/a",
		};
		h.files.mockImplementation(async (id) =>
			id === "snapshot_base" ? [before] : [after],
		);
		expect(
			await loadInstructionChangeDelta({
				...operation,
				contentKind: "FULL_SNAPSHOT",
				baseSnapshotId: "snapshot_base",
			}),
		).toEqual({ added: [], modified: [after], deleted: [] });
		expect(h.intent).not.toHaveBeenCalled();
	});
});
