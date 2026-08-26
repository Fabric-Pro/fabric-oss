/**
 * Pure matching core for linking meeting action items to work items (#1902).
 *
 * Split out from the activity for the same reason `duplicate-detection.ts` is
 * split from `duplicate-scan-core.ts`: candidate selection and thresholding are
 * where the behaviour actually lives, and they are worth testing without mocking
 * the embedding and LLM stacks.
 *
 * No DB, no AI, no IO — `cosineSimilarity` is the only import, and it is itself
 * pure.
 */

import { cosineSimilarity } from "@repo/database";

/**
 * Cosine score a story must clear to be worth an LLM call.
 *
 * Deliberately lower than the duplicate scanner's 0.7: that compares two work
 * items written in the same register, whereas this compares a terse spoken
 * commitment ("Alice to look at the digest download") against a written
 * specification. The texts are less alike even when the relationship is real, so
 * the embedding stage is a coarse funnel here and the LLM verifier — not this
 * floor — is what decides.
 */
export const CANDIDATE_FLOOR = 0.5;

/**
 * Cap on candidates handed to the verifier per action item. Bounds cost at
 * items x 1 LLM call with a bounded prompt, and past ~5 the marginal candidate
 * is noise the model has to argue itself out of.
 */
export const MAX_CANDIDATES_PER_ITEM = 5;

/** Verifier confidence a match must clear to be stored as a link. */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

const MAX_CANDIDATE_DESCRIPTION_CHARS = 600;

export type CandidateStory = {
	id: string;
	identifier: string;
	embedding: number[];
};

export type SelectedCandidate = {
	storyId: string;
	identifier: string;
	similarity: number;
};

/**
 * Read the tunable confidence threshold (card investigation item #2 — "must be
 * tunable" without a code deploy).
 *
 * An unparseable or out-of-range value falls back to the default rather than
 * being clamped: `0` would link everything the verifier so much as considered
 * and `2` would link nothing, and either is far more likely to be a typo than an
 * intent. Silently honouring a typo here is how a threshold feature erodes trust.
 */
export function resolveMinConfidence(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env.MEETING_ACTION_ITEM_LINK_MIN_CONFIDENCE;
	if (raw === undefined) {
		return DEFAULT_MIN_CONFIDENCE;
	}
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
		return DEFAULT_MIN_CONFIDENCE;
	}
	return parsed;
}

/**
 * Cosine pre-filter: the strongest few stories for one action item.
 *
 * A dimension mismatch scores 0 (see `cosineSimilarity`) and is therefore
 * dropped by the floor — so a mid-run embedding-model change degrades to "no
 * candidates" rather than to a garbage match.
 */
export function selectCandidates(
	itemEmbedding: number[],
	stories: CandidateStory[],
): SelectedCandidate[] {
	return stories
		.map((story) => ({
			storyId: story.id,
			identifier: story.identifier,
			similarity: cosineSimilarity(itemEmbedding, story.embedding),
		}))
		.filter((c) => c.similarity > CANDIDATE_FLOOR)
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, MAX_CANDIDATES_PER_ITEM);
}

/** One candidate as the verifier prompt renders it. */
export type CandidateForPrompt = {
	identifier: string;
	title: string;
	description: string | null;
};

/**
 * The verifier prompt for ONE action item against all of its candidates.
 *
 * One call per item rather than per pair: it is cheaper, and it lets the model
 * see the candidates side by side, which is what stops it from confidently
 * linking an item to three near-identical tickets.
 */
export function buildMatchPrompt(
	item: { text: string; tentativeOwnerName: string | null },
	meetingSubject: string | null,
	candidates: CandidateForPrompt[],
): string {
	const meetingLine = meetingSubject ? `Meeting: ${meetingSubject}\n` : "";
	const ownerLine = item.tentativeOwnerName
		? `Tentative owner: ${item.tentativeOwnerName}\n`
		: "";
	const candidateBlock = candidates
		.map((c, i) => {
			const description = (c.description ?? "")
				.trim()
				.slice(0, MAX_CANDIDATE_DESCRIPTION_CHARS);
			return [
				`${i + 1}. ${c.identifier} — ${c.title}`,
				description ? `   ${description}` : null,
			]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n\n");

	return `You are deciding whether a commitment made in a meeting refers to specific existing work items.

${meetingLine}${ownerLine}Action item: ${item.text}

Candidate work items:
${candidateBlock}

For EACH candidate, decide whether the action item is about that specific work item — that is, whether doing the action item would advance, change, or resolve it.

Answer "relates": false when the action item merely touches the same area, the same feature family, or the same component. Shared subject matter is not a relationship. Only answer true when a reader would agree the action item is a follow-up ON that specific work item.

Give a confidence between 0 and 1 reflecting how certain you are, and one short sentence of reasoning. Return one verdict per candidate, using the candidate's identifier exactly as given.`;
}

/**
 * Final gate before a verdict becomes a stored link. Both conditions matter: a
 * high-confidence "no" is still a no.
 */
export function classifyMatch(
	verdict: { relates: boolean; confidence: number },
	minConfidence: number,
): boolean {
	return verdict.relates && verdict.confidence >= minConfidence;
}
