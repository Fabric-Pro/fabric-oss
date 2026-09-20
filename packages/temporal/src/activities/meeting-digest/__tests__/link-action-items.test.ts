import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGenerateEmbeddings,
	mockGenerateObject,
	mockTrackUsage,
	mockGetAIModelWithMetadata,
	mockResolveModelWithProvider,
	mockIsFeatureEnabled,
	mockListActiveStoriesForDetection,
	mockListDecidedLinkKeys,
	mockInsertAutoLinks,
	mockMarkActionItemsLinked,
	mockListStoryDuplicateEmbeddingMetadata,
	mockListStoryDuplicateEmbeddings,
	mockUpsertStoryDuplicateEmbeddings,
	mockFindFirstTranscript,
	mockEvaluate,
	mockGetDecisionModel,
	mockDecisionTrackUsage,
	mockHeartbeat,
	AiUsageLimitExceededError,
} = vi.hoisted(() => {
	// Stand-in for the real error class: the activity only ever tests
	// membership, and mocking it keeps the payments package out of this unit
	// test.
	class AiUsageLimitExceededError extends Error {
		constructor() {
			super("AI usage limit exceeded");
			this.name = "AiUsageLimitExceededError";
		}
	}
	return {
		AiUsageLimitExceededError,
		mockGenerateEmbeddings: vi.fn(),
		mockGenerateObject: vi.fn(),
		mockTrackUsage: vi.fn(),
		mockGetAIModelWithMetadata: vi.fn(),
		mockResolveModelWithProvider: vi.fn(),
		mockIsFeatureEnabled: vi.fn(),
		mockListActiveStoriesForDetection: vi.fn(),
		mockListDecidedLinkKeys: vi.fn(),
		mockInsertAutoLinks: vi.fn(),
		mockMarkActionItemsLinked: vi.fn(),
		mockListStoryDuplicateEmbeddingMetadata: vi.fn(),
		mockListStoryDuplicateEmbeddings: vi.fn(),
		mockUpsertStoryDuplicateEmbeddings: vi.fn(),
		mockFindFirstTranscript: vi.fn(),
		mockEvaluate: vi.fn(),
		mockGetDecisionModel: vi.fn(),
		mockDecisionTrackUsage: vi.fn(),
		mockHeartbeat: vi.fn(),
	};
});

vi.mock("@repo/rag", () => ({ generateEmbeddings: mockGenerateEmbeddings }));

vi.mock("@repo/ai", () => ({
	generateObject: mockGenerateObject,
	getAIModelWithMetadata: mockGetAIModelWithMetadata,
	resolveModelWithProvider: mockResolveModelWithProvider,
	experimental_evaluate: mockEvaluate,
	getAIDecisionModelWithMetadata: mockGetDecisionModel,
}));

vi.mock("@repo/payments/lib/ai-usage-limit-error", () => ({
	AiUsageLimitExceededError,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: mockHeartbeat }));

vi.mock("@repo/database", async () => {
	// Keep the real pure helpers (item keys, detection text, cosine) running —
	// they have no DB or AI imports and their behaviour is what we're testing.
	const keys = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/meeting-action-item-keys")
	>("@repo/database/prisma/queries/projects/meeting-action-item-keys");
	const detection = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
	>("@repo/database/prisma/queries/projects/duplicate-detection");
	return {
		...keys,
		...detection,
		linkStateKey: (itemKey: string, storyId: string) =>
			`${itemKey}:${storyId}`,
		isFeatureEnabled: mockIsFeatureEnabled,
		listActiveStoriesForDetection: mockListActiveStoriesForDetection,
		listDecidedLinkKeys: mockListDecidedLinkKeys,
		insertAutoLinks: mockInsertAutoLinks,
		markActionItemsLinked: mockMarkActionItemsLinked,
		listStoryDuplicateEmbeddingMetadata:
			mockListStoryDuplicateEmbeddingMetadata,
		listStoryDuplicateEmbeddings: mockListStoryDuplicateEmbeddings,
		upsertStoryDuplicateEmbeddings: mockUpsertStoryDuplicateEmbeddings,
		db: {
			projectMeetingTranscript: { findFirst: mockFindFirstTranscript },
		},
	};
});

