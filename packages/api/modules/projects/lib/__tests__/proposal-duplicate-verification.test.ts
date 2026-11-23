/**
 * The duplicate verifier's part in the Proposal Inbox duplicate flags: as on
 * the roadmap, only a candidate the verifier confirmed is shown. An inbox
 * item's candidate is settled by its stored verdict, and the background
 * verification is started for the rest, never holding the flags back; a pair
 * that keeps failing waits. A manual entry's candidates are verified inline
 * on a verifying check, and the verdicts kept, so a repeat bills nothing; a
 * typing prefetch lists only kept confirmations.
 *
 * The real candidate rule, verdict settlement and hashes run; the corpus,
 * the verdict queries, the verifier, Upstash and the background start are
 * mocked.
 */

import {
	detectionVerdictHash,
	INBOX_VERIFY_FAILURE_LIMIT,
	inboxItemSubject,
	storySubject,
	VERIFIER_VERSION,
} from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listItems: vi.fn(),
	listFocus: vi.fn(),
	listVerdicts: vi.fn(),
	loadCorpus: vi.fn(),
	resolveModel: vi.fn(),
	verifierModel: vi.fn(),
	verifyPair: vi.fn(),
	startVerification: vi.fn(),
	readCache: vi.fn(),
	writeCache: vi.fn(),
	redisMget: vi.fn(),
	redisSet: vi.fn(),
	redisExec: vi.fn(),
	waitUntil: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

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

// The manual entry's kept verdicts; the inbox's own vectors are mocked
// below.
vi.mock("../../../../lib/redis-client", () => ({
	getRedisClient: () => ({
		mget: mocks.redisMget,
		pipeline: () => ({ set: mocks.redisSet, exec: mocks.redisExec }),
	}),
}));

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
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/rag", () => ({ generateEmbeddings: vi.fn() }));

vi.mock("@repo/temporal/backlog-routing-core", () => ({
	loadRoutingCorpus: mocks.loadCorpus,
}));

import {
	detectInboxDuplicates,
	findProposalInboxMatches,
	manualEntry,
	START_VERIFICATION_WAIT_MS,
} from "../proposal-duplicate-matching";

const EMBEDDING_MODEL = "example-embedding-model";

const item = (proposalId: string, changeIndex: number, title: string) => ({
	proposalId,
	changeIndex,
	source: "TEAMS_CHANNEL",
	proposalSummary: `Summary of ${proposalId}`,
	createdAt: new Date("2026-11-02T09:00:00.000Z"),
	title,
	description: "",
	acceptanceCriteria: "",
	focusTexts: null,
});

const scope = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
};

/** A unit vector at `similarity` cosine from [1, 0]. */
const at = (similarity: number) => [
	similarity,
	Math.sqrt(1 - similarity * similarity),
];

/** A ready corpus with one ticket at [1, 0]. */
const readyCorpus = (itemEmbeddings: number[][]) => ({
	kind: "ready",
	model: EMBEDDING_MODEL,
	itemEmbeddings,
	candidateVectors: [
		{ id: "story-1", identifier: "F-12", embedding: [1, 0] },
	],
	storyById: new Map([
		["story-1", { id: "story-1", identifier: "F-12", title: "Dark theme" }],
	]),
	textByStoryId: new Map(),
	skippedStale: 0,
});

/** A resolved verifier model, as `getAIModelWithMetadata` returns it. */
const modelNamed = (modelString: string) => ({
	model: {},
	metadata: { provider: "VERCEL_GATEWAY", modelString },
	trackUsage: vi.fn(),
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listFocus.mockResolvedValue([]);
	mocks.resolveModel.mockResolvedValue({
		modelString: `openai/${EMBEDDING_MODEL}`,
	});
	mocks.readCache.mockResolvedValue(new Map());
	mocks.writeCache.mockResolvedValue(true);
	mocks.listVerdicts.mockResolvedValue([]);
	mocks.startVerification.mockResolvedValue(undefined);
	mocks.verifierModel.mockResolvedValue(modelNamed("example/model-a"));
	mocks.verifyPair.mockResolvedValue({
		verdict: { relationship: "same_work_item", confidence: 0.95 },
		effect: "link:DUPLICATE",
	});
	mocks.redisMget.mockImplementation(async (keys: string[]) =>
		keys.map(() => null),
	);
	mocks.redisExec.mockResolvedValue([]);
});

