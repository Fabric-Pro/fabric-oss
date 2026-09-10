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

import { db, Prisma } from "../../client"; // client.ts re-exports both — NOT ../../../src

/** The subset of a resolved analysis question this table needs. */
export interface ReconcilableQuestion {
	questionId: string;
	decisionKind: string;
	subject: string | null;
	question: string;
	recommendedResponse: string | null;
	/** Several answers to choose between; `null` when the model offered none. */
	answerOptions?: { text: string; justification: string }[] | null;
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
		/**
		 * Which entry kind these rows are.
		 *
		 * `QUESTION` by default, so every existing caller is unchanged.
		 * `BLOCKER` reuses this whole function — the identity match, the
		 * refresh, the soft-close of anything the new analysis stopped raising,
		 * and the rule that a row a PERSON settled is never reopened. All of
		 * that is the same for a thing the topic is missing as for a decision
		 * nobody has made, and a second copy would be two spellings of the
		 * soft-close rule that drift the first time either is edited.
		 */
		kind?: "QUESTION" | "BLOCKER";
	},
): Promise<ReconcileOutcome> {
	const entryKind = input.kind ?? "QUESTION";
	// Live roots only. Scoped by projectId as well as topicId (DV16) — a topic id
	// is not a capability, and every read in this file re-scopes.
	const roots = await tx.publishingTopicDecisionEntry.findMany({
		where: {
			topicId: input.topicId,
			projectId: input.projectId,
			parentId: null,
			kind: entryKind,
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
					answerOptions:
						(question.answerOptions as
							| Prisma.InputJsonValue
							| undefined) ?? Prisma.DbNull,
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
				kind: entryKind,
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
				answerOptions:
					(question.answerOptions as
						| Prisma.InputJsonValue
						| undefined) ?? Prisma.DbNull,
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
				// Named for what actually changed. The blocker pass runs after
				// the question pass in the same transaction, so an unqualified
				// "Questions after regeneration" would appear twice and the
				// second one would be describing something else.
				content: `${
					entryKind === "BLOCKER" ? "Blockers" : "Questions"
				} after regeneration: ${parts.join(", ")}.`,
				analysisVersion: input.analysisVersion,
			},
		});
	}

	return outcome;
}

/**
 * A person a question is waiting on, and who put them there (Fizzy #1851).
 *
 * `assignedByUserId` is not bookkeeping: after a re-assignment there are two
 * candidate askers, and this is what makes "tell the person who asked" resolve
 * to exactly one of them.
 */
export interface TopicQuestionAssignee {
	assigneeUserId: string;
	assignedByUserId: string;
}

export interface TopicDecisionEntry {
	id: string;
	parentId: string | null;
	kind: "QUESTION" | "AI_UPDATE" | "BLOCKER";
	status: string;
	authorType: "USER" | "AGENT";
	authorUserId: string | null;
	questionId: string | null;
	decisionKind: string | null;
	subject: string | null;
	summary: string | null;
	content: string | null;
	recommendedResponse: string | null;
	answerOptions: { text: string; justification: string }[] | null;
	whyItMatters: string | null;
	answerSource: string | null;
	analysisVersion: number | null;
	createdAt: Date;
	/**
	 * Who this question is waiting on. Always present, empty when nobody has
	 * been asked — "unassigned" is a state the panel renders, not missing data.
	 * Replies and AI Update notes carry none; only a question root can.
	 */
	assignees: TopicQuestionAssignee[];
	/**
	 * Who made this decision, when a person did.
	 *
	 * `null` for an AI turn, and `null` for a person whose account has since
	 * been removed — `authorUserId` is `ON DELETE SET NULL`, so the log keeps
	 * the decision and loses only the name. Readers fall back to the generic
	 * label in both cases rather than inventing one.
	 */
	author: { id: string; name: string; image: string | null } | null;
}

/**
 * The assignee rows every read of a decision entry carries.
 *
 * Extracted so the shape cannot drift between the thread list and the four
 * single-root reads: `TopicDecisionEntry.assignees` is non-optional, so a read
 * that forgot the include would satisfy the type only through the `as unknown`
 * cast each of them already uses — and hand back a question whose assignees
 * silently read as absent rather than as empty.
 */
