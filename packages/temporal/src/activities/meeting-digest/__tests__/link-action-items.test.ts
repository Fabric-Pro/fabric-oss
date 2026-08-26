import { beforeEach, describe, expect, it, vi } from "vitest";

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
} = vi.hoisted(() => ({
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
}));

vi.mock("@repo/rag", () => ({ generateEmbeddings: mockGenerateEmbeddings }));

vi.mock("@repo/ai", () => ({
	generateObject: mockGenerateObject,
	getAIModelWithMetadata: mockGetAIModelWithMetadata,
	resolveModelWithProvider: mockResolveModelWithProvider,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

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