/** The verifier answers each `relationship` in turn. */
function verifierSays(relationships: string[]) {
	for (const relationship of relationships) {
		mocks.verifyPair.mockResolvedValueOnce({
			verdict: { relationship, confidence: 0.9 },
			effect:
				relationship === "same_work_item" ? "link:DUPLICATE" : "cache",
		});
	}
}

describe("detectInboxDuplicates", () => {
	const open = item("open", 0, "Export as CSV");
	const itemHash = detectionVerdictHash(inboxItemSubject(open));
	// The corpus row (`readyCorpus`) has no sections, so the ticket is hashed
	// on its text alone, as a bug is.
	const ticketHash = detectionVerdictHash(
		storySubject({
			id: "story-1",
			identifier: "F-12",
			title: "Dark theme",
			kind: "BUG",
		}),
	);
	const verdict = (flagged: boolean, contentHash = itemHash) => ({
		proposalId: "open",
		changeIndex: 0,
		counterpartKey: "story:story-1",
		contentHash,
		counterpartHash: ticketHash,
		flagged,
		linkType: "DUPLICATE",
		confidence: 0.9,
		failedAttempts: 0,
		lastFailedAt: null,
	});
	const ticketPair = {
		item: { proposalId: "open", changeIndex: 0 },
		counterpart: { kind: "story", storyId: "story-1" },
		similarity: expect.closeTo(0.75, 5),
		proximate: false,
		focusKind: null,
	};

	const check = () =>
		detectInboxDuplicates({
			...scope,
			maxStaleEmbeds: 200,
			logPrefix: "[T]",
		});

	beforeEach(() => {
		mocks.listItems.mockResolvedValue([open]);
		mocks.loadCorpus.mockResolvedValue(readyCorpus([at(0.75)]));
	});

	it("shows no flag before the verifier has decided, and starts it for the candidate", async () => {
		const result = await check();

		expect(result.flags).toEqual([]);
		expect(result.verifying).toBe(1);
		expect(result.checking).toEqual([
			{ proposalId: "open", changeIndex: 0 },
		]);
		expect(mocks.listVerdicts).toHaveBeenCalledWith("project-1");
		expect(mocks.startVerification).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			pairs: [ticketPair],
		});
	});

	it("flags a pair the verifier confirmed, with the rule's score", async () => {
		mocks.listVerdicts.mockResolvedValue([verdict(true)]);

		const result = await check();

		expect(result.flags).toEqual([
			{
				proposalId: "open",
				changeIndex: 0,
				matches: [
					expect.objectContaining({
						kind: "story",
						storyId: "story-1",
						similarity: expect.closeTo(0.75, 5),
					}),
				],
			},
		]);
		expect(result.verifying).toBe(0);
		expect(result.checking).toEqual([]);
		expect(mocks.startVerification).toHaveBeenCalledWith(
			expect.objectContaining({ pairs: [] }),
		);
	});

	it("shows no flag for a pair the verifier rejected", async () => {
		mocks.listVerdicts.mockResolvedValue([verdict(false)]);

		const result = await check();

		expect(result.flags).toEqual([]);
		expect(result.verifying).toBe(0);
	});

	it("verifies a pair again once the item's text changed", async () => {
		// The flag was confirmed on the item's earlier text.
		const earlier = item("open", 0, "Export as XLSX");
		const earlierHash = detectionVerdictHash(inboxItemSubject(earlier));
		mocks.listVerdicts.mockResolvedValue([verdict(true, earlierHash)]);

		const result = await check();

		expect(result.flags).toEqual([]);
		expect(result.verifying).toBe(1);
		expect(mocks.startVerification).toHaveBeenCalledWith(
			expect.objectContaining({ pairs: [ticketPair] }),
		);
	});

	it("returns the confirmed flags without waiting on a start Temporal does not answer, and keeps the start alive", async () => {
		mocks.listVerdicts.mockResolvedValue([verdict(true)]);
		const start = new Promise<void>(() => {});
		mocks.startVerification.mockReturnValue(start);
		const startedAt = Date.now();

		const result = await check();

		expect(result.flags).toHaveLength(1);
		// Kept alive past the response on a serverless host.
		expect(mocks.waitUntil).toHaveBeenCalledWith(start);
		// Real time: the check gives the start its one second, no more.
		expect(Date.now() - startedAt).toBeLessThan(
			START_VERIFICATION_WAIT_MS + 2_000,
		);
	});

	it("shows nothing for a pair whose verification keeps failing, and does not keep its item checking", async () => {
		mocks.listVerdicts.mockResolvedValue([
			{
				...verdict(false),
				flagged: null,
				failedAttempts: INBOX_VERIFY_FAILURE_LIMIT,
				lastFailedAt: new Date(),
			},
		]);

		const result = await check();

		expect(result.flags).toEqual([]);
		expect(result.verifying).toBe(0);
		expect(result.checking).toEqual([]);
		expect(mocks.startVerification).toHaveBeenCalledWith(
			expect.objectContaining({ pairs: [] }),
		);
	});

	it("flags nothing under the candidate rule, and verifies nothing", async () => {
		mocks.loadCorpus.mockResolvedValue(readyCorpus([at(0.6)]));

		const result = await check();

		expect(result.flags).toEqual([]);
		expect(result.verifying).toBe(0);
		expect(mocks.startVerification).toHaveBeenCalledWith(
			expect.objectContaining({ pairs: [] }),
		);
	});

	it("keeps flagging a pair the verifier confirmed after the rule's score for it drops under the bar", async () => {
		mocks.loadCorpus.mockResolvedValue(readyCorpus([at(0.6)]));
		mocks.listVerdicts.mockResolvedValue([verdict(true)]);

		const result = await check();

		expect(result.flags).toEqual([
			{
				proposalId: "open",
				changeIndex: 0,
				matches: [
					expect.objectContaining({
						kind: "story",
						storyId: "story-1",
						similarity: expect.closeTo(0.6, 5),
					}),
				],
			},
		]);
		expect(result.verifying).toBe(0);
		expect(result.checking).toEqual([]);
	});

	it("verifies a flagged pair under the bar again once the item's text changed, and keeps the item checking", async () => {
		mocks.loadCorpus.mockResolvedValue(readyCorpus([at(0.6)]));
		const earlier = item("open", 0, "Export as XLSX");
		const earlierHash = detectionVerdictHash(inboxItemSubject(earlier));
		mocks.listVerdicts.mockResolvedValue([verdict(true, earlierHash)]);

		const result = await check();

		expect(result.flags).toEqual([]);
		expect(result.verifying).toBe(1);
		expect(result.checking).toEqual([
			{ proposalId: "open", changeIndex: 0 },
		]);
		expect(mocks.startVerification).toHaveBeenCalledWith(
			expect.objectContaining({
				pairs: [{ ...ticketPair, similarity: expect.closeTo(0.6, 5) }],
			}),
		);
	});
});