import { computeActionItemKey } from "@repo/database";
import {
	buildMatchPrompt,
	MATCH_RULE_TEXT,
} from "../../../lib/action-item-link-core";
import { linkMeetingActionItemsActivity } from "../link-action-items";

const baseInput = {
	projectId: "proj-1",
	organizationId: "org-1",
	userId: "user-1",
	transcriptCuid: "tr-cuid-1",
};

/** A transcript with the given action item texts. */
function transcript(texts: string[], overrides: Record<string, unknown> = {}) {
	return {
		id: "tr-cuid-1",
		meetingSubject: "Weekly DSU",
		actionItemsLinkVersion: null,
		userId: null,
		organizationId: "org-1",
		linkedMeeting: { subject: "Weekly DSU" },
		actionItems: texts.map((text) => ({ text, tentativeOwnerName: null })),
		...overrides,
	};
}

const STORY = {
	id: "story-1",
	identifier: "F-1",
	title: "Digest download",
	description: "Let members download the transcript",
	acceptanceCriteria: null,
	createdAt: new Date("2026-07-01"),
};

/**
 * Item text and story text embed to the same vector, so the item clears the
 * cosine floor and reaches the verifier.
 */
function arrangeEmbeddings() {
	mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
		embeddings: texts.map(() => [1, 0]),
		model: "text-embedding-3-small",
	}));
}

/** Give the organization a configured typed decision model. */
function enableDecisionModel() {
	mockGetDecisionModel.mockResolvedValue({
		model: {},
		metadata: { modelString: "jev-1" },
		trackUsage: mockDecisionTrackUsage,
	});
}

/**
 * One `experimental_evaluate` result: the probability, per synthetic candidate
 * key, that the action item DOES relate to that candidate.
 */
function decisionAnswers(probabilities: Record<string, number>) {
	return {
		answers: Object.fromEntries(
			Object.entries(probabilities).map(([key, probability]) => [
				key,
				{ type: "boolean", probability },
			]),
		),
	};
}

/**
 * Three candidate stories, all above the cosine floor with strictly decreasing
 * similarity, so `candidate_0`/`_1`/`_2` map to F-1/F-2/F-3 deterministically.
 */
function arrangeThreeCandidates() {
	const stories = [
		{
			...STORY,
			id: "story-1",
			identifier: "F-1",
			title: "Digest download",
		},
		{
			...STORY,
			id: "story-2",
			identifier: "F-2",
			title: "Agenda generation",
		},
		{
			...STORY,
			id: "story-3",
			identifier: "F-3",
			title: "Recording upload",
		},
	];
	mockListActiveStoriesForDetection.mockResolvedValue(stories);

	const vectorByTitle: Record<string, number[]> = {
		"Digest download": [1, 0],
		"Agenda generation": [1, 0.1],
		"Recording upload": [1, 0.2],
	};
	mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
		embeddings: texts.map((text) => {
			const title = Object.keys(vectorByTitle).find((t) =>
				text.includes(t),
			);
			// Anything that is not a story's detection text is the action item.
			return title ? vectorByTitle[title] : [1, 0];
		}),
		model: "text-embedding-3-small",
	}));
	return stories;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockIsFeatureEnabled.mockResolvedValue(true);
	mockFindFirstTranscript.mockResolvedValue(transcript(["Ship the digest"]));
	mockListActiveStoriesForDetection.mockResolvedValue([STORY]);
	mockListDecidedLinkKeys.mockResolvedValue(new Set<string>());
	mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([]);
	mockListStoryDuplicateEmbeddings.mockResolvedValue([]);
	mockUpsertStoryDuplicateEmbeddings.mockResolvedValue(undefined);
	mockInsertAutoLinks.mockImplementation(
		async ({ rows }: { rows: unknown[] }) => rows.length,
	);
	mockMarkActionItemsLinked.mockResolvedValue(undefined);
	mockResolveModelWithProvider.mockResolvedValue({
		modelString: "text-embedding-3-small",
	});
	mockGetAIModelWithMetadata.mockResolvedValue({
		model: {},
		trackUsage: mockTrackUsage,
	});
	// No decision model by DEFAULT, so every test above this file's new
	// describe block exercises the language-verifier-only path unchanged.
	mockGetDecisionModel.mockRejectedValue(
		new Error("no decision model configured"),
	);
	arrangeEmbeddings();
	mockGenerateObject.mockResolvedValue({
		object: {
			verdicts: [
				{
					identifier: "F-1",
					relates: true,
					confidence: 0.9,
					reasoning: "y",
				},
			],
		},
	});
});

