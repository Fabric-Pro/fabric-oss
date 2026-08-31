/**
 * The publishing topic decision thread (Publishing Suite Phase 2A-3, #1851).
 *
 * Reconciliation is the load-bearing idea here. A topic's questions are not
 * written once; every regeneration of the Planning & Analysis re-derives them,
 * and the user may have answered some in between. This is a FOUR-way branch —
 * not the three the design spec describes, and not the Feature Decision Log's
 * three either (`answer-question.ts`, AC-2.4):
 *
 *  - RESOLVED — left alone. The user already answered it; re-opening it would
 *    discard that answer from the open list.
 *  - OPEN — refreshed in place. Wording and recommendation may have improved,
 *    but the identity, and therefore the row, is the same decision.
 *  - POSSIBLY_RESOLVED — REACTIVATED to OPEN. This is the branch a three-way
 *    reading misses. The `POSSIBLY_RESOLVED` value in `enum DecisionStatus`
 *    documents itself as "auto-reactivated to OPEN if it reappears in a later
 *    refresh" — and
 *    the partial unique index on `(topicId, questionId)` means there is no
 *    second chance: treating it as settled the way RESOLVED is treated would
 *    leave a decision the analysis is asking for AGAIN permanently
 *    unanswerable, because no second root can ever be minted to replace it.
 *  - a live OPEN root the new analysis no longer raises — soft-closed to
 *    POSSIBLY_RESOLVED rather than deleted, because a dropped question is weak
 *    evidence that the decision went away and the row must stay restorable.
 */

import { db } from "../../client";

/** The subset of a resolved analysis question this table needs. */
export interface ReconcilableQuestion {
	questionId: string;
	decisionKind: string;
	subject: string | null;
	question: string;
	recommendedResponse: string | null;
	whyItMatters: string | null;
}

export interface ReconcileOutcome {
	minted: number;
	refreshed: number;
	softClosed: number;
	reactivated: number;
}

/** The transaction handle shape the reconciler needs. */
type DecisionTx = {
	publishingTopicDecisionEntry: {
		findMany: (
			args: unknown,
		) => Promise<
			{ id: string; questionId: string | null; status: string }[]
		>;
		create: (args: unknown) => Promise<unknown>;
		updateMany: (args: unknown) => Promise<{ count: number }>;
	};
};