const ASSIGNEE_INCLUDE = {
	assignees: {
		orderBy: { createdAt: "asc" },
		select: { assigneeUserId: true, assignedByUserId: true },
	},
	/**
	 * The decision's author, for the same reason the assignees ride along: the
	 * Decision Log rendered the literal string "Team member" on every human
	 * turn, because the id was on the wire and the name never was. The relation
	 * already existed; nothing here needed a migration.
	 *
	 * Only the three fields a label needs. The full `User` carries an email and
	 * a password hash, and a decision log is not a reason to put either on the
	 * wire.
	 */
	author: { select: { id: true, name: true, image: true } },
} as const;

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
		// Included rather than fetched separately: the assignee rows are
		// scoped by the PARENT, which this query has already scoped, so a
		// second round trip would only be a second chance to scope it
		// differently. Ordered by creation so the avatars keep a stable order
		// between renders instead of shuffling on every refetch.
		include: ASSIGNEE_INCLUDE,
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
	/**
	 * Which kind of root is being settled. `QUESTION` by default, so every
	 * existing caller is unchanged.
	 *
	 * A blocker is settled the same way a question is — a reply that supersedes
	 * it and flips the root — so this is one function rather than two. What the
	 * kind must NOT do is fall out of the lookup: a blocker id clearing a
	 * question would be a cross-kind write with the same shape as a correct one.
	 */
	kind?: "QUESTION" | "BLOCKER";
}): Promise<{
	status: "resolved" | "deduped" | "not_found";
	root: TopicDecisionEntry | null;
}> {
	return db.$transaction(async (tx) => {
		const root = await tx.publishingTopicDecisionEntry.findFirst({
			// Re-scoped to the project (DV16) and to a live root of the SAME kind:
			// a reply's id must not be answerable, a soft-deleted root must not
			// resurrect, and a blocker id must not clear a question or the other
			// way round. The kind is part of what is being addressed, not a
			// filter that can be relaxed.
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				questionId: input.questionId,
				parentId: null,
				kind: input.kind ?? "QUESTION",
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
				// The reply carries the ROOT's kind: a blocker cleared by a
				// person is still a blocker in the log, and typing it as a
				// question would hide it from the section that raised it.
				kind: input.kind ?? "QUESTION",
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
			include: ASSIGNEE_INCLUDE,
		});

		return {
			status: "resolved" as const,
			root: updated as unknown as TopicDecisionEntry,
		};
	});
}

/**
 * Change the answer to an ALREADY-RESOLVED question — the amend affordance the
 * Feature Maturation Decision Log has (`amendQuestionAnswer`), brought to the
 * Publishing Suite's Summary & Questions tab.
 *
 * A SEPARATE function rather than a relaxed `answerTopicQuestion` above. That
 * one's settled check is what stops a double-submit minting two replies for one
 * act, and its docstring records the rule it enforces — the same question must
 * never be answered twice. Amending is a different act with a different
 * precondition (there must already BE an answer), so it gets its own guard
 * instead of widening one that is holding something else up.
 *
 * APPEND, NEVER MUTATE, like its maturation sibling: the amendment is a NEW
 * reply and the superseded turn stays byte-identical beneath it, so the Decision
 * Log can show what the answer used to say. The root keeps its RESOLVED status
 * throughout — amending changes the answer, not whether the question is settled.
 *
 * Unlike maturation, there is no `supersedesId` COLUMN to record the link. That
 * would be a migration on `PublishingTopicDecisionEntry`, and it is not needed:
 * replies under one root are a single chronological chain, so "the live answer"
 * is the newest reply carrying content and everything before it is history.
 * `listTopicDecisions` already returns replies `createdAt asc`, so readers get
 * that order for free. Callers must therefore take the LAST answering reply,
 * not the first — before amendment existed those were the same reply, and code
 * written against that assumption now shows a stale answer.
 *
 * Three refusals, and they mean different things to a caller:
 *
 *  - `not_found` — no such question, or it is not settled. An OPEN or
 *    POSSIBLY_RESOLVED root is answered through `answerTopicQuestion`; there is
 *    nothing here to supersede.
 *  - `stale` — `supersedesId` does not name the live answer any more, so the
 *    caller is amending text a colleague has already replaced. Refused rather
 *    than applied: the whole point of an amendment is that its author read what
 *    they were changing.
 *  - `deduped` — the submitted text already IS the live answer. Makes the
 *    operation idempotent, which is what a double-click on the Save button
 *    produces, and costs a reader nothing: an amendment that changes no words
 *    is not a decision.
 */
