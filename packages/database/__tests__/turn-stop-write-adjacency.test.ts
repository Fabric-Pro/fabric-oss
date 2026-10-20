/**
 * Story creation and the frame writes check the ambient dispatch guard
 * (`@repo/utils/dispatch-guard`) immediately before each write they make,
 * with no `await` between the check and the write.
 *
 * Inside an Advisor chat turn the guard throws once the turn has stopped.
 * Each helper here awaits a read before it writes (the default status, the
 * column order, the story's own row, the frame it updates), so a check at
 * its call site leaves that read between the check and the write: a stop
 * that lands during the read let the write through. The guard here latches
 * its stop during exactly that read. Outside a guard nothing changes.
 *
 * The store is faked: these pin which writes are issued, not Postgres. The
 * transaction callback throwing before it returns is what makes Prisma roll
 * the transaction back, so nothing it already ran inside commits.
 */

import { runWithDispatchGuard } from "@repo/utils/dispatch-guard";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	stopped: false,
	/** Runs inside the named read; the test latches the stop there. */
	during: {} as Record<string, (() => void) | undefined>,
	statusFindFirst: vi.fn(),
	statusCreateMany: vi.fn(),
	transaction: vi.fn(),
	allocate: vi.fn(),
	orderFindFirst: vi.fn(),
	storyCreate: vi.fn(),
	storyUpdate: vi.fn(),
	projectFindUnique: vi.fn(),
	organizationFindUnique: vi.fn(),
	frameFindFirst: vi.fn(),
	frameUpdate: vi.fn(),
	frameHistoryCreate: vi.fn(),
}));

async function reading<T>(name: string, value: T): Promise<T> {
	await Promise.resolve();
	h.during[name]?.();
	return value;
}

vi.mock("../prisma/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prisma/client")>();
	const tx = {
		$queryRaw: h.allocate,
		userStory: { findFirst: h.orderFindFirst, create: h.storyCreate },
		agentWorkspaceFile: { update: h.frameUpdate },
		frameEditHistory: { create: h.frameHistoryCreate },
	};
	h.transaction.mockImplementation(
		async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
	);
	return {
		...actual,
		db: {
			projectStoryStatus: {
				findFirst: h.statusFindFirst,
				createMany: h.statusCreateMany,
			},
			$transaction: h.transaction,
			userStory: { update: h.storyUpdate },
			project: { findUnique: h.projectFindUnique },
			organization: { findUnique: h.organizationFindUnique },
			agentWorkspaceFile: {
				findFirst: h.frameFindFirst,
				update: h.frameUpdate,
			},
			frameEditHistory: { create: h.frameHistoryCreate },
		},
	};
});

const { createStory } = await import("../prisma/queries/projects/stories");
const { publishFrame, updateFrame } = await import("../prisma/queries/frames");

const STOP = new Error("the chat turn stopped");

/** The turn guard: throws its stop once it has latched one. */
const guard = {
	key: "turn-example-1",
	assertDispatchable: async () => undefined,
	abortSignal: () => undefined,
	rethrowIfStopped: () => {
		if (h.stopped) {
			throw STOP;
		}
	},
	throwIfStopped: () => {
		if (h.stopped) {
			throw STOP;
		}
	},
};

/** Runs `work` in the turn, latching the stop during the named read. */
function inTurn<T>(stopDuring: string | undefined, work: () => Promise<T>) {
	if (stopDuring) {
		h.during[stopDuring] = () => {
			h.stopped = true;
		};
	}
	return runWithDispatchGuard(guard, work).then(
		(value) => ({ resolvedWith: value }),
		(error: unknown) => error,
	);
}

const STORY_ROW = {
	id: "story-example-1",
	identifier: "7",
	title: "Saved searches",
	description: "Let people save a search.",
	acceptanceCriteria: null,
	statusId: "status-example-1",
};

const FRAME_ROW = {
	id: "frame-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
	projectId: null,
	name: "Plan.frame.json",
	path: "frames/plan.frame.json",
	content: JSON.stringify(
		{
			version: 1,
			kind: "frame",
			title: "Plan",
			blocks: [{ id: "block-1", type: "markdown", content: "# Plan" }],
			metadata: {},
		},
		null,
		2,
	),
	isPublic: false,
	shareToken: null,
	fileType: "FRAME",
	createdAt: new Date("2026-10-01T00:00:00Z"),
	updatedAt: new Date("2026-10-01T00:00:00Z"),
};

beforeEach(() => {
	h.stopped = false;
	h.during = {};
	for (const mock of [
		h.statusFindFirst,
		h.statusCreateMany,
		h.allocate,
		h.orderFindFirst,
		h.storyCreate,
		h.storyUpdate,
		h.projectFindUnique,
		h.organizationFindUnique,
		h.frameFindFirst,
		h.frameUpdate,
		h.frameHistoryCreate,
	]) {
		mock.mockReset();
	}
	h.transaction.mockClear();
	// A project without seeded statuses: createStory bootstraps them.
	h.statusFindFirst
		.mockImplementationOnce(() => reading("default status lookup", null))
		.mockImplementation(async () => ({ id: "status-example-1" }));
	h.statusCreateMany.mockResolvedValue({ count: 4 });
	h.allocate.mockResolvedValue([{ allocated: 7 }]);
	h.orderFindFirst.mockImplementation(() =>
		reading("column order lookup", { order: 3 }),
	);
	h.storyCreate.mockImplementation(() => reading("insert", STORY_ROW));
	h.projectFindUnique.mockImplementation(() =>
		reading("back-link project read", { organizationId: null }),
	);
	h.storyUpdate.mockResolvedValue(STORY_ROW);
	h.organizationFindUnique.mockResolvedValue({
		canShareFramesPublicly: true,
	});
	h.frameFindFirst.mockImplementation(() => reading("frame read", FRAME_ROW));
	h.frameUpdate.mockResolvedValue(FRAME_ROW);
	h.frameHistoryCreate.mockResolvedValue({});
});

