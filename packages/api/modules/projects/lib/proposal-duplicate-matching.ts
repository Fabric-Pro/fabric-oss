/**
 * Embedding side of duplicate detection against the Proposal Inbox. The
 * scoring itself is pure and lives in `proposal-duplicate-scoring.ts`.
 *
 * Inbox items have no embedding cache (they are short-lived and change on
 * every merge), so their texts ride in the SAME batched request as the
 * routing corpus's stale ticket re-embeds (`loadRoutingCorpus` `itemTexts`):
 * one embedding pass per call. A project with no tickets loads no corpus, so
 * its inbox texts are embedded in one direct request instead. The item count
 * is capped per call and every text is capped by `buildDetectionText`, which
 * bounds the cost whatever the inbox holds.
 *
 * Ticket matches follow `stories.checkDuplicate`: the same routing shortlist
 * and, for a shortlist below the duplicate bar, the same routing judge. See
 * `proposal-duplicate-scoring.ts` for the rule.
 */

import {
	buildDetectionText,
	listUnresolvedPendingProposalItems,
	type PendingProposalMatchItem,
	routingConfidenceThreshold,
} from "@repo/database";
import { logger } from "@repo/logs";
import { generateEmbeddings } from "@repo/rag";
import {
	type EmptyRoutingCorpus,
	judgeRoutingItem,
	loadRoutingCorpus,
	type ReadyRoutingCorpus,
	resolveRoutingModels,
	type RoutingAlternative,
	routingShortlist,
} from "@repo/temporal/backlog-routing-core";
import {
	buildDuplicateFlags,
	confidentTickets,
	judgeBand,
	MAX_MANUAL_ENTRY_MATCHES,
	type ProposalDuplicateFlag,
	type ProposalInboxMatch,
	rankSimilar,
} from "./proposal-duplicate-scoring";

/** Inbox items embedded per call, newest proposals first. */
export const MAX_INBOX_ITEMS_SCANNED = 150;

/** How an inbox item was captured, as the judge prompt renders it. */
const INBOX_ITEM_REASONING =
	"Proposed in the Proposal Inbox as a new roadmap work item.";

interface EmbeddingScope {
	projectId: string;
	userId: string;
	organizationId?: string;
	abortSignal?: AbortSignal;
}

/** An unresolved inbox item with its detection text. */
export interface InboxMatchEntry {
	item: PendingProposalMatchItem;
	text: string;
}

/** The unresolved inbox items a duplicate check scans, with their texts. */
export async function listInboxMatchEntries(
	projectId: string,
): Promise<InboxMatchEntry[]> {
	const items = await listUnresolvedPendingProposalItems({
		projectId,
		maxItems: MAX_INBOX_ITEMS_SCANNED,
	});
	return items
		.map((item) => ({
			item,
			text: buildDetectionText(item.title, item.description),
		}))
		.filter((entry) => entry.text.length > 0);
}

/**
 * The texts a manual-create check passes to `loadRoutingCorpus`: the entry
 * first, then the inbox items, so all of them are embedded in one request.
 */
export function manualEntryCorpusTexts(
	itemText: string,
	entries: readonly InboxMatchEntry[],
): string[] {
	return [itemText, ...entries.map((entry) => entry.text)];
}

/** What the matcher reads from a loaded `RoutingCorpus`. */
type CorpusItemEmbeddings =
	| EmptyRoutingCorpus
	| Pick<ReadyRoutingCorpus, "kind" | "itemEmbeddings">;

/** The embeddings of `texts`: from the corpus batch, else one request. */
async function embedItemTexts(
	texts: string[],
	corpus: CorpusItemEmbeddings,
	scope: EmbeddingScope,
): Promise<number[][]> {
	if (corpus.kind === "ready") {
		return corpus.itemEmbeddings;
	}
	const { embeddings } = await generateEmbeddings(
		texts,
		{
			userId: scope.userId,
			organizationId: scope.organizationId,
			projectId: scope.projectId,
			featureKey: "backlog-update",
		},
		undefined,
		scope.abortSignal,
	);
	return embeddings;
}

/**
 * Pending inbox items similar to a manually entered work item, strongest
 * first. `corpus` was loaded with `manualEntryCorpusTexts(itemText,
 * entries)`. Throws on an embedding failure; the caller decides how that
 * degrades.
 */
export async function findProposalInboxMatches(
	params: EmbeddingScope & {
		itemText: string;
		entries: readonly InboxMatchEntry[];
		corpus: CorpusItemEmbeddings;
	},
): Promise<ProposalInboxMatch[]> {
	if (params.entries.length === 0) {
		return [];
	}
	const [query, ...vectors] = await embedItemTexts(
		manualEntryCorpusTexts(params.itemText, params.entries),
		params.corpus,
		params,
	);
	if (!query) {
		return [];
	}
	const candidates = params.entries.map((entry, index) => ({
		...entry.item,
		embedding: vectors[index] ?? [],
	}));
	return rankSimilar(query, candidates, MAX_MANUAL_ENTRY_MATCHES).map(
		({ candidate, similarity }) => ({
			proposalId: candidate.proposalId,
			changeIndex: candidate.changeIndex,
			title: candidate.title,
			summary: candidate.proposalSummary,
			source: candidate.source,
			similarity,
		}),
	);
}

