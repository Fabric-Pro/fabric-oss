/**
 * Priority-band change history for the roadmap's Priority view.
 *
 * Every band CHANGE in the product funnels through {@link recordPriorityMove}
 * — directly (updateStory, move-story-roadmap) or via
 * {@link applyPriorityChanges} (setPriority, the AI re-prioritize batch) — so
 * the trail can never drift from the field it describes. Story CREATES set an
 * initial band with no history row by design ("Created as" is derived, see
 * listStoryPriorityHistory). The invariant that makes the history readable —
 * and the one the product explicitly asked for — is that a row exists only
 * when the band actually MOVED. A re-prioritization pass that agrees with the
 * current band writes nothing, so the history stays a record of decisions
 * rather than a log of every time the ranker ran.
 */

import {
	db,
	type PriorityChangeSource,
	type Prisma,
	type StoryPriority,
} from "../../client";

/** The subset of the client both a transaction and `db` satisfy. */
type PriorityTx = Pick<
	Prisma.TransactionClient,
	"storyPriorityChange" | "userStory"
>;

/**
 * Record ONE band move and compute the roadmap rank it should land on, inside
 * the caller's transaction.
 *
 * This is the single implementation of what a priority move means, shared by
 * `updateStory` (which changes priority alongside other fields) and
 * {@link applyPriorityChanges} (which changes many at once). Keeping it in one
 * place is what stops the two paths drifting on the two rules that matter: a
 * move rebases `roadmapOrder` into the bottom of its new band, and a move —
 * only a real move — writes exactly one history row.
 */
export async function recordPriorityMove(
	tx: PriorityTx,
	{
		storyId,
		projectId,
		fromPriority,
		toPriority,
		source,
		reason,
		actorId,
		actorName,
		changedAt,
	}: {
		storyId: string;
		projectId: string;
		fromPriority: StoryPriority | null;
		toPriority: StoryPriority;
		source: PriorityChangeSource;
		reason?: string | null;
		actorId?: string | null;
		actorName?: string | null;
		changedAt: Date;
	},
): Promise<{ roadmapOrder: number }> {
	// Read Committed lets two concurrent moves compute the same max+1; the
	// duplicate is resolved by the client-side id tiebreaker (roadmap-sorts.ts).
	const maxAgg = await tx.userStory.aggregate({
		where: { projectId, priority: toPriority },
		_max: { roadmapOrder: true },
	});

	await tx.storyPriorityChange.create({
		data: {
			storyId,
			projectId,
			fromPriority,
			toPriority,
			source,
			reason: reason?.trim() || null,
			actorId: actorId ?? null,
			actorName: actorName ?? null,
			createdAt: changedAt,
		},
	});

	return { roadmapOrder: (maxAgg._max.roadmapOrder ?? 0) + 1 };
}

/** One requested band change, before the no-op diff is applied. */
export type PriorityChangeRequest = {
	storyId: string;
	/** The band to move to. Equal-to-current requests are dropped. */
	toPriority: StoryPriority;
	/** AI rationale or the author's optional comment. */
	reason?: string | null;
};

export type PriorityChangeActor = {
	id: string | null;
	/** Snapshotted so a deleted user still reads as a person. */
	name: string | null;
};

/** What actually moved, for the caller's audit metadata and UI response. */
export type AppliedPriorityChange = {
	storyId: string;
	fromPriority: StoryPriority;
	toPriority: StoryPriority;
};

/**
 * Apply a batch of band changes and record one history row per real move.
 *
 * Returns only the changes that were applied: callers use it to report "3 of 40
 * items changed" and to skip audit noise when a run was a no-op. Ids that don't
 * belong to `projectId` are ignored rather than throwing — the batch is
 * best-effort by design (an AI pass may name a story that was deleted mid-run),
 * and the projectId predicate is what keeps it tenant-safe.
 *
 * Runs in a transaction so the story rows, their `priorityChangedAt` stamps and
 * the history rows can never be observed out of step.
 */