const create = () =>
	createStory({
		projectId: "project-example-1",
		title: "Saved searches",
		description: "Let people save a search.",
		createdById: "user-example-1",
		source: "CUSTOM_AGENT",
	});

describe("createStory inside a chat turn", () => {
	it("creates the story when nothing stops the turn", async () => {
		const outcome = await inTurn(undefined, create);
		expect(outcome).toMatchObject({
			resolvedWith: { id: "story-example-1" },
		});
		expect(h.statusCreateMany).toHaveBeenCalledTimes(1);
		expect(h.allocate).toHaveBeenCalledTimes(1);
		expect(h.storyCreate).toHaveBeenCalledTimes(1);
	});

	it("bootstraps no statuses and opens no transaction when the turn stops during the default-status lookup", async () => {
		const outcome = await inTurn("default status lookup", create);
		expect(outcome).toBe(STOP);
		expect(h.statusCreateMany).not.toHaveBeenCalled();
		expect(h.allocate).not.toHaveBeenCalled();
		expect(h.storyCreate).not.toHaveBeenCalled();
	});

	it("inserts no row when the turn stops during the column-order lookup, and fails the transaction so the identifier it took rolls back", async () => {
		const outcome = await inTurn("column order lookup", create);
		expect(outcome).toBe(STOP);
		expect(h.storyCreate).not.toHaveBeenCalled();
		await expect(h.transaction.mock.results[0]?.value).rejects.toBe(STOP);
	});

	it("fails the transaction before it commits when the turn stops while the row is inserted", async () => {
		const outcome = await inTurn("insert", create);
		expect(outcome).toBe(STOP);
		await expect(h.transaction.mock.results[0]?.value).rejects.toBe(STOP);
		expect(h.storyUpdate).not.toHaveBeenCalled();
	});

	it("writes no back-link when the turn stops while the story's project is read for it", async () => {
		const outcome = await inTurn("back-link project read", create);
		expect(outcome).toBe(STOP);
		expect(h.storyUpdate).not.toHaveBeenCalled();
	});

	it("is unchanged outside a chat turn", async () => {
		await expect(create()).resolves.toMatchObject({
			id: "story-example-1",
		});
		expect(h.storyCreate).toHaveBeenCalledTimes(1);
	});
});

describe("frame writes inside a chat turn", () => {
	it("updates the frame when nothing stops the turn", async () => {
		const outcome = await inTurn(undefined, () =>
			updateFrame({
				id: FRAME_ROW.id,
				userId: FRAME_ROW.userId,
				organizationId: FRAME_ROW.organizationId,
				title: "Plan v2",
			}),
		);
		expect(outcome).toMatchObject({ resolvedWith: { id: FRAME_ROW.id } });
		expect(h.frameUpdate).toHaveBeenCalledTimes(1);
	});

	it("does not update the frame when the turn stops while it is read", async () => {
		const outcome = await inTurn("frame read", () =>
			updateFrame({
				id: FRAME_ROW.id,
				userId: FRAME_ROW.userId,
				organizationId: FRAME_ROW.organizationId,
				title: "Plan v2",
			}),
		);
		expect(outcome).toBe(STOP);
		expect(h.frameUpdate).not.toHaveBeenCalled();
		expect(h.frameHistoryCreate).not.toHaveBeenCalled();
	});

	it("keeps the previous content as a revertible snapshot before it updates the frame", async () => {
		await inTurn(undefined, () =>
			updateFrame({
				id: FRAME_ROW.id,
				userId: FRAME_ROW.userId,
				organizationId: FRAME_ROW.organizationId,
				title: "Plan v2",
			}),
		);
		expect(h.frameHistoryCreate).toHaveBeenCalledTimes(1);
		expect(h.frameHistoryCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				frameId: FRAME_ROW.id,
				editType: "full_update",
				contentSnapshot: FRAME_ROW.content,
				editedBy: FRAME_ROW.userId,
			}),
		});
		expect(h.frameHistoryCreate.mock.invocationCallOrder[0]).toBeLessThan(
			h.frameUpdate.mock.invocationCallOrder[0],
		);
		expect(h.transaction).toHaveBeenCalledTimes(1);
	});

	it("records no snapshot when an update leaves the content as it was", async () => {
		await inTurn(undefined, () =>
			updateFrame({
				id: FRAME_ROW.id,
				userId: FRAME_ROW.userId,
				organizationId: FRAME_ROW.organizationId,
				title: "Plan",
			}),
		);
		expect(h.frameHistoryCreate).not.toHaveBeenCalled();
		expect(h.frameUpdate).toHaveBeenCalledTimes(1);
	});

	it("does not publish the frame when the turn stops while it is read", async () => {
		const outcome = await inTurn("frame read", () =>
			publishFrame({
				id: FRAME_ROW.id,
				userId: FRAME_ROW.userId,
				organizationId: FRAME_ROW.organizationId,
			}),
		);
		expect(outcome).toBe(STOP);
		expect(h.frameUpdate).not.toHaveBeenCalled();
	});
});
