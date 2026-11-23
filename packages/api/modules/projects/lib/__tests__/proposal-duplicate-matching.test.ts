/**
 * Embedding side of the Proposal Inbox duplicate flags: one batched corpus
 * request for the inbox items not yet in the item vector cache (at most
 * `MAX_NEW_INBOX_EMBEDS` per call) and their feature sections, matches by the
 * roadmap duplicate scan's candidate rule (Scope weighting included) and
 * nothing under its bar, a count of the items still to check, no flags when
 * the cache cannot be used, and a direct embedding when the Roadmap has no
 * tickets. A manual entry is matched against the inbox by the same rule, on
 * the sections both have.
 *
 * Every candidate is taken as confirmed by the duplicate verifier here; the
 * verifier's part is covered in `proposal-duplicate-verification.test.ts`.
 */

import { hashDetectionText } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listItems: vi.fn(),
	listFocus: vi.fn(),
	listVerdicts: vi.fn(),
	loadCorpus: vi.fn(),
	embed: vi.fn(),
	warn: vi.fn(),
	resolveModel: vi.fn(),
	verifierModel: vi.fn(),
	verifyPair: vi.fn(),
	startVerification: vi.fn(),
	settle: vi.fn(),
	readCache: vi.fn(),
	writeCache: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.verifierModel,
	resolveModelWithProvider: mocks.resolveModel,
}));

vi.mock("@repo/temporal/duplicate-scan-core", () => ({
	verifyDuplicatePair: mocks.verifyPair,
}));

vi.mock("@repo/temporal/inbox-duplicate-verification-start", () => ({
	startInboxDuplicateVerification: mocks.startVerification,
}));

// Every candidate counts as confirmed, so the candidate rule is what the
// tests below see.
vi.mock("../proposal-duplicate-scoring", async () => ({
	...(await vi.importActual<Record<string, unknown>>(
		"../proposal-duplicate-scoring",
	)),
	settleCandidates: mocks.settle,
}));

vi.mock("../../../../lib/redis-client", () => ({ getRedisClient: () => null }));

vi.mock("../proposal-item-vector-cache", async () => ({
	...(await vi.importActual<Record<string, unknown>>(
		"../proposal-item-vector-cache",
	)),
	readCachedItemVectors: mocks.readCache,
	writeCachedItemVectors: mocks.writeCache,
}));

vi.mock("@repo/database", async () => ({
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/queries/projects/duplicate-detection",
	)),
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/queries/projects/duplicate-focus",
	)),
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/queries/projects/proposal-item-duplicate-pairs",
	)),
	listUnresolvedPendingProposalItems: mocks.listItems,
	listStoryDuplicateFocusEmbeddings: mocks.listFocus,
	listProposalItemDuplicateVerdicts: mocks.listVerdicts,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

vi.mock("@repo/rag", () => ({ generateEmbeddings: mocks.embed }));

vi.mock("@repo/temporal/backlog-routing-core", () => ({
	loadRoutingCorpus: mocks.loadCorpus,
}));

import {
	detectInboxDuplicates,
	findProposalInboxMatches,
	MAX_NEW_INBOX_EMBEDS,
	manualEntry,
	manualEntryCorpusTexts,
} from "../proposal-duplicate-matching";
import { itemVectorHash } from "../proposal-item-vector-cache";

const EMBEDDING_MODEL = "example-embedding-model";

const item = (
	proposalId: string,
	changeIndex: number,
	title: string,
	focusTexts: Record<string, string> | null = null,
) => ({
	proposalId,
	changeIndex,
	source: "TEAMS_CHANNEL",
	proposalSummary: `Summary of ${proposalId}`,
	createdAt: new Date("2026-11-02T09:00:00.000Z"),
	title,
	description: "",
	acceptanceCriteria: "",
	focusTexts,
});

const scope = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
};

const check = () =>
	detectInboxDuplicates({
		...scope,
		maxStaleEmbeds: 200,
		logPrefix: "[T]",
	});

const detect = async () => (await check()).flags;

/** The inbox matches a verifying manual-create check lists. */
const findMatches = async (
	params: Omit<Parameters<typeof findProposalInboxMatches>[0], "verify">,
) => (await findProposalInboxMatches({ ...params, verify: true })).matches;

