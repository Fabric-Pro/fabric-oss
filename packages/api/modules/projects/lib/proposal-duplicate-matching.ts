/**
 * Embedding side of duplicate detection against the Proposal Inbox. The
 * scoring itself is pure and lives in `proposal-duplicate-scoring.ts`.
 *
 * Texts to embed, and a feature item's Scope and acceptance-criteria
 * sections, ride in the SAME batched request as the routing corpus's stale
 * ticket re-embeds (`loadRoutingCorpus` `itemTexts`): one embedding pass per
 * call. A project with no tickets loads no corpus, so these texts are
 * embedded in one direct request instead. Every text is capped where it is
 * read.
 *
 * The inbox check covers every unresolved item of every PENDING proposal.
 * Item vectors are cached in Upstash (`proposal-item-vector-cache.ts`), and
 * one call embeds at most `MAX_NEW_INBOX_EMBEDS` uncached items: it returns
 * the flags of the items it could compare and how many are still waiting, and
 * the client asks again until none are.
 *
 * A manual entry's check puts the entry's own text and sections first in the
 * request, and embeds an inbox item's section only when the entry has the
 * same section, since no other section can weigh the pair. It embeds its
 * inbox items fresh, so it reads at most `MAX_INBOX_ITEMS_SCANNED` of them.
 *
 * A ticket's section vectors come from the roadmap scan's focus cache. A
 * section whose cached vector no longer matches its text or the embedding
 * model is not re-embedded here; that ticket is compared on its whole
 * document until the next roadmap scan refreshes the cache.
 *
 * A candidate is shown only once the roadmap scan's verifier has confirmed
 * it. The inbox check reads the stored verdicts and starts the verification
 * workflow for the candidates with no verdict on their current texts; their
 * items are reported as still being checked until a later call reads the
 * verdicts. A pair whose verification keeps failing waits, and its item is
 * not reported as being checked meanwhile. A manual entry's candidates are
 * verified inline on its final check, and the verdicts kept for a day
 * (`manual-entry-verification.ts`), since the entry is never stored.
 */

import { resolveModelWithProvider } from "@repo/ai";
import {
	baseModelName,
	type DetectionItem,
	detectionTextForStory,
	detectionVerdictHash,
	extractFocusTexts,
	type FocusTexts,
	hashDetectionText,
	type InboxItemRef,
	inboxItemSubject,
	listProposalItemDuplicateVerdicts,
	listStoryDuplicateFocusEmbeddings,
	listUnresolvedPendingProposalItems,
	MAX_LLM_VERIFICATIONS,
	PAIR_FOCUS_KINDS,
	type PairFocusKind,
	type PendingProposalMatchItem,
	storySubject,
} from "@repo/database";
import { logger } from "@repo/logs";
import { generateEmbeddings } from "@repo/rag";
import {
	type EmptyRoutingCorpus,
	loadRoutingCorpus,
	type ReadyRoutingCorpus,
} from "@repo/temporal/backlog-routing-core";
import { startInboxDuplicateVerification } from "@repo/temporal/inbox-duplicate-verification-start";
import { waitUntil } from "@vercel/functions";
import { confirmManualEntryCandidates } from "./manual-entry-verification";
import {
	buildDuplicateFlags,
	candidateMatches,
	MAX_MANUAL_ENTRY_MATCHES,
	type ProposalDuplicateFlag,
	type ProposalInboxMatch,
	rankCandidates,
	type ScoredInboxItem,
	type ScoredTicket,
	settleCandidates,
} from "./proposal-duplicate-scoring";
import {
	type ItemVectorScope,
	type ItemVectors,
	itemVectorHash,
	readCachedItemVectors,
	writeCachedItemVectors,
} from "./proposal-item-vector-cache";

/**
 * Inbox items a manual-create check embeds, newest proposals first. Sized so
 * one call stays one embedding request in the usual case: each item is at
 * most ~3,200 characters of text plus two sections of at most
 * `MAX_FOCUS_CHARS`, and most are far shorter.
 */
