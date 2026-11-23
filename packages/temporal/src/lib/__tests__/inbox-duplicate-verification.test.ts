/**
 * The Proposal Inbox's duplicate verifier: the roadmap scan's verifier call,
 * prompt and second opinion on each candidate pair, verdicts stored on both
 * sides' verdict hashes, a pair verified again only once a side's text
 * changed, and a retryable failure when every pair failed.
 *
 * The real verifier helper, prompt and hashes run; the model, the logger
 * and the verdict and item queries are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
	trackUsage: vi.fn(),
	getModel: vi.fn(),
	listItems: vi.fn(),
	listStories: vi.fn(),
	getVerdict: vi.fn(),
	upsertVerdict: vi.fn(),
	stampVerdict: vi.fn(),
	recordFailure: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	Output: { object: (spec: unknown) => spec },
	generateText: mocks.generateText,
	getAIModelWithMetadata: mocks.getModel,
}));

vi.mock("@repo/rag", () => ({ generateEmbeddings: vi.fn() }));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
	listActiveStoriesForDetection: mocks.listStories,
	getProposalItemDuplicateVerdict: mocks.getVerdict,
	upsertProposalItemDuplicateVerdict: mocks.upsertVerdict,
	stampProposalItemDuplicateVerdict: mocks.stampVerdict,
	recordProposalItemDuplicateVerdictFailure: mocks.recordFailure,
}));

import {
	detectionVerdictHash,
	INBOX_VERIFY_FAILURE_LIMIT,
	type InboxDuplicatePair,
	inboxItemSubject,
	storySubject,
} from "@repo/database";
import { verifyInboxDuplicatePairs } from "../inbox-duplicate-verification";

const item = (
	proposalId: string,
	changeIndex: number,
	title: string,
	focusTexts: Record<string, string> | null = null,
) => ({
	proposalId,
	changeIndex,
	source: "TEAMS_CHANNEL" as const,
	proposalSummary: `Summary of ${proposalId}`,
	createdAt: new Date("2026-11-02T09:00:00.000Z"),
	title,
	description: "",
	acceptanceCriteria: "",
	focusTexts,
});

const ticket = {
	id: "story-1",
	identifier: "F-12",
	title: "Export throttling",
	description: "Exports need a queue.",
	acceptanceCriteria: null,
	kind: "BUG" as const,
	createdAt: new Date("2026-10-01T09:00:00.000Z"),
	tasks: [],
};

const alpha = item("alpha", 0, "Queue exports");
const beta = item("beta", 1, "Export queue");

const hashOf = (entry: ReturnType<typeof item>) =>
	detectionVerdictHash(inboxItemSubject(entry));

/** The pair of the two inbox items, read from `beta`'s side. */
const itemPair: InboxDuplicatePair = {
	item: { proposalId: "beta", changeIndex: 1 },
	counterpart: { kind: "item", proposalId: "alpha", changeIndex: 0 },
	similarity: 0.82,
	proximate: true,
	focusKind: null,
};

const ticketPair: InboxDuplicatePair = {
	item: { proposalId: "alpha", changeIndex: 0 },
	counterpart: { kind: "story", storyId: "story-1" },
	similarity: 0.76,
	proximate: false,
	focusKind: null,
};

/** The pair as it is stored: on `alpha`, the item whose key sorts first. */
const stored = {
	item: { proposalId: "alpha", changeIndex: 0 },
	counterpart: { kind: "item", proposalId: "beta", changeIndex: 1 },
};

/** The verifier answers each `relationship` in turn. */
function verifierSays(...relationships: string[]) {
	for (const relationship of relationships) {
		mocks.generateText.mockResolvedValueOnce({
			output: { relationship, confidence: 0.9, reasoning: "test" },
		});
	}
}

const run = (pairs: InboxDuplicatePair[]) =>
	verifyInboxDuplicatePairs({
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		pairs,
	});

