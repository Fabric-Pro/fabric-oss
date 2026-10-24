/**
 * Whether a recurring log error is already tracked, so the scan adds to what
 * tracks it instead of proposing it again. Two things can track it:
 *   - an open bug someone filed by hand: the occurrences go on that bug;
 *   - a log-error proposal still awaiting review, filed for a different error
 *     group that is the same problem (one failure often logs several distinct
 *     messages): the group joins that proposal as related evidence, so the
 *     reviewer gets one proposal per problem rather than one per message.
 *
 * The duplicate detector's two stages, run one-against-many: the error's text
 * is embedded and compared with the candidates' vectors (open bugs from the
 * shared cache, pending proposals embedded once per scan), and the closest few
 * go to the detector's own verifier, in parallel so a group costs one round
 * trip. There is no similarity floor: a raw log excerpt and a hand-written bug
 * score low against each other even when they describe the same failure, so
 * the closest candidates are always verified and the verifier decides. Only a
 * verdict that the two are the same work item, at the detector's confidence
 * bar, counts. Overlapping scope does not: a report about the same area is
 * not this error's ticket, and two look-alike errors stay two proposals.
 *
 * Every candidate checked is returned with its score and verdict, so a
 * proposal filed anyway shows what was ruled out and why.
 *
 * Candidates are loaded once per scan, on the first group that needs them,
 * and each proposal the scan files is added (`remember`) so a later group in
 * the same scan can join it. A failure to load them or to embed an error
 * THROWS, and the scan records it and files the proposal as before: a
 * recurring error still reaches the inbox when matching is unavailable.
 */
import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import {
	buildDetectionText,
	buildVerifierPrompt,
	cosineSimilarity,
	detectionTextForStory,
	listOpenBugStoriesForMatching,
	listPendingLogProposalsForMatching,
	normalizeVerifierRelationship,
	type VerifierRelationship,
} from "@repo/database";
import { logger } from "@repo/logs";
import { generateEmbeddings } from "@repo/rag";
import { VerdictSchema } from "../../lib/duplicate-scan-core";
import { loadStoryVectors } from "../../lib/story-vectors";
import type { RedactedErrorGroup } from "./evidence";

const LOG_PREFIX = "[RecurringErrors/matchOpenBug]";

/** Candidates verified per error group, the most similar first. */
export const MAX_MATCH_CANDIDATES = 3;

/** How a proposal is named to the verifier and in the recorded check. */
const MAX_PROPOSAL_LABEL_CHARS = 80;

export type TrackedMatch =
	| { kind: "story"; storyId: string; identifier: string; confidence: number }
	| {
			kind: "proposal";
			proposalId: string;
			identifier: string;
			confidence: number;
	  };

/** One candidate the error was verified against, kept on the proposal. */
export interface CheckedCandidate {
	kind: "story" | "proposal";
	/** A story's identifier, or a proposal's title. */
	identifier: string;
	similarity: number;
	/** `null` when the verifier call failed. */
	relationship: VerifierRelationship | null;
	confidence: number | null;
}

export interface OpenBugCheck {
	match: TrackedMatch | null;
	checked: CheckedCandidate[];
}

export interface OpenBugMatcher {
	check(group: RedactedErrorGroup): Promise<OpenBugCheck>;
	/** A proposal this scan just filed for `group`, for later groups to join. */
	remember(
		group: RedactedErrorGroup,
		proposalId: string,
		title: string,
	): void;
}

const NOTHING_CHECKED: OpenBugCheck = { match: null, checked: [] };

export interface OpenBugMatcherInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	/** Minimum verifier confidence for "the same problem" (the project's). */
	similarityThreshold: number;
}

interface Candidate {
	kind: "story" | "proposal";
	id: string;
	identifier: string;
	text: string;
	embedding: number[];
}

/** The text an error group is compared by, built the way a story's is. */
export function detectionTextForErrorGroup(group: RedactedErrorGroup): string {
	return buildDetectionText(
		group.title,
		[
			group.components.length > 0
				? `Components: ${group.components.join(", ")}`
				: "",
			...group.excerpts,
		]
			.filter(Boolean)
			.join("\n"),
	);
}

function proposalLabel(title: string): string {
	return title.slice(0, MAX_PROPOSAL_LABEL_CHARS);
}

function toMatch(candidate: Candidate, confidence: number): TrackedMatch {
	return candidate.kind === "story"
		? {
				kind: "story",
				storyId: candidate.id,
				identifier: candidate.identifier,
				confidence,
			}
		: {
				kind: "proposal",
				proposalId: candidate.id,
				identifier: candidate.identifier,
				confidence,
			};
}

