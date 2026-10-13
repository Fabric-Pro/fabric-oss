/**
 * Removes the per-source ChatGPT plan rows whose source is gone (Fizzy #3038).
 *
 * The breaker state, served-model, budget-observation and window-accuracy
 * rows are keyed by `(sourceKind, sourceId)` with no foreign key. Disconnect,
 * replacement and plan moves clear them under the source's lock, but deleting
 * a user cascades their `ChatGptPlanCredential`, and purging an organization
 * cascades its `ChatGptPlanOrgAccount`s, with no such cleanup. A writer still
 * running an older app version can also add a row after its source went. This
 * sweep, run daily by the worker, removes what those leave behind.
 *
 * It adds no lock to those cascades. Each source it removes rows for is
 * handled in its own transaction under the source's own advisory lock, the
 * one every writer of these rows takes first: the credential fence, the
 * `delete…UnderLock` helpers and `plan-move.ts` in `@repo/ai`. So it waits
 * for a write, a disconnect or a move in flight, then checks again that the
 * source is gone before deleting. Under READ COMMITTED each statement after
 * the lock sees what those committed, so a source reconnected, or a move
 * that re-keyed rows onto it, keeps its rows.
 *
 * Reads the account table through the base client, as the fence does: the
 * worker's role sees every organization's rows (`apply-rls-direct.ts`).
 *
 * One call handles one page of candidates. The caller walks the pages with
 * the returned `nextCursor`, so a source that keeps failing does not hold the
 * head of every page: the walk moves past it and it is tried again on the
 * next walk. A `deadline` stops a call from starting another source's
 * transaction once it passes, so a caller can bound a call's wall clock by
 * one source's worst case past the deadline.
 */

import { db } from "../client";
import type { ChatGptPlanSourceKind } from "../generated/client";
import {
	chatGptPlanLockKey,
	chatGptPlanOrgAccountLockKey,
	REFRESH_LOCK_MAX_WAIT_MS,
	REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
	withRefreshLock,
} from "./lib/refresh-lock";

/**
 * The longest one source's transaction can take: `withRefreshLock` waits up
 * to `REFRESH_LOCK_MAX_WAIT_MS` for a connection, then its transaction is
 * cut off after `REFRESH_LOCK_TRANSACTION_TIMEOUT_MS`. A caller sizing a
 * deadline adds this once past it, for the transaction started just before.
 */
export function chatGptPlanSourceSweepSourceWorstCaseMs(): number {
	// Read on call, not at module load: the queries barrel loads this module,
	// and tests elsewhere mock `./lib/refresh-lock` without these constants.
	return REFRESH_LOCK_MAX_WAIT_MS + REFRESH_LOCK_TRANSACTION_TIMEOUT_MS;
}

type SweepTx = Parameters<Parameters<typeof withRefreshLock>[1]>[0];

export interface ChatGptPlanOrphanedSource {
	sourceKind: ChatGptPlanSourceKind;
	sourceId: string;
}

export interface ChatGptPlanSourceSweepResult {
	/** Sources found without a sign-in, after the cursor, up to the limit. */
	candidates: number;
	/** Sources whose rows were deleted. */
	sourcesSwept: number;
	/** Sources found again under the lock (reconnected, or moved onto). */
	sourcesKept: number;
	/** Sources whose transaction failed; the next run tries them again. */
	sourcesFailed: Array<ChatGptPlanOrphanedSource & { error: string }>;
	deleted: {
		sourceState: number;
		servedModels: number;
		budgetObservations: number;
		windowAccuracy: number;
	};
	/**
	 * Candidates this call did not start because the deadline passed; the
	 * next call, from `nextCursor`, reaches them.
	 */
	sourcesNotReached: number;
	/**
	 * Exclusive cursor for the next call: the last candidate this call
	 * handled, whether swept, kept or failed. `null` once a short page was
	 * handled in full, which means no candidate is left after `after`.
	 */
	nextCursor: ChatGptPlanOrphanedSource | null;
}

/**
 * Up to `limit` sources that have rows in any of the four tables and no
 * sign-in: no credential for that user, or no account with that id. A
 * candidate only; the sweep checks again under the lock.
 *
 * Keyset-paged in one total order: `"sourceKind"::text, "sourceId"`. The
 * ORDER BY and the `>` row comparison use the same two expressions, so a page
 * starts exactly after the cursor's place in the order the last page ended
 * in. The kind is compared as text, not in the enum's declaration order, and
 * the cursor values are cast to text so the comparison never depends on how
 * the driver types a bound parameter.
 */
