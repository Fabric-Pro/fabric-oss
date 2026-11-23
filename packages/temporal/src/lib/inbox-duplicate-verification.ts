/**
 * The duplicate verifier for the Proposal Inbox: the roadmap scan's
 * confirmation step, run on the candidate pairs the inbox's read path found
 * (`proposal-duplicate-matching.ts` in @repo/api), with the verdicts stored
 * in `ProposalItemDuplicateVerdict`.
 *
 * Each pair gets the roadmap's verifier call (`verifyDuplicatePair`), the
 * same prompt, read on the section the pair was scored on, and the same
 * second opinion before a re-check changes what the inbox shows
 * (`verdictChangesState` and `confirmedEffect`). A pair is verified again only
 * when one side's verdict hash has changed since its verdict.
 *
 * The pairs are read fresh: an item resolved or a ticket closed since the
 * read path found the pair is skipped, and an edited one is verified on its
 * current text. A failed verification is recorded on the pair's row, so a
 * pair that keeps failing waits (`inboxVerdictState`) instead of being
 * billed on every check of the inbox. Throws when every pair it took up
 * failed, so the activity retries; one failed pair is left for the next run.
 */

import { getAIModelWithMetadata } from "@repo/ai";
import {
	buildVerifierPrompt,
	detectionVerdictHash,
	getProposalItemDuplicateVerdict,
	type InboxDuplicatePair,
	type InboxDuplicateVerdict,
	type InboxItemRef,
	inboxItemSubject,
	inboxVerdictKey,
	inboxVerdictState,
	listActiveStoriesForDetection,
	listUnresolvedPendingProposalItems,
	MAX_LLM_VERIFICATIONS,
	orderInboxPair,
	recordProposalItemDuplicateVerdictFailure,
	stampProposalItemDuplicateVerdict,
	storySubject,
	upsertProposalItemDuplicateVerdict,
	type VerdictSubject,
} from "@repo/database";
import type { DuplicateLinkType } from "@repo/database/prisma/generated/enums";
import { logger } from "@repo/logs";
import {
	confirmedEffect,
	type DuplicateLinkState,
	type DuplicateVerifier,
	RUN_TIME_BUDGET_MS,
	type VerdictEffect,
	verdictChangesState,
	verifyDuplicatePair,
} from "./duplicate-scan-core";

const LOG_PREFIX = "[Inbox Dup Verify]";

/** Pairs verified at once. The queue holds each pair once, and each pair
 * has a row of its own. */
const VERIFY_CONCURRENCY = 3;

export interface VerifyInboxDuplicatesParams {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	pairs: InboxDuplicatePair[];
}

export interface VerifyInboxDuplicatesResult {
	/** Pairs this run took up: both sides still in review. */
	attempted: number;
	/** Of those, pairs with nothing to do: already verified on the current
	 * texts, or waiting after failing on them. */
	current: number;
	/** Of those, pairs flagged once the verdict was in. */
	flagged: number;
	/** Of those, pairs whose verification failed. */
	failed: number;
	/** Pairs not taken up: a side no longer in review. */
	skipped: number;
	/** Pairs over the cap or not reached in time; the next check asks
	 * for them again. */
	leftOver: number;
}

/** A stored inbox verdict as the roadmap's state rules read a link; a row
 * the verifier has not decided yet is no link. */
function asLinkState(
	verdict: InboxDuplicateVerdict | null,
): DuplicateLinkState {
	return verdict && verdict.flagged !== null
		? {
				status: verdict.flagged ? "PENDING" : "NOT_DUPLICATE",
				linkType: verdict.linkType,
				verifiedContentHashA: verdict.contentHash,
				verifiedContentHashB: verdict.counterpartHash,
			}
		: null;
}

function linkTypeOf(effect: VerdictEffect): DuplicateLinkType | null {
	switch (effect) {
		case "link:DUPLICATE":
			return "DUPLICATE";
		case "link:OVERLAP":
			return "OVERLAP";
		case "clear":
		case "cache":
			return null;
		default: {
			const unhandled: never = effect;
			return unhandled;
		}
	}
}

function itemKeyOf(item: InboxItemRef): string {
	return `${item.proposalId}:${item.changeIndex}`;
}

/** The two sides of a pair in stored order, read fresh, or null when one is
 * no longer in review. */
function pairSubjects(
	pair: InboxDuplicatePair,
	items: ReadonlyMap<string, VerdictSubject>,
	stories: ReadonlyMap<string, VerdictSubject>,
): { item: VerdictSubject; counterpart: VerdictSubject } | null {
	const item = items.get(itemKeyOf(pair.item));
	const counterpart =
		pair.counterpart.kind === "story"
			? stories.get(pair.counterpart.storyId)
			: items.get(itemKeyOf(pair.counterpart));
	return item && counterpart ? { item, counterpart } : null;
}

/**
 * Verify the inbox's candidate pairs that have no current verdict, at most
 * `MAX_LLM_VERIFICATIONS` of them and within `RUN_TIME_BUDGET_MS`, and store
 * each verdict.
 */