export async function reconcileTopicQuestions(
	tx: DecisionTx,
	input: {
		topicId: string;
		projectId: string;
		organizationId: string | null;
		userId: string | null;
		analysisVersion: number;
		questions: ReconcilableQuestion[];
	},
): Promise<ReconcileOutcome> {
	// Live roots only. Scoped by projectId as well as topicId (DV16) — a topic id
	// is not a capability, and every read in this file re-scopes.
	const roots = await tx.publishingTopicDecisionEntry.findMany({
		where: {
			topicId: input.topicId,
			projectId: input.projectId,
			parentId: null,
			kind: "QUESTION",
			deletedAt: null,
		},
		select: { id: true, questionId: true, status: true },
	});

	const byQuestionId = new Map(
		roots
			.filter((r) => r.questionId)
			.map((r) => [r.questionId as string, r]),
	);
	const incoming = new Set(input.questions.map((q) => q.questionId));

	const outcome: ReconcileOutcome = {
		minted: 0,
		refreshed: 0,
		softClosed: 0,
		reactivated: 0,
	};

	for (const question of input.questions) {
		const existing = byQuestionId.get(question.questionId);

		// SETTLED BY A PERSON → idempotent. Re-opening a decision the user already
		// made would discard their answer from the open list without deleting
		// anything, which is the worst of both.
		//
		// POSSIBLY_RESOLVED is deliberately NOT in this branch. It was not settled
		// by anyone — reconciliation soft-closed it because an earlier analysis
		// stopped raising it — and the `POSSIBLY_RESOLVED` value in
		// `enum DecisionStatus`'s own contract is that it reactivates when the
		// question reappears. Folding it in with RESOLVED would leave a decision the
		// analysis is asking for AGAIN permanently invisible, and the unique index
		// guarantees no second root can ever be minted to replace it.
		if (
			existing &&
			existing.status !== "OPEN" &&
			existing.status !== "POSSIBLY_RESOLVED"
		) {
			continue;
		}

		if (existing) {
			const reactivating = existing.status === "POSSIBLY_RESOLVED";
			// Refresh in place: wording and recommendation may have improved, but
			// the identity — and therefore the row — is the same decision.
			// Scoped by projectId/topicId as well as id (spec §4.7: every
			// mutation carries {id, projectId}).
			//
			// CLAIM BEFORE WRITE — the mirror image of `answerTopicQuestion`'s own
			// claim below. `existing.status` was read at the top of this function
			// and can be stale by the time this write lands: a concurrent
			// `answerTopicQuestion` can claim this same root RESOLVED in between.
			// An unconditional write here would stomp that claim — reopening a
			// just-answered question (the reactivating branch) or blindly
			// refreshing a row someone just resolved — while the reply the answer
			// inserted survives next to a root that no longer says RESOLVED. So
			// the write is conditional on the SAME status this read observed, via
			// `updateMany` rather than `update` (Prisma's singular `update` has no
			// non-unique-filter form that can fail silently instead of throwing).
			// A lost race (`count === 0`) leaves the root and its fields entirely
			// untouched — someone settled it while this ran, and their answer
			// wins — and is not counted, on purpose: `refreshed`/`reactivated` are
			// supposed to mean writes that actually happened.
			const { count } = await tx.publishingTopicDecisionEntry.updateMany({
				where: {
					id: existing.id,
					projectId: input.projectId,
					topicId: input.topicId,
					status: existing.status,
				},
				data: {
					...(reactivating ? { status: "OPEN" as const } : {}),
					summary: question.question,
					recommendedResponse: question.recommendedResponse,
					whyItMatters: question.whyItMatters,
					// `decisionKind`/`subject` are persisted for identity and
					// provenance, not for display: they are the inputs
					// `deriveQuestionId` hashes to keep this row stable across a
					// regeneration that only rephrases the question, and no FR
					// renders them. Deliberately not read by any UI surface.
					decisionKind: question.decisionKind,
					subject: question.subject,
					analysisVersion: input.analysisVersion,
				},
			});
			if (count === 1) {
				if (reactivating) {
					outcome.reactivated += 1;
				} else {
					outcome.refreshed += 1;
				}
			}
			continue;
		}

		await tx.publishingTopicDecisionEntry.create({
			data: {
				topicId: input.topicId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				parentId: null,
				kind: "QUESTION",
				status: "OPEN",
				// The analysis raised it, so the AGENT authored it. `authorUserId`
				// stays null: the person who clicked Generate did not write the
				// question, and recording them as its author would misattribute it.
				authorType: "AGENT",
				authorUserId: null,
				questionId: question.questionId,
				// See the update branch above: identity/provenance only, never
				// rendered.
				decisionKind: question.decisionKind,
				subject: question.subject,
				summary: question.question,
				recommendedResponse: question.recommendedResponse,
				whyItMatters: question.whyItMatters,
				analysisVersion: input.analysisVersion,
			},
		});
		outcome.minted += 1;
	}

	// Roots the new analysis no longer raises. POSSIBLY_RESOLVED, never deleted:
	// the analysis dropping a question is weak evidence that the decision went
	// away, and the reused enum value means exactly "soft-closed by
	// reconciliation, restorable".
	//
	// Batched as ONE scoped `updateMany` rather than N sequential per-row
	// `update`s: {id: {in: staleIds}, projectId, topicId} satisfies spec §4.7
	// (every mutation carries {id, projectId}), and it replaces N round-trips
	// inside a transaction that is holding a row lock with one. The `count`
	// updateMany reports — not `staleIds.length` — is what `softClosed` takes,
	// since it is the number of rows this write actually touched.
	const staleIds = roots
		.filter(
			(root) =>
				root.status === "OPEN" &&
				root.questionId &&
				!incoming.has(root.questionId),
		)
		.map((root) => root.id);
	if (staleIds.length > 0) {
		const { count } = await tx.publishingTopicDecisionEntry.updateMany({
			where: {
				id: { in: staleIds },
				projectId: input.projectId,
				topicId: input.topicId,
				status: "OPEN",
			},
			data: { status: "POSSIBLY_RESOLVED" },
		});
		outcome.softClosed = count;
	}

	// FR47 / spec D5: one AI Update per regeneration that actually changed the
	// question set. The text is DERIVED from the outcome above rather than asked
	// of a model — it is the only line in this log a reader can check against the
	// rows beside it, and a second LLM call could contradict them.
	const changed =
		outcome.minted +
			outcome.refreshed +
			outcome.softClosed +
			outcome.reactivated >
		0;
	if (input.analysisVersion > 1 && changed) {
		const parts: string[] = [];
		if (outcome.minted > 0) {
			parts.push(`${outcome.minted} new`);
		}
		if (outcome.refreshed > 0) {
			parts.push(`${outcome.refreshed} updated`);
		}
		if (outcome.reactivated > 0) {
			parts.push(`${outcome.reactivated} raised again`);
		}
		if (outcome.softClosed > 0) {
			parts.push(`${outcome.softClosed} no longer raised`);
		}
		await tx.publishingTopicDecisionEntry.create({
			data: {
				topicId: input.topicId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				parentId: null,
				kind: "AI_UPDATE",
				// RESOLVED, not OPEN: a run note is a record, not a question
				// awaiting an answer, and an OPEN one would inflate every open-item
				// count that reads this table.
				status: "RESOLVED",
				authorType: "AGENT",
				authorUserId: null,
				summary: `Planning analysis v${input.analysisVersion}`,
				content: `Questions after regeneration: ${parts.join(", ")}.`,
				analysisVersion: input.analysisVersion,
			},
		});
	}

	return outcome;
}