/** An inbox item's cache hash, as the check computes it. */
const hashOf = (title: string) =>
	itemVectorHash({ text: title, focusTexts: null });

/** A ready corpus with one ticket at the given vector. */
const readyCorpus = (
	itemEmbeddings: number[][],
	ticketEmbedding: number[],
) => ({
	kind: "ready",
	model: EMBEDDING_MODEL,
	itemEmbeddings,
	candidateVectors: [
		{ id: "story-1", identifier: "F-12", embedding: ticketEmbedding },
	],
	storyById: new Map([
		["story-1", { id: "story-1", identifier: "F-12", title: "Dark theme" }],
	]),
	textByStoryId: new Map(),
	skippedStale: 0,
});

/** A unit vector at `similarity` cosine from [1, 0]. */
const at = (similarity: number) => [
	similarity,
	Math.sqrt(1 - similarity * similarity),
];

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listItems.mockResolvedValue([
		item("open", 0, "Queue exports"),
		item("open", 2, "Dark mode"),
		item("other", 1, "Export queue"),
	]);
	mocks.listFocus.mockResolvedValue([]);
	mocks.resolveModel.mockResolvedValue({
		modelString: `openai/${EMBEDDING_MODEL}`,
	});
	mocks.readCache.mockResolvedValue(new Map());
	mocks.writeCache.mockResolvedValue(true);
	mocks.settle.mockImplementation(confirmAll);
	mocks.listVerdicts.mockResolvedValue([]);
	mocks.startVerification.mockResolvedValue(undefined);
	mocks.verifierModel.mockResolvedValue({
		model: {},
		metadata: { provider: "VERCEL_GATEWAY", modelString: "example/model" },
		trackUsage: vi.fn(),
	});
	mocks.verifyPair.mockResolvedValue({
		verdict: { relationship: "same_work_item", confidence: 0.95 },
		effect: "link:DUPLICATE",
	});
});

/** Settles every candidate as confirmed. */
function confirmAll(candidates: { match: unknown }[][]) {
	return {
		matches: candidates.map((list) => list.map(({ match }) => match)),
		waiting: candidates.map(() => false),
		unverified: [],
	};
}