const MAX_INBOX_ITEMS_SCANNED = 150;

/**
 * Uncached inbox items the inbox check embeds per call, newest proposals
 * first; the rest wait for the next call. Smaller than
 * `MAX_INBOX_ITEMS_SCANNED`, so a call that also re-embeds stale tickets
 * stays well inside the request deadline.
 */
export const MAX_NEW_INBOX_EMBEDS = 100;

type FocusVectors = Partial<Record<PairFocusKind, number[]>>;

type SectionHashes = Partial<Record<PairFocusKind, string>>;

/** A subject's whole-text vector and its section vectors. */
type SubjectVectors = ItemVectors;

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

/** Unresolved inbox items with their texts; every one without `maxItems`. */
async function readInboxMatchEntries(
	projectId: string,
	signal: AbortSignal | undefined,
	maxItems?: number,
): Promise<InboxMatchEntry[]> {
	const items = await listUnresolvedPendingProposalItems({
		projectId,
		maxItems,
		signal,
	});
	return items
		.map((item) => ({ item, text: detectionTextForStory(item) }))
		.filter((entry) => entry.text.length > 0);
}

/** The unresolved inbox items a manual-create check scans, with their texts. */
export async function listInboxMatchEntries(
	projectId: string,
	signal?: AbortSignal,
): Promise<InboxMatchEntry[]> {
	return await readInboxMatchEntries(
		projectId,
		signal,
		MAX_INBOX_ITEMS_SCANNED,
	);
}

/** A text compared for duplicates, with a feature's comparable sections. */
interface DetectionSubject {
	text: string;
	focusTexts: FocusTexts | null;
}

/**
 * A manually entered work item as the roadmap candidate rule reads it. The
 * create dialog collects only a description and the classifier picks the
 * kind on create, so the entry is read as a feature, the kind every non-bug
 * create gets: a Scope or acceptance-criteria section in the description
 * weighs it against an inbox feature with the same section, and a
 * description with neither is compared on its whole text.
 */
export function manualEntry(
	itemText: string,
	description: string,
): DetectionSubject {
	return {
		text: itemText,
		focusTexts: extractFocusTexts({ kind: "FEATURE", description }),
	};
}

/** Every subject's sections, in subject order. */
function focusSections(subjects: readonly DetectionSubject[]) {
	return subjects.flatMap((subject, index) =>
		PAIR_FOCUS_KINDS.flatMap((kind) => {
			const text = subject.focusTexts?.[kind];
			return text ? [{ index, kind, text }] : [];
		}),
	);
}

/** The texts one embedding request carries: every subject's text, in order,
 * then every subject's sections. */
function detectionBatchTexts(subjects: readonly DetectionSubject[]): string[] {
	return [
		...subjects.map((subject) => subject.text),
		...focusSections(subjects).map((section) => section.text),
	];
}

/** Each subject's vectors, read back from the embeddings of
 * `detectionBatchTexts(subjects)`. */
function readDetectionBatch(
	subjects: readonly DetectionSubject[],
	embedded: readonly number[][],
): SubjectVectors[] {
	const read: SubjectVectors[] = subjects.map((_, index) => ({
		embedding: embedded[index] ?? [],
	}));
	focusSections(subjects).forEach((section, position) => {
		const vector = embedded[subjects.length + position];
		const target = read[section.index];
		if (vector && target) {
			target.focusVectors = {
				...target.focusVectors,
				[section.kind]: vector,
			};
		}
	});
	return read;
}

/** The inbox items as subjects: their text, and their sections. */
function inboxSubjects(
	entries: readonly InboxMatchEntry[],
): DetectionSubject[] {
	return entries.map((entry) => ({
		text: entry.text,
		focusTexts: entry.item.focusTexts,
	}));
}

/**
 * A manual check's subjects: the entry first, then the inbox items, each
 * keeping only the sections the entry also has. No other section can weigh
 * the pair, so a description with no section adds nothing to the request.
 */
