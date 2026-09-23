/**
 * Meeting Digest — match action items to work items (#1902).
 *
 * Runs after insight extraction has produced `ProjectMeetingActionItem` rows,
 * and links each of them to the features and bugs it is actually about.
 *
 * The pipeline is deliberately the duplicate scanner's, one stage shallower:
 * embed both sides → cosine pre-filter to a handful of candidates → one LLM
 * verdict per action item → store the verdicts that clear the confidence
 * threshold. Story vectors come from (and are written back to) the SAME
 * `StoryDuplicateEmbedding` cache the duplicate scan uses, so the two features
 * warm each other's cache instead of each paying to embed the backlog.
 *
 * When the organization has a typed decision model configured, each item's
 * candidates first go to it in ONE `experimental_evaluate` call — a `boolean`
 * question per candidate over the same relationship rule the language verifier
 * is given — and a candidate whose answer is confident either way is settled
 * from that answer alone. Everything else (no decision model, an uncertain or
 * malformed answer, or any non-usage-limit decision error) falls through to the
 * language verifier, which stays the behaviour of record.
 *
 * What this activity will NOT do:
 *   - touch a pair the user has already decided (`listDecidedLinkKeys` covers
 *     both DISMISSED tombstones and existing MANUAL/CREATED rows), so a rejected
 *     suggestion stays rejected and a person's link is never relabelled AUTO;
 *   - fail the meeting because one verdict failed — per-item try/catch, counted
 *     and logged, the rest still link;
 *   - run at all when the feature flag is off.
 *
 * Failure of the whole run is not fatal to the digest: the caller is
 * fire-and-forget and the digest renders unlinked, which is the card's FR8 and
 * reliability NFR.
 */

import {
	experimental_evaluate,
	generateObject,
	getAIDecisionModelWithMetadata,
	getAIModelWithMetadata,
	resolveModelWithProvider,
} from "@repo/ai";
import {
	ACTION_ITEM_LINK_VERSION,
	type AutoLinkRow,
	baseModelName,
	computeActionItemKey,
	db,
	detectionTextForStory,
	hashDetectionText,
	insertAutoLinks,
	isFeatureEnabled,
	linkStateKey,
	listActiveStoriesForDetection,
	listDecidedLinkKeys,
	listStoryDuplicateEmbeddingMetadata,
	listStoryDuplicateEmbeddings,
	markActionItemsLinked,
	resolveMeetingDisplayName,
	upsertStoryDuplicateEmbeddings,
} from "@repo/database";
import { logger } from "@repo/logs";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { generateEmbeddings } from "@repo/rag";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";
import {
	buildMatchPrompt,
	type CandidateForPrompt,
	classifyMatch,
	MATCH_RULE_TEXT,
	MAX_CANDIDATE_DESCRIPTION_CHARS,
	resolveMinConfidence,
	type SelectedCandidate,
	selectCandidates,
} from "../../lib/action-item-link-core";

const LOG_PREFIX = "[MeetingDigest/linkActionItems]";

/** Heartbeat cadence through the per-item verifier loop. */
const HEARTBEAT_EVERY_ITEMS = 10;

/**
 * Typed decision fast path, mirroring `delivery-track/classify.ts` and
 * `backlog-context/route-action-items.ts`: the same retry budget, the same
 * acceptance floor, and the same rule that anything not clearly parseable is
 * uncertain rather than trusted.
 *
 * The floor is a routing policy, not a claim that provider probabilities are
 * calibrated. Until labeled Fabric link data calibrates it, only a very
 * confident typed answer may stand in for the language verifier — and it must
 * still clear the operator's `MEETING_ACTION_ITEM_LINK_MIN_CONFIDENCE`, which
 * stays authoritative for what becomes a stored link.
 */
const DECISION_TIMEOUT_MS = 30_000;
const DECISION_MAX_RETRIES = 1;
const DECISION_CONFIDENCE_THRESHOLD = 0.9;
// Stated as a literal rather than derived as `1 - DECISION_CONFIDENCE_THRESHOLD`,
// which is 0.09999999999999998 in binary floating point and would let an answer
// of exactly 0.1 escape the rejection arm.
const DECISION_REJECTION_THRESHOLD = 0.1;

