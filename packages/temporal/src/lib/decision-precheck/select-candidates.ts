/**
 * Candidate selection for the decision pre-check.
 *
 * Pulls the project's ACCEPTED and REJECTED architecture decisions (the only
 * two statuses that can be "contradicted" — see status-semantics.ts), ranks
 * them by lightweight relevance to the produced artifact, and returns the most
 * relevant few with the body content the judge needs.
 *
 * Deliberately NOT RAG (`retrieveProjectContexts`): that retrieval does not
 * filter by context type, so it would dilute the candidate set with unrelated
 * project context. The status-filtered SQL query is the precise source here.
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";

/**
 * A judge-facing decision candidate: the identity + status the normalizer
 * resolves findings against, plus the body content (`decision`,
 * `contextProblem`, `rationale`) the judge reasons over. A single status-
 * filtered query below fetches exactly these fields for ranking and the judge.
 */
export interface CandidateDecision {
	id: string;
	identifier: string;
	title: string;
	/** "ACCEPTED" | "REJECTED" — the two statuses this pre-check considers. */
	status: string;
	domain: string | null;
	decision: string;
	rationale: string;
	contextProblem: string;
}

/**
 * Ceiling on the recent window fetched before relevance ranking. The query
 * returns by recency; we over-fetch a bounded window so ranking can prefer the
 * most *relevant* decisions rather than merely the most recent, then trim to
 * top-K overall.
 */
const CANDIDATE_FETCH_CAP = 100;

/**
 * Judge-facing select — includes `decision`/`contextProblem`/`rationale` (the
 * bodies the judge reasons over) so a single query serves both ranking and the
 * judge. The shared `decisionListSelect` omits those fields and must stay
 * untouched, so this select is local.
 */
const candidateDetailSelect = {
	id: true,
	identifier: true,
	title: true,
	status: true,
	domain: true,
	decision: true,
	rationale: true,
	contextProblem: true,
} as const;

/** Lowercase alphanumeric tokens of length > 2, de-duplicated into a set. */
function tokenize(text: string): Set<string> {
	const tokens = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(" ")
		.filter((t) => t.length > 2);
	return new Set(tokens);
}

/**
 * Relevance = how many of a decision's own tokens (identifier + title +
 * rationale + domain) appear in the artifact. A simple overlap count is enough
 * to float the decisions most likely to be contradicted to the top; the judge
 * makes the final agree/contradict call.
 */
function relevanceScore(
	artifactTokens: Set<string>,
	decision: {
		identifier: string;
		title: string;
		rationale: string | null;
		domain: string | null;
	},
): number {
	const decisionTokens = tokenize(
		[
			decision.identifier,
			decision.title,
			decision.rationale ?? "",
			decision.domain ?? "",
		].join(" "),
	);
	let score = 0;
	for (const token of decisionTokens) {
		if (artifactTokens.has(token)) {
			score++;
		}
	}
	return score;
}

/**
 * Select the top-K most relevant ACCEPTED/REJECTED decisions for `artifactText`.
 * Returns `[]` when the log is empty for both statuses or if any query throws
 * (the pre-check degrades to "no candidates" and shows no warning).
 */
export async function selectCandidateDecisions(params: {
	projectId: string;
	artifactText: string;
	topK?: number;
}): Promise<CandidateDecision[]> {
	const { projectId, artifactText, topK = 10 } = params;
	try {
		// One status-filtered query fetches the judge-facing bodies directly — no
		// wasted COUNT, no unread comment subquery, no second round-trip. Only the
		// two "contradictable" statuses, soft-deleted excluded, over a bounded
		// recent window that ranking then trims to top-K.
		const decisions = await db.architectureDecision.findMany({
			where: {
				projectId,
				deletedAt: null,
				status: { in: ["ACCEPTED", "REJECTED"] },
			},
			select: candidateDetailSelect,
			take: CANDIDATE_FETCH_CAP,
			orderBy: { decisionDate: "desc" },
		});

		if (decisions.length === 0) {
			return [];
		}

		// Rank by relevance, keep the top-K. Array.sort is stable, so equal
		// scores retain the query (recency) order — relevance wins over recency,
		// recency only breaks ties.
		const artifactTokens = tokenize(artifactText);
		return decisions
			.map((decision) => ({
				decision,
				score: relevanceScore(artifactTokens, decision),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, topK)
			.map((entry) => entry.decision);
	} catch (error) {
		logger.warn("[Decision Pre-Check] candidate selection failed", {
			projectId,
			reason: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}
