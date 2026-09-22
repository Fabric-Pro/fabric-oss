import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Questions a DRAFT run raises, and why they are not reconciled (Fizzy #1988).
 *
 * Unit-level with a mocked client, like `publishing-topic-decisions.test.ts`:
 * what is read, what is written, and under which branch. The partial unique
 * index on `(topicId, questionId)` lives in the migration, so the P2002 path is
 * exercised by making `create` reject with that code rather than by Postgres.
 *
 * The collision this file exists to pin: the planning analysis used to be the
 * only producer of `QUESTION` roots, so reconciliation could soft-close every
 * OPEN root of that kind it no longer raised. Three content types now raise
 * asset confirmations of their own, each from its own list. A sweep that did
 * not know the difference would have a Case Study run soft-close the asset a
 * Webinar draft is waiting on, and the next Webinar run reactivate it — a row
 * flapping on every generation.
 */

const { findManyRoots, createEntry, updateEntry } = vi.hoisted(() => ({
	findManyRoots: vi.fn(),
	createEntry: vi.fn(),
	updateEntry: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		publishingTopicDecisionEntry: {
			findMany: findManyRoots,
			create: createEntry,
			updateMany: updateEntry,
		},
	},
	Prisma: {},
}));

import {
	raiseDraftQuestions,
	reconcileTopicQuestions,
} from "../prisma/queries/projects/publishing-decisions";

const tx = {
	publishingTopicDecisionEntry: {
		findMany: findManyRoots,
		create: createEntry,
		updateMany: updateEntry,
	},
} as unknown as Parameters<typeof raiseDraftQuestions>[0];

const TENANT = {
	topicId: "topic-1",
	projectId: "proj-1",
	organizationId: "org-1",
	userId: "user-1",
};

const ASSET_QUESTION = {
	questionId: "q-latency-chart",
	decisionKind: "ASSET_APPROVAL",
	subject: "the latency chart",
	question: "Is the latency chart confirmed for use?",
	answerOptions: [{ text: "Confirmed", justification: "It may be used." }],
	whyItMatters: "The draft references it but cannot confirm it.",
};

const raise = (questions = [ASSET_QUESTION]) =>
	raiseDraftQuestions(tx, {
		...TENANT,
		postType: "WEBINAR_SCRIPT",
		questions,
	});

beforeEach(() => {
	vi.clearAllMocks();
	findManyRoots.mockResolvedValue([]);
	createEntry.mockResolvedValue({});
	updateEntry.mockResolvedValue({ count: 1 });
});