export interface TopicDecisionEntry {
	id: string;
	parentId: string | null;
	kind: "QUESTION" | "AI_UPDATE";
	status: string;
	authorType: "USER" | "AGENT";
	authorUserId: string | null;
	questionId: string | null;
	decisionKind: string | null;
	subject: string | null;
	summary: string | null;
	content: string | null;
	recommendedResponse: string | null;
	whyItMatters: string | null;
	answerSource: string | null;
	analysisVersion: number | null;
	createdAt: Date;
}

export interface TopicDecisionThread {
	root: TopicDecisionEntry;
	replies: TopicDecisionEntry[];
}

/**
 * Every live turn of a topic's decision thread, as roots with their replies.
 *
 * One query, assembled in memory, with no `take` and no cursor — this read is
 * currently UNBOUNDED. That is not true of a single analysis's own question
 * set (tens, not thousands), but it is not true of the table: every
 * regeneration that changes anything appends an AI_UPDATE root, soft-closed
 * question roots are never deleted, and there is no cooldown or run cap on
 * regeneration, so a topic's thread grows monotonically with regenerations.
 * Pagination is a real design decision, deliberately deferred rather than
 * added here — this comment exists so the next reader does not assume the
 * bound that used to be claimed here.
 */
export async function listTopicDecisions(input: {
	topicId: string;
	projectId: string;
}): Promise<TopicDecisionThread[]> {
	const rows = await db.publishingTopicDecisionEntry.findMany({
		// Scoped by projectId as well as topicId (DV16).
		where: {
			topicId: input.topicId,
			projectId: input.projectId,
			deletedAt: null,
		},
		orderBy: { createdAt: "asc" },
	});

	const roots = rows.filter((r) => r.parentId === null);
	const repliesByParent = new Map<string, typeof rows>();
	for (const row of rows) {
		if (!row.parentId) {
			continue;
		}
		const bucket = repliesByParent.get(row.parentId);
		if (bucket) {
			bucket.push(row);
		} else {
			repliesByParent.set(row.parentId, [row]);
		}
	}

	return roots.map((root) => ({
		root: root as unknown as TopicDecisionEntry,
		replies: (repliesByParent.get(root.id) ??
			[]) as unknown as TopicDecisionEntry[],
	}));
}