/**
 * Read one `boolean` answer defensively: the probability that the action item
 * DOES relate to that candidate.
 *
 * An answer that is missing, not an object, not a boolean answer, or whose
 * probability is not a finite number in [0, 1] is uncertain — never a verdict.
 * A malformed answer must cost one language call, not a wrong link.
 */
function readRelatesAnswer(
	result: Awaited<ReturnType<typeof experimental_evaluate>>,
	questionKey: string,
): number | null {
	const answer = (result as { answers?: Record<string, unknown> }).answers?.[
		questionKey
	];
	if (!answer || typeof answer !== "object") {
		return null;
	}

	const { type, probability } = answer as {
		type?: unknown;
		probability?: unknown;
	};
	if (
		type !== "boolean" ||
		typeof probability !== "number" ||
		!Number.isFinite(probability) ||
		probability < 0 ||
		probability > 1
	) {
		return null;
	}

	return probability;
}

/**
 * `relates` is a boolean and `identifier` a plain string — never an enum — so a
 * slightly-off identifier costs one candidate rather than failing the whole
 * call's schema. `reasoning` is generously capped for the same reason the
 * duplicate verifier's is: a valid verdict must never be discarded because the
 * model was verbose.
 */
const VerdictSchema = z.object({
	verdicts: z.array(
		z.object({
			identifier: z.string(),
			relates: z.boolean(),
			confidence: z.number().min(0).max(1),
			reasoning: z.string().max(1000).optional(),
		}),
	),
});

export interface LinkMeetingActionItemsInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	transcriptCuid: string;
	/** Re-match even when the cache is fresh at the current link version. */
	force?: boolean;
}

export interface LinkMeetingActionItemsOutput {
	itemsConsidered: number;
	linksCreated: number;
	verifierFailures: number;
	/** Non-null when the run deliberately did nothing. */
	skipped: "flag-off" | "fresh" | "no-items" | "no-stories" | null;
}

const emptyResult = (
	skipped: LinkMeetingActionItemsOutput["skipped"],
): LinkMeetingActionItemsOutput => ({
	itemsConsidered: 0,
	linksCreated: 0,
	verifierFailures: 0,
	skipped,
});