describe("feature flag", () => {
	it("does nothing at all when the flag is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.skipped).toBe("flag-off");
		expect(mockFindFirstTranscript).not.toHaveBeenCalled();
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});
});

describe("scope", () => {
	it("looks the transcript up by project, so another project's id is unfindable", async () => {
		await linkMeetingActionItemsActivity(baseInput);

		expect(mockFindFirstTranscript).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "tr-cuid-1", projectId: "proj-1" },
			}),
		);
	});

	it("only ever considers stories from this project (AC10)", async () => {
		await linkMeetingActionItemsActivity(baseInput);

		expect(mockListActiveStoriesForDetection).toHaveBeenCalledWith(
			"proj-1",
		);
	});

	it("throws when the transcript does not belong to the project", async () => {
		mockFindFirstTranscript.mockResolvedValue(null);

		await expect(linkMeetingActionItemsActivity(baseInput)).rejects.toThrow(
			/not found in project/,
		);
	});
});

describe("cache guard", () => {
	it("skips a meeting already matched at the current version", async () => {
		mockFindFirstTranscript.mockResolvedValue(
			transcript(["Ship the digest"], { actionItemsLinkVersion: 1 }),
		);

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.skipped).toBe("fresh");
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("re-matches a fresh meeting when force is set", async () => {
		mockFindFirstTranscript.mockResolvedValue(
			transcript(["Ship the digest"], { actionItemsLinkVersion: 1 }),
		);

		const result = await linkMeetingActionItemsActivity({
			...baseInput,
			force: true,
		});

		expect(result.skipped).toBeNull();
		expect(mockGenerateObject).toHaveBeenCalled();
	});
});

describe("matching", () => {
	it("stores a link for an above-threshold verdict", async () => {
		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result).toMatchObject({
			itemsConsidered: 1,
			linksCreated: 1,
			verifierFailures: 0,
			skipped: null,
		});
		expect(mockInsertAutoLinks).toHaveBeenCalledWith(
			expect.objectContaining({
				transcriptId: "tr-cuid-1",
				projectId: "proj-1",
				rows: [
					expect.objectContaining({
						itemKey: computeActionItemKey("Ship the digest"),
						itemTextSnapshot: "Ship the digest",
						storyId: "story-1",
						confidence: 0.9,
					}),
				],
			}),
		);
	});

	it("stores nothing for a below-threshold verdict", async () => {
		mockGenerateObject.mockResolvedValue({
			object: {
				verdicts: [
					{ identifier: "F-1", relates: true, confidence: 0.4 },
				],
			},
		});

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.linksCreated).toBe(0);
		expect(mockInsertAutoLinks).toHaveBeenCalledWith(
			expect.objectContaining({ rows: [] }),
		);
	});

	it("stores nothing for a confident 'no'", async () => {
		mockGenerateObject.mockResolvedValue({
			object: {
				verdicts: [
					{ identifier: "F-1", relates: false, confidence: 0.99 },
				],
			},
		});

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.linksCreated).toBe(0);
	});

	it("drops a verdict for an identifier the model invented", async () => {
		mockGenerateObject.mockResolvedValue({
			object: {
				verdicts: [
					{ identifier: "F-999", relates: true, confidence: 0.95 },
				],
			},
		});

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.linksCreated).toBe(0);
	});

	it("never re-suggests a pair the user already decided", async () => {
		const itemKey = computeActionItemKey("Ship the digest");
		mockListDecidedLinkKeys.mockResolvedValue(
			new Set([`${itemKey}:story-1`]),
		);

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.linksCreated).toBe(0);
		// The verifier is never even asked — a rejected pair costs nothing.
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});
});