/**
 * Record a user's answer to an open question.
 *
 * Mirrors `resolveQuestionThread` (`feature-maturation.ts`): the answer is a
 * REPLY and the root is flipped, so the question survives beside its answer and
 * the Decision Log can show both. Plus `answer-question.ts`'s dedupe branch — an
 * already-settled root returns unchanged rather than minting a parallel
 * decision, because the same question must never resurface twice.
 *
 * The settled check is a DENY-list, not `status === "RESOLVED"` — the same
 * shape `reconcileTopicQuestions` uses above, for the same reason: `OPEN` and
 * `POSSIBLY_RESOLVED` are the only two statuses this feature ever leaves a root
 * in that are still awaiting a person. `POSSIBLY_RESOLVED` in particular MUST
 * stay answerable — it was soft-closed by a regeneration that stopped raising
 * the question, not settled by anyone, and answering it is a real decision. A
 * status this table never writes today (`REJECTED`, `FORMATTING_ONLY`) falls on
 * the settled side by default, the safe direction if the enum ever grows.
 *
 * The settled check above is a READ, so it alone does not stop two concurrent
 * answers to the SAME still-open question — both would pass it. The
 * `updateMany` claim below is what actually serializes them: only the first
 * caller's conditional update can match, so only one reply is ever created.
 */
export async function answerTopicQuestion(input: {
	topicId: string;
	projectId: string;
	questionId: string;
	answer: string;
	answerSource: "AI_SUGGESTED" | "AI_EDITED" | "MANUAL";
	authorUserId: string;
}): Promise<{
	status: "resolved" | "deduped" | "not_found";
	root: TopicDecisionEntry | null;
}> {
	return db.$transaction(async (tx) => {
		const root = await tx.publishingTopicDecisionEntry.findFirst({
			// Re-scoped to the project (DV16) and to a live QUESTION root: a reply's
			// id must not be answerable, and a soft-deleted root must not resurrect.
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				questionId: input.questionId,
				parentId: null,
				kind: "QUESTION",
				deletedAt: null,
			},
			select: {
				id: true,
				status: true,
				organizationId: true,
				userId: true,
			},
		});

		if (!root) {
			return { status: "not_found" as const, root: null };
		}

		if (root.status !== "OPEN" && root.status !== "POSSIBLY_RESOLVED") {
			// Already settled. The answer must not be recorded a second time — the
			// caller gets back the row as it stands, not a fresh write.
			const existing = await tx.publishingTopicDecisionEntry.findUnique({
				where: { id: root.id },
			});
			return {
				status: "deduped" as const,
				root: existing as unknown as TopicDecisionEntry,
			};
		}

		// CLAIM BEFORE WRITE. Two concurrent answers to the same question both
		// read an OPEN/POSSIBLY_RESOLVED root above — without a conditional claim
		// here, both would `create` a reply and both `update` the root, leaving
		// TWO reply rows for one question on a double-click, under READ
		// COMMITTED. The `status: { in: [...] }` guard means only the FIRST
		// caller's `updateMany` can match this row: by the time a second caller's
		// `updateMany` runs, the row is already RESOLVED and it matches zero.
		// Same local shape this repo already uses for send-idempotency, scoped by
		// {projectId, topicId} (DV16) as well as id.
		const claim = await tx.publishingTopicDecisionEntry.updateMany({
			where: {
				id: root.id,
				projectId: input.projectId,
				topicId: input.topicId,
				status: { in: ["OPEN", "POSSIBLY_RESOLVED"] },
			},
			data: { status: "RESOLVED", answerSource: input.answerSource },
		});

		if (claim.count === 0) {
			// Lost the race: a concurrent answer claimed this root first. Same
			// idempotent shape as the already-settled branch above — no reply is
			// recorded for the loser, and no second decision is minted.
			const existing = await tx.publishingTopicDecisionEntry.findUnique({
				where: { id: root.id },
			});
			return {
				status: "deduped" as const,
				root: existing as unknown as TopicDecisionEntry,
			};
		}

		await tx.publishingTopicDecisionEntry.create({
			data: {
				topicId: input.topicId,
				projectId: input.projectId,
				// Tenancy is INHERITED from the root. Stamping the answering user's
				// own tenant would break the XOR the moment someone answers inside an
				// org topic — and would put a row in the wrong tenant besides.
				organizationId: root.organizationId,
				userId: root.userId,
				parentId: root.id,
				kind: "QUESTION",
				status: "RESOLVED",
				authorType: "USER",
				authorUserId: input.authorUserId,
				content: input.answer,
				answerSource: input.answerSource,
			},
		});

		// Re-read: `updateMany` only reports a count, not the row's post-claim
		// shape, and the caller needs the latter.
		const updated = await tx.publishingTopicDecisionEntry.findUnique({
			where: { id: root.id },
		});

		return {
			status: "resolved" as const,
			root: updated as unknown as TopicDecisionEntry,
		};
	});
}