describe("findProposalInboxMatches", () => {
	const entries = [
		{ item: item("p-1", 0, "Queue exports"), text: "Queue exports" },
		{ item: item("p-2", 3, "Dark mode"), text: "Dark mode" },
	];
	const plainEntry = manualEntry("Rate limit exports", "Rate limit exports");

	const BOTH_CANDIDATES = [[1, 0], [1, 0], at(0.8)];

	const check = (
		itemEmbeddings: number[][],
		options: { verify?: boolean; abortSignal?: AbortSignal } = {},
	) =>
		findProposalInboxMatches({
			...scope,
			entry: plainEntry,
			entries,
			corpus: { kind: "ready", itemEmbeddings },
			verify: options.verify ?? true,
			abortSignal: options.abortSignal,
		});

	const find = async (itemEmbeddings: number[][]) =>
		(await check(itemEmbeddings)).matches;

	const verifierPrompt = () => mocks.verifyPair.mock.calls[0]?.[0]?.prompt;

	it("verifies each candidate with the roadmap scan's verifier and lists the confirmed ones", async () => {
		const matches = await find(BOTH_CANDIDATES);

		expect(matches.map((match) => match.proposalId)).toEqual([
			"p-1",
			"p-2",
		]);
		expect(mocks.verifierModel).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			expect.objectContaining({
				projectId: "project-1",
				featureKey: "duplicate-scan",
			}),
		);
		expect(mocks.verifyPair).toHaveBeenCalledTimes(2);
		expect(verifierPrompt()).toContain("Rate limit exports");
		expect(verifierPrompt()).toContain("Queue exports");
		expect(mocks.verifyPair.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ bothFeatures: false }),
		);
	});

	it("lists no candidate the verifier rejects", async () => {
		mocks.verifyPair
			.mockResolvedValueOnce({
				verdict: { relationship: "distinct", confidence: 0.9 },
				effect: "cache",
			})
			.mockResolvedValueOnce({
				verdict: { relationship: "overlapping", confidence: 0.9 },
				effect: "link:OVERLAP",
			});

		const matches = await find(BOTH_CANDIDATES);

		expect(matches.map((match) => match.proposalId)).toEqual(["p-2"]);
	});

	it("lists no candidate whose verification fails, and keeps no verdict for it", async () => {
		mocks.verifyPair.mockRejectedValue(new Error("provider outage"));

		await expect(find(BOTH_CANDIDATES)).resolves.toEqual([]);
		expect(mocks.redisSet).not.toHaveBeenCalled();
	});

	it("calls no verifier when nothing clears the candidate rule", async () => {
		await find([[1, 0], at(0.6), [0, 1]]);

		expect(mocks.verifierModel).not.toHaveBeenCalled();
		expect(mocks.verifyPair).not.toHaveBeenCalled();
	});

	it("stops its verifier calls when the request is abandoned", async () => {
		const request = new AbortController();

		await check(BOTH_CANDIDATES, { abortSignal: request.signal });

		expect(mocks.verifyPair.mock.calls[0]?.[0]?.abortSignal).toBe(
			request.signal,
		);
	});

	describe("kept verdicts", () => {
		/** The verdicts the last check kept, by key. */
		const keptByLastCheck = () =>
			new Map(
				mocks.redisSet.mock.calls.map(([key, value]) => [key, value]),
			);

		/** The next checks read what the checks so far kept. */
		function readKept() {
			const kept = keptByLastCheck();
			mocks.verifyPair.mockClear();
			mocks.redisMget.mockImplementation(async (keys: string[]) =>
				keys.map((key) => kept.get(key) ?? null),
			);
		}

		it("keeps each verdict for a day, keyed by the verifier, its model and both texts", async () => {
			verifierSays(["distinct", "same_work_item"]);

			await find(BOTH_CANDIDATES);

			expect(mocks.redisSet).toHaveBeenCalledTimes(2);
			const [key, value, options] = mocks.redisSet.mock.calls[0] ?? [];
			expect(key).toMatch(
				/^proposal-dup:manual-verdict:org-1:project-1:/,
			);
			expect(key).toContain(
				`:v${VERIFIER_VERSION}:VERCEL_GATEWAY:example/model-a:`,
			);
			expect(value).toEqual({ confirmed: false });
			expect(options).toEqual({ ex: 24 * 60 * 60 });
		});

		it("bills nothing for a text checked before", async () => {
			verifierSays(["distinct", "same_work_item"]);
			await find(BOTH_CANDIDATES);
			readKept();

			const matches = await find(BOTH_CANDIDATES);

			expect(matches.map((match) => match.proposalId)).toEqual(["p-2"]);
			expect(mocks.verifyPair).not.toHaveBeenCalled();
		});

		it("verifies again once the verifier resolves to another model", async () => {
			await find(BOTH_CANDIDATES);
			readKept();
			mocks.verifierModel.mockResolvedValue(
				modelNamed("example/model-b"),
			);

			await find(BOTH_CANDIDATES);

			expect(mocks.verifyPair).toHaveBeenCalledTimes(2);
		});

		it("verifies again once the entry's text changed", async () => {
			await find(BOTH_CANDIDATES);
			readKept();

			await findProposalInboxMatches({
				...scope,
				entry: manualEntry("Throttle exports", "Throttle exports"),
				entries,
				corpus: { kind: "ready", itemEmbeddings: BOTH_CANDIDATES },
				verify: true,
			});

			expect(mocks.verifyPair).toHaveBeenCalledTimes(2);
		});

		it("a typing prefetch bills no verifier, lists only kept confirmations, and counts the rest", async () => {
			verifierSays(["same_work_item"]);
			await check([
				[1, 0],
				[1, 0],
				[0, 1],
			]);
			readKept();

			const prefetch = await check(BOTH_CANDIDATES, { verify: false });

			expect(prefetch.matches.map((match) => match.proposalId)).toEqual([
				"p-1",
			]);
			expect(prefetch.unverified).toBe(1);
			expect(mocks.verifyPair).not.toHaveBeenCalled();
		});
	});
});