export async function amendTopicQuestionAnswer(input: {
	topicId: string;
	projectId: string;
	questionId: string;
	/** The answer turn the caller read and is replacing. */
	supersedesId: string;
	answer: string;
	answerSource: "AI_SUGGESTED" | "AI_EDITED" | "MANUAL";
	authorUserId: string;
}): Promise<{
	status: "amended" | "deduped" | "stale" | "not_found";
	root: TopicDecisionEntry | null;
}> {
	return db.$transaction(async (tx) => {
		const root = await tx.publishingTopicDecisionEntry.findFirst({
			// Same scoping as `answerTopicQuestion`: project (DV16) plus a live
			// QUESTION root, so a reply id is not amendable and a soft-deleted
			// root does not resurrect.
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
				updatedAt: true,
				organizationId: true,
				userId: true,
			},
		});

		// Only a settled question has an answer to amend, and RESOLVED is the
		// only status this table settles into. Deliberately an ALLOW-list here,
		// the mirror of the deny-list `answerTopicQuestion` uses: that one asks
		// "is anyone still waiting on this?", which must fail safe towards
		// settled, while this one asks "is there an answer to replace?", which
		// must fail safe towards no.
		if (!root || root.status !== "RESOLVED") {
			return { status: "not_found" as const, root: null };
		}

		// The live answer is the NEWEST reply carrying content. `id desc` breaks
		// a same-millisecond tie so this is a total order — without it two
		// replies written in one batch could swap places between the read that
		// decides staleness and the read that renders the thread.
		const live = await tx.publishingTopicDecisionEntry.findFirst({
			where: {
				parentId: root.id,
				projectId: input.projectId,
				topicId: input.topicId,
				deletedAt: null,
				content: { not: null },
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			select: { id: true, content: true },
		});

		if (!live || live.id !== input.supersedesId) {
			// Either the root is settled with no answering reply at all — which
			// nothing writes today — or someone else amended first.
			const existing = await tx.publishingTopicDecisionEntry.findUnique({
				where: { id: root.id },
			});
			return {
				status: "stale" as const,
				root: existing as unknown as TopicDecisionEntry,
			};
		}

		const trimmed = input.answer.trim();
		if (trimmed === (live.content ?? "").trim()) {
			const existing = await tx.publishingTopicDecisionEntry.findUnique({
				where: { id: root.id },
			});
			return {
				status: "deduped" as const,
				root: existing as unknown as TopicDecisionEntry,
			};
		}

		// CLAIM BEFORE WRITE, the same pattern `answerTopicQuestion` uses, with
		// the root's own `updatedAt` as the version token — there is no status
		// to flip here, because the root is RESOLVED before and after. Prisma
		// stamps `updatedAt` on every write, and this path always writes
		// `answerSource`, so a second concurrent amender's predicate no longer
		// matches and it loses cleanly instead of appending a second reply to a
		// thread whose live answer moved under it.
		const claim = await tx.publishingTopicDecisionEntry.updateMany({
			where: {
				id: root.id,
				projectId: input.projectId,
				topicId: input.topicId,
				status: "RESOLVED",
				updatedAt: root.updatedAt,
			},
			// The root carries the CURRENT answer's provenance, so it moves with
			// the amendment. Leaving it behind would report the superseded
			// answer's source for a decision that no longer says what it said —
			// and this column is what recommendation-acceptance reporting
			// counts (see `20260828120000_repoint_ai_edited_answer_source`).
			data: { answerSource: input.answerSource },
		});

		if (claim.count === 0) {
			const existing = await tx.publishingTopicDecisionEntry.findUnique({
				where: { id: root.id },
			});
			return {
				status: "stale" as const,
				root: existing as unknown as TopicDecisionEntry,
			};
		}

		await tx.publishingTopicDecisionEntry.create({
			data: {
				topicId: input.topicId,
				projectId: input.projectId,
				// Tenancy is INHERITED from the root, exactly as answering does:
				// stamping the amending user's own tenant would break the XOR
				// the moment someone amends inside an org topic.
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

		const updated = await tx.publishingTopicDecisionEntry.findUnique({
			where: { id: root.id },
			include: ASSIGNEE_INCLUDE,
		});

		return {
			status: "amended" as const,
			root: updated as unknown as TopicDecisionEntry,
		};
	});
}

/**
 * Replace a question's assignee set (Fizzy #1851).
 *
 * SET SEMANTICS, mirroring `setQuestionAssignees` in `feature-maturation.ts`:
 * assigning, re-assigning and clearing are the same call with a different
 * desired set, so the caller never diffs. Rows already present are left
 * untouched so their original `assignedByUserId` survives a re-save —
 * re-picking somebody already assigned must not silently transfer who is
 * recorded as having asked.
 *
 * Returns the newly-ADDED assignees — exactly the set to notify — alongside the
 * question's own wording, which the notification card needs. Re-saving an
 * unchanged list adds nobody, which is what keeps toggling avatars in a picker
 * from spamming the room.
 *
 * The wording comes back from HERE rather than from a second read in the
 * caller because this function has already loaded the row it belongs to, and
 * because the alternative — re-reading the whole decision thread to find one
 * subject line — is a great deal of work for a notification snippet.
 *
 * `null` means the question does not exist in this topic and project, which the
 * caller must not report as a successful no-op assignment.
 *
 * NOT ACCESS CONTROL. Assignment routes accountability; it never restricts who
 * may answer, or who may reassign. There is deliberately no check that the
 * caller is the author or an existing assignee — the same call the procedure's
 * `PUBLISHING_TOPIC_UPDATE` gate already covers.
 */
export async function setTopicQuestionAssignees(input: {
	topicId: string;
	projectId: string;
	/** The question thread ROOT. */
	entryId: string;
	/** The complete desired set. Empty clears the question. */
	assigneeUserIds: string[];
	assignedByUserId: string;
}): Promise<{ added: string[]; summary: string | null } | null> {
	// Resolve the question first, and take the child's tenant columns from IT.
	// Stamping the caller's own tenant is the mistake this shape exists to
	// prevent: the table's XOR check compares the two columns to each other,
	// not to the parent, so a row whose tenant disagrees with its question
	// would satisfy the constraint and still be invisible to the reader of the
	// thread it belongs to.
	const entry = await db.publishingTopicDecisionEntry.findFirst({
		where: {
			id: input.entryId,
			topicId: input.topicId,
			projectId: input.projectId,
			parentId: null,
			kind: "QUESTION",
			deletedAt: null,
		},
		select: {
			id: true,
			userId: true,
			organizationId: true,
			subject: true,
			content: true,
		},
	});
	if (!entry) {
		return null;
	}
	const summary = entry.subject ?? entry.content;

	const desired = [...new Set(input.assigneeUserIds)];
	const existing = await db.publishingTopicQuestionAssignee.findMany({
		where: { decisionEntryId: entry.id },
		select: { assigneeUserId: true },
	});
	const existingIds = new Set(existing.map((row) => row.assigneeUserId));
	const added = desired.filter((id) => !existingIds.has(id));
	const removed = [...existingIds].filter((id) => !desired.includes(id));

	if (added.length === 0 && removed.length === 0) {
		return { added: [], summary };
	}

	await db.$transaction(async (tx) => {
		if (removed.length > 0) {
			await tx.publishingTopicQuestionAssignee.deleteMany({
				where: {
					decisionEntryId: entry.id,
					assigneeUserId: { in: removed },
				},
			});
		}
		if (added.length > 0) {
			await tx.publishingTopicQuestionAssignee.createMany({
				data: added.map((assigneeUserId) => ({
					decisionEntryId: entry.id,
					assigneeUserId,
					assignedByUserId: input.assignedByUserId,
					projectId: input.projectId,
					// Inherited from the question, never from the assignee or
					// the caller — see the model's doc-comment.
					userId: entry.userId,
					organizationId: entry.organizationId,
				})),
				// Two people saving the picker at once both compute the same
				// `added`, and the unique index turns the second write into an
				// error rather than a duplicate. Skipping is the right
				// resolution: the row the loser wanted already exists.
				skipDuplicates: true,
			});
		}
	});

	return { added, summary };
}