function findOrphanedChatGptPlanSources(
	limit: number,
	after: ChatGptPlanOrphanedSource | null,
): Promise<ChatGptPlanOrphanedSource[]> {
	const afterKind = after?.sourceKind ?? null;
	const afterId = after?.sourceId ?? null;
	return db.$queryRaw<ChatGptPlanOrphanedSource[]>`
		SELECT s."sourceKind", s."sourceId"
		FROM (
			SELECT "sourceKind", "sourceId" FROM "chat_gpt_plan_source_state"
			UNION
			SELECT "sourceKind", "sourceId" FROM "chat_gpt_plan_served_model"
			UNION
			SELECT "sourceKind", "sourceId" FROM "chat_gpt_plan_budget_observation"
			UNION
			SELECT "sourceKind", "sourceId" FROM "chat_gpt_plan_window_accuracy"
		) AS s
		WHERE (
			(
				s."sourceKind" = 'USER'
				AND NOT EXISTS (
					SELECT 1 FROM "chat_gpt_plan_credential" AS c
					WHERE c."userId" = s."sourceId"
				)
			) OR (
				s."sourceKind" = 'ORG'
				AND NOT EXISTS (
					SELECT 1 FROM "chat_gpt_plan_org_account" AS a
					WHERE a."id" = s."sourceId"
				)
			)
		)
		AND (
			${afterKind}::text IS NULL
			OR (s."sourceKind"::text, s."sourceId") > (${afterKind}::text, ${afterId}::text)
		)
		ORDER BY s."sourceKind"::text, s."sourceId"
		LIMIT ${limit}`;
}

function sourceExists(
	tx: SweepTx,
	source: ChatGptPlanOrphanedSource,
): Promise<unknown> {
	return source.sourceKind === "USER"
		? tx.chatGptPlanCredential.findUnique({
				where: { userId: source.sourceId },
				select: { id: true },
			})
		: tx.chatGptPlanOrgAccount.findUnique({
				where: { id: source.sourceId },
				select: { id: true },
			});
}

/**
 * Deletes the four tables' rows of up to `limit` sources after `after` that
 * no longer exist. Each source is its own transaction, so one that fails (a
 * lock wait past the transaction timeout, say) is reported, and the walk
 * moves past it; the next walk tries it again.
 *
 * Once `deadline` (epoch ms) has passed, no further source's transaction is
 * started; `nextCursor` then names the last source handled. The check runs
 * before every source, the first included, so a call never starts a
 * transaction after its deadline. If the candidate query itself ran past the
 * deadline and no source was started, the call throws instead of returning a
 * null cursor (which would read as the end of the walk), so the caller retries
 * it from the same `after`.
 */
export async function sweepOrphanedChatGptPlanSourceRows(params: {
	limit: number;
	after?: ChatGptPlanOrphanedSource | null;
	deadline?: number;
}): Promise<ChatGptPlanSourceSweepResult> {
	if (!Number.isInteger(params.limit) || params.limit < 1) {
		throw new RangeError(
			`ChatGPT plan source sweep limit must be a positive integer, got ${params.limit}`,
		);
	}
	const after = params.after ?? null;
	const candidates = await findOrphanedChatGptPlanSources(
		params.limit,
		after,
	);
	const result: ChatGptPlanSourceSweepResult = {
		candidates: candidates.length,
		sourcesSwept: 0,
		sourcesKept: 0,
		sourcesFailed: [],
		deleted: {
			sourceState: 0,
			servedModels: 0,
			budgetObservations: 0,
			windowAccuracy: 0,
		},
		sourcesNotReached: 0,
		nextCursor: null,
	};
	let last: ChatGptPlanOrphanedSource | null = null;
	for (const [index, candidate] of candidates.entries()) {
		if (params.deadline !== undefined && Date.now() >= params.deadline) {
			result.sourcesNotReached = candidates.length - index;
			break;
		}
		const source = {
			sourceKind: candidate.sourceKind,
			sourceId: candidate.sourceId,
		};
		last = source;
		const lockKey =
			source.sourceKind === "USER"
				? chatGptPlanLockKey(source.sourceId)
				: chatGptPlanOrgAccountLockKey(source.sourceId);
		try {
			const counts = await withRefreshLock(lockKey, async (tx) => {
				// After the lock: a connect, a fenced write or a move that
				// held it has committed, and this read sees it.
				if (await sourceExists(tx, source)) {
					return null;
				}
				const where = source;
				const state = await tx.chatGptPlanSourceState.deleteMany({
					where,
				});
				const served = await tx.chatGptPlanServedModel.deleteMany({
					where,
				});
				const observations =
					await tx.chatGptPlanBudgetObservation.deleteMany({ where });
				const accuracy = await tx.chatGptPlanWindowAccuracy.deleteMany({
					where,
				});
				return {
					sourceState: state.count,
					servedModels: served.count,
					budgetObservations: observations.count,
					windowAccuracy: accuracy.count,
				};
			});
			if (counts === null) {
				result.sourcesKept += 1;
				continue;
			}
			result.sourcesSwept += 1;
			result.deleted.sourceState += counts.sourceState;
			result.deleted.servedModels += counts.servedModels;
			result.deleted.budgetObservations += counts.budgetObservations;
			result.deleted.windowAccuracy += counts.windowAccuracy;
		} catch (error) {
			result.sourcesFailed.push({
				...source,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (last === null && candidates.length > 0) {
		throw new Error(
			"ChatGPT plan source sweep reached its deadline before starting any source; retry from the same cursor",
		);
	}
	// A short page handled in full is the end; anything else resumes after
	// the last source handled.
	const reachedEnd =
		candidates.length < params.limit && result.sourcesNotReached === 0;
	result.nextCursor = reachedEnd ? null : last;
	return result;
}