describe("resilience", () => {
	it("counts one item's verifier failure and still links the others", async () => {
		mockFindFirstTranscript.mockResolvedValue(
			transcript(["Ship the digest", "Fix the agenda"]),
		);
		mockGenerateObject
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce({
				object: {
					verdicts: [
						{ identifier: "F-1", relates: true, confidence: 0.9 },
					],
				},
			});

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.verifierFailures).toBe(1);
		expect(result.linksCreated).toBe(1);
	});

	it("does not fail the run when the shared embedding cache write fails", async () => {
		mockUpsertStoryDuplicateEmbeddings.mockRejectedValue(
			new Error("cache down"),
		);

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.linksCreated).toBe(1);
	});

	it("propagates a missing embedding model so the activity retries", async () => {
		mockResolveModelWithProvider.mockRejectedValue(
			new Error("no embedding model configured"),
		);

		await expect(linkMeetingActionItemsActivity(baseInput)).rejects.toThrow(
			/no embedding model/,
		);
	});
});

describe("empty cases", () => {
	it("stamps and returns when the meeting has no action items", async () => {
		mockFindFirstTranscript.mockResolvedValue(transcript([]));

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.skipped).toBe("no-items");
		expect(mockMarkActionItemsLinked).toHaveBeenCalled();
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
	});

	it("stamps and returns when the project has no active work items", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([]);

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.skipped).toBe("no-stories");
		expect(mockMarkActionItemsLinked).toHaveBeenCalled();
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});
});

describe("embedding cache reuse", () => {
	it("reuses a cached story vector instead of re-embedding it", async () => {
		const { buildDetectionText, hashDetectionText } = await import(
			"@repo/database"
		);
		const contentHash = hashDetectionText(
			buildDetectionText(STORY.title, STORY.description, null),
		);
		mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([
			{
				storyId: "story-1",
				contentHash,
				model: "text-embedding-3-small",
			},
		]);
		mockListStoryDuplicateEmbeddings.mockResolvedValue([
			{ storyId: "story-1", embedding: [1, 0] },
		]);

		await linkMeetingActionItemsActivity(baseInput);

		// Only the action item text is embedded — the story vector came from cache.
		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
		expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
			["Ship the digest"],
			expect.anything(),
		);
	});
});

describe("wholesale verifier failure", () => {
	it("throws and does NOT stamp when every verifier call fails", async () => {
		mockFindFirstTranscript.mockResolvedValue(
			transcript(["Ship the digest", "Fix the agenda"]),
		);
		mockGenerateObject.mockRejectedValue(new Error("provider down"));

		await expect(linkMeetingActionItemsActivity(baseInput)).rejects.toThrow(
			/verifier failed for all 2 action item\(s\)/,
		);

		// The stamp is the whole point: a meeting is matched ONCE, so stamping a
		// failed run would mark it done forever — zero links, never retried, no
		// signal. Temporal must be allowed to retry instead.
		expect(mockMarkActionItemsLinked).not.toHaveBeenCalled();
	});

	it("still stamps on PARTIAL failure, so the run is not re-paid for", async () => {
		mockFindFirstTranscript.mockResolvedValue(
			transcript(["Ship the digest", "Fix the agenda"]),
		);
		mockGenerateObject
			.mockRejectedValueOnce(new Error("one flaky call"))
			.mockResolvedValueOnce({
				object: {
					verdicts: [
						{ identifier: "F-1", relates: true, confidence: 0.9 },
					],
				},
			});

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.verifierFailures).toBe(1);
		expect(result.linksCreated).toBe(1);
		expect(mockMarkActionItemsLinked).toHaveBeenCalled();
	});

	it("does not mistake 'no candidates' for a verifier outage", async () => {
		// Items whose candidates are all below the cosine floor never reach the
		// LLM. Counting them as failures would throw on a perfectly healthy run
		// whose backlog simply had nothing similar — and then retry it forever.
		mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
			embeddings: texts.map((t) =>
				t === "Ship the digest" ? [0, 1] : [1, 0],
			),
			model: "text-embedding-3-small",
		}));

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.verifierFailures).toBe(0);
		expect(result.linksCreated).toBe(0);
		expect(mockMarkActionItemsLinked).toHaveBeenCalled();
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});
});