describe("detectInboxDuplicates", () => {
	it("embeds every uncached inbox item in the corpus request and flags each against tickets and the others", async () => {
		mocks.loadCorpus.mockResolvedValue(
			readyCorpus(
				[
					[1, 0],
					[0, 1],
					[1, 0],
				],
				[0, 1],
			),
		);

		const result = await check();
		const flags = result.flags;

		// Every PENDING proposal: no item cap.
		expect(mocks.listItems).toHaveBeenCalledWith({
			projectId: "project-1",
		});
		expect(mocks.listItems.mock.calls[0]?.[0]?.maxItems).toBeUndefined();
		expect(result.stillChecking).toBe(0);
		expect(mocks.loadCorpus).toHaveBeenCalledTimes(1);
		expect(mocks.loadCorpus).toHaveBeenCalledWith(
			expect.objectContaining({
				itemTexts: ["Queue exports", "Dark mode", "Export queue"],
				maxStaleEmbeds: 200,
			}),
		);
		expect(mocks.embed).not.toHaveBeenCalled();
		expect(flags).toEqual([
			{
				proposalId: "open",
				changeIndex: 0,
				matches: [
					{
						kind: "proposal_item",
						proposalId: "other",
						matchChangeIndex: 1,
						title: "Export queue",
						similarity: 1,
					},
				],
			},
			{
				proposalId: "open",
				changeIndex: 2,
				matches: [
					{
						kind: "story",
						storyId: "story-1",
						identifier: "F-12",
						title: "Dark theme",
						similarity: 1,
					},
				],
			},
			{
				proposalId: "other",
				changeIndex: 1,
				matches: [
					{
						kind: "proposal_item",
						proposalId: "open",
						matchChangeIndex: 0,
						title: "Queue exports",
						similarity: 1,
					},
				],
			},
		]);
	});

	it("flags no ticket under the roadmap scan's bar", async () => {
		// Under the 0.7 bar, and the item was not captured close enough to
		// the ticket for the proximity relaxation.
		mocks.listItems.mockResolvedValue([item("open", 0, "Export as CSV")]);
		mocks.loadCorpus.mockResolvedValue(readyCorpus([at(0.6)], [1, 0]));

		await expect(detect()).resolves.toEqual([]);
	});

	it("flags a 0.75 ticket", async () => {
		mocks.listItems.mockResolvedValue([item("open", 0, "Export as CSV")]);
		mocks.loadCorpus.mockResolvedValue(readyCorpus([at(0.75)], [1, 0]));

		const flags = await detect();

		expect(flags[0]?.matches).toEqual([
			expect.objectContaining({
				kind: "story",
				identifier: "F-12",
				similarity: expect.closeTo(0.75, 5),
			}),
		]);
	});

	it("flags only the items whose ticket clears the bar", async () => {
		mocks.listItems.mockResolvedValue([
			item("open", 0, "Export as CSV"),
			item("other", 0, "Dark mode"),
		]);
		// The first item's ticket is under the bar (0.67), the second's over
		// it (0.8); the two items are far apart, so they never match.
		mocks.loadCorpus.mockResolvedValue(
			readyCorpus([[0.67, -Math.sqrt(1 - 0.67 * 0.67)], at(0.8)], [1, 0]),
		);

		const flags = await detect();

		expect(flags).toEqual([
			{
				proposalId: "other",
				changeIndex: 0,
				matches: [
					expect.objectContaining({
						kind: "story",
						similarity: expect.closeTo(0.8, 5),
					}),
				],
			},
		]);
	});

	describe("feature sections", () => {
		const SCOPE = "In scope:\n- Queue large exports";
		const MODEL = "example-embedding-model";
		const sectionCorpus = (documentSimilarity: number) => ({
			...readyCorpus([at(documentSimilarity), [1, 0]], [1, 0]),
			model: MODEL,
			storyById: new Map([
				[
					"story-1",
					{
						id: "story-1",
						identifier: "F-12",
						title: "Export queue",
						kind: "FEATURE",
						description:
							"## Scope\n### In Scope\n- Queue large exports",
						acceptanceCriteria: null,
					},
				],
			]),
		});
		const cachedScope = (contentHash: string) => ({
			storyId: "story-1",
			kind: "scope",
			contentHash,
			model: MODEL,
			embedding: [1, 0],
		});

		beforeEach(() => {
			mocks.listItems.mockResolvedValue([
				item("open", 0, "Queue exports", { scope: SCOPE }),
			]);
		});

		it("weighs a feature pair on its Scope sections, as the roadmap scan does", async () => {
			mocks.loadCorpus.mockResolvedValue(sectionCorpus(0.55));
			mocks.listFocus.mockResolvedValue([
				cachedScope(hashDetectionText(SCOPE)),
			]);

			const flags = await detect();

			expect(mocks.loadCorpus).toHaveBeenCalledWith(
				expect.objectContaining({
					itemTexts: ["Queue exports", SCOPE],
				}),
			);
			// 0.75 × 1 + 0.25 × 0.55 = 0.8875, on the threshold's scale.
			expect(flags).toEqual([
				{
					proposalId: "open",
					changeIndex: 0,
					matches: [
						expect.objectContaining({
							kind: "story",
							storyId: "story-1",
							similarity: expect.closeTo(
								0.7 + ((0.8875 - 0.62) * 0.3) / 0.38,
								10,
							),
						}),
					],
				},
			]);
		});

		it("compares on the whole document when the cached section is stale", async () => {
			mocks.loadCorpus.mockResolvedValue(sectionCorpus(0.55));
			mocks.listFocus.mockResolvedValue([
				cachedScope("example-stale-hash"),
			]);

			await expect(detect()).resolves.toEqual([]);
		});

		it("keeps out a ticket whose document reads alike but whose Scope does not", async () => {
			mocks.loadCorpus.mockResolvedValue({
				...sectionCorpus(0.95),
				itemEmbeddings: [at(0.95), [0, 1]],
			});
			mocks.listFocus.mockResolvedValue([
				cachedScope(hashDetectionText(SCOPE)),
			]);

			await expect(detect()).resolves.toEqual([]);
		});
	});

	it("embeds the items directly when the Roadmap has no tickets", async () => {
		mocks.loadCorpus.mockResolvedValue({ kind: "empty" });
		mocks.embed.mockResolvedValue({
			embeddings: [
				[1, 0],
				[0, 1],
				[1, 0],
			],
			model: "example-embedding-model",
		});

		const flags = await detect();

		expect(mocks.embed).toHaveBeenCalledTimes(1);
		expect(mocks.embed.mock.calls[0]?.[0]).toEqual([
			"Queue exports",
			"Dark mode",
			"Export queue",
		]);
		expect(flags.map((f) => [f.proposalId, f.changeIndex])).toEqual([
			["open", 0],
			["other", 1],
		]);
	});

	it("loads no corpus for an empty inbox", async () => {
		mocks.listItems.mockResolvedValue([]);

		await expect(detect()).resolves.toEqual([]);
		expect(mocks.loadCorpus).not.toHaveBeenCalled();
		expect(mocks.embed).not.toHaveBeenCalled();
	});

	describe("item vector cache", () => {
		const cacheScope = {
			organizationId: "org-1",
			projectId: "project-1",
			model: EMBEDDING_MODEL,
		};

		it("reads cached vectors and embeds only the items it does not find", async () => {
			mocks.readCache.mockResolvedValue(
				new Map([
					[hashOf("Queue exports"), { embedding: [1, 0] }],
					[hashOf("Dark mode"), { embedding: [0, 1] }],
				]),
			);
			mocks.loadCorpus.mockResolvedValue(readyCorpus([[1, 0]], [0, 1]));

			const result = await check();

			expect(mocks.readCache).toHaveBeenCalledWith(cacheScope, [
				hashOf("Queue exports"),
				hashOf("Dark mode"),
				hashOf("Export queue"),
			]);
			expect(mocks.loadCorpus).toHaveBeenCalledWith(
				expect.objectContaining({ itemTexts: ["Export queue"] }),
			);
			expect(mocks.writeCache).toHaveBeenCalledWith(
				cacheScope,
				new Map([[hashOf("Export queue"), { embedding: [1, 0] }]]),
			);
			// Cached and fresh vectors are compared alike.
			expect(result.stillChecking).toBe(0);
			expect(
				result.flags.map((flag) => [flag.proposalId, flag.changeIndex]),
			).toEqual([
				["open", 0],
				["open", 2],
				["other", 1],
			]);
		});

		it("embeds nothing and writes nothing when every item is cached", async () => {
			mocks.readCache.mockResolvedValue(
				new Map([
					[hashOf("Queue exports"), { embedding: [1, 0] }],
					[hashOf("Dark mode"), { embedding: [0, 1] }],
					[hashOf("Export queue"), { embedding: [1, 0] }],
				]),
			);
			mocks.loadCorpus.mockResolvedValue(readyCorpus([], [0, 1]));

			const result = await check();

			expect(mocks.loadCorpus).toHaveBeenCalledWith(
				expect.objectContaining({ itemTexts: [] }),
			);
			expect(mocks.writeCache).not.toHaveBeenCalled();
			expect(result.flags).toHaveLength(3);
			expect(result.stillChecking).toBe(0);
		});

		it("embeds at most the per-call bound of new items and counts the rest as still checking", async () => {
			const titles = Array.from(
				{ length: MAX_NEW_INBOX_EMBEDS + 30 },
				(_, index) => `Item ${index}`,
			);
			mocks.listItems.mockResolvedValue(
				titles.map((title, index) => item(`p-${index}`, 0, title)),
			);
			mocks.loadCorpus.mockImplementation(
				async ({ itemTexts }: { itemTexts: string[] }) =>
					readyCorpus(
						itemTexts.map((_, index) => [index + 1, 1]),
						[0, 1],
					),
			);

			const result = await check();

			const embedded = mocks.loadCorpus.mock.calls[0]?.[0]?.itemTexts;
			// Newest proposals first.
			expect(embedded).toEqual(titles.slice(0, MAX_NEW_INBOX_EMBEDS));
			expect(result.stillChecking).toBe(30);
		});

		it("covers the whole inbox over successive calls as the cache fills", async () => {
			const titles = Array.from(
				{ length: MAX_NEW_INBOX_EMBEDS + 30 },
				(_, index) => `Item ${index}`,
			);
			mocks.listItems.mockResolvedValue(
				titles.map((title, index) => item(`p-${index}`, 0, title)),
			);
			type Stored = Map<string, { embedding: number[] }>;
			const store: Stored = new Map();
			mocks.readCache.mockImplementation(async () => new Map(store));
			mocks.writeCache.mockImplementation(
				async (_scope: unknown, fresh: Stored) => {
					for (const [hash, vectors] of fresh) {
						store.set(hash, vectors);
					}
					return true;
				},
			);
			mocks.loadCorpus.mockImplementation(
				async ({ itemTexts }: { itemTexts: string[] }) =>
					readyCorpus(
						itemTexts.map((_, index) => [index + 1, 1]),
						[0, 1],
					),
			);

			const first = await check();
			const second = await check();

			expect(first.stillChecking).toBe(30);
			expect(second.stillChecking).toBe(0);
			expect(mocks.loadCorpus.mock.calls[1]?.[0]?.itemTexts).toEqual(
				titles.slice(MAX_NEW_INBOX_EMBEDS),
			);
		});

		it("embeds an item once when two items read alike", async () => {
			mocks.listItems.mockResolvedValue([
				item("open", 0, "Queue exports"),
				item("other", 1, "Queue exports"),
			]);
			mocks.loadCorpus.mockResolvedValue(readyCorpus([[1, 0]], [0, 1]));

			const result = await check();

			expect(mocks.loadCorpus).toHaveBeenCalledWith(
				expect.objectContaining({ itemTexts: ["Queue exports"] }),
			);
			expect(result.flags).toHaveLength(2);
		});

		it("returns no flags and nothing to wait for when the cache cannot be read", async () => {
			mocks.readCache.mockResolvedValue(null);

			await expect(check()).resolves.toEqual({
				flags: [],
				stillChecking: 0,
				verifying: 0,
				checking: [],
			});
			expect(mocks.loadCorpus).not.toHaveBeenCalled();
			expect(mocks.warn).toHaveBeenCalledWith(
				"[T] item vector cache unavailable; no flags",
				{ projectId: "project-1" },
			);
		});

		it("still flags this call's items when the fresh vectors cannot be stored", async () => {
			// Each read answers a map of its own, as the cache does; a shared
			// one would keep the first call's vectors for the second.
			mocks.readCache.mockImplementation(async () => new Map());
			mocks.loadCorpus.mockResolvedValue(
				readyCorpus(
					[
						[1, 0],
						[0, 1],
						[1, 0],
					],
					[0, 1],
				),
			);
			const stored = await check();
			mocks.writeCache.mockResolvedValue(false);

			const unstored = await check();

			expect(stored.flags.length).toBeGreaterThan(0);
			expect(unstored).toEqual(stored);
			expect(mocks.warn).toHaveBeenCalledWith(
				"[T] item vectors not stored",
				{ projectId: "project-1" },
			);
		});

		it("hands beforeEmbed to the corpus load, after the cache read", async () => {
			const beforeEmbed = vi.fn().mockResolvedValue(undefined);
			mocks.loadCorpus.mockResolvedValue(
				readyCorpus(
					[
						[1, 0],
						[0, 1],
						[1, 0],
					],
					[0, 1],
				),
			);

			await detectInboxDuplicates({
				...scope,
				maxStaleEmbeds: 200,
				logPrefix: "[T]",
				beforeEmbed,
			});

			// The corpus load asks it before its one embedding request, so a
			// call that re-embeds only stale tickets counts too.
			expect(mocks.loadCorpus).toHaveBeenCalledWith(
				expect.objectContaining({ beforeEmbed }),
			);
			const [read] = mocks.readCache.mock.invocationCallOrder;
			const [loaded] = mocks.loadCorpus.mock.invocationCallOrder;
			expect(read).toBeLessThan(loaded ?? 0);
		});

		it("asks before embedding the items itself when the roadmap is empty", async () => {
			const beforeEmbed = vi.fn().mockResolvedValue(undefined);
			mocks.loadCorpus.mockResolvedValue({ kind: "empty" });
			mocks.embed.mockResolvedValue({
				embeddings: [
					[1, 0],
					[0, 1],
					[1, 0],
				],
				model: EMBEDDING_MODEL,
			});

			await detectInboxDuplicates({
				...scope,
				maxStaleEmbeds: 200,
				logPrefix: "[T]",
				beforeEmbed,
			});

			expect(beforeEmbed).toHaveBeenCalledOnce();
			const [asked] = beforeEmbed.mock.invocationCallOrder;
			const [embedded] = mocks.embed.mock.invocationCallOrder;
			expect(asked).toBeLessThan(embedded ?? 0);
		});

		it("does not ask when the roadmap is empty and every item is cached", async () => {
			const beforeEmbed = vi.fn().mockResolvedValue(undefined);
			mocks.readCache.mockResolvedValue(
				new Map([
					[hashOf("Queue exports"), { embedding: [1, 0] }],
					[hashOf("Dark mode"), { embedding: [0, 1] }],
					[hashOf("Export queue"), { embedding: [1, 0] }],
				]),
			);
			mocks.loadCorpus.mockResolvedValue({ kind: "empty" });

			const result = await detectInboxDuplicates({
				...scope,
				maxStaleEmbeds: 200,
				logPrefix: "[T]",
				beforeEmbed,
			});

			expect(beforeEmbed).not.toHaveBeenCalled();
			expect(mocks.embed).not.toHaveBeenCalled();
			expect(result.flags.length).toBeGreaterThan(0);
		});

		it("embeds nothing when the call is refused before embedding", async () => {
			const refusal = new Error("rate limited");
			mocks.loadCorpus.mockResolvedValue({ kind: "empty" });

			await expect(
				detectInboxDuplicates({
					...scope,
					maxStaleEmbeds: 200,
					logPrefix: "[T]",
					beforeEmbed: vi.fn().mockRejectedValue(refusal),
				}),
			).rejects.toBe(refusal);
			expect(mocks.embed).not.toHaveBeenCalled();
			expect(mocks.writeCache).not.toHaveBeenCalled();
		});

		it("returns no flags when the corpus was embedded with another model than the cache key", async () => {
			mocks.loadCorpus.mockResolvedValue({
				...readyCorpus(
					[
						[1, 0],
						[0, 1],
						[1, 0],
					],
					[0, 1],
				),
				model: "example-other-model",
			});

			await expect(check()).resolves.toEqual({
				flags: [],
				stillChecking: 0,
				verifying: 0,
				checking: [],
			});
			expect(mocks.writeCache).not.toHaveBeenCalled();
		});

		it("keys a personal project's cache without an organization", async () => {
			await detectInboxDuplicates({
				projectId: "project-1",
				userId: "user-1",
				maxStaleEmbeds: 200,
				logPrefix: "[T]",
			}).catch(() => undefined);

			expect(mocks.readCache).toHaveBeenCalledWith(
				{ ...cacheScope, organizationId: null },
				expect.any(Array),
			);
		});
	});
});

