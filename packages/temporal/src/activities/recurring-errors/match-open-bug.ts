/**
 * Whether a recurring log error is already tracked, so the scan adds to what
 * tracks it instead of proposing it again. Two things can track it:
 *   - an open bug someone filed by hand: the occurrences go on that bug;
 *   - a log-error proposal still awaiting review, filed for a different error
 *     group that is the same problem (one failure often logs several distinct
 *     messages): the group joins that proposal as related evidence, so the
 *     reviewer gets one proposal per problem rather than one per message.
 *
 * The duplicate detector's two stages, run one-against-many: the error's
 * text is embedded and compared with the candidates' vectors (open bugs from
 * the shared cache, pending proposals embedded when loaded). A proposal
 * remembered without a vector is embedded when a later check needs it, with
 * later checks retrying while its vector is missing. The closest few
 * candidates go to the detector's own verifier in parallel, costing one
 * verifier round trip per group. There is no similarity floor: a raw log
 * excerpt and a hand-written bug score low against each other even when they
 * describe the same failure, so the closest candidates with positive
 * similarity reach the verifier. Only a verdict that the two are the same
 * work item, at the detector's confidence bar, counts. Overlapping scope
 * does not: a report about the same area is not this error's ticket, and two
 * look-alike errors stay two proposals.
 *
 * Every candidate checked is returned with its score and verdict, so a
 * proposal filed anyway shows what was ruled out and why.
 *
 * Candidates are loaded on the first group that needs them and retained after
 * a successful load. Each proposal the scan files is added (`remember`) so a
 * later group in the same scan can join it. Rejected candidate-loading or
 * error-embedding calls throw; the scan records the failure and proceeds to
 * filing. Rejected embedding calls for remembered proposals are caught and
 * logged as warnings instead; candidates without vectors are skipped while
 * candidates with vectors remain usable.
 */

import { generateText, getAIModelWithMetadata, Output } from "@repo/ai";
import { requireStructuredOutput } from "@repo/ai/lib/structured-output";
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
	/** Sticky for this matcher: some candidates could not be compared reliably. */
	readonly degraded: boolean;
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
	embedding: number[] | undefined;
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
	let degraded = false;
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
			if (!embedding?.length) {
				degraded = true;
			}
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
			if (!embedding?.length) {
				degraded = true;
			}
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
		if (!embedding?.length) {
			degraded = true;
		}
		if (!embedding) {
			return NOTHING_CHECKED;
		}
		groupVectors.set(group.fingerprint, { text, embedding });
		// Groups first seen with an empty pool have no vector until a later
		// group needs to compare with them. Keep this batch separate so its
		// failure leaves candidates with existing vectors usable.
		const unembedded = pool.filter((candidate) => !candidate.embedding);
		if (unembedded.length > 0) {
			try {
				const { embeddings } = await generateEmbeddings(
					unembedded.map((candidate) => candidate.text),
					embedOptions,
				);
				for (const [index, candidate] of unembedded.entries()) {
					const vector = embeddings[index];
					candidate.embedding = vector?.length ? vector : undefined;
					if (!candidate.embedding) {
						degraded = true;
					}
				}
			} catch (err) {
				degraded = true;
				logger.warn(
					`${LOG_PREFIX} remembered proposal embeddings failed`,
					{
						projectId: input.projectId,
						err: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}
		// A dimension mismatch also scores 0, so a mid-run embedding-model
		// change degrades to "nothing to check" rather than to a garbage match.
		if (
			pool.some(
				(candidate) =>
					!candidate.embedding ||
					candidate.embedding.length !== embedding.length,
			)
		) {
			degraded = true;
		}
		const shortlist = pool
			.map((candidate) => ({
				candidate,
				similarity: candidate.embedding
					? cosineSimilarity(embedding, candidate.embedding)
					: 0,
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
						const { output: verdict } =
							await requireStructuredOutput(
								generateText({
									model,
									output: Output.object({
										schema: VerdictSchema,
									}),
									prompt: buildVerifierPrompt(
										{ identifier: "Recurring error", text },
										{
											identifier: candidate.identifier,
											text: candidate.text,
										},
									),
								}),
							);
						trackUsage();
						return {
							...scored,
							relationship:
								normalizeVerifierRelationship(verdict),
							confidence: verdict.confidence,
						};
					} catch (err) {
						degraded = true;
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
		if (!loaded) {
			return;
		}
		loaded.push({
			kind: "proposal",
			id: proposalId,
			identifier: proposalLabel(title),
			text: vector?.text ?? detectionTextForErrorGroup(group),
			embedding: vector?.embedding,
		});
	};

	return {
		check,
		remember,
		get degraded() {
			return degraded;
		},
	};
}
