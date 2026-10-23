/**
 * Matching a recurring log error to what already tracks it: an open bug
 * someone filed, or a pending proposal for the same problem. The duplicate
 * detector's pure pieces (detection text, verifier prompt, verdict
 * normalization, cosine) run for real; the candidate lists, the vectors, the
 * embeddings and the verifier's answers are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listOpenBugStoriesForMatching: vi.fn(),
	listPendingLogProposalsForMatching: vi.fn(),
	loadStoryVectors: vi.fn(),
	generateEmbeddings: vi.fn(),
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	trackUsage: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
	>("@repo/database/prisma/queries/projects/duplicate-detection")),
	listOpenBugStoriesForMatching: mocks.listOpenBugStoriesForMatching,
	listPendingLogProposalsForMatching:
		mocks.listPendingLogProposalsForMatching,
}));
vi.mock("../../../lib/story-vectors", () => ({
	loadStoryVectors: mocks.loadStoryVectors,
}));
vi.mock("@repo/rag", () => ({ generateEmbeddings: mocks.generateEmbeddings }));
vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createOpenBugMatcher } from "../match-open-bug";

const INPUT = {
	projectId: "proj_1",
	organizationId: "org_example",
	userId: "user_owner",
	similarityThreshold: 0.7,
};

const GROUP = {
	fingerprint: "fp_1",
	kind: "trace" as const,
	title: "Payment provider timed out",
	occurrences: 8,
	firstSeen: "2026-10-21T10:00:00Z",
	lastSeen: "2026-10-22T08:00:00Z",
	affectedUsers: 3,
	components: ["checkout-api"],
	excerpts: ["Payment provider timed out after 30s"],
};

function bug(id: string, title: string) {
	return {
		id,
		identifier: id.toUpperCase(),
		title,
		description: null,
		acceptanceCriteria: null,
		tasks: [],
	};
}

/** The verifier's answer for each candidate, keyed by its label in the prompt. */
function answer(byIdentifier: Record<string, object | Error>) {
	mocks.generateObject.mockImplementation(async ({ prompt }) => {
		for (const [identifier, verdict] of Object.entries(byIdentifier)) {
			if (prompt.includes(`Item B (${identifier})`)) {
				if (verdict instanceof Error) {
					throw verdict;
				}
				return { object: verdict };
			}
		}
		throw new Error("unexpected candidate");
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listOpenBugStoriesForMatching.mockResolvedValue([
		bug("b_close", "Checkout times out at the payment provider"),
		bug("b_near", "Payment page is slow"),
		bug("b_far", "Avatar upload rejects PNG files"),
	]);
	mocks.listPendingLogProposalsForMatching.mockResolvedValue([]);
	mocks.loadStoryVectors.mockResolvedValue({
		vectors: new Map([
			["b_close", [1, 0.05]],
			["b_near", [1, 0.3]],
			["b_far", [0, 1]],
		]),
		embedded: 0,
	});
	mocks.generateEmbeddings.mockResolvedValue({ embeddings: [[1, 0]] });
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		trackUsage: mocks.trackUsage,
	});
});

