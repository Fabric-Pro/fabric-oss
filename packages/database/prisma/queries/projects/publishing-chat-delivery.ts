import { db } from "../../client";

/**
 * The broadcast ledger's writers, and the cycle-topics reader the broadcast
 * renders from (Fizzy #1850, Phase 1C-3b).
 *
 * Shaped on the newsletter's chat ledger writers in ./newsletter.ts, with one
 * deliberate difference: this table has BOTH a `reason` and an `errorMessage`
 * column, and they are not interchangeable. `reason` is a closed classification
 * an operator can filter a query on; `errorMessage` is whatever the provider
 * said. The newsletter path predates the split and puts its skip classification
 * in `errorMessage`, which is why the same string there is both a reason and an
 * error.
 */
export type PublishingChatDeliveryReason =
	/** The selection names a channel that is no longer linked to the project. */
	| "CHANNEL_NOT_LINKED"
	/** The stored linker whose token would post is no longer an authorized actor. */
	| "LINKER_NOT_AUTHORIZED"
	/** The provider refused the post, or the credential resolution threw. */
	| "POST_FAILED";

/**
 * Claim a channel for this cycle by INSERTING its row.
 *
 * The unique (cycleId, platform, externalTeamId, channelId) index is the ONLY
 * dedupe gate, and the claim is fail-closed: a conflict means some attempt has
 * already handled this channel, so the caller must not post. Chat posts are not
 * idempotent and a duplicate lands in a room full of people.
 *
 * There is deliberately no status term in the refusal. ANY pre-existing row
 * refuses — including a SENDING one, which is the row a crashed attempt leaves
 * behind after the provider accepted the message but before the confirming
 * write landed. Re-posting to be sure would be the wrong trade.
 */
export async function claimPublishingChatDelivery(input: {
	cycleId: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	platform: "TEAMS" | "SLACK";
	externalTeamId: string;
	channelId: string;
	/**
	 * The status to land the row in. Defaults to `SENDING` — the send path,
	 * where the row is a lease taken before the provider is contacted.
	 *
	 * A caller that has ALREADY decided the outcome passes it here instead, so
	 * the decision is one statement rather than a claim followed by a settle.
	 * That is not tidiness: `SENDING` is counted as delivered, so a skip written
	 * as claim-then-settle leaves a row that reads as a delivered broadcast if
	 * anything goes wrong between the two writes — for a channel the send path
	 * never even contacted.
	 */
	status?: "SENDING" | "SKIPPED";
	reason?: PublishingChatDeliveryReason;
}): Promise<{ claimed: boolean }> {
	const status = input.status ?? "SENDING";
	try {
		await db.publishingChatDelivery.create({
			data: {
				cycleId: input.cycleId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				platform: input.platform,
				externalTeamId: input.externalTeamId,
				channelId: input.channelId,
				status,
				reason: input.reason ?? null,
			},
		});
		return { claimed: true };
	} catch (e) {
		if ((e as { code?: string }).code === "P2002") {
			return { claimed: false };
		}
		throw e;
	}
}

/**
 * Settle a claimed row.
 *
 * No status guard, and that is a consequence of the claim rather than an
 * oversight: exactly one attempt ever holds a given row, because every later
 * claim on the same triple is refused. A timed-out attempt that is still
 * running is therefore settling a row no other attempt can also be settling.
 */
export async function markPublishingChatDelivery(input: {
	cycleId: string;
	platform: "TEAMS" | "SLACK";
	externalTeamId: string;
	channelId: string;
	status: "SENT" | "FAILED" | "SKIPPED";
	reason?: PublishingChatDeliveryReason;
	errorMessage?: string;
	postedMessageId?: string;
}): Promise<void> {
	await db.publishingChatDelivery.updateMany({
		where: {
			cycleId: input.cycleId,
			platform: input.platform,
			externalTeamId: input.externalTeamId,
			channelId: input.channelId,
		},
		data: {
			status: input.status,
			reason: input.reason ?? null,
			errorMessage: input.errorMessage ?? null,
			postedMessageId: input.postedMessageId ?? null,
			deliveredAt: input.status === "SENT" ? new Date() : null,
		},
	});
}

export async function listPublishingChatDeliveriesForCycle(cycleId: string) {
	return db.publishingChatDelivery.findMany({
		where: { cycleId },
		select: {
			platform: true,
			externalTeamId: true,
			channelId: true,
			status: true,
			reason: true,
			errorMessage: true,
			postedMessageId: true,
			deliveredAt: true,
		},
	});
}

/**
 * One cycle's chat deliveries, for an API caller (Fizzy #1850, Phase 1C-4b).
 *
 * A separate function from `listPublishingChatDeliveriesForCycle` rather than a
 * widening of it. That one serves the broadcast activity, which has already
 * resolved the tenant and needs `postedMessageId` / `deliveredAt` for its
 * aggregate log line — fields this reader must NOT return. Widening it would
 * force that caller to pass an argument it does not need, to satisfy a caller it
 * knows nothing about.
 *
 * `projectId` is the security boundary. An API caller's `cycleId` is untrusted,
 * so without the bound any authenticated user who can read one project reads
 * another project's ledger by passing that project's cycle id. Note what does
 * NOT participate: the API connects with BYPASSRLS, and this `where` consults
 * neither of the row's denormalized tenant columns — the RLS policy on this
 * table and its isolation suite do not cover this path.
 *
 * ORDERED on the ledger's full identity. A channel id is unique only WITHIN a
 * workspace, so ordering by platform+channelId alone leaves two rows differing
 * only by externalTeamId in unspecified order, and the panel reshuffles them
 * between refetches for no visible reason. `where` pins `cycleId` and all three
 * remaining columns are NOT NULL under a unique index, so this is a total order.
 */
export async function listPublishingChatDeliveriesForProjectCycle(
	cycleId: string,
	projectId: string,
) {
	return db.publishingChatDelivery.findMany({
		// BOTH terms, and the second is the referentially enforced one. The row's
		// own `projectId` is a bare TEXT column with no foreign key and no CHECK
		// tying it to the cycle's project, so on its own the boundary rests on
		// one writer's discipline. `cycle: { projectId }` walks the FK instead —
		// and it makes this reader agree with the `_count` on the cycle-history
		// row, which counts through the relation and never sees the denormalized
		// column. Two readers of the same rows disagreeing about what "belongs to
		// this project" means is the divergence a later backfill would exploit.
		where: { cycleId, projectId, cycle: { projectId } },
		select: {
			platform: true,
			externalTeamId: true,
			channelId: true,
			status: true,
			reason: true,
			errorMessage: true,
			// The panel must distinguish a delivery still in flight from one that
			// was stranded: a row is SENDING for the whole duration of the
			// provider call, and the cycle is already terminal and listed before
			// the broadcast is dispatched.
			createdAt: true,
		},
		orderBy: [
			{ platform: "asc" },
			{ externalTeamId: "asc" },
			{ channelId: "asc" },
		],
	});
}

/**
 * The cycle's topics, in the order the broadcast lists them.
 *
 * ORDERED, and not incidentally: the renderer caps the list, so which topics
 * survive the cap is decided here. `createdAt` then `id` — `createdAt` alone
 * ties for topics inserted by one `createMany`, and a tie broken by nothing is a
 * list whose contents change between two reads of the same cycle.
 */
export async function listPublishingTopicsForCycle(cycleId: string) {
	return db.publishingTopic.findMany({
		where: { cycleId },
		select: { title: true, angle: true },
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
	});
}