describe("findProposalInboxMatches", () => {
	const entries = [
		{ item: item("p-1", 0, "Queue exports"), text: "Queue exports" },
		{ item: item("p-2", 3, "Dark mode"), text: "Dark mode" },
	];
	const plainEntry = manualEntry("Rate limit exports", "Rate limit exports");

	it("reads the entry's and the items' vectors from the corpus batch", async () => {
		const matches = await findMatches({
			...scope,
			entry: plainEntry,
			entries,
			corpus: {
				kind: "ready",
				itemEmbeddings: [
					[1, 0],
					[1, 0],
					[0, 1],
				],
			},
		});

		const texts = manualEntryCorpusTexts(plainEntry, entries);
		expect(texts).toEqual([
			"Rate limit exports",
			"Queue exports",
			"Dark mode",
		]);
		expect(mocks.embed).not.toHaveBeenCalled();
		expect(matches).toEqual([
			{
				proposalId: "p-1",
				changeIndex: 0,
				title: "Queue exports",
				summary: "Summary of p-1",
				source: "TEAMS_CHANNEL",
				similarity: 1,
			},
		]);
	});

	it("compares a plain entry on cosine at or above the bar, adding no item section to the request", async () => {
		const sectioned = [
			{
				item: item("p-1", 0, "Queue exports", { scope: "In scope: A" }),
				text: "Queue exports",
			},
			{
				item: item("p-2", 3, "Dark mode", { scope: "In scope: B" }),
				text: "Dark mode",
			},
		];

		const matches = await findMatches({
			...scope,
			entry: plainEntry,
			entries: sectioned,
			corpus: {
				kind: "ready",
				itemEmbeddings: [[1, 0], at(0.75), at(0.69)],
			},
		});

		expect(manualEntryCorpusTexts(plainEntry, sectioned)).toEqual([
			"Rate limit exports",
			"Queue exports",
			"Dark mode",
		]);
		expect(matches).toEqual([
			expect.objectContaining({
				proposalId: "p-1",
				similarity: expect.closeTo(0.75, 5),
			}),
		]);
	});

	it("relaxes the bar for an inbox item captured close to now, as the roadmap scan does", async () => {
		const similarity = 0.7 - 0.015;
		const recent = {
			item: { ...item("p-1", 0, "Queue exports"), createdAt: new Date() },
			text: "Queue exports",
		};
		const older = {
			item: {
				...item("p-2", 3, "Dark mode"),
				createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000),
			},
			text: "Dark mode",
		};

		const matches = await findMatches({
			...scope,
			entry: plainEntry,
			entries: [recent, older],
			corpus: {
				kind: "ready",
				itemEmbeddings: [[1, 0], at(similarity), at(similarity)],
			},
		});

		expect(matches).toEqual([
			expect.objectContaining({
				proposalId: "p-1",
				similarity: expect.closeTo(similarity, 5),
			}),
		]);
	});

	describe("feature sections", () => {
		const SCOPE = "In scope:\n- Queue large exports";
		const OTHER_SCOPE = "In scope:\n- Dark mode toggle";
		const featureEntry = manualEntry(
			"Rate limit exports",
			"Rate limit exports\n\n## Scope\n### In Scope\n- Queue large exports",
		);
		const features = [
			{
				item: item("p-1", 0, "Queue exports", { scope: SCOPE }),
				text: "Queue exports",
			},
			{
				item: item("p-2", 3, "Dark mode", {
					scope: OTHER_SCOPE,
					acceptance_criteria: "Given a toggle",
				}),
				text: "Dark mode",
			},
		];

		it("reads the entry as a feature with the description's Scope section", () => {
			expect(featureEntry.focusTexts).toEqual({ scope: SCOPE });
			expect(manualEntryCorpusTexts(featureEntry, features)).toEqual([
				"Rate limit exports",
				"Queue exports",
				"Dark mode",
				SCOPE,
				SCOPE,
				OTHER_SCOPE,
			]);
		});

		it("weighs the entry and an inbox feature on their Scope sections, as the roadmap scan does", async () => {
			const matches = await findMatches({
				...scope,
				entry: featureEntry,
				entries: features,
				corpus: {
					kind: "ready",
					// The entry; p-1 reads apart (0.5) but shares the Scope;
					// p-2 reads alike (0.95) but its Scope does not.
					itemEmbeddings: [
						[1, 0],
						at(0.5),
						at(0.95),
						[1, 0],
						[1, 0],
						[0, 1],
					],
				},
			});

			// 0.75 × 1 + 0.25 × 0.5 = 0.875, on the threshold's scale.
			expect(matches).toEqual([
				expect.objectContaining({
					proposalId: "p-1",
					similarity: expect.closeTo(
						0.7 + ((0.875 - 0.62) * 0.3) / 0.38,
						10,
					),
				}),
			]);
		});
	});

	it("embeds nothing when the inbox has no items", async () => {
		await expect(
			findMatches({
				...scope,
				entry: plainEntry,
				entries: [],
				corpus: { kind: "empty" },
			}),
		).resolves.toEqual([]);
		expect(mocks.embed).not.toHaveBeenCalled();
	});
});