describe("createOpenBugMatcher", () => {
	it("returns the open bug the verifier calls the same work item", async () => {
		answer({
			B_CLOSE: { relationship: "same_work_item", confidence: 0.92 },
			B_NEAR: { relationship: "distinct", confidence: 0.9 },
		});

		const { match, checked } =
			await createOpenBugMatcher(INPUT).check(GROUP);

		expect(match).toEqual({
			kind: "story",
			storyId: "b_close",
			identifier: "B_CLOSE",
			confidence: 0.92,
		});
		expect(checked).toEqual([
			{
				kind: "story",
				identifier: "B_CLOSE",
				similarity: 0.999,
				relationship: "same_work_item",
				confidence: 0.92,
			},
			{
				kind: "story",
				identifier: "B_NEAR",
				similarity: 0.958,
				relationship: "distinct",
				confidence: 0.9,
			},
		]);
		// A bug with nothing in common with the error never reaches the verifier.
		expect(mocks.generateObject).toHaveBeenCalledTimes(2);
		const prompts = mocks.generateObject.mock.calls.map(
			([call]) => call.prompt,
		);
		expect(prompts.join("\n")).not.toContain("Avatar upload");
		expect(prompts[0]).toContain("Payment provider timed out after 30s");
	});

	it("does not count overlapping scope or a low-confidence verdict as a match", async () => {
		answer({
			B_CLOSE: { relationship: "overlapping_scope", confidence: 0.95 },
			B_NEAR: { relationship: "same_work_item", confidence: 0.4 },
		});

		expect(
			(await createOpenBugMatcher(INPUT).check(GROUP)).match,
		).toBeNull();
	});

	it("verifies a weakly similar bug, so a hand-written report of a log error is still found", async () => {
		mocks.loadStoryVectors.mockResolvedValue({
			vectors: new Map([["b_far", [0.3, 1]]]),
			embedded: 0,
		});
		answer({ B_FAR: { relationship: "same_work_item", confidence: 0.85 } });

		const { match, checked } =
			await createOpenBugMatcher(INPUT).check(GROUP);

		expect(checked[0]?.similarity).toBeLessThan(0.5);
		expect(match).toMatchObject({ kind: "story", storyId: "b_far" });
	});

	it("verifies only the closest three candidates", async () => {
		const ids = ["b1", "b2", "b3", "b4"];
		mocks.listOpenBugStoriesForMatching.mockResolvedValue(
			ids.map((id) => bug(id, `Bug ${id}`)),
		);
		mocks.loadStoryVectors.mockResolvedValue({
			vectors: new Map(ids.map((id, i) => [id, [1, i * 0.5]])),
			embedded: 0,
		});
		answer(
			Object.fromEntries(
				ids.map((id) => [
					id.toUpperCase(),
					{ relationship: "distinct", confidence: 0.9 },
				]),
			),
		);

		const { checked } = await createOpenBugMatcher(INPUT).check(GROUP);

		expect(checked.map((entry) => entry.identifier)).toEqual([
			"B1",
			"B2",
			"B3",
		]);
	});

	it("prefers the most confident of several matches", async () => {
		answer({
			B_CLOSE: { relationship: "same_work_item", confidence: 0.75 },
			B_NEAR: { relationship: "same_work_item", confidence: 0.9 },
		});

		const { match } = await createOpenBugMatcher(INPUT).check(GROUP);

		expect(match).toMatchObject({ storyId: "b_near" });
	});

	it("holds a match to the project's similarity threshold", async () => {
		answer({
			B_CLOSE: { relationship: "same_work_item", confidence: 0.85 },
			B_NEAR: { relationship: "same_work_item", confidence: 0.92 },
		});

		const strict = await createOpenBugMatcher({
			...INPUT,
			similarityThreshold: 0.95,
		}).check(GROUP);
		const moderate = await createOpenBugMatcher({
			...INPUT,
			similarityThreshold: 0.9,
		}).check(GROUP);
		const loose = await createOpenBugMatcher({
			...INPUT,
			similarityThreshold: 0.8,
		}).check(GROUP);

		expect(strict.match).toBeNull();
		expect(moderate.match).toMatchObject({ storyId: "b_near" });
		// The bar decides what counts; among those, the most confident wins.
		expect(loose.match).toMatchObject({ storyId: "b_near" });
		answer({
			B_CLOSE: { relationship: "same_work_item", confidence: 0.85 },
		});
		expect(
			(
				await createOpenBugMatcher({
					...INPUT,
					similarityThreshold: 0.8,
				}).check(GROUP)
			).match,
		).toMatchObject({ storyId: "b_close" });
	});

	it("treats one failed verdict as no match for that candidate, not a failure", async () => {
		answer({
			B_CLOSE: new Error("model returned no object"),
			B_NEAR: { relationship: "same_work_item", confidence: 0.8 },
		});

		const { match, checked } =
			await createOpenBugMatcher(INPUT).check(GROUP);

		expect(match).toMatchObject({ storyId: "b_near" });
		expect(checked[0]).toMatchObject({
			identifier: "B_CLOSE",
			relationship: null,
			confidence: null,
		});
	});

	it("matches a pending proposal for another error group of the same problem", async () => {
		mocks.listOpenBugStoriesForMatching.mockResolvedValue([]);
		mocks.loadStoryVectors.mockResolvedValue({
			vectors: new Map(),
			embedded: 0,
		});
		mocks.listPendingLogProposalsForMatching.mockResolvedValue([
			{
				id: "prop_1",
				summary: "Fix payment provider timeouts at checkout",
				evidence: "Occurrences: 12 in the last 24 hours",
			},
		]);
		mocks.generateEmbeddings
			.mockResolvedValueOnce({ embeddings: [[1, 0.1]] })
			.mockResolvedValue({ embeddings: [[1, 0]] });
		answer({
			"Fix payment provider timeouts at checkout": {
				relationship: "same_work_item",
				confidence: 0.88,
			},
		});

		const { match, checked } =
			await createOpenBugMatcher(INPUT).check(GROUP);

		expect(match).toEqual({
			kind: "proposal",
			proposalId: "prop_1",
			identifier: "Fix payment provider timeouts at checkout",
			confidence: 0.88,
		});
		expect(checked[0]?.kind).toBe("proposal");
	});

	it("lets a later group join a proposal the same scan filed", async () => {
		// One open bug unlike both groups keeps the first check from being a
		// no-op, so the first group's vector is computed and can be remembered.
		mocks.listOpenBugStoriesForMatching.mockResolvedValue([
			bug("b_far", "Avatar upload rejects PNG files"),
		]);
		mocks.loadStoryVectors.mockResolvedValue({
			vectors: new Map([["b_far", [0, 1]]]),
			embedded: 0,
		});
		answer({
			"Fix checkout timeouts": {
				relationship: "same_work_item",
				confidence: 0.9,
			},
		});
		const matcher = createOpenBugMatcher(INPUT);

		const first = await matcher.check(GROUP);
		matcher.remember(GROUP, "prop_new", "Fix checkout timeouts");
		const second = await matcher.check({
			...GROUP,
			fingerprint: "fp_2",
			excerpts: ["Payment provider returned 504"],
		});

		expect(first.match).toBeNull();
		expect(second.match).toMatchObject({
			kind: "proposal",
			proposalId: "prop_new",
		});
	});

	it("loads the candidates once per scan", async () => {
		answer({
			B_CLOSE: { relationship: "distinct", confidence: 0.9 },
			B_NEAR: { relationship: "distinct", confidence: 0.9 },
		});
		const matcher = createOpenBugMatcher(INPUT);

		await matcher.check(GROUP);
		await matcher.check({ ...GROUP, fingerprint: "fp_2" });

		expect(mocks.loadStoryVectors).toHaveBeenCalledTimes(1);
		expect(mocks.listPendingLogProposalsForMatching).toHaveBeenCalledTimes(
			1,
		);
		expect(mocks.generateEmbeddings).toHaveBeenCalledTimes(2);
	});

	it("spends nothing when nothing could track the error", async () => {
		mocks.listOpenBugStoriesForMatching.mockResolvedValue([]);
		mocks.loadStoryVectors.mockResolvedValue({
			vectors: new Map(),
			embedded: 0,
		});

		expect(await createOpenBugMatcher(INPUT).check(GROUP)).toEqual({
			match: null,
			checked: [],
		});
		expect(mocks.generateEmbeddings).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("throws when the candidates cannot be loaded, and retries them on the next group", async () => {
		mocks.loadStoryVectors.mockRejectedValueOnce(
			new Error("embedding gateway timed out"),
		);
		answer({
			B_CLOSE: { relationship: "same_work_item", confidence: 0.9 },
			B_NEAR: { relationship: "distinct", confidence: 0.9 },
		});
		const matcher = createOpenBugMatcher(INPUT);

		await expect(matcher.check(GROUP)).rejects.toThrow(
			"embedding gateway timed out",
		);
		expect((await matcher.check(GROUP)).match).toMatchObject({
			storyId: "b_close",
		});
		expect(mocks.loadStoryVectors).toHaveBeenCalledTimes(2);
	});
});