/**
 * The typed decision fast path.
 *
 * Branches covered, one test each unless noted:
 *  - resolver succeeds .......................... every test below
 *  - resolver throws a usage limit .............. "rethrows a usage limit raised while resolving"
 *  - resolver throws anything else .............. "keeps the language path byte-identical"
 *  - no candidates, decision model configured ... "fails the run for retry when every decided item…"
 *  - question/state shape ....................... "asks one boolean question per candidate…"
 *  - confident yes → link ....................... "links a candidate it is confident about…"
 *  - probability exactly at the accept floor .... "accepts a probability of exactly the confidence floor"
 *  - confident no → dropped ..................... "stores nothing for a confident 'no'…"
 *  - probability exactly at the reject floor .... "rejects a probability of exactly the rejection floor"
 *  - uncertain → language verifier .............. "sends an uncertain candidate to the language verifier"
 *  - confident yes below minConfidence .......... "keeps the operator's minimum confidence authoritative"
 *  - malformed answer → uncertain ............... "treats %s as uncertain…" (5 shapes)
 *  - mixed yes/uncertain/no in one item ......... "verifies only the candidates it could not settle"
 *  - generic evaluate error ..................... "falls back to the language verifier with every candidate"
 *  - usage-limit evaluate error ................. "counts a decision usage limit as a verifier failure"
 *                                                 + "fails the run for retry when every decided item…"
 *  - one attempt counted per candidate-bearing
 *    item, whichever model settles it ........... "does not discard a fast-path link when another item…"
 *  - trackUsage after a completed evaluation .... "links a candidate it is confident about…"
 *  - extra beat before the decision call ........ "links a candidate it is confident about…"
 *  - extra beat before a fall-through language
 *    call ....................................... "beats between the decision call and the language call"
 */