export async function applyPriorityChanges(
	projectId: string,
	requests: PriorityChangeRequest[],
	source: PriorityChangeSource,
	actor: PriorityChangeActor,
): Promise<AppliedPriorityChange[]> {
	if (requests.length === 0) {
		return [];
	}

	// Collapse duplicate ids (last write wins) so a malformed batch can't
	// produce two history rows for one story in a single pass.
	const byId = new Map<string, PriorityChangeRequest>();
	for (const request of requests) {
		byId.set(request.storyId, request);
	}

	const current = await db.userStory.findMany({
		where: { id: { in: [...byId.keys()] }, projectId },
		select: { id: true, priority: true },
	});

	// The no-op filter — the whole point of the table.
	const applied: AppliedPriorityChange[] = [];
	for (const story of current) {
		const request = byId.get(story.id);
		if (!request || request.toPriority === story.priority) {
			continue;
		}
		applied.push({
			storyId: story.id,
			fromPriority: story.priority,
			toPriority: request.toPriority,
		});
	}

	if (applied.length === 0) {
		return [];
	}

	// Deterministic lock order: `current` comes back in arbitrary DB order, and
	// two concurrent batches locking overlapping story rows in different orders
	// is a textbook deadlock. Sorting by id makes every batch acquire locks in
	// the same sequence, so the loser just waits instead of aborting.
	applied.sort((a, b) => (a.storyId < b.storyId ? -1 : 1));

	const changedAt = new Date();

	// One transaction for the whole batch, so a partially re-prioritized project
	// is never observable. Each move goes through `recordPriorityMove`, the same
	// helper `updateStory` uses — including its rebase, which is why the moves
	// are applied in sequence rather than in parallel: two items landing in the
	// same band must take consecutive ranks, not the same one.
	await db.$transaction(
		async (tx) => {
			for (const change of applied) {
				const reason = byId.get(change.storyId)?.reason;
				const { roadmapOrder } = await recordPriorityMove(tx, {
					storyId: change.storyId,
					projectId,
					fromPriority: change.fromPriority,
					toPriority: change.toPriority,
					source,
					reason,
					actorId: actor.id,
					actorName: actor.name,
					changedAt,
				});
				await tx.userStory.updateMany({
					where: { id: change.storyId, projectId },
					data: {
						priority: change.toPriority,
						priorityChangedAt: changedAt,
						// Mirror the rationale for the inline row "why".
						priorityChangeReason: reason?.trim() || null,
						roadmapOrder,
						lastEditedAt: changedAt,
						lastEditedByName: actor.name,
						lastEditedSource:
							source === "AI" ? "AI_BACKLOG_UPDATE" : "MANUAL",
					},
				});
			}
		},
		// A 100-move AI run is ~300 sequential statements; Prisma's default 5s
		// interactive-transaction timeout can abort it AFTER the model call was
		// billed. Sized for the cap with headroom — a bound, not a target.
		{ timeout: 30_000 },
	);

	return applied;
}

export type PriorityHistoryEntry = {
	id: string;
	fromPriority: StoryPriority | null;
	toPriority: StoryPriority;
	source: PriorityChangeSource;
	reason: string | null;
	actorId: string | null;
	actorName: string | null;
	actorImage: string | null;
	createdAt: Date;
};

/**
 * One story's history, newest first, cursor-paginated.
 *
 * Cursor semantics mirror the roadmap's other history surfaces: the cursor is
 * the last row's id, and `nextCursor` is null on the final page. The
 * `(storyId, createdAt DESC)` index serves this directly.
 */
export async function listStoryPriorityHistory({
	storyId,
	projectId,
	cursor,
	limit,
}: {
	storyId: string;
	projectId: string;
	cursor?: string | null;
	limit: number;
}): Promise<{
	items: PriorityHistoryEntry[];
	nextCursor: string | null;
	/**
	 * The band the item was created with, or null when it has never moved.
	 *
	 * Derived rather than stored: the OLDEST change row's `fromPriority` is by
	 * definition what the item was before anything touched it. That makes the
	 * "Created as X" anchor correct for items that predate this table too — they
	 * have no rows, so the caller falls back to the current band, which is
	 * exactly right for something that has never been re-banded.
	 */
	initialPriority: StoryPriority | null;
	/** Total rows, so the UI can say "view all 12" without walking the pages. */
	totalCount: number;
}> {
	// Over-fetch by one to learn whether another page exists without a count.
	const rows = await db.storyPriorityChange.findMany({
		where: { storyId, projectId },
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: limit + 1,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		select: {
			id: true,
			fromPriority: true,
			toPriority: true,
			source: true,
			reason: true,
			actorId: true,
			actorName: true,
			createdAt: true,
			actor: { select: { name: true, image: true } },
		},
	});

	// Both are cheap and index-served: a count on (storyId, createdAt) and a
	// single-row lookup at the far end of the same index.
	const [totalCount, oldest] = await Promise.all([
		db.storyPriorityChange.count({ where: { storyId, projectId } }),
		db.storyPriorityChange.findFirst({
			where: { storyId, projectId },
			orderBy: [{ createdAt: "asc" }, { id: "asc" }],
			select: { fromPriority: true },
		}),
	]);

	const page = rows.slice(0, limit);
	return {
		totalCount,
		initialPriority: oldest?.fromPriority ?? null,
		items: page.map((row) => ({
			id: row.id,
			fromPriority: row.fromPriority,
			toPriority: row.toPriority,
			source: row.source,
			reason: row.reason,
			actorId: row.actorId,
			// Prefer the live user's current name; fall back to the snapshot
			// taken at write time when the account is gone.
			actorName: row.actor?.name ?? row.actorName,
			actorImage: row.actor?.image ?? null,
			createdAt: row.createdAt,
		})),
		nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
	};
}