function manualEntrySubjects(
	entry: DetectionSubject,
	entries: readonly InboxMatchEntry[],
): DetectionSubject[] {
	return [
		entry,
		...inboxSubjects(entries).map((subject) => {
			const shared: FocusTexts = {};
			for (const kind of PAIR_FOCUS_KINDS) {
				const text = subject.focusTexts?.[kind];
				if (text && entry.focusTexts?.[kind]) {
					shared[kind] = text;
				}
			}
			return { text: subject.text, focusTexts: shared };
		}),
	];
}

/**
 * The texts a manual-create check passes to `loadRoutingCorpus`: the entry
 * first, then the inbox items, then the sections compared, so all of them
 * are embedded in one request and `itemEmbeddings[0]` is the entry's.
 */
export function manualEntryCorpusTexts(
	entry: DetectionSubject,
	entries: readonly InboxMatchEntry[],
): string[] {
	return detectionBatchTexts(manualEntrySubjects(entry, entries));
}

/** What the matcher reads from a loaded `RoutingCorpus`. */
type CorpusItemEmbeddings =
	| EmptyRoutingCorpus
	| Pick<ReadyRoutingCorpus, "kind" | "itemEmbeddings">;

/** `texts` embedded in one request of their own, with the model used. */
async function embedDirectly(
	texts: string[],
	scope: EmbeddingScope,
): Promise<{ embeddings: number[][]; model: string }> {
	return await generateEmbeddings(
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
}

/** The embeddings of `texts`: from the corpus batch, else one request. */
async function embedItemTexts(
	texts: string[],
	corpus: CorpusItemEmbeddings,
	scope: EmbeddingScope,
): Promise<number[][]> {
	if (corpus.kind === "ready") {
		return corpus.itemEmbeddings;
	}
	return (await embedDirectly(texts, scope)).embeddings;
}

/** A manual entry's inbox matches, and its candidates left unverified. */
export interface ManualEntryInboxMatches {
	matches: ProposalInboxMatch[];
	/** Candidates with no kept verdict, left by a check that does not
	 * verify; a check that verifies decides them. */
	unverified: number;
}

const NO_MANUAL_ENTRY_MATCHES: ManualEntryInboxMatches = {
	matches: [],
	unverified: 0,
};

/**
 * Pending inbox items a manually entered work item may duplicate: the
 * candidates the roadmap candidate rule selects, strongest first, that the
 * roadmap scan's verifier confirms (`confirmManualEntryCandidates`), each
 * with the rule's score. Without `verify`, only the candidates a kept
 * verdict confirmed are listed. The entry is scored as created now.
 * `corpus` was loaded with `manualEntryCorpusTexts(entry, entries)`. Throws
 * on an embedding failure; the caller decides how that degrades.
 */
export async function findProposalInboxMatches(
	params: EmbeddingScope & {
		entry: DetectionSubject;
		entries: readonly InboxMatchEntry[];
		corpus: CorpusItemEmbeddings;
		verify: boolean;
	},
): Promise<ManualEntryInboxMatches> {
	if (params.entries.length === 0) {
		return NO_MANUAL_ENTRY_MATCHES;
	}
	const subjects = manualEntrySubjects(params.entry, params.entries);
	const [query, ...vectors] = readDetectionBatch(
		subjects,
		await embedItemTexts(
			detectionBatchTexts(subjects),
			params.corpus,
			params,
		),
	);
	if (!query) {
		return NO_MANUAL_ENTRY_MATCHES;
	}
	const entry: DetectionItem = {
		storyId: "manual-entry",
		createdAt: new Date(),
		...query,
	};
	const candidates = params.entries.map(({ item }, index) => ({
		item,
		detection: inboxDetection(item, vectors[index]),
	}));
	const ranked = rankCandidates(entry, candidates, MAX_MANUAL_ENTRY_MATCHES);
	if (ranked.length === 0) {
		return NO_MANUAL_ENTRY_MATCHES;
	}
	const { confirmed, unverified } = await confirmManualEntryCandidates({
		scope: params,
		entry: params.entry,
		candidates: ranked.map(({ candidate, found }) => ({
			item: candidate.item,
			found,
		})),
		verify: params.verify,
	});
	const matches = ranked
		.filter((_, index) => confirmed[index])
		.map(({ candidate: { item }, found }) => ({
			proposalId: item.proposalId,
			changeIndex: item.changeIndex,
			title: item.title,
			summary: item.proposalSummary,
			source: item.source,
			similarity: found.score,
		}));
	return { matches, unverified };
}

/**
 * The project's tickets as the roadmap candidate rule scores them: their
 * whole-document vectors from the corpus and, for a feature, the section
 * vectors the roadmap scan cached, used only while they still match the
 * section's text and the corpus's embedding model.
 */
async function scoredTickets(
	projectId: string,
	corpus: ReadyRoutingCorpus,
): Promise<ScoredTicket[]> {
	const sectionHashes = new Map<string, SectionHashes>();
	for (const story of corpus.storyById.values()) {
		const texts = extractFocusTexts(story);
		if (!texts) {
			continue;
		}
		const hashes: SectionHashes = {};
		for (const kind of PAIR_FOCUS_KINDS) {
			const text = texts[kind];
			if (text) {
				hashes[kind] = hashDetectionText(text);
			}
		}
		sectionHashes.set(story.id, hashes);
	}
	const focusVectors = new Map<string, FocusVectors>();
	if (sectionHashes.size > 0) {
		for (const row of await listStoryDuplicateFocusEmbeddings(projectId)) {
			if (
				row.model === corpus.model &&
				sectionHashes.get(row.storyId)?.[row.kind] === row.contentHash
			) {
				focusVectors.set(row.storyId, {
					...focusVectors.get(row.storyId),
					[row.kind]: row.embedding,
				});
			}
		}
	}
	return corpus.candidateVectors.flatMap((candidate): ScoredTicket[] => {
		const story = corpus.storyById.get(candidate.id);
		if (!story) {
			return [];
		}
		const detection: DetectionItem = {
			storyId: story.id,
			embedding: candidate.embedding,
			createdAt: story.createdAt,
			focusVectors: focusVectors.get(story.id),
		};
		return [
			{
				storyId: story.id,
				identifier: story.identifier,
				title: story.title,
				detection,
				verdictHash: detectionVerdictHash(storySubject(story)),
			},
		];
	});
}

/** An inbox item as the roadmap candidate rule scores it. */
function inboxDetection(
	item: PendingProposalMatchItem,
	vectors: SubjectVectors | undefined,
): DetectionItem {
	return {
		storyId: `${item.proposalId}:${item.changeIndex}`,
		embedding: vectors?.embedding ?? [],
		createdAt: item.createdAt,
		focusVectors: vectors?.focusVectors,
	};
}

/** The inbox items as the roadmap candidate rule scores them. */
function scoredInboxItems(
	entries: readonly InboxMatchEntry[],
	vectors: readonly SubjectVectors[],
): ScoredInboxItem[] {
	return entries.map(({ item }, index) => ({
		proposalId: item.proposalId,
		changeIndex: item.changeIndex,
		title: item.title,
		detection: inboxDetection(item, vectors[index]),
		verdictHash: detectionVerdictHash(inboxItemSubject(item)),
	}));
}

/** One inbox check: the flags found, and what is left to compare. */
export interface InboxDuplicateCheck {
	/** Only items with at least one confirmed match. */
	flags: ProposalDuplicateFlag[];
	/** Items not compared yet because their vectors are still to be
	 * embedded; a later call compares them. Zero once the whole inbox is. */
	stillChecking: number;
	/** Items compared whose candidates still wait for the verifier; it runs
	 * in the background, and a later call shows its verdicts. */
	verifying: number;
	/** Every item without a final answer yet, for either reason. */
	checking: InboxItemRef[];
}

/** No flags and nothing left: what the check returns when it cannot use the
 * vector cache, so the review goes on without flags. */
const NOTHING_TO_FLAG: InboxDuplicateCheck = {
	flags: [],
	stillChecking: 0,
	verifying: 0,
	checking: [],
};

/**
 * The first uncached subject of each hash, newest proposals first, at most
 * `MAX_NEW_INBOX_EMBEDS` of them: what this call embeds.
 */
function subjectsToEmbed(
	subjects: readonly DetectionSubject[],
	hashes: readonly string[],
	cached: ReadonlyMap<string, SubjectVectors>,
): Map<string, DetectionSubject> {
	const toEmbed = new Map<string, DetectionSubject>();
	hashes.forEach((hash, index) => {
		const subject = subjects[index];
		if (
			subject &&
			!cached.has(hash) &&
			!toEmbed.has(hash) &&
			toEmbed.size < MAX_NEW_INBOX_EMBEDS
		) {
			toEmbed.set(hash, subject);
		}
	});
	return toEmbed;
}

/**
 * Possible duplicates for every unresolved create item of the project's
 * PENDING proposals: roadmap tickets, and the other inbox items, siblings
 * included.
 *
 * Each item's vectors come from the Upstash cache, or are embedded in this
 * call's one embedding pass, at most `MAX_NEW_INBOX_EMBEDS` new items per
 * call. Items still without vectors are counted in `stillChecking` and
 * compared on a later call. Without a readable cache the check returns no
 * flags and nothing to wait for, so the inbox is never re-embedded on every
 * call. Vectors the cache could not store still flag this call's result;
 * they are embedded again on the next call.
 *
 * `beforeEmbed` runs, after the cache read, just before the call's one
 * embedding request: when it has inbox items to embed or stale roadmap
 * tickets to re-embed. A call with every vector in hand sends no request
 * and does not run it. It refuses the call by throwing.
 *
 * Only a ticket or inbox item the roadmap candidate rule selects, or the
 * verifier flagged before, and the verifier flagged on both current texts,
 * is a match. A candidate with no such verdict is sent to the verification
 * workflow and its item is counted in `verifying`. Throws only on a
 * wholesale load or embedding failure.
 */
export async function detectInboxDuplicates(
	params: EmbeddingScope & {
		maxStaleEmbeds: number;
		logPrefix: string;
		beforeEmbed?: () => Promise<void>;
	},
): Promise<InboxDuplicateCheck> {
	const entries = await readInboxMatchEntries(
		params.projectId,
		params.abortSignal,
	);
	if (entries.length === 0) {
		return NOTHING_TO_FLAG;
	}
	const resolved = await resolveModelWithProvider("EMBEDDING", {
		userId: params.userId,
		organizationId: params.organizationId,
	});
	const cacheScope: ItemVectorScope = {
		organizationId: params.organizationId ?? null,
		projectId: params.projectId,
		model: baseModelName(resolved.modelString),
	};
	const subjects = inboxSubjects(entries);
	const hashes = subjects.map(itemVectorHash);
	const vectorsByHash = await readCachedItemVectors(cacheScope, hashes);
	if (!vectorsByHash) {
		logger.warn(
			`${params.logPrefix} item vector cache unavailable; no flags`,
			{ projectId: params.projectId },
		);
		return NOTHING_TO_FLAG;
	}

	const toEmbed = subjectsToEmbed(subjects, hashes, vectorsByHash);
	const embedSubjects = Array.from(toEmbed.values());
	const embeddedTexts = detectionBatchTexts(embedSubjects);
	const corpus = await loadRoutingCorpus({
		projectId: params.projectId,
		userId: params.userId,
		organizationId: params.organizationId,
		itemTexts: embeddedTexts,
		logPrefix: params.logPrefix,
		maxStaleEmbeds: params.maxStaleEmbeds,
		abortSignal: params.abortSignal,
		beforeEmbed: params.beforeEmbed,
	});
	if (corpus.kind === "ready" && corpus.model !== cacheScope.model) {
		logger.warn(`${params.logPrefix} embedding model changed mid-check`, {
			projectId: params.projectId,
		});
		return NOTHING_TO_FLAG;
	}
	if (embedSubjects.length > 0) {
		// An empty roadmap sent no request: the items are embedded here.
		if (corpus.kind === "empty") {
			await params.beforeEmbed?.();
		}
		const embedded =
			corpus.kind === "ready"
				? corpus.itemEmbeddings
				: await embedDirectlyAs(
						cacheScope.model,
						embeddedTexts,
						params,
					);
		if (!embedded) {
			logger.warn(
				`${params.logPrefix} embedding model changed mid-check`,
				{ projectId: params.projectId },
			);
			return NOTHING_TO_FLAG;
		}
		const fresh = new Map<string, SubjectVectors>();
		const hashesToEmbed = Array.from(toEmbed.keys());
		const batch = readDetectionBatch(embedSubjects, embedded);
		batch.forEach((vectors, index) => {
			const hash = hashesToEmbed[index];
			if (hash && vectors.embedding.length > 0) {
				fresh.set(hash, vectors);
			}
		});
		if (!(await writeCachedItemVectors(cacheScope, fresh))) {
			logger.warn(`${params.logPrefix} item vectors not stored`, {
				projectId: params.projectId,
			});
		}
		for (const [hash, vectors] of fresh) {
			vectorsByHash.set(hash, vectors);
		}
	}

	const ready = entries.flatMap((entry, index) => {
		const vectors = vectorsByHash.get(hashes[index] ?? "");
		return vectors ? [{ entry, vectors }] : [];
	});
	const items = scoredInboxItems(
		ready.map(({ entry }) => entry),
		ready.map(({ vectors }) => vectors),
	);
	const verdicts = await listProposalItemDuplicateVerdicts(params.projectId);
	const candidates = candidateMatches({
		items,
		tickets:
			corpus.kind === "ready"
				? await scoredTickets(params.projectId, corpus)
				: [],
		verdicts,
	});
	const settled = settleCandidates(candidates, verdicts, Date.now());
	// The verdicts are in hand: a slow or unreachable Temporal never holds
	// them back. The start keeps running past the response (`waitUntil`),
	// and logs its own failure.
	const start = startInboxDuplicateVerification({
		projectId: params.projectId,
		userId: params.userId,
		organizationId: params.organizationId,
		pairs: settled.unverified.slice(0, MAX_LLM_VERIFICATIONS),
	});
	waitUntil(start);
	await waitAtMost(START_VERIFICATION_WAIT_MS, start);
	const verifyingItems = items.filter((_, index) => settled.waiting[index]);
	const unembedded = entries.filter(
		(_, index) => !vectorsByHash.has(hashes[index] ?? ""),
	);
	const stillChecking = unembedded.length;
	logger.info(`${params.logPrefix} inbox checked`, {
		projectId: params.projectId,
		items: entries.length,
		embedded: embedSubjects.length,
		stillChecking,
		verifying: verifyingItems.length,
		unverifiedPairs: settled.unverified.length,
	});
	return {
		flags: buildDuplicateFlags({
			items: items.map((item, index) => ({
				proposalId: item.proposalId,
				changeIndex: item.changeIndex,
				matches: settled.matches[index] ?? [],
			})),
		}),
		stillChecking,
		verifying: verifyingItems.length,
		checking: [
			...unembedded.map(({ item }) => itemRef(item)),
			...verifyingItems.map(itemRef),
		],
	};
}

function itemRef(item: InboxItemRef): InboxItemRef {
	return { proposalId: item.proposalId, changeIndex: item.changeIndex };
}

/** The longest the inbox check waits for the verification to start. */
export const START_VERIFICATION_WAIT_MS = 1_000;

/** Waits for `work` at most `ms`; past that it keeps running unawaited. */
async function waitAtMost(ms: number, work: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		work,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		}),
	]);
	clearTimeout(timer);
}

/** `texts` embedded directly, or null when the provider answered with a
 * model other than the one the cache is keyed on. */
async function embedDirectlyAs(
	model: string,
	texts: string[],
	scope: EmbeddingScope,
): Promise<number[][] | null> {
	const embedded = await embedDirectly(texts, scope);
	return embedded.model === model ? embedded.embeddings : null;
}
