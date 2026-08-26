import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks, tx } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const tx = {
		userStory: {
			findUnique: vi.fn(),
			findMany: vi.fn(),
		},
		// The procedure writes roadmapOrder/priority via raw SQL — NOT Prisma
		// `update` — so a drag-reorder never trips the model's `@updatedAt` and
		// reset every reordered peer's "last active" date. `$executeRaw` is a
		// tagged template: it is invoked as (stringsArray, ...interpolatedValues),
		// so the bucket writes are asserted by reading those interpolated values.
		$executeRaw: vi.fn(),
	};
	const mocks = {
		transaction: vi.fn(async (fn: any) => fn(tx)),
		recordAudit: vi.fn(),
		workflowStart: vi.fn(),
		// The shared helper that owns what a band move means (history row +
		// rebase). Mocked here so these tests assert the drag path CALLS it with
		// the right move; its own behaviour is covered in @repo/database.
		recordPriorityMove: vi.fn(),
	};
	return { handlers, mocks, tx };
});

vi.mock("@repo/database", () => ({
	db: { $transaction: mocks.transaction },
	recordPriorityMove: mocks.recordPriorityMove,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart },
	})),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["moveStoryRoadmap"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireInputOrgPermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

await import("../move-story-roadmap");

const ctx = { user: { id: "u-1", name: "A. Diaz" }, session: {} };

const validInput = {
	projectId: "p-1",
	storyId: "story-moved",
	organizationId: null,
	newPriority: "P0_CRITICAL" as const,
	insertBeforeId: "story-existing-2",
};

// Decode the raw-SQL bucket writes (in call order) into a comparable shape. An
// order-only write interpolates (roadmapOrder, id, projectId); the band-move
// write interpolates (priority, roadmapOrder, priorityChangedAt, lastEditedAt,
// lastEditedByName, id, projectId). A 7-value call is the moved story crossing
// lanes, and it is the only
// call that carries a priority and a stamp.
const rawWrites = () =>
	tx.$executeRaw.mock.calls.map((call: unknown[]) => {
		const values = call.slice(1);
		return values.length === 7
			? {
					id: values[5],
					roadmapOrder: values[1],
					priority: values[0],
				}
			: { id: values[1], roadmapOrder: values[0] };
	});

/**
 * The `priorityChangedAt` stamp written alongside the band, or undefined when
 * no call carried one — i.e. when the drag stayed inside one lane.
 */
const bandStamp = () =>
	tx.$executeRaw.mock.calls
		.map((call: unknown[]) => call.slice(1))
		.find((values) => values.length === 7)?.[2] as Date | undefined;

const semanticEditTuple = () => {
	const values = tx.$executeRaw.mock.calls
		.map((call: unknown[]) => call.slice(1))
		.find((candidate) => candidate.length === 7);
	return values
		? { lastEditedAt: values[3], lastEditedByName: values[4] }
		: undefined;
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	tx.userStory.findUnique.mockReset();
	tx.userStory.findMany.mockReset();
	tx.$executeRaw.mockReset();
	tx.$executeRaw.mockResolvedValue(1);
	mocks.transaction.mockImplementation(async (fn: any) => fn(tx));
	// The helper rebases to the bottom of the target band. The drag must ignore
	// that number, so it is deliberately far from any position under test.
	mocks.recordPriorityMove.mockResolvedValue({ roadmapOrder: 99 });
	// Default bucket: full target bucket sorted by (roadmapOrder, id).
	tx.userStory.findMany.mockResolvedValue([
		{ id: "story-existing-1" }, // current roadmapOrder 1
		{ id: "story-existing-2" }, // current roadmapOrder 2
		{ id: "story-existing-3" }, // current roadmapOrder 3
	]);
	tx.userStory.findUnique.mockResolvedValue({
		id: "story-moved",
		title: "Moved Story",
		priority: "P2_MEDIUM",
	});
});

