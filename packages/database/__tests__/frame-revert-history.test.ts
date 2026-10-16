/**
 * Reverting a frame is an edit like any other, and it keeps what it replaced.
 *
 * Every history entry holds the content the edit overwrote, so "version N" is
 * "the page before the Nth change". A revert that stored the content it
 * restored instead would leave nothing to go back to: the page it replaced, the
 * one the person was looking at a moment ago, would be gone.
 *
 * The history row and the content update stand or fall together, so a revert
 * whose update fails leaves no version nobody saw. The store here stages what a
 * transaction writes and keeps it only if the transaction finishes; Postgres
 * itself, and the row lock, are not exercised.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
	frames: [] as Row[],
	history: [] as Row[],
	failFrameUpdate: false,
	transactions: 0,
	directWrites: 0,
	locks: [] as unknown[][],
	events: [] as string[],
}));

vi.mock("../prisma/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prisma/client")>();

	const bare = () => {
		store.directWrites += 1;
		throw new Error("revert wrote outside its transaction");
	};

	return {
		...actual,
		db: {
			agentWorkspaceFile: { update: bare, findFirst: bare },
			frameEditHistory: { create: bare, findMany: bare },
			$transaction: async <T>(
				body: (tx: Record<string, unknown>) => Promise<T>,
			): Promise<T> => {
				store.transactions += 1;
				const stagedHistory: Row[] = [];
				const stagedFrames = store.frames.map((row) => ({ ...row }));
				const tx = {
					$queryRaw: async (...args: unknown[]) => {
						store.locks.push(args);
						store.events.push("lock");
						return [];
					},
					frameEditHistory: {
						findMany: async ({
							where,
							skip = 0,
							take,
						}: {
							where: { frameId: string };
							skip?: number;
							take?: number;
						}) =>
							[...store.history, ...stagedHistory]
								.filter((e) => e.frameId === where.frameId)
								.sort(
									(a, b) =>
										(a.editedAt as Date).getTime() -
										(b.editedAt as Date).getTime(),
								)
								.slice(
									skip,
									take === undefined
										? undefined
										: skip + take,
								),
						create: async ({ data }: { data: Row }) => {
							store.events.push("history");
							const entry = {
								id: `edit-${store.history.length + stagedHistory.length + 1}`,
								editedAt: new Date(
									Date.UTC(2026, 9, 2) +
										stagedHistory.length * 1000,
								),
								oldString: null,
								newString: null,
								...data,
							};
							stagedHistory.push(entry);
							return entry;
						},
					},
					agentWorkspaceFile: {
						findFirst: async ({ where }: { where: Row }) =>
							stagedFrames.find((row) =>
								Object.entries(where).every(
									([key, condition]) =>
										key === "fileType"
											? (
													condition as {
														in: unknown[];
													}
												).in.includes(row.fileType)
											: (row[key] ?? null) ===
												(condition ?? null),
								),
							) ?? null,
						update: async ({
							where,
							data,
						}: {
							where: { id: string };
							data: Row;
						}) => {
							store.events.push("update");
							if (store.failFrameUpdate) {
								throw new Error("the update failed");
							}
							const row = stagedFrames.find(
								(r) => r.id === where.id,
							);
							if (!row) {
								throw new Error("no such frame");
							}
							return Object.assign(row, data);
						},
					},
				};
				const result = await body(tx);
				store.history.push(...stagedHistory);
				for (const staged of stagedFrames) {
					const row = store.frames.find((r) => r.id === staged.id);
					if (row) {
						Object.assign(row, staged);
					}
				}
				return result;
			},
		},
	};
});

const { revertFrameToVersion } = await import(
	"../prisma/queries/frame-edit-history"
);

function document(title: string, tools?: string[]) {
	return JSON.stringify(
		{
			version: 1,
			kind: "frame",
			title,
			blocks: [{ id: "page", type: "html", content: `<p>${title}</p>` }],
			metadata: tools ? { runtime: { tools } } : {},
		},
		null,
		2,
	);
}

const CURRENT = document("Now", ["fabric_page_data_get"]);
const BEFORE_FIRST_EDIT = document("Original", ["fabric_page_data_get"]);

const input = {
	frameId: "frame-1",
	userId: "user-1",
	organizationId: "org-1",
	toVersion: 1,
};

function firstEdit(snapshot: string | null = BEFORE_FIRST_EDIT): Row {
	return {
		id: "edit-1",
		frameId: "frame-1",
		editType: "full_update",
		oldString: null,
		newString: null,
		contentSnapshot: snapshot,
		editedBy: "user-1",
		editedAt: new Date("2026-10-01T00:00:00Z"),
		revertedToVersion: null,
	};
}

beforeEach(() => {
	store.frames.length = 0;
	store.history.length = 0;
	store.frames.push({
		id: "frame-1",
		userId: "user-1",
		organizationId: "org-1",
		fileType: "FRAME",
		content: CURRENT,
		size: CURRENT.length,
	});
	store.history.push(firstEdit());
	store.failFrameUpdate = false;
	store.transactions = 0;
	store.directWrites = 0;
	store.locks.length = 0;
	store.events.length = 0;
});

describe("revertFrameToVersion", () => {
	it("restores the content the chosen version held", async () => {
		const result = await revertFrameToVersion(input);

		expect(result).toEqual({
			success: true,
			newContent: BEFORE_FIRST_EDIT,
		});
		expect(store.frames[0]?.content).toBe(BEFORE_FIRST_EDIT);
		expect(store.frames[0]?.size).toBe(
			Buffer.byteLength(BEFORE_FIRST_EDIT),
		);
	});

	it("records the revert with the content it replaced, so it can be undone", async () => {
		await revertFrameToVersion(input);

		expect(store.history).toHaveLength(2);
		expect(store.history[1]).toMatchObject({
			frameId: "frame-1",
			editType: "revert",
			contentSnapshot: CURRENT,
			revertedToVersion: 1,
			editedBy: "user-1",
		});
	});

	it("takes the page's row lock before it reads anything, then writes history before content", async () => {
		await revertFrameToVersion(input);

		expect(store.events).toEqual(["lock", "history", "update"]);
		expect(store.locks).toHaveLength(1);
	});

	it("does all of it in one transaction", async () => {
		await revertFrameToVersion(input);

		expect(store.transactions).toBe(1);
		expect(store.directWrites).toBe(0);
	});

	it("leaves no history row behind when the content update fails", async () => {
		store.failFrameUpdate = true;

		await expect(revertFrameToVersion(input)).rejects.toThrow(
			"the update failed",
		);

		expect(store.history).toHaveLength(1);
		expect(store.frames[0]?.content).toBe(CURRENT);
	});

	it("changes nothing for a version that holds no snapshot", async () => {
		store.history.length = 0;

		const result = await revertFrameToVersion(input);

		expect(result.success).toBe(false);
		expect(store.history).toEqual([]);
		expect(store.frames[0]?.content).toBe(CURRENT);
	});

	it("changes nothing for a frame the caller does not own", async () => {
		const result = await revertFrameToVersion({
			...input,
			userId: "someone-else",
		});

		expect(result).toEqual({ success: false, error: "Frame not found" });
		expect(store.history).toHaveLength(1);
		expect(store.frames[0]?.content).toBe(CURRENT);
	});

	it("does not reach a frame of another organization", async () => {
		const result = await revertFrameToVersion({
			...input,
			organizationId: "org-2",
		});

		expect(result).toEqual({ success: false, error: "Frame not found" });
		expect(store.history).toHaveLength(1);
	});

	it("does not say whether a version exists to someone who does not own the frame", async () => {
		const result = await revertFrameToVersion({
			...input,
			userId: "someone-else",
			toVersion: 99,
		});

		expect(result).toEqual({ success: false, error: "Frame not found" });
	});

	describe("the Fabric tools the page may call", () => {
		it("keeps the tools declared now, not the ones the old version declared", async () => {
			store.history[0] = firstEdit(
				document("Original", [
					"fabric_page_data_get",
					"fabric_share_frame",
				]),
			);

			await revertFrameToVersion(input);

			const restored = JSON.parse(store.frames[0]?.content as string);
			expect(restored.title).toBe("Original");
			expect(restored.metadata.runtime.tools).toEqual([
				"fabric_page_data_get",
			]);
		});

		it("does not bring back tools to a page that declares none now", async () => {
			store.frames[0] = {
				...store.frames[0],
				content: document("Now"),
			};
			store.history[0] = firstEdit(
				document("Original", ["fabric_share_frame"]),
			);

			await revertFrameToVersion(input);

			const restored = JSON.parse(store.frames[0]?.content as string);
			expect(restored.title).toBe("Original");
			expect(restored.metadata.runtime).toBeUndefined();
		});

		it("restores a version that declared none with the tools declared now", async () => {
			store.history[0] = firstEdit(document("Original"));

			await revertFrameToVersion(input);

			const restored = JSON.parse(store.frames[0]?.content as string);
			expect(restored.metadata.runtime.tools).toEqual([
				"fabric_page_data_get",
			]);
		});

		it("refuses a snapshot that is not a JSON document and changes nothing", async () => {
			store.history[0] = firstEdit("not json at all");

			const result = await revertFrameToVersion(input);

			expect(result).toEqual({
				success: false,
				error: "Version 1 cannot be restored",
			});
			expect(store.history).toHaveLength(1);
			expect(store.frames[0]?.content).toBe(CURRENT);
		});
	});
});