describe("typed decision fast path", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		// `vi.clearAllMocks()` clears calls but keeps implementations, and the
		// ordering test installs one on the heartbeat mock that nothing else
		// overwrites.
		mockHeartbeat.mockReset();
	});

	it("links a candidate it is confident about, without calling the language verifier", async () => {
		enableDecisionModel();
		mockEvaluate.mockResolvedValue(decisionAnswers({ candidate_0: 0.97 }));

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result).toMatchObject({
			itemsConsidered: 1,
			linksCreated: 1,
			// The language verifier was never attempted, so the wholesale
			// "every verifier call failed" guard must not fire.
			verifierFailures: 0,
			skipped: null,
		});
		expect(mockInsertAutoLinks).toHaveBeenCalledWith(
			expect.objectContaining({
				rows: [
					expect.objectContaining({
						itemKey: computeActionItemKey("Ship the digest"),
						storyId: "story-1",
						confidence: 0.97,
						// A probability is not written evidence.
						reasoning: null,
					}),
				],
			}),
		);
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockDecisionTrackUsage).toHaveBeenCalledTimes(1);
		expect(mockMarkActionItemsLinked).toHaveBeenCalled();
		// Two model calls per item are now possible against a 2-minute
		// heartbeatTimeout, so the item gets its own beat.
		expect(mockHeartbeat).toHaveBeenCalledWith(
			"linkActionItems: deciding 1/1",
		);
	});

	it("asks one boolean question per candidate over the shared match rule", async () => {
		enableDecisionModel();
		arrangeThreeCandidates();
		mockEvaluate.mockResolvedValue(
			decisionAnswers({
				candidate_0: 0.5,
				candidate_1: 0.5,
				candidate_2: 0.5,
			}),
		);

		await linkMeetingActionItemsActivity(baseInput);

		expect(mockEvaluate).toHaveBeenCalledTimes(1);
		const call = mockEvaluate.mock.calls[0][0];
		expect(Object.keys(call.questions)).toEqual([
			"candidate_0",
			"candidate_1",
			"candidate_2",
		]);
		for (const question of Object.values(call.questions)) {
			expect((question as { type: string }).type).toBe("boolean");
		}
		// The decision model judges by the SAME rule the language verifier is
		// given, so the two paths cannot disagree on what "relates" means.
		expect(call.state.policy).toBe(MATCH_RULE_TEXT);
		// Synthetic keys, with the identifiers carried in state instead.
		expect(
			call.state.candidates.map(
				(c: { key: string; identifier: string }) => [
					c.key,
					c.identifier,
				],
			),
		).toEqual([
			["candidate_0", "F-1"],
			["candidate_1", "F-2"],
			["candidate_2", "F-3"],
		]);
		expect(call.maxRetries).toBe(1);
		expect(call.abortSignal).toBeInstanceOf(AbortSignal);
	});

	it("stores nothing for a confident 'no' and never calls the language verifier", async () => {
		enableDecisionModel();
		mockEvaluate.mockResolvedValue(decisionAnswers({ candidate_0: 0.02 }));

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result).toMatchObject({ linksCreated: 0, verifierFailures: 0 });
		expect(mockInsertAutoLinks).toHaveBeenCalledWith(
			expect.objectContaining({ rows: [] }),
		);
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockMarkActionItemsLinked).toHaveBeenCalled();
	});

	it("sends an uncertain candidate to the language verifier", async () => {
		enableDecisionModel();
		mockEvaluate.mockResolvedValue(decisionAnswers({ candidate_0: 0.5 }));

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		expect(mockGenerateObject.mock.calls[0][0].prompt).toContain("F-1");
		expect(result.linksCreated).toBe(1);
	});

	it("keeps the operator's minimum confidence authoritative over the decision floor", async () => {
		// 0.92 clears the 0.9 routing floor but not the operator's 0.95, so it
		// is uncertain — never a link the operator asked not to be made.
		vi.stubEnv("MEETING_ACTION_ITEM_LINK_MIN_CONFIDENCE", "0.95");
		enableDecisionModel();
		mockEvaluate.mockResolvedValue(decisionAnswers({ candidate_0: 0.92 }));

		await linkMeetingActionItemsActivity(baseInput);

		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		expect(mockGenerateObject.mock.calls[0][0].prompt).toContain("F-1");
	});

	it.each([
		["a missing answer", { answers: {} }],
		[
			"a NaN probability",
			{
				answers: {
					candidate_0: { type: "boolean", probability: Number.NaN },
				},
			},
		],
		[
			"an out-of-range probability",
			{ answers: { candidate_0: { type: "boolean", probability: 1.4 } } },
		],
		[
			"an answer of the wrong type",
			{
				answers: {
					candidate_0: {
						type: "choice",
						choice: "yes",
						probabilities: { yes: 0.99 },
					},
				},
			},
		],
		["a non-object answer", { answers: { candidate_0: "yes" } }],
	])(
		"treats %s as uncertain and uses the language verifier",
		async (_label, evaluation) => {
			enableDecisionModel();
			mockEvaluate.mockResolvedValue(evaluation);

			const result = await linkMeetingActionItemsActivity(baseInput);

			expect(mockGenerateObject).toHaveBeenCalledTimes(1);
			expect(mockGenerateObject.mock.calls[0][0].prompt).toContain("F-1");
			expect(result.linksCreated).toBe(1);
		},
	);

	it("verifies only the candidates it could not settle", async () => {
		enableDecisionModel();
		arrangeThreeCandidates();
		mockEvaluate.mockResolvedValue(
			decisionAnswers({
				candidate_0: 0.95, // yes
				candidate_1: 0.4, // uncertain
				candidate_2: 0.02, // no
			}),
		);
		mockGenerateObject.mockResolvedValue({
			object: {
				verdicts: [
					{ identifier: "F-2", relates: true, confidence: 0.88 },
				],
			},
		});

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		const prompt = mockGenerateObject.mock.calls[0][0].prompt;
		expect(prompt).toContain("F-2");
		expect(prompt).not.toContain("F-1");
		expect(prompt).not.toContain("F-3");
		expect(result.linksCreated).toBe(2);
		expect(mockInsertAutoLinks).toHaveBeenCalledWith(
			expect.objectContaining({
				rows: [
					expect.objectContaining({
						storyId: "story-1",
						confidence: 0.95,
						reasoning: null,
					}),
					expect.objectContaining({
						storyId: "story-2",
						confidence: 0.88,
					}),
				],
			}),
		);
	});

	it("falls back to the language verifier with every candidate when the evaluation errors", async () => {
		enableDecisionModel();
		arrangeThreeCandidates();
		mockEvaluate.mockRejectedValue(new Error("decision provider down"));

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		const prompt = mockGenerateObject.mock.calls[0][0].prompt;
		expect(prompt).toContain("F-1");
		expect(prompt).toContain("F-2");
		expect(prompt).toContain("F-3");
		// A decision failure the language verifier recovered from is NOT a
		// verifier failure.
		expect(result.verifierFailures).toBe(0);
		expect(result.linksCreated).toBe(1);
		expect(mockDecisionTrackUsage).not.toHaveBeenCalled();
	});

	it("counts a decision usage limit as a verifier failure and skips that item", async () => {
		enableDecisionModel();
		mockFindFirstTranscript.mockResolvedValue(
			transcript(["Ship the digest", "Fix the agenda"]),
		);
		mockEvaluate
			.mockRejectedValueOnce(new AiUsageLimitExceededError())
			.mockResolvedValueOnce(decisionAnswers({ candidate_0: 0.5 }));

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.verifierFailures).toBe(1);
		// Retrying the limited item through the language verifier would bill
		// the very spend the limit refused, so only the second item is
		// verified.
		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		const prompt = mockGenerateObject.mock.calls[0][0].prompt;
		expect(prompt).toContain("Fix the agenda");
		expect(prompt).not.toContain("Ship the digest");
		expect(result.linksCreated).toBe(1);
		// Partial failure still stamps, so the run is not re-paid for.
		expect(mockMarkActionItemsLinked).toHaveBeenCalled();
	});

	it("fails the run for retry when every decided item hits the usage limit", async () => {
		enableDecisionModel();
		mockFindFirstTranscript.mockResolvedValue(
			transcript(["Ship the digest", "Fix the agenda"]),
		);
		// The second item has no candidate above the cosine floor, so it never
		// reaches either model and must not dilute the failure ratio.
		mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
			embeddings: texts.map((t) =>
				t === "Fix the agenda" ? [0, 1] : [1, 0],
			),
			model: "text-embedding-3-small",
		}));
		mockEvaluate.mockRejectedValue(new AiUsageLimitExceededError());

		await expect(linkMeetingActionItemsActivity(baseInput)).rejects.toThrow(
			/verifier failed for all 1 action item\(s\)/,
		);

		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockMarkActionItemsLinked).not.toHaveBeenCalled();
	});

	it("rethrows a usage limit raised while resolving the decision model", async () => {
		mockGetDecisionModel.mockRejectedValue(new AiUsageLimitExceededError());

		await expect(linkMeetingActionItemsActivity(baseInput)).rejects.toThrow(
			/AI usage limit exceeded/,
		);

		expect(mockEvaluate).not.toHaveBeenCalled();
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockMarkActionItemsLinked).not.toHaveBeenCalled();
	});

	it("accepts a probability of exactly the confidence floor", async () => {
		enableDecisionModel();
		mockEvaluate.mockResolvedValue(decisionAnswers({ candidate_0: 0.9 }));

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.linksCreated).toBe(1);
		expect(mockInsertAutoLinks).toHaveBeenCalledWith(
			expect.objectContaining({
				rows: [expect.objectContaining({ confidence: 0.9 })],
			}),
		);
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("rejects a probability of exactly the rejection floor", async () => {
		// Regression: the rejection floor is the literal 0.1, not
		// `1 - DECISION_CONFIDENCE_THRESHOLD`, which is 0.09999999999999998 —
		// so an answer of exactly 0.1 would escape into a needless language
		// call.
		enableDecisionModel();
		mockEvaluate.mockResolvedValue(decisionAnswers({ candidate_0: 0.1 }));

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.linksCreated).toBe(0);
		expect(mockInsertAutoLinks).toHaveBeenCalledWith(
			expect.objectContaining({ rows: [] }),
		);
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("does not discard a fast-path link when another item hits the usage limit", async () => {
		// Both items count as attempts, so one usage-limit failure out of two
		// is partial: the wholesale guard must not fire and throw away the link
		// the decision model had already settled.
		enableDecisionModel();
		mockFindFirstTranscript.mockResolvedValue(
			transcript(["Ship the digest", "Fix the agenda"]),
		);
		mockEvaluate
			.mockResolvedValueOnce(decisionAnswers({ candidate_0: 0.97 }))
			.mockRejectedValueOnce(new AiUsageLimitExceededError());

		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(result.verifierFailures).toBe(1);
		expect(result.linksCreated).toBe(1);
		expect(mockInsertAutoLinks).toHaveBeenCalledWith(
			expect.objectContaining({
				rows: [
					expect.objectContaining({
						itemKey: computeActionItemKey("Ship the digest"),
						storyId: "story-1",
						confidence: 0.97,
					}),
				],
			}),
		);
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockMarkActionItemsLinked).toHaveBeenCalled();
	});

	it("beats between the decision call and the language call", async () => {
		// The decision call can burn its 30s timeout plus a retry before the
		// unbounded language call even starts, against a 2-minute
		// heartbeatTimeout.
		enableDecisionModel();
		const order: string[] = [];
		mockEvaluate.mockImplementation(async () => {
			order.push("evaluate");
			return decisionAnswers({ candidate_0: 0.5 });
		});
		mockHeartbeat.mockImplementation((message: string) => {
			order.push(`heartbeat:${message}`);
		});
		mockGenerateObject.mockImplementation(async () => {
			order.push("generateObject");
			return {
				object: {
					verdicts: [
						{ identifier: "F-1", relates: true, confidence: 0.9 },
					],
				},
			};
		});

		await linkMeetingActionItemsActivity(baseInput);

		const evaluateAt = order.indexOf("evaluate");
		const generateAt = order.indexOf("generateObject");
		// The loop-top cadence beat carries the same message, so take the LAST
		// one: the beat added for the fall-through.
		const beatAt = order.lastIndexOf(
			"heartbeat:linkActionItems: verifying 1/1",
		);
		expect(evaluateAt).toBeGreaterThanOrEqual(0);
		expect(generateAt).toBeGreaterThanOrEqual(0);
		expect(beatAt).toBeGreaterThan(evaluateAt);
		expect(beatAt).toBeLessThan(generateAt);
	});

	it("keeps the language path byte-identical when no decision model is configured", async () => {
		// The shared beforeEach already rejects the resolver with a generic
		// error; this asserts what that means for the verifier prompt.
		const result = await linkMeetingActionItemsActivity(baseInput);

		expect(mockEvaluate).not.toHaveBeenCalled();
		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		expect(mockGenerateObject.mock.calls[0][0].prompt).toBe(
			buildMatchPrompt(
				{ text: "Ship the digest", tentativeOwnerName: null },
				"Weekly DSU",
				[
					{
						identifier: "F-1",
						title: STORY.title,
						description: STORY.description,
					},
				],
			),
		);
		expect(result).toMatchObject({ linksCreated: 1, verifierFailures: 0 });
	});
});