describe("raiseDraftQuestions", () => {
	it("mints an OPEN root stamped with the draft that raised it", async () => {
		const outcome = await raise();

		expect(outcome).toEqual({ minted: 1, reactivated: 0, untouched: 0 });
		const data = createEntry.mock.calls[0]?.[0]?.data;
		expect(data).toMatchObject({
			topicId: "topic-1",
			projectId: "proj-1",
			kind: "QUESTION",
			status: "OPEN",
			authorType: "AGENT",
			authorUserId: null,
			questionId: "q-latency-chart",
			decisionKind: "ASSET_APPROVAL",
			subject: "the latency chart",
			raisedByPostType: "WEBINAR_SCRIPT",
		});
		// No analysis raised it, so it carries no analysis version.
		expect(data.analysisVersion).toBeUndefined();
	});

	it("leaves a live OPEN root exactly as it is", async () => {
		findManyRoots.mockResolvedValue([
			{
				id: "root-1",
				questionId: "q-latency-chart",
				status: "OPEN",
				raisedByPostType: "CASE_STUDY",
			},
		]);

		const outcome = await raise();

		expect(outcome).toEqual({ minted: 0, reactivated: 0, untouched: 1 });
		expect(createEntry).not.toHaveBeenCalled();
		expect(updateEntry).not.toHaveBeenCalled();
	});

	it("finds the row the ANALYSIS raised rather than minting a second one", async () => {
		// One question per asset, whoever raised it first: `deriveQuestionId`
		// hashes (topicId, decisionKind, subject), so both producers land on
		// the same id — and the partial unique index would refuse the second.
		findManyRoots.mockResolvedValue([
			{
				id: "root-1",
				questionId: "q-latency-chart",
				status: "OPEN",
				raisedByPostType: null,
			},
		]);

		const outcome = await raise();

		expect(outcome.minted).toBe(0);
		expect(createEntry).not.toHaveBeenCalled();
	});

	it("reactivates a root reconciliation soft-closed", async () => {
		findManyRoots.mockResolvedValue([
			{
				id: "root-1",
				questionId: "q-latency-chart",
				status: "POSSIBLY_RESOLVED",
				raisedByPostType: null,
			},
		]);

		const outcome = await raise();

		expect(outcome).toEqual({ minted: 0, reactivated: 1, untouched: 0 });
		expect(updateEntry).toHaveBeenCalledWith({
			where: {
				id: "root-1",
				projectId: "proj-1",
				topicId: "topic-1",
				status: "POSSIBLY_RESOLVED",
			},
			data: { status: "OPEN" },
		});
	});

	it("loses a claim race without reopening anything", async () => {
		// Somebody answered it between the read and the write. Their answer
		// wins; this run records it as untouched rather than as reactivated.
		findManyRoots.mockResolvedValue([
			{
				id: "root-1",
				questionId: "q-latency-chart",
				status: "POSSIBLY_RESOLVED",
				raisedByPostType: null,
			},
		]);
		updateEntry.mockResolvedValue({ count: 0 });

		const outcome = await raise();

		expect(outcome).toEqual({ minted: 0, reactivated: 0, untouched: 1 });
	});

	it("never reopens a root somebody settled", async () => {
		for (const status of ["RESOLVED", "REJECTED", "FORMATTING_ONLY"]) {
			vi.clearAllMocks();
			findManyRoots.mockResolvedValue([
				{
					id: "root-1",
					questionId: "q-latency-chart",
					status,
					raisedByPostType: null,
				},
			]);

			const outcome = await raise();

			expect(outcome.reactivated).toBe(0);
			expect(updateEntry).not.toHaveBeenCalled();
		}
	});

	it("SWEEPS NOTHING — a live row it did not raise is untouched", async () => {
		// The whole difference from `reconcileTopicQuestions`. This run's list
		// names only the latency chart; the demo recording, raised by another
		// content type, must survive.
		findManyRoots.mockResolvedValue([
			{
				id: "root-2",
				questionId: "q-demo-recording",
				status: "OPEN",
				raisedByPostType: "NEWSLETTER_BLURB",
			},
		]);

		await raise();

		expect(updateEntry).not.toHaveBeenCalled();
	});

	it("treats a unique violation as the outcome it wanted", async () => {
		// Two generations for the same topic can reach the create at once.
		createEntry.mockRejectedValue({ code: "P2002" });

		const outcome = await raise();

		expect(outcome).toEqual({ minted: 0, reactivated: 0, untouched: 1 });
	});

	it("still throws on a failure that is not a unique violation", async () => {
		createEntry.mockRejectedValue(new Error("connection reset"));

		await expect(raise()).rejects.toThrow("connection reset");
	});

	it("reads nothing and writes nothing for an empty list", async () => {
		const outcome = await raise([]);

		expect(outcome).toEqual({ minted: 0, reactivated: 0, untouched: 0 });
		expect(findManyRoots).not.toHaveBeenCalled();
	});
});

describe("reconcileTopicQuestions — the sweep knows whose rows it owns", () => {
	const reconcile = (questions: unknown[] = []) =>
		reconcileTopicQuestions(tx as never, {
			...TENANT,
			analysisVersion: 2,
			questions: questions as never,
		});

	it("does NOT soft-close a row a draft raised", async () => {
		findManyRoots.mockResolvedValue([
			{
				id: "root-1",
				questionId: "q-latency-chart",
				status: "OPEN",
				raisedByPostType: "WEBINAR_SCRIPT",
			},
		]);

		const outcome = await reconcile();

		expect(outcome.softClosed).toBe(0);
		// Only the AI_UPDATE note may be written, never a status change.
		expect(updateEntry).not.toHaveBeenCalled();
	});

	it("still soft-closes its OWN row", async () => {
		findManyRoots.mockResolvedValue([
			{
				id: "root-1",
				questionId: "q-customer-name",
				status: "OPEN",
				raisedByPostType: null,
			},
		]);

		const outcome = await reconcile();

		expect(outcome.softClosed).toBe(1);
		expect(updateEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { status: "POSSIBLY_RESOLVED" },
			}),
		);
	});

	it("ADOPTS a draft-raised row once it raises the question itself", async () => {
		// From that moment the analysis owns it and its sweep applies —
		// otherwise a row raised once by a draft would be exempt forever.
		findManyRoots.mockResolvedValue([
			{
				id: "root-1",
				questionId: "q-latency-chart",
				status: "OPEN",
				raisedByPostType: "WEBINAR_SCRIPT",
			},
		]);

		await reconcile([
			{
				questionId: "q-latency-chart",
				decisionKind: "ASSET_APPROVAL",
				subject: "the latency chart",
				question: "Is the latency chart approved?",
				recommendedResponse: null,
				answerOptions: null,
				whyItMatters: null,
				foldedQuestions: [],
			},
		]);

		expect(updateEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ raisedByPostType: null }),
			}),
		);
	});
});