export async function verifyInboxDuplicatePairs(
	params: VerifyInboxDuplicatesParams,
): Promise<VerifyInboxDuplicatesResult> {
	const { projectId, userId } = params;
	const startedAt = Date.now();
	const unique = new Map<string, InboxDuplicatePair>();
	for (const pair of params.pairs) {
		const ordered = orderInboxPair(pair.item, pair.counterpart);
		const key = inboxVerdictKey(ordered.item, ordered.counterpart);
		if (!unique.has(key)) {
			unique.set(key, {
				...pair,
				item: ordered.item,
				counterpart: ordered.counterpart,
			});
		}
	}
	const queue = Array.from(unique.values()).slice(0, MAX_LLM_VERIFICATIONS);
	const result: VerifyInboxDuplicatesResult = {
		attempted: 0,
		current: 0,
		flagged: 0,
		failed: 0,
		skipped: 0,
		leftOver: unique.size - queue.length,
	};
	if (queue.length === 0) {
		return result;
	}

	const pendingItems = await listUnresolvedPendingProposalItems({
		projectId,
	});
	const items = new Map(
		pendingItems.map((item) => [itemKeyOf(item), inboxItemSubject(item)]),
	);
	const hasStoryPair = queue.some((p) => p.counterpart.kind === "story");
	const activeStories = hasStoryPair
		? await listActiveStoriesForDetection(projectId)
		: [];
	const stories = new Map(
		activeStories.map((story) => [story.id, storySubject(story)]),
	);
	const verifier: DuplicateVerifier = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId,
			organizationId: params.organizationId ?? undefined,
			projectId,
			featureKey: "duplicate-scan",
		},
	);

	const verifyOne = async (pair: InboxDuplicatePair) => {
		const sides = pairSubjects(pair, items, stories);
		if (!sides) {
			result.skipped += 1;
			return;
		}
		const hashes = {
			item: detectionVerdictHash(sides.item),
			counterpart: detectionVerdictHash(sides.counterpart),
		};
		const focusKind = pair.focusKind;
		const textA = focusKind ? sides.item.focusTexts?.[focusKind] : null;
		const textB = focusKind
			? sides.counterpart.focusTexts?.[focusKind]
			: null;
		const bothFeatures =
			sides.item.kind === "FEATURE" &&
			sides.counterpart.kind === "FEATURE";
		const prompt = buildVerifierPrompt(sides.item, sides.counterpart, {
			proximate: pair.proximate,
			focus:
				focusKind && textA && textB
					? { kind: focusKind, textA, textB }
					: undefined,
			bothFeatures,
		});
		const verify = () =>
			verifyDuplicatePair({ verifier, prompt, bothFeatures });
		const readVerdict = () =>
			getProposalItemDuplicateVerdict(pair.item, pair.counterpart);
		const stateOf = (verdict: InboxDuplicateVerdict | null) =>
			inboxVerdictState(verdict, hashes, Date.now());
		// Counted before the first read, so a failed read counts towards a
		// wholesale failure, as in the roadmap scan.
		result.attempted += 1;
		try {
			const prior = await readVerdict();
			// Verified on these texts, or waiting after failing on them,
			// maybe by an overlapping run: nothing to do.
			if (stateOf(prior) !== "unverified") {
				result.current += 1;
				return;
			}
			const priorState = asLinkState(prior);
			const { verdict, effect: first } = await verify();
			const effect = verdictChangesState(priorState, first)
				? confirmedEffect(priorState, first, (await verify()).effect)
				: first;
			// An overlapping run decided the same texts while the verifier
			// calls ran: its verdict stands.
			const latest = stateOf(await readVerdict());
			if (latest === "flagged" || latest === "clear") {
				result.current += 1;
				return;
			}
			const linkType = effect ? linkTypeOf(effect) : null;
			// No second opinion behind a change, or an unsure verdict on a
			// flagged pair: the pair keeps its state on the new texts.
			if (effect === null || (effect === "cache" && prior?.flagged)) {
				await stampProposalItemDuplicateVerdict({
					item: pair.item,
					counterpart: pair.counterpart,
					hashes,
				});
				result.flagged += prior?.flagged ? 1 : 0;
				return;
			}
			await upsertProposalItemDuplicateVerdict({
				item: pair.item,
				counterpart: pair.counterpart,
				hashes,
				flagged: linkType !== null,
				linkType: linkType ?? "DUPLICATE",
				similarity: pair.similarity,
				confidence: verdict.confidence,
				reasoning: verdict.reasoning,
			});
			result.flagged += linkType !== null ? 1 : 0;
		} catch (err) {
			result.failed += 1;
			logger.warn(`${LOG_PREFIX} verifier failed for a pair — skipping`, {
				projectId,
				err: err instanceof Error ? err.message : String(err),
			});
			await recordProposalItemDuplicateVerdictFailure({
				item: pair.item,
				counterpart: pair.counterpart,
				hashes,
				similarity: pair.similarity,
			}).catch((recordErr: unknown) => {
				logger.warn(`${LOG_PREFIX} could not record the failure`, {
					projectId,
					err:
						recordErr instanceof Error
							? recordErr.message
							: String(recordErr),
				});
			});
		}
	};

	let next = 0;
	const worker = async () => {
		while (next < queue.length) {
			const pair = queue[next];
			next += 1;
			if (
				result.attempted > 0 &&
				Date.now() - startedAt >= RUN_TIME_BUDGET_MS
			) {
				result.leftOver += 1;
				continue;
			}
			if (pair) {
				await verifyOne(pair);
			}
		}
	};
	await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, worker));

	logger.info(`${LOG_PREFIX} run complete`, { projectId, ...result });
	if (result.attempted > 0 && result.failed >= result.attempted) {
		throw new Error(
			`${LOG_PREFIX} verifier failed for all ${result.attempted} pair(s) — failing activity for retry`,
		);
	}
	return result;
}