const promptOf = (call: number) =>
	mocks.generateText.mock.calls[call]?.[0]?.prompt;

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getModel.mockResolvedValue({
		model: { id: "example-model" },
		trackUsage: mocks.trackUsage,
	});
	mocks.listItems.mockResolvedValue([alpha, beta]);
	mocks.listStories.mockResolvedValue([ticket]);
	mocks.getVerdict.mockResolvedValue(null);
	mocks.upsertVerdict.mockResolvedValue(undefined);
	mocks.stampVerdict.mockResolvedValue(undefined);
	mocks.recordFailure.mockResolvedValue(undefined);
});

/** A stored row as the verdict queries return it. */
const row = (fields: {
	contentHash: string;
	counterpartHash: string;
	flagged?: boolean | null;
	failedAttempts?: number;
	lastFailedAt?: Date | null;
}) => ({
	flagged: true,
	linkType: "DUPLICATE",
	failedAttempts: 0,
	lastFailedAt: null,
	...fields,
});

describe("verifyInboxDuplicatePairs", () => {
	it("stores a confirmed pair as flagged, in stored order, on both sides' hashes", async () => {
		verifierSays("same_work_item");

		const result = await run([itemPair]);

		expect(mocks.getModel).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			expect.objectContaining({
				projectId: "project-1",
				featureKey: "duplicate-scan",
			}),
		);
		expect(promptOf(0)).toContain("Queue exports");
		expect(promptOf(0)).toContain("Export queue");
		expect(mocks.upsertVerdict).toHaveBeenCalledWith({
			...stored,
			hashes: { item: hashOf(alpha), counterpart: hashOf(beta) },
			flagged: true,
			linkType: "DUPLICATE",
			similarity: 0.82,
			confidence: 0.9,
			reasoning: "test",
		});
		expect(result).toEqual({
			attempted: 1,
			current: 0,
			flagged: 1,
			failed: 0,
			skipped: 0,
			leftOver: 0,
		});
	});

	it("stores a rejected pair unflagged, so the inbox shows nothing for it", async () => {
		verifierSays("distinct");

		await run([ticketPair]);

		expect(mocks.upsertVerdict).toHaveBeenCalledWith(
			expect.objectContaining({
				counterpart: { kind: "story", storyId: "story-1" },
				hashes: {
					item: hashOf(alpha),
					counterpart: detectionVerdictHash(storySubject(ticket)),
				},
				flagged: false,
			}),
		);
	});

	it("verifies an item pair once, whichever side found it", async () => {
		verifierSays("same_work_item");
		const fromAlpha: InboxDuplicatePair = {
			...itemPair,
			item: { proposalId: "alpha", changeIndex: 0 },
			counterpart: { kind: "item", proposalId: "beta", changeIndex: 1 },
		};

		await run([itemPair, fromAlpha]);

		expect(mocks.generateText).toHaveBeenCalledTimes(1);
	});

	it("skips a pair whose verdict was given on the current texts", async () => {
		mocks.getVerdict.mockResolvedValue(
			row({ contentHash: hashOf(alpha), counterpartHash: hashOf(beta) }),
		);

		const result = await run([itemPair]);

		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(result.current).toBe(1);
	});

	it("does not fail the run when the one pair it tried failed and another was already verified", async () => {
		// The item pair is already verified; the ticket pair is not.
		mocks.getVerdict.mockImplementation(async (_item, counterpart) =>
			counterpart.kind === "item"
				? row({
						contentHash: hashOf(alpha),
						counterpartHash: hashOf(beta),
					})
				: null,
		);
		mocks.generateText.mockRejectedValue(new Error("provider outage"));

		const result = await run([itemPair, ticketPair]);

		expect(result).toEqual(
			expect.objectContaining({ attempted: 2, current: 1, failed: 1 }),
		);
	});

	describe("a pair whose verification fails", () => {
		it("records the failure on the pair's current texts", async () => {
			mocks.generateText.mockRejectedValue(new Error("provider outage"));

			await expect(run([itemPair])).rejects.toThrow();

			expect(mocks.recordFailure).toHaveBeenCalledWith({
				...stored,
				hashes: { item: hashOf(alpha), counterpart: hashOf(beta) },
				similarity: 0.82,
			});
		});

		it("is not verified again while it waits after failing on its texts", async () => {
			mocks.getVerdict.mockResolvedValue(
				row({
					contentHash: hashOf(alpha),
					counterpartHash: hashOf(beta),
					flagged: null,
					failedAttempts: INBOX_VERIFY_FAILURE_LIMIT,
					lastFailedAt: new Date(),
				}),
			);

			const result = await run([itemPair]);

			expect(mocks.generateText).not.toHaveBeenCalled();
			expect(result.current).toBe(1);
		});

		it("is verified again after one failure, and needs no second opinion for a first verdict", async () => {
			mocks.getVerdict.mockResolvedValue(
				row({
					contentHash: hashOf(alpha),
					counterpartHash: hashOf(beta),
					flagged: null,
					failedAttempts: 1,
					lastFailedAt: new Date(),
				}),
			);
			verifierSays("same_work_item");

			await run([itemPair]);

			expect(mocks.generateText).toHaveBeenCalledTimes(1);
			expect(mocks.upsertVerdict).toHaveBeenCalledWith(
				expect.objectContaining({ flagged: true }),
			);
		});
	});

	it("skips a pair one of whose sides is no longer in review", async () => {
		mocks.listItems.mockResolvedValue([alpha]);

		const result = await run([itemPair]);

		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(mocks.upsertVerdict).not.toHaveBeenCalled();
		expect(result.skipped).toBe(1);
	});

	describe("after a side's text changed", () => {
		const featureA = item("alpha", 0, "Queue exports", {});
		const featureB = item("beta", 1, "Export queue", {});
		const flaggedOnEarlierText = row({
			contentHash: "hash-of-the-earlier-text",
			counterpartHash: hashOf(featureB),
		});

		beforeEach(() => {
			mocks.listItems.mockResolvedValue([featureA, featureB]);
			mocks.getVerdict.mockResolvedValue(flaggedOnEarlierText);
		});

		it("verifies the pair again and clears the flag when a second opinion agrees", async () => {
			verifierSays("distinct", "distinct");

			await run([itemPair]);

			expect(mocks.generateText).toHaveBeenCalledTimes(2);
			expect(mocks.upsertVerdict).toHaveBeenCalledWith(
				expect.objectContaining({
					hashes: {
						item: hashOf(featureA),
						counterpart: hashOf(featureB),
					},
					flagged: false,
				}),
			);
		});

		it("keeps the flag on the new texts when the second opinion disagrees", async () => {
			verifierSays("distinct", "same_work_item");

			const result = await run([itemPair]);

			expect(mocks.upsertVerdict).not.toHaveBeenCalled();
			expect(mocks.stampVerdict).toHaveBeenCalledWith({
				...stored,
				hashes: {
					item: hashOf(featureA),
					counterpart: hashOf(featureB),
				},
			});
			expect(result.flagged).toBe(1);
		});
	});

	it("verifies a pair on the section it was scored on", async () => {
		const scopeA = "In scope:\n- Queue large exports";
		const scopeB = "In scope:\n- Queue every export";
		mocks.listItems.mockResolvedValue([
			item("alpha", 0, "Queue exports", { scope: scopeA }),
			item("beta", 1, "Export queue", { scope: scopeB }),
		]);
		verifierSays("same_work_item");

		await run([{ ...itemPair, focusKind: "scope" }]);

		expect(promptOf(0)).toContain(`<scope_a>\n${scopeA}\n</scope_a>`);
		expect(promptOf(0)).toContain(`<scope_b>\n${scopeB}\n</scope_b>`);
	});

	it("fails for a retry when every pair it tried failed", async () => {
		mocks.generateText.mockRejectedValue(new Error("provider outage"));

		await expect(run([itemPair, ticketPair])).rejects.toThrow(
			/verifier failed for all 2 pair/,
		);
		expect(mocks.upsertVerdict).not.toHaveBeenCalled();
	});

	it("does nothing for no pairs", async () => {
		await expect(run([])).resolves.toEqual({
			attempted: 0,
			current: 0,
			flagged: 0,
			failed: 0,
			skipped: 0,
			leftOver: 0,
		});
		expect(mocks.getModel).not.toHaveBeenCalled();
	});
});
