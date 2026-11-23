"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	duplicateReviewOf,
	NO_DUPLICATE_REVIEW,
	type ProposalDuplicateReview,
} from "./proposal-duplicate-flags";
import { proposalDuplicateFlagsQueryKey } from "./proposal-inbox-client";

/**
 * How long the inbox's flags are reused before an open checks again. The
 * check embeds the inbox, so it is not repeated on every focus.
 */
const DUPLICATE_FLAGS_STALE_MS = 5 * 60_000;

/**
 * How soon to ask again after the first answer that left part of the inbox
 * unchecked. Each later wait is twice as long, up to
 * {@link DUPLICATE_FLAGS_MAX_RECHECK_MS}: a call that embeds counts against
 * the AI rate limit.
 */
export const DUPLICATE_FLAGS_RECHECK_MS = 5_000;

/** The longest wait between two asks. */
export const DUPLICATE_FLAGS_MAX_RECHECK_MS = 60_000;

/**
 * How soon to ask again while the background verifier still has candidates
 * to decide. Such an answer embeds nothing, so the wait does not grow.
 */
export const DUPLICATE_VERIFY_RECHECK_MS = 10_000;

/**
 * The most asks made while only the verifier is outstanding: about three
 * minutes, the time a full run of verifications takes. Items still waiting
 * after that show no note, as when the check ends any other way; the next
 * open of the inbox checks them again.
 */
export const MAX_DUPLICATE_VERIFY_RECHECKS = 18;

/** One answer of a check, as the wait before the next ask reads it. */
type DuplicateCheckAnswer = {
	stillChecking: number;
	verifying: number;
};

/** The answers of the check in progress, when the last one arrived, and
 * the answer the last check ended on. */
type CheckProgress = {
	at: number;
	answers: DuplicateCheckAnswer[];
	endedAt: number;
};

/**
 * The wait before asking again, from the `stillChecking` of each answer of
 * this check so far, oldest first. Never once nothing is left to check, and
 * never once two answers in a row checked nothing more: the server is not
 * getting through the inbox, and asking again would only spend the limit.
 */
export function duplicateFlagsRefetchInterval(
	checks: readonly number[],
): number | false {
	const last = checks[checks.length - 1] ?? 0;
	const [before, previous, latest] = checks.slice(-3);
	const stalled =
		before !== undefined &&
		previous !== undefined &&
		latest !== undefined &&
		previous >= before &&
		latest >= previous;
	if (last === 0 || stalled) {
		return false;
	}
	return Math.min(
		DUPLICATE_FLAGS_RECHECK_MS * 2 ** (checks.length - 1),
		DUPLICATE_FLAGS_MAX_RECHECK_MS,
	);
}

/**
 * The wait before asking again from every answer of this check: the
 * embedding wait while items are still to be compared; once every item is,
 * a steady wait while the verifier has candidates left, at most
 * {@link MAX_DUPLICATE_VERIFY_RECHECKS} times. A check whose embedding
 * stalled stops, as before.
 */
export function duplicateCheckRefetchInterval(
	answers: readonly DuplicateCheckAnswer[],
): number | false {
	const embedding = duplicateFlagsRefetchInterval(
		answers.map((answer) => answer.stillChecking),
	);
	if (embedding !== false) {
		return embedding;
	}
	const last = answers[answers.length - 1];
	if (!last || last.stillChecking > 0 || last.verifying === 0) {
		return false;
	}
	const verifyingAnswers = answers.filter((answer) => answer.verifying > 0);
	return verifyingAnswers.length <= MAX_DUPLICATE_VERIFY_RECHECKS
		? DUPLICATE_VERIFY_RECHECK_MS
		: false;
}

/**
 * Possible-duplicate flags for the ONE proposal open in the inbox, and its
 * items still being checked. The flags of the whole inbox come from one
 * project-level query, fetched when a proposal first opens and reused for
 * every other one. A large inbox is checked over several calls: the query
 * asks again, less often each time, while the server reports items still to
 * compare and gets through them, then at a steady pace while the verifier
 * decides the candidates it found, and shows the confirmed flags so far
 * meanwhile. A failed or unavailable check yields no flags: the review goes
 * on as before.
 */
export function useProposalDuplicateFlags(params: {
	projectId: string;
	organizationId: string | null;
	proposalId: string | null;
	enabled: boolean;
}): ProposalDuplicateReview & {
	/** The inbox's first check is still running: no item has an answer. */
	loading: boolean;
} {
	const { projectId, organizationId, proposalId, enabled } = params;
	// Each answer of the check in progress, and when the last one arrived,
	// so an answer is counted once.
	const checksRef = useRef<CheckProgress>({
		at: 0,
		answers: [],
		endedAt: 0,
	});
	const { data, dataUpdatedAt, errorUpdatedAt, fetchStatus } = useQuery({
		queryKey: proposalDuplicateFlagsQueryKey(projectId, organizationId),
		queryFn: async () =>
			await orpcClient.projects.backlog.proposals.duplicateFlags({
				projectId,
				organizationId,
			}),
		enabled: enabled && !!proposalId,
		staleTime: DUPLICATE_FLAGS_STALE_MS,
		refetchInterval: (query) => {
			const { data: answer, dataUpdatedAt } = query.state;
			const checks = checksRef.current;
			if (answer && dataUpdatedAt !== checks.at) {
				checks.at = dataUpdatedAt;
				checks.answers = [
					...checks.answers,
					{
						stillChecking: answer.stillChecking,
						verifying: answer.verifying,
					},
				];
			}
			// A refused or failed ask (the rate limit, say) ends the check.
			const next = query.state.error
				? false
				: duplicateCheckRefetchInterval(checks.answers);
			if (next === false) {
				// The check is over: a later fetch starts a new one.
				checks.answers = [];
				checks.endedAt = dataUpdatedAt;
			}
			return next;
		},
		refetchOnWindowFocus: false,
		retry: false,
	});
	// The answer the last check ended on. Its items still waiting (a pair
	// the verifier keeps failing, or past the last ask) show no note: no
	// later ask of this check would settle them. Read after each answer or
	// failure; TanStack decides the next ask (`refetchInterval`) before it
	// renders that answer, so the decision is in by then.
	const [endedAt, setEndedAt] = useState(0);
	useEffect(() => {
		if (dataUpdatedAt > 0 || errorUpdatedAt > 0) {
			setEndedAt(checksRef.current.endedAt);
		}
	}, [dataUpdatedAt, errorUpdatedAt]);
	// The first answer can take a few seconds (it embeds the inbox); until
	// it arrives every open item is still being checked.
	const loading = !data && !!proposalId && fetchStatus === "fetching";
	return useMemo(() => {
		if (!data || !proposalId) {
			return { ...NO_DUPLICATE_REVIEW, loading };
		}
		const review = duplicateReviewOf(data, proposalId);
		return dataUpdatedAt === endedAt
			? {
					...review,
					checking: NO_DUPLICATE_REVIEW.checking,
					loading: false,
				}
			: { ...review, loading: false };
	}, [data, dataUpdatedAt, endedAt, proposalId, loading]);
}