describe("move-story-roadmap — happy path", () => {
	it("inserts before insertBeforeId and rewrites the whole bucket", async () => {
		await handlers.moveStoryRoadmap({ input: validInput, context: ctx });

		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		// findUnique should be project-scoped on the moved story id.
		expect(tx.userStory.findUnique).toHaveBeenCalledWith({
			where: { id: "story-moved", projectId: "p-1" },
			select: expect.objectContaining({
				id: true,
				title: true,
				priority: true,
			}),
		});
		// findMany should target (projectId, priority=newPriority) with the
		// documented tiebreaker order.
		expect(tx.userStory.findMany).toHaveBeenCalledWith({
			where: { projectId: "p-1", priority: "P0_CRITICAL" },
			select: { id: true },
			orderBy: [{ roadmapOrder: "asc" }, { id: "asc" }],
		});

		// Insertion before story-existing-2: result order =
		// [story-existing-1, story-moved, story-existing-2, story-existing-3].
		// Only the moved story carries a priority write; peers are order-only.
		expect(rawWrites()).toEqual([
			{ id: "story-existing-1", roadmapOrder: 1 },
			{ id: "story-moved", roadmapOrder: 2, priority: "P0_CRITICAL" },
			{ id: "story-existing-2", roadmapOrder: 3 },
			{ id: "story-existing-3", roadmapOrder: 4 },
		]);
	});

	it("appends moved story when insertBeforeId is omitted", async () => {
		tx.userStory.findMany.mockResolvedValueOnce([
			{ id: "story-existing-1" },
			{ id: "story-existing-2" },
		]);
		await handlers.moveStoryRoadmap({
			input: {
				projectId: "p-1",
				storyId: "story-moved",
				organizationId: null,
				newPriority: "P0_CRITICAL" as const,
			},
			context: ctx,
		});

		expect(rawWrites()).toEqual([
			{ id: "story-existing-1", roadmapOrder: 1 },
			{ id: "story-existing-2", roadmapOrder: 2 },
			{ id: "story-moved", roadmapOrder: 3, priority: "P0_CRITICAL" },
		]);
	});

	it("appends moved story when insertBeforeId is null", async () => {
		tx.userStory.findMany.mockResolvedValueOnce([
			{ id: "story-existing-1" },
			{ id: "story-existing-2" },
		]);
		await handlers.moveStoryRoadmap({
			input: { ...validInput, insertBeforeId: null },
			context: ctx,
		});

		expect(rawWrites()).toContainEqual({
			id: "story-moved",
			roadmapOrder: 3,
			priority: "P0_CRITICAL",
		});
	});

	it("includes hidden CLOSED peers in the compaction (regression)", async () => {
		// findMany returns the FULL bucket — the procedure must not filter
		// draftingStage, so a CLOSED peer is included.
		tx.userStory.findMany.mockResolvedValueOnce([
			{ id: "story-existing-1" },
			{ id: "story-closed-hidden" },
			{ id: "story-existing-2" },
		]);
		await handlers.moveStoryRoadmap({ input: validInput, context: ctx });

		// findMany must NOT filter by draftingStage.
		const findManyArgs = tx.userStory.findMany.mock.calls[0][0];
		expect(findManyArgs.where).not.toHaveProperty("draftingStage");
		expect(Object.keys(findManyArgs.where)).toEqual(
			expect.arrayContaining(["projectId", "priority"]),
		);

		// insertBeforeId = story-existing-2 ⇒ result:
		// [story-existing-1, story-closed-hidden, story-moved, story-existing-2]
		expect(rawWrites()).toEqual([
			{ id: "story-existing-1", roadmapOrder: 1 },
			{ id: "story-closed-hidden", roadmapOrder: 2 },
			{ id: "story-moved", roadmapOrder: 3, priority: "P0_CRITICAL" },
			{ id: "story-existing-2", roadmapOrder: 4 },
		]);
	});

	it("emits audit with story.title as resource.name and roadmap-drag via", async () => {
		await handlers.moveStoryRoadmap({ input: validInput, context: ctx });
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "story.updated",
				resource: expect.objectContaining({
					id: "story-moved",
					name: "Moved Story",
				}),
				metadata: expect.objectContaining({
					changedFields: ["priority", "roadmapOrder"],
					via: "roadmap-drag",
				}),
			}),
		);
	});

	it("does NOT enqueue PM sync", async () => {
		await handlers.moveStoryRoadmap({ input: validInput, context: ctx });
		await new Promise((r) => setImmediate(r));
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("opens exactly one transaction", async () => {
		await handlers.moveStoryRoadmap({ input: validInput, context: ctx });
		expect(mocks.transaction).toHaveBeenCalledTimes(1);
	});

	it("handles the moved story already being in the target bucket idempotently", async () => {
		// findMany returns a list that already includes the moved id.
		tx.userStory.findMany.mockResolvedValueOnce([
			{ id: "story-existing-1" },
			{ id: "story-moved" },
			{ id: "story-existing-2" },
		]);
		await handlers.moveStoryRoadmap({ input: validInput, context: ctx });

		// insertBeforeId = story-existing-2; moved should land directly before it.
		// Final order: [story-existing-1, story-moved, story-existing-2] — exactly
		// three writes, no duplicate rewrite of the moved story.
		expect(rawWrites()).toEqual([
			{ id: "story-existing-1", roadmapOrder: 1 },
			{ id: "story-moved", roadmapOrder: 2, priority: "P0_CRITICAL" },
			{ id: "story-existing-2", roadmapOrder: 3 },
		]);
	});
});