export async function linkMeetingActionItemsActivity(
	input: LinkMeetingActionItemsInput,
): Promise<LinkMeetingActionItemsOutput> {
	const { projectId, organizationId, userId, transcriptCuid, force } = input;

	if (!(await isFeatureEnabled("MEETING_ACTION_ITEM_LINKING"))) {
		return emptyResult("flag-off");
	}

	heartbeat("linkActionItems: loading meeting");

	// Scoped by projectId, not just id: a transcript cuid from another project
	// must be unfindable here, not merely unauthorized upstream.
	const transcript = await db.projectMeetingTranscript.findFirst({
		where: { id: transcriptCuid, projectId },
		select: {
			id: true,
			meetingSubject: true,
			actionItemsLinkVersion: true,
			userId: true,
			organizationId: true,
			linkedMeeting: { select: { subject: true } },
			actionItems: {
				select: { text: true, tentativeOwnerName: true },
				orderBy: { orderIndex: "asc" },
			},
		},
	});
	if (!transcript) {
		throw new Error(
			`${LOG_PREFIX} transcript ${transcriptCuid} not found in project ${projectId}`,
		);
	}

	if (
		!force &&
		transcript.actionItemsLinkVersion === ACTION_ITEM_LINK_VERSION
	) {
		return emptyResult("fresh");
	}

	if (transcript.actionItems.length === 0) {
		// Stamp anyway: a meeting with no action items is matched, and re-opening
		// it should not keep re-entering this activity.
		await markActionItemsLinked({
			transcriptCuid,
			version: ACTION_ITEM_LINK_VERSION,
		});
		return emptyResult("no-items");
	}

	// AC10: candidates come from THIS project only. The scope is structural —
	// there is no cross-project code path to get wrong.
	const stories = await listActiveStoriesForDetection(projectId);
	const storiesWithText = stories
		.map((s) => ({
			id: s.id,
			identifier: s.identifier,
			title: s.title,
			description: s.description,
			text: detectionTextForStory(s),
		}))
		.filter((s) => s.text.length > 0);

	if (storiesWithText.length === 0) {
		await markActionItemsLinked({
			transcriptCuid,
			version: ACTION_ITEM_LINK_VERSION,
		});
		return emptyResult("no-stories");
	}

	// --- Story vectors: shared cache first, embed only the misses -----------
	heartbeat("linkActionItems: resolving embedding model");

	let currentModel: string;
	try {
		const resolved = await resolveModelWithProvider("EMBEDDING", {
			userId,
			organizationId: organizationId ?? undefined,
		});
		currentModel = baseModelName(resolved.modelString);
	} catch (err) {
		// No embedding model configured is an environment problem, not a data
		// one. Surface it so the activity retries (and the failure is visible)
		// rather than silently producing zero links forever.
		logger.error(`${LOG_PREFIX} embedding model resolution failed`, {
			projectId,
			err: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}

	const hashById = new Map(
		storiesWithText.map((s) => [s.id, hashDetectionText(s.text)]),
	);
	const cacheMeta = await listStoryDuplicateEmbeddingMetadata(projectId);
	const cacheMetaByStoryId = new Map(cacheMeta.map((r) => [r.storyId, r]));
	const staleStories = storiesWithText.filter((s) => {
		const cached = cacheMetaByStoryId.get(s.id);
		return (
			!cached ||
			cached.contentHash !== hashById.get(s.id) ||
			cached.model !== currentModel
		);
	});
	const staleIds = new Set(staleStories.map((s) => s.id));

	const embeddingByStoryId = new Map<string, number[]>();
	if (staleIds.size < storiesWithText.length) {
		for (const row of await listStoryDuplicateEmbeddings(projectId)) {
			if (!staleIds.has(row.storyId)) {
				embeddingByStoryId.set(row.storyId, row.embedding);
			}
		}
	}

	heartbeat("linkActionItems: embedding");

	if (staleStories.length > 0) {
		const { embeddings, model } = await generateEmbeddings(
			staleStories.map((s) => s.text),
			{ userId, organizationId: organizationId ?? undefined, projectId },
		);
		staleStories.forEach((s, i) => {
			embeddingByStoryId.set(s.id, embeddings[i]);
		});
		// Write back to the SHARED cache so the duplicate scan reuses this work.
		// Best-effort: a cache write failure must not fail a run whose matching
		// work already succeeded — the next run simply re-embeds.
		try {
			await upsertStoryDuplicateEmbeddings(
				projectId,
				staleStories.map((s, i) => ({
					storyId: s.id,
					contentHash: hashById.get(s.id) ?? "",
					model,
					embedding: embeddings[i],
				})),
			);
		} catch (err) {
			logger.warn(
				`${LOG_PREFIX} embedding cache write failed — continuing`,
				{
					projectId,
					rows: staleStories.length,
					err: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	const candidateStories = storiesWithText
		.map((s) => {
			const embedding = embeddingByStoryId.get(s.id);
			return embedding ? { ...s, embedding } : null;
		})
		.filter(
			(
				s,
			): s is (typeof storiesWithText)[number] & {
				embedding: number[];
			} => s !== null,
		);

	// --- Action item vectors -------------------------------------------------
	const items = transcript.actionItems.map((item) => ({
		...item,
		itemKey: computeActionItemKey(item.text),
	}));
	const { embeddings: itemEmbeddings } = await generateEmbeddings(
		items.map((i) => i.text),
		{ userId, organizationId: organizationId ?? undefined, projectId },
	);

	// --- Verify ---------------------------------------------------------------
	const decidedKeys = await listDecidedLinkKeys(transcriptCuid);
	const minConfidence = resolveMinConfidence();
	const storyById = new Map(candidateStories.map((s) => [s.id, s]));
	// The occurrence's name, not the series', so the model is told what the
	// meeting was actually called (#2340).
	const meetingSubject = resolveMeetingDisplayName({
		occurrence: transcript.meetingSubject,
		series: transcript.linkedMeeting?.subject,
	});

	const { model, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		// projectId threaded so this feature's token spend is attributable in
		// ai_usage_log — without it the cost of linking is unmeasurable.
		{
			userId,
			organizationId: organizationId ?? undefined,
			projectId,
			jobType: "meeting-transcript-sync",
		},
	);

	// Optional typed decision model, resolved ONCE per run. It is a fast path,
	// not a dependency: an organization without an organization-owned Vercel
	// Gateway decision model — or any other resolution failure — verifies every
	// item with the language model exactly as it does today. Only a usage limit
	// escapes, because retrying through the language verifier would bill the
	// very spend the limit refused.
	let decisionModel: Awaited<
		ReturnType<typeof getAIDecisionModelWithMetadata>
	> | null = null;
	try {
		decisionModel = await getAIDecisionModelWithMetadata({
			userId,
			organizationId: organizationId ?? undefined,
			projectId,
		});
	} catch (err) {
		if (err instanceof AiUsageLimitExceededError) {
			throw err;
		}
		decisionModel = null;
		logger.info(
			`${LOG_PREFIX} decision model unavailable; using language verifier only`,
			{
				projectId,
				err: err instanceof Error ? err.message : String(err),
			},
		);
	}

	const accepted: AutoLinkRow[] = [];
	// Fast-path accounting, for the run-complete log only — the activity's
	// output shape is unchanged.
	let decisionLinks = 0;
	let decisionResolvedItems = 0;
	let verifierFailures = 0;
	// Items that actually reached a model — the decision model, the language
	// verifier, or both. Compared against verifierFailures below to tell "the
	// provider is down" apart from "nothing cleared the cosine floor": items
	// with no candidates call neither model and must not count toward either
	// number.
	let verifierAttempts = 0;

	for (const [index, item] of items.entries()) {
		if (index % HEARTBEAT_EVERY_ITEMS === 0) {
			heartbeat(
				`linkActionItems: verifying ${index + 1}/${items.length}`,
			);
		}

		const candidates = selectCandidates(
			itemEmbeddings[index],
			candidateStories,
		).filter(
			(c) => !decidedKeys.has(linkStateKey(item.itemKey, c.storyId)),
		);
		if (candidates.length === 0) {
			continue;
		}

		// Counted ONCE per item that has candidates, whichever model settles
		// it. Counting only the language call would make an item the decision
		// model settled invisible here, so a run of one fast-path success and
		// one decision failure would read as "every attempt failed" and throw
		// away the link it had already accepted. Without a decision model this
		// is the same count as before: one per candidate-bearing item.
		verifierAttempts += 1;

		// --- Typed decision fast path ---------------------------------------
		// Candidates the decision model did not settle. Without a decision
		// model this stays the full list, which is today's behaviour exactly.
		let leftover: SelectedCandidate[] = candidates;
		if (decisionModel) {
			// An extra beat because this item may now make TWO model calls and
			// the workflow's heartbeatTimeout is 2 minutes
			// (`workflows/link-meeting-action-items.ts`); the every-10 cadence
			// above is not enough on its own.
			heartbeat(`linkActionItems: deciding ${index + 1}/${items.length}`);

			const questions: Record<
				string,
				{ type: "boolean"; instructions: string }
			> = {};
			// Synthetic keys: a work-item identifier is not safe as an object
			// key at the provider, and mapping back by index costs nothing.
			const stateCandidates = candidates.map((c, candidateIndex) => {
				const key = `candidate_${candidateIndex}`;
				const story = storyById.get(c.storyId);
				questions[key] = {
					type: "boolean",
					instructions: `Apply policy to the work item keyed "${key}" in candidates, and judge only that work item. Answer whether actionItem is a follow-up ON it — that is, whether doing actionItem would advance, change, or resolve that specific work item. Merely touching the same area, the same feature family, or the same component is false; shared subject matter is not a relationship.`,
				};
				return {
					key,
					identifier: c.identifier,
					title: story?.title ?? c.identifier,
					description: (story?.description ?? "")
						.trim()
						.slice(0, MAX_CANDIDATE_DESCRIPTION_CHARS),
				};
			});

			let decision: Awaited<
				ReturnType<typeof experimental_evaluate>
			> | null = null;
			try {
				decision = await experimental_evaluate({
					model: decisionModel.model,
					state: {
						policy: MATCH_RULE_TEXT,
						meetingSubject: meetingSubject ?? "",
						actionItem: {
							text: item.text,
							tentativeOwnerName: item.tentativeOwnerName ?? "",
						},
						candidates: stateCandidates,
					},
					questions,
					maxRetries: DECISION_MAX_RETRIES,
					abortSignal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
				});
			} catch (err) {
				if (err instanceof AiUsageLimitExceededError) {
					// The one decision failure that must NOT be retried through
					// the language verifier: doing so would bill the very spend
					// the limit refused. Counted as a verifier failure against
					// the attempt already recorded above, so a run where every
					// item hits the limit still fails for retry rather than
					// stamping zero links.
					verifierFailures += 1;
					logger.warn(
						`${LOG_PREFIX} decision usage limit reached for an item — skipping`,
						{ projectId, transcriptCuid },
					);
					continue;
				}
				// Timeout, provider error, malformed response: the item simply
				// goes to the language verifier with ALL of its candidates, so
				// this is not a verifier failure and is not counted as one.
				logger.warn(
					`${LOG_PREFIX} decision evaluation unavailable — using the language verifier`,
					{
						projectId,
						transcriptCuid,
						err: err instanceof Error ? err.message : String(err),
					},
				);
			}

			if (decision) {
				// A completed evaluation used the organization provider even
				// when no answer is confident enough for the fast path, so
				// update last-used BEFORE inspecting the answers.
				decisionModel.trackUsage();

				const uncertain: SelectedCandidate[] = [];
				let decidedRelated = 0;
				let decidedUnrelated = 0;
				for (const [
					candidateIndex,
					candidate,
				] of candidates.entries()) {
					const probability = readRelatesAnswer(
						decision,
						`candidate_${candidateIndex}`,
					);
					if (
						probability !== null &&
						probability >= DECISION_CONFIDENCE_THRESHOLD &&
						// The operator's env threshold stays authoritative: a
						// probability that clears the routing floor but not a
						// higher minConfidence is uncertain, not accepted.
						classifyMatch(
							{ relates: true, confidence: probability },
							minConfidence,
						)
					) {
						decidedRelated += 1;
						accepted.push({
							itemKey: item.itemKey,
							itemTextSnapshot: item.text,
							storyId: candidate.storyId,
							similarity: candidate.similarity,
							confidence: probability,
							// A typed evaluation returns a probability, not
							// written evidence. Store none rather than invent
							// any.
							reasoning: null,
						});
						continue;
					}
					if (
						probability !== null &&
						probability <= DECISION_REJECTION_THRESHOLD
					) {
						decidedUnrelated += 1;
						continue;
					}
					uncertain.push(candidate);
				}

				decisionLinks += decidedRelated;
				leftover = uncertain;
				// Counts only — never item or story text (worker-log redaction
				// policy, as for the run-complete log below).
				logger.info(`${LOG_PREFIX} decision fast path`, {
					projectId,
					transcriptCuid,
					related: decidedRelated,
					unrelated: decidedUnrelated,
					uncertain: uncertain.length,
				});
			}
		}

		if (leftover.length === 0) {
			// Every candidate was settled typed — the language verifier was
			// never called for this item, though the item itself still counts
			// as an attempt above.
			decisionResolvedItems += 1;
			continue;
		}

		if (decisionModel) {
			// The decision call just spent up to DECISION_TIMEOUT_MS plus one
			// retry, and the language call that follows has no abort timeout of
			// its own — together they can outlast the workflow's 2-minute
			// heartbeatTimeout. Beat here so the language call starts from a
			// fresh deadline. Not reached without a decision model, so that
			// path's heartbeat cadence is unchanged.
			heartbeat(
				`linkActionItems: verifying ${index + 1}/${items.length}`,
			);
		}

		// --- Language verifier (the behaviour of record) ---------------------
		// Rebuilt from the leftovers alone: the prompt and the identifier
		// allowlist below both key on the exact set the model was given.
		const byIdentifier = new Map(leftover.map((c) => [c.identifier, c]));
		const promptCandidates: CandidateForPrompt[] = leftover.map((c) => {
			const story = storyById.get(c.storyId);
			return {
				identifier: c.identifier,
				title: story?.title ?? c.identifier,
				description: story?.description ?? null,
			};
		});

		try {
			const { object } = await generateObject({
				model,
				schema: VerdictSchema,
				prompt: buildMatchPrompt(
					{
						text: item.text,
						tentativeOwnerName: item.tentativeOwnerName,
					},
					meetingSubject,
					promptCandidates,
				),
			});
			trackUsage();

			for (const verdict of object.verdicts) {
				const candidate = byIdentifier.get(verdict.identifier);
				// An identifier the model invented, or one for a candidate it was
				// not given, is dropped rather than guessed at.
				if (!candidate || !classifyMatch(verdict, minConfidence)) {
					continue;
				}
				accepted.push({
					itemKey: item.itemKey,
					itemTextSnapshot: item.text,
					storyId: candidate.storyId,
					similarity: candidate.similarity,
					confidence: verdict.confidence,
					reasoning: verdict.reasoning ?? null,
				});
			}
		} catch (err) {
			// One flaky verdict is skipped, not fatal. The meeting is still
			// stamped, so a retry does not re-spend the whole run for one item;
			// a user can re-trigger with force if it matters.
			verifierFailures += 1;
			logger.warn(
				`${LOG_PREFIX} verifier failed for an item — skipping`,
				{
					projectId,
					transcriptCuid,
					err: err instanceof Error ? err.message : String(err),
					modelText: (err as { text?: string })?.text?.slice(0, 300),
				},
			);
		}
	}

	// EVERY verifier call failed — the provider is wholesale broken (outage, or a
	// model that cannot produce the structured verdict). Throw BEFORE stamping so
	// Temporal's retry policy engages, exactly as the duplicate scanner does with
	// `throwOnWholesaleVerifierFailure`.
	//
	// Stamping here instead would be a silent, permanent failure: the version
	// guard would treat the meeting as matched forever, so it would never be
	// retried and would sit with zero links and no indication anything went
	// wrong. A meeting is matched once, which makes that single run's outcome
	// load-bearing — the opposite of the duplicate scan, where the next scan
	// picks up what the last one dropped.
	if (verifierAttempts > 0 && verifierFailures === verifierAttempts) {
		throw new Error(
			`${LOG_PREFIX} verifier failed for all ${verifierAttempts} action item(s) — failing activity for retry`,
		);
	}

	const linksCreated = await insertAutoLinks({
		transcriptId: transcriptCuid,
		projectId,
		userId: transcript.userId,
		organizationId: transcript.organizationId,
		rows: accepted,
	});

	await markActionItemsLinked({
		transcriptCuid,
		version: ACTION_ITEM_LINK_VERSION,
	});

	// Counts only — never item or story text (worker-log redaction policy).
	logger.info(`${LOG_PREFIX} run complete`, {
		projectId,
		transcriptCuid,
		items: items.length,
		stories: candidateStories.length,
		embedded: staleStories.length,
		reused: candidateStories.length - staleStories.length,
		linksCreated,
		verifierFailures,
		minConfidence,
		decisionLinks,
		decisionResolvedItems,
	});

	return {
		itemsConsidered: items.length,
		linksCreated,
		verifierFailures,
		skipped: null,
	};
}