/** Resolves to null once `signal` aborts; never rejects. */
function abandonedOn(signal: AbortSignal): Promise<null> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(null);
			return;
		}
		signal.addEventListener("abort", () => resolve(null), { once: true });
	});
}

/**
 * The routing judge's verdict for each item in `band` (positions into
 * `texts`), as `stories.checkDuplicate` runs it: the target of an `enrich`
 * verdict, by position. A `create` or `failed` verdict, a failed model
 * resolution, or the judge stage's abort adds nothing; the stage never
 * throws.
 */
async function verifyBand(
	params: Omit<EmbeddingScope, "abortSignal"> & {
		logPrefix: string;
		corpus: ReadyRoutingCorpus;
		texts: readonly string[];
		vectors: readonly number[][];
		band: readonly number[];
		judgeSignal: AbortSignal;
	},
): Promise<Map<number, RoutingAlternative>> {
	const verified = new Map<number, RoutingAlternative>();
	if (params.band.length === 0) {
		return verified;
	}
	const abandoned = abandonedOn(params.judgeSignal);
	const models = await Promise.race([
		resolveRoutingModels({
			userId: params.userId,
			organizationId: params.organizationId,
			projectId: params.projectId,
			logPrefix: params.logPrefix,
		}).catch(() => null),
		abandoned,
	]);
	if (!models) {
		logger.warn(`${params.logPrefix} judge stage skipped`, {
			projectId: params.projectId,
			items: params.band.length,
			aborted: params.judgeSignal.aborted,
		});
		return verified;
	}

	const verdicts = await Promise.all(
		params.band.map((index) =>
			Promise.race([
				judgeRoutingItem({
					itemText: params.texts[index] ?? "",
					analyzerReasoning: INBOX_ITEM_REASONING,
					itemEmbedding: params.vectors[index] ?? [],
					candidateVectors: params.corpus.candidateVectors,
					storyById: params.corpus.storyById,
					textByStoryId: params.corpus.textByStoryId,
					judge: models.judge,
					decisionModel: models.decisionModel,
					threshold: routingConfidenceThreshold(),
					userId: params.userId,
					organizationId: params.organizationId,
					projectId: params.projectId,
					logPrefix: params.logPrefix,
					abortSignal: params.judgeSignal,
				}),
				abandoned,
			]),
		),
	);
	let failed = 0;
	let unfinished = 0;
	verdicts.forEach((verdict, position) => {
		const index = params.band[position];
		if (verdict === null) {
			unfinished += 1;
		} else if (verdict.kind === "failed") {
			failed += 1;
		} else if (verdict.kind === "enrich" && index !== undefined) {
			verified.set(index, verdict.target);
		}
	});
	if (failed > 0 || unfinished > 0) {
		logger.warn(`${params.logPrefix} judge stage incomplete`, {
			projectId: params.projectId,
			items: params.band.length,
			failed,
			unfinished,
		});
	}
	return verified;
}

/**
 * Possible duplicates for every unresolved create item of the project's
 * PENDING proposals, in one embedding pass: roadmap tickets, and the other
 * inbox items, siblings included.
 *
 * A ticket on an item's routing shortlist at or above the duplicate bar is
 * a match outright. Items whose best ticket is below it go to the routing
 * judge (at most `MAX_VERIFIED_INBOX_ITEMS`, in parallel, under
 * `judgeSignal`), and only an `enrich` verdict adds its target. When the
 * judge stage aborts, the matches found without it are returned. Throws
 * only on a wholesale load or embedding failure.
 */
export async function detectInboxDuplicates(
	params: EmbeddingScope & {
		maxStaleEmbeds: number;
		logPrefix: string;
		judgeSignal: AbortSignal;
	},
): Promise<ProposalDuplicateFlag[]> {
	const entries = await listInboxMatchEntries(params.projectId);
	if (entries.length === 0) {
		return [];
	}
	const texts = entries.map((entry) => entry.text);
	const corpus = await loadRoutingCorpus({
		projectId: params.projectId,
		userId: params.userId,
		organizationId: params.organizationId,
		itemTexts: texts,
		logPrefix: params.logPrefix,
		maxStaleEmbeds: params.maxStaleEmbeds,
		abortSignal: params.abortSignal,
	});
	const vectors = await embedItemTexts(texts, corpus, params);
	const shortlists = vectors.map((vector) =>
		corpus.kind === "ready" ? routingShortlist(vector, corpus) : [],
	);
	const verified =
		corpus.kind === "ready"
			? await verifyBand({
					projectId: params.projectId,
					userId: params.userId,
					organizationId: params.organizationId,
					logPrefix: params.logPrefix,
					corpus,
					texts,
					vectors,
					band: judgeBand(shortlists),
					judgeSignal: params.judgeSignal,
				})
			: new Map<number, RoutingAlternative>();

	return buildDuplicateFlags({
		items: entries.map(({ item }, index) => {
			const target = verified.get(index);
			return {
				proposalId: item.proposalId,
				changeIndex: item.changeIndex,
				title: item.title,
				embedding: vectors[index] ?? [],
				storyMatches: [
					...confidentTickets(shortlists[index] ?? []),
					...(target ? [target] : []),
				],
			};
		}),
	});
}