describe("move-story-roadmap — priority history", () => {
	it("records exactly one MANUAL move, attributed to the dragging user", async () => {
		await handlers.moveStoryRoadmap({ input: validInput, context: ctx });

		expect(mocks.recordPriorityMove).toHaveBeenCalledTimes(1);
		const [client, move] = mocks.recordPriorityMove.mock.calls[0];
		// Same transaction client as the bucket writes: the history row and the
		// band it describes are never observable out of step.
		expect(client).toBe(tx);
		expect(move).toEqual(
			expect.objectContaining({
				storyId: "story-moved",
				projectId: "p-1",
				fromPriority: "P2_MEDIUM",
				toPriority: "P0_CRITICAL",
				source: "MANUAL",
				actorId: "u-1",
				actorName: "A. Diaz",
			}),
		);
	});

	it("stamps priorityChangedAt with the same instant it recorded", async () => {
		await handlers.moveStoryRoadmap({ input: validInput, context: ctx });

		const [, move] = mocks.recordPriorityMove.mock.calls[0];
		expect(bandStamp()).toBeInstanceOf(Date);
		expect(bandStamp()).toEqual(move.changedAt);
		expect(semanticEditTuple()).toEqual({
			lastEditedAt: move.changedAt,
			lastEditedByName: "A. Diaz",
		});
	});

	it("keeps the drop position instead of the helper's rebase", async () => {
		// recordPriorityMove returns roadmapOrder 99 (bottom of the band). The
		// user dragged the card to a specific slot, so the position computed
		// from insertBeforeId must win.
		await handlers.moveStoryRoadmap({ input: validInput, context: ctx });

		expect(rawWrites()).toEqual([
			{ id: "story-existing-1", roadmapOrder: 1 },
			{ id: "story-moved", roadmapOrder: 2, priority: "P0_CRITICAL" },
			{ id: "story-existing-2", roadmapOrder: 3 },
			{ id: "story-existing-3", roadmapOrder: 4 },
		]);
	});

	it("records nothing for a reorder within the same lane", async () => {
		tx.userStory.findUnique.mockResolvedValueOnce({
			id: "story-moved",
			title: "Moved Story",
			priority: "P0_CRITICAL", // already in the target lane
		});

		await handlers.moveStoryRoadmap({ input: validInput, context: ctx });

		// No history row and no stamp — a same-lane drag is a presentation
		// change, and the history stays a record of decisions.
		expect(mocks.recordPriorityMove).not.toHaveBeenCalled();
		expect(bandStamp()).toBeUndefined();
		// The reorder itself still lands, order-only on every row.
		expect(rawWrites()).toEqual([
			{ id: "story-existing-1", roadmapOrder: 1 },
			{ id: "story-moved", roadmapOrder: 2 },
			{ id: "story-existing-2", roadmapOrder: 3 },
			{ id: "story-existing-3", roadmapOrder: 4 },
		]);
		// And the audit says so: order only, not priority — otherwise the log
		// would claim a band change the history (correctly) never recorded.
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				metadata: expect.objectContaining({
					changedFields: ["roadmapOrder"],
					via: "roadmap-drag",
				}),
			}),
		);
	});

	it("snapshots a null actor name when the account has none", async () => {
		await handlers.moveStoryRoadmap({
			input: validInput,
			context: { user: { id: "u-1", name: null }, session: {} },
		});

		const [, move] = mocks.recordPriorityMove.mock.calls[0];
		expect(move.actorName).toBeNull();
	});

	it("records no history when a peer write fails", async () => {
		// The history row is created inside the same transaction, so a failed
		// bucket write must take it down with everything else.
		tx.$executeRaw.mockImplementation((...call: unknown[]) => {
			if (call.slice(1).includes("story-existing-3")) {
				throw new Error("constraint failure");
			}
			return Promise.resolve(1);
		});

		await expect(
			handlers.moveStoryRoadmap({ input: validInput, context: ctx }),
		).rejects.toThrow(/constraint failure/);
		// Same tx client ⇒ the rollback covers the row this asserts was staged.
		const [client] = mocks.recordPriorityMove.mock.calls[0];
		expect(client).toBe(tx);
	});
});