export function createOpenBugMatcher(
	input: OpenBugMatcherInput,
): OpenBugMatcher {
	const embedOptions: Parameters<typeof generateEmbeddings>[1] = {
		userId: input.userId,
		organizationId: input.organizationId ?? undefined,
		projectId: input.projectId,
		featureKey: "knowledge-search",
	};
	let loading: Promise<Candidate[]> | null = null;
	let loaded: Candidate[] | null = null;
	/** Each checked group's vector, so `remember` need not embed it again. */
	const groupVectors = new Map<
		string,
		{ text: string; embedding: number[] }
	>();

	const loadStories = async (): Promise<Candidate[]> => {
		const stories = (await listOpenBugStoriesForMatching(input.projectId))
			.map((story) => ({
				id: story.id,
				identifier: story.identifier,
				text: detectionTextForStory(story),
			}))
			.filter((story) => story.text.length > 0);
		const { vectors } = await loadStoryVectors({
			...input,
			stories,
			logPrefix: LOG_PREFIX,
		});
		return stories.flatMap((story) => {
			const embedding = vectors.get(story.id);
			return embedding
				? [{ ...story, kind: "story" as const, embedding }]
				: [];
		});
	};

	const loadProposals = async (): Promise<Candidate[]> => {
		const proposals = (
			await listPendingLogProposalsForMatching(input.projectId)
		)
			.map((proposal) => ({
				id: proposal.id,
				identifier: proposalLabel(proposal.summary),
				text: buildDetectionText(proposal.summary, proposal.evidence),
			}))
			.filter((proposal) => proposal.text.length > 0);
		if (proposals.length === 0) {
			return [];
		}
		const { embeddings } = await generateEmbeddings(
			proposals.map((proposal) => proposal.text),
			embedOptions,
		);
		return proposals.flatMap((proposal, index) => {
			const embedding = embeddings[index];
			return embedding
				? [{ ...proposal, kind: "proposal" as const, embedding }]
				: [];
		});
	};

	const candidates = async (): Promise<Candidate[]> => {
		loading ??= Promise.all([loadStories(), loadProposals()]).then(
			([stories, proposals]) => {
				loaded = [...stories, ...proposals];
				return loaded;
			},
		);
		try {
			return await loading;
		} catch (err) {
			// Not cached as a failure: the next group retries the load, so one
			// transient error does not switch matching off for the whole scan.
			loading = null;
			throw err;
		}
	};

	const check = async (group: RedactedErrorGroup): Promise<OpenBugCheck> => {
		const pool = await candidates();
		if (pool.length === 0) {
			return NOTHING_CHECKED;
		}

		const text = detectionTextForErrorGroup(group);
		const {
			embeddings: [embedding],
		} = await generateEmbeddings([text], embedOptions);
		if (!embedding) {
			return NOTHING_CHECKED;
		}
		groupVectors.set(group.fingerprint, { text, embedding });
		// A dimension mismatch also scores 0, so a mid-run embedding-model
		// change degrades to "nothing to check" rather than to a garbage match.
		const shortlist = pool
			.map((candidate) => ({
				candidate,
				similarity: cosineSimilarity(embedding, candidate.embedding),
			}))
			.filter((entry) => entry.similarity > 0)
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, MAX_MATCH_CANDIDATES);
		if (shortlist.length === 0) {
			return NOTHING_CHECKED;
		}

		const { model, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{
				userId: input.userId,
				organizationId: input.organizationId ?? undefined,
				projectId: input.projectId,
			},
		);
		const checked = await Promise.all(
			shortlist.map(
				async ({
					candidate,
					similarity,
				}): Promise<CheckedCandidate> => {
					const scored = {
						kind: candidate.kind,
						identifier: candidate.identifier,
						similarity: Math.round(similarity * 1000) / 1000,
					};
					try {
						const { object: verdict } = await generateObject({
							model,
							schema: VerdictSchema,
							prompt: buildVerifierPrompt(
								{ identifier: "Recurring error", text },
								{
									identifier: candidate.identifier,
									text: candidate.text,
								},
							),
						});
						trackUsage();
						return {
							...scored,
							relationship:
								normalizeVerifierRelationship(verdict),
							confidence: verdict.confidence,
						};
					} catch (err) {
						// One failed verdict is "no match" for that candidate, not a
						// failed scan: the worst case is a proposal a reviewer can
						// dismiss.
						logger.warn(
							`${LOG_PREFIX} verifier failed for a candidate`,
							{
								projectId: input.projectId,
								err:
									err instanceof Error
										? err.message
										: String(err),
							},
						);
						return {
							...scored,
							relationship: null,
							confidence: null,
						};
					}
				},
			),
		);

		let match: TrackedMatch | null = null;
		for (const [index, { candidate }] of shortlist.entries()) {
			const { relationship, confidence } = checked[index] ?? {};
			if (
				relationship === "same_work_item" &&
				confidence != null &&
				confidence >= input.similarityThreshold &&
				(!match || confidence > match.confidence)
			) {
				match = toMatch(candidate, confidence);
			}
		}
		return { match, checked };
	};

	const remember = (
		group: RedactedErrorGroup,
		proposalId: string,
		title: string,
	): void => {
		const vector = groupVectors.get(group.fingerprint);
		if (!loaded || !vector) {
			return;
		}
		loaded.push({
			kind: "proposal",
			id: proposalId,
			identifier: proposalLabel(title),
			text: vector.text,
			embedding: vector.embedding,
		});
	};

	return { check, remember };
}
