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
	generateObject,
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
	upsertStoryDuplicateEmbeddings,
} from "@repo/database";
import { logger } from "@repo/logs";
import { generateEmbeddings } from "@repo/rag";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";
import {
	buildMatchPrompt,
	type CandidateForPrompt,
	classifyMatch,
	resolveMinConfidence,
	selectCandidates,
} from "../../lib/action-item-link-core";

const LOG_PREFIX = "[MeetingDigest/linkActionItems]";

/** Heartbeat cadence through the per-item verifier loop. */
const HEARTBEAT_EVERY_ITEMS = 10;

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
	const meetingSubject =
		transcript.linkedMeeting?.subject ?? transcript.meetingSubject ?? null;

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

	const accepted: AutoLinkRow[] = [];
	let verifierFailures = 0;
	// Items that actually reached the verifier. Compared against verifierFailures
	// below to tell "the provider is down" apart from "nothing cleared the cosine
	// floor" — items with no candidates never call the LLM and must not count
	// toward either number.
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

		const byIdentifier = new Map(candidates.map((c) => [c.identifier, c]));
		const promptCandidates: CandidateForPrompt[] = candidates.map((c) => {
			const story = storyById.get(c.storyId);
			return {
				identifier: c.identifier,
				title: story?.title ?? c.identifier,
				description: story?.description ?? null,
			};
		});

		verifierAttempts += 1;
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
	});

	return {
		itemsConsidered: items.length,
		linksCreated,
		verifierFailures,
		skipped: null,
	};
}