describe("move-story-roadmap — input validation", () => {
	it("rejects with NOT_FOUND when the moved story is missing", async () => {
		tx.userStory.findUnique.mockResolvedValueOnce(null);
		await expect(
			handlers.moveStoryRoadmap({ input: validInput, context: ctx }),
		).rejects.toThrow(/not found in project/i);
	});

	it("writes nothing for a story id belonging to another project", async () => {
		// The findUnique is scoped by projectId, so a borrowed id from another
		// tenant's project resolves to null before anything is written.
		tx.userStory.findUnique.mockResolvedValueOnce(null);

		await expect(
			handlers.moveStoryRoadmap({
				input: { ...validInput, storyId: "story-other-project" },
				context: ctx,
			}),
		).rejects.toThrow(/not found in project/i);

		expect(mocks.recordPriorityMove).not.toHaveBeenCalled();
		expect(tx.$executeRaw).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("rejects with BAD_REQUEST when insertBeforeId is not in the target bucket", async () => {
		tx.userStory.findMany.mockResolvedValueOnce([
			{ id: "story-existing-1" },
			// no story-existing-2 here
			{ id: "story-existing-3" },
		]);
		await expect(
			handlers.moveStoryRoadmap({ input: validInput, context: ctx }),
		).rejects.toThrow(/not present in the target priority bucket/i);

		// The rejected drop never reached the history either.
		expect(mocks.recordPriorityMove).not.toHaveBeenCalled();
	});
});

describe("move-story-roadmap — rollback on peer write failure", () => {
	it("propagates the throw and emits no audit", async () => {
		// Fail when the raw write for story-existing-2 runs (its id is one of the
		// interpolated values of that call).
		tx.$executeRaw.mockImplementation((...call: unknown[]) => {
			const values = call.slice(1);
			if (values.includes("story-existing-2")) {
				throw new Error("constraint failure");
			}
			return Promise.resolve(1);
		});
		await expect(
			handlers.moveStoryRoadmap({ input: validInput, context: ctx }),
		).rejects.toThrow(/constraint failure/);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});
});
