import { UnsupportedEmbeddingModelError } from "@repo/ai/lib/embedding-dimensions";
/**
 * Tests for `detectAndFlagDuplicateStories` — the automatic, one-vs-rest
 * duplicate check shared by the AI backlog-update activity and the channel
 * proposal-approve procedures; a thin wrapper around the shared
 * `runDuplicateScanCore` (targets mode, COMPLEX tier, retry contract).
 *
 * Strategy: mock the embedding provider (`@repo/rag`), the LLM verifier
 * (`@repo/ai`), the logger, and the DB query helpers (`@repo/database`), but
 * run the REAL shared core + pure detection lib (spread back in via
 * `vi.importActual`). Asserts:
 *   - retry contract (THROWS on transient embedding/DB failure so the Temporal
 *     activity retries; a MINORITY of flaky verifier verdicts is skipped, not
 *     fatal, but a WHOLESALE verifier outage — every pair failing — throws so
 *     the activity retries instead of silently flagging nothing),
 *   - one-vs-rest scoping (existing↔existing pairs not flagged),
 *   - 3-way verdict routing (duplicate link / overlap link / cached negative
 *     verdict) and verdict-valid pair exclusion,
 *   - embedding-cache reuse with PER-ITEM persistence (only a failed pair's
 *     items stay stale),
 *   - dismissed pairs stay dismissed,
 *   - FEATURE↔FEATURE pairs are scored and verified mainly on their Scope
 *     (or acceptance-criteria) sections; any pair with a BUG is unchanged.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test src/lib/__tests__/detect-duplicate-stories.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Declared via vi.hoisted so the (also-hoisted) vi.mock factories below can
// reference them without hitting the temporal-dead-zone.
const {
	mockGenerateEmbeddings,
	mockGenerateObject,
	mockTrackUsage,
	mockGetAIModelWithMetadata,
	mockResolveModelWithProvider,
	mockListActiveStoriesForDetection,
	mockListDismissedDuplicatePairKeys,
	mockListVerdictValidPairKeys,
	mockListStoryDuplicateEmbeddingMetadata,
	mockListStoryDuplicateEmbeddings,
	mockUpsertStoryDuplicateEmbeddings,
	mockUpsertPendingDuplicateLink,
	mockRecordDistinctVerdict,
	mockLoggerInfo,
} = vi.hoisted(() => ({
	mockGenerateEmbeddings: vi.fn(),
	mockGenerateObject: vi.fn(),
	mockTrackUsage: vi.fn(),
	mockGetAIModelWithMetadata: vi.fn(),
	mockResolveModelWithProvider: vi.fn(),
	mockListActiveStoriesForDetection: vi.fn(),
	mockListDismissedDuplicatePairKeys: vi.fn(),
	mockListVerdictValidPairKeys: vi.fn(),
	mockListStoryDuplicateEmbeddingMetadata: vi.fn(),
	mockListStoryDuplicateEmbeddings: vi.fn(),
	mockUpsertStoryDuplicateEmbeddings: vi.fn(),
	mockUpsertPendingDuplicateLink: vi.fn(),
	mockRecordDistinctVerdict: vi.fn(),
	mockLoggerInfo: vi.fn(),
}));

vi.mock("@repo/rag", () => ({
	generateEmbeddings: mockGenerateEmbeddings,
}));

vi.mock("@repo/ai", () => ({
	// A real class, not a stub: the scan rethrows it by `instanceof` so a
	// configuration refusal keeps its own type instead of being rewrapped as a
	// transient embedding failure, and `instanceof` against a `vi.fn()` is
	// always false.
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "AIProviderNotConfiguredError";
		}
	},
	generateObject: mockGenerateObject,
	getAIModelWithMetadata: mockGetAIModelWithMetadata,
	resolveModelWithProvider: mockResolveModelWithProvider,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", async () => {
	// Keep the REAL pure detection lib running (no DB/AI imports in it).
	const pure = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
	>("@repo/database/prisma/queries/projects/duplicate-detection");
	// The feature-pair focus selection is pure too, and is under test here.
	const focus = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/duplicate-focus")
	>("@repo/database/prisma/queries/projects/duplicate-focus");
	return {
		...pure,
		...focus,
		// The real predicate — the scan's provider guard is one of the things
		// these tests exercise, and a stub would decide it instead of the rule.
		// Kept in step with `@repo/database` by its own tests
		// (`ai-gateway-legacy-config-key`, `ai-gateway-service-principal`).
		hasProviderCredentials: (row: {
			apiKey?: string | null;
			clientId?: string | null;
			encryptedClientSecret?: string | null;
		}) =>
			Boolean(row.apiKey || (row.clientId && row.encryptedClientSecret)),
		listActiveStoriesForDetection: mockListActiveStoriesForDetection,
		listDismissedDuplicatePairKeys: mockListDismissedDuplicatePairKeys,
		listVerdictValidPairKeys: mockListVerdictValidPairKeys,
		listStoryDuplicateEmbeddingMetadata:
			mockListStoryDuplicateEmbeddingMetadata,
		listStoryDuplicateEmbeddings: mockListStoryDuplicateEmbeddings,
		upsertStoryDuplicateEmbeddings: mockUpsertStoryDuplicateEmbeddings,
		upsertPendingDuplicateLink: mockUpsertPendingDuplicateLink,
		recordDistinctVerdict: mockRecordDistinctVerdict,
	};
});

import { detectAndFlagDuplicateStories } from "../detect-duplicate-stories";

type Story = {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
};

/** Wire the mocks so `stories` embed to `embeddingFor(story.id)`. */
function arrange(
	stories: Story[],
	embeddingFor: (id: string) => number[],
	verdict: { sameWorkItem: boolean; confidence: number } = {
		sameWorkItem: true,
		confidence: 0.95,
	},
) {
	mockListActiveStoriesForDetection.mockResolvedValue(stories);
	// generateEmbeddings is called with the text array, in story order — return
	// vectors aligned to that same order.
	mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => {
		// Map each text back to its story by title prefix to stay order-robust.
		const embeddings = texts.map((text) => {
			const story = stories.find((s) => text.startsWith(s.title));
			return embeddingFor(story?.id ?? "");
		});
		return { embeddings, model: "text-embedding-3-small" };
	});
	mockGenerateObject.mockResolvedValue({
		object: { ...verdict, reasoning: "test" },
	});
}

const baseParams = {
	projectId: "proj-1",
	userId: "user-1",
	organizationId: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockListDismissedDuplicatePairKeys.mockResolvedValue([]);
	mockListVerdictValidPairKeys.mockResolvedValue([]);
	// Empty embedding cache by default: every item is stale, so the legacy
	// expectations (embed everything, compare every pair) keep holding.
	mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([]);
	mockListStoryDuplicateEmbeddings.mockResolvedValue([]);
	mockUpsertStoryDuplicateEmbeddings.mockResolvedValue(undefined);
	mockUpsertPendingDuplicateLink.mockResolvedValue({});
	mockRecordDistinctVerdict.mockResolvedValue(undefined);
	// A CONFIGURED tenant, which is what every test below assumes. The apiKey
	// matters: the scan now refuses up front when the resolver comes back
	// without credentials, because `resolveModelWithProvider` returns
	// `{ apiKey: null, _error }` for a keyless tenant rather than throwing.
	mockResolveModelWithProvider.mockResolvedValue({
		modelString: "openai/text-embedding-3-small",
		apiKey: "encrypted:sk-test",
		source: "organization",
	});
	mockGetAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: mockTrackUsage,
	});
});

describe("detectAndFlagDuplicateStories", () => {
	it("returns early without any AI/DB work when there are no targets", async () => {
		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: [],
		});
		expect(result).toEqual({
			scanned: 0,
			candidates: 0,
			confirmed: 0,
			truncated: 0,
		});
		expect(mockListActiveStoriesForDetection).not.toHaveBeenCalled();
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
	});

	it("flags a new story that duplicates an existing one (2-stage gate)", async () => {
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Add SSO login",
				description: null,
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Add SSO login",
				description: null,
			},
		];
		arrange(stories, (id) =>
			id === "existing" ? [1, 1, 0] : [1, 1, 0.02],
		);

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.scanned).toBe(2);
		expect(result.candidates).toBe(1);
		expect(result.confirmed).toBe(1);
		expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledTimes(1);
		const arg = mockUpsertPendingDuplicateLink.mock.calls[0][0] as {
			storyAId: string;
			storyBId: string;
			confidence: number;
		};
		expect(new Set([arg.storyAId, arg.storyBId])).toEqual(
			new Set(["existing", "new"]),
		);
		expect(arg.confidence).toBe(0.95);
	});

	it("does NOT flag when the LLM verdict is 'not the same work item'", async () => {
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Login",
				description: null,
			},
			{ id: "new", identifier: "F-2", title: "Login", description: null },
		];
		arrange(
			stories,
			(id) => (id === "existing" ? [1, 1, 0] : [1, 1, 0.02]),
			{
				sameWorkItem: false,
				confidence: 0.9,
			},
		);

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.candidates).toBe(1);
		expect(result.confirmed).toBe(0);
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
	});

	it("does NOT flag when LLM confidence is below threshold", async () => {
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Login",
				description: null,
			},
			{ id: "new", identifier: "F-2", title: "Login", description: null },
		];
		arrange(
			stories,
			(id) => (id === "existing" ? [1, 1, 0] : [1, 1, 0.02]),
			{
				sameWorkItem: true,
				confidence: 0.4,
			},
		);

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.confirmed).toBe(0);
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
	});

	it("ignores duplicate pairs that lie entirely between non-targets (one-vs-rest)", async () => {
		// e1/e2 are an existing duplicate; the only target `n` is unrelated.
		const stories: Story[] = [
			{
				id: "e1",
				identifier: "F-1",
				title: "Login bug",
				description: null,
			},
			{
				id: "e2",
				identifier: "F-2",
				title: "Login bug",
				description: null,
			},
			{
				id: "n",
				identifier: "F-3",
				title: "Dark mode toggle",
				description: null,
			},
		];
		arrange(stories, (id) => {
			if (id === "n") {
				return [0, 0, 1];
			}
			return id === "e1" ? [1, 1, 0] : [1, 1, 0.01];
		});

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["n"],
		});

		expect(result.candidates).toBe(0);
		expect(result.confirmed).toBe(0);
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
	});

	it("respects dismissed pairs (never re-flags a dismissed duplicate)", async () => {
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Login",
				description: null,
			},
			{ id: "new", identifier: "F-2", title: "Login", description: null },
		];
		arrange(stories, (id) =>
			id === "existing" ? [1, 1, 0] : [1, 1, 0.02],
		);
		// Canonical pair key "existing:new" (existing < new lexicographically).
		mockListDismissedDuplicatePairKeys.mockResolvedValue(["existing:new"]);

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.candidates).toBe(0);
		expect(result.confirmed).toBe(0);
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
	});

	it("THROWS on an embedding failure so the Temporal activity retries", async () => {
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Login",
				description: null,
			},
			{ id: "new", identifier: "F-2", title: "Login", description: null },
		];
		mockListActiveStoriesForDetection.mockResolvedValue(stories);
		mockGenerateEmbeddings.mockRejectedValue(new Error("embedding 500"));

		await expect(
			detectAndFlagDuplicateStories({
				...baseParams,
				targetStoryIds: ["new"],
			}),
		).rejects.toThrow("embedding 500");
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
	});

	it("THROWS on a DB-query failure so the Temporal activity retries", async () => {
		mockListActiveStoriesForDetection.mockRejectedValue(
			new Error("db down"),
		);

		await expect(
			detectAndFlagDuplicateStories({
				...baseParams,
				targetStoryIds: ["new"],
			}),
		).rejects.toThrow("db down");
	});

	it("skips a flaky verifier verdict among others without aborting the run (minority failure not fatal)", async () => {
		// The new target duplicates TWO existing stories → two candidate pairs.
		// One pair's verifier throws (must be skipped); the other still confirms.
		// The run RESOLVES with the surviving flag — one bad pair can't abort it.
		const stories: Story[] = [
			{
				id: "e1",
				identifier: "F-1",
				title: "Add SSO login",
				description: null,
			},
			{
				id: "e2",
				identifier: "F-2",
				title: "SSO sign-in support",
				description: null,
			},
			{
				id: "new",
				identifier: "F-3",
				title: "Single sign-on (SSO)",
				description: null,
			},
		];
		arrange(stories, (id) => {
			if (id === "e1") {
				return [1, 1, 0];
			}
			return id === "e2" ? [1, 1, 0.01] : [1, 1, 0.02];
		});
		// First candidate pair's verifier throws; the second returns a confident
		// duplicate verdict.
		let call = 0;
		mockGenerateObject.mockImplementation(async () => {
			call += 1;
			if (call === 1) {
				throw new Error("verifier 429");
			}
			return {
				object: {
					sameWorkItem: true,
					confidence: 0.95,
					reasoning: "dup",
				},
			};
		});

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.candidates).toBe(2);
		expect(result.confirmed).toBe(1);
		expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledTimes(1);
	});

	it("THROWS when EVERY candidate pair fails verification (wholesale outage) so the activity retries", async () => {
		// A total verifier outage must NOT be reported as a misleading "0
		// duplicates" success — it must fail the activity so Temporal retries.
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Add SSO login",
				description: null,
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Add SSO login",
				description: null,
			},
		];
		arrange(stories, (id) =>
			id === "existing" ? [1, 1, 0] : [1, 1, 0.02],
		);
		mockGenerateObject.mockRejectedValue(
			new Error("No object generated: response did not match schema."),
		);

		await expect(
			detectAndFlagDuplicateStories({
				...baseParams,
				targetStoryIds: ["new"],
			}),
		).rejects.toThrow(/verifier failed for all/);
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
	});

	it("returns early (no embeddings) when fewer than 2 stories carry text", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([
			{
				id: "new",
				identifier: "F-1",
				title: "Only one",
				description: null,
			},
		]);

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.scanned).toBe(1);
		expect(result.candidates).toBe(0);
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
	});

	it("flags an overlapping-scope verdict as an OVERLAP link with the pair's content hashes", async () => {
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-573",
				title: "AI-Assisted Priority Management Page for Roadmap",
				description: null,
			},
			{
				id: "new",
				identifier: "F-595",
				title: "AI-driven priority scoring and ranking",
				description: null,
			},
		];
		arrange(stories, (id) =>
			id === "existing"
				? [1, 0, 0]
				: [0.78, Math.sqrt(1 - 0.78 * 0.78), 0],
		);
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "overlapping_scope",
				confidence: 0.85,
				reasoning: "same capability, different framing",
			},
		});

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.confirmed).toBe(1);
		expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledWith(
			expect.objectContaining({
				linkType: "OVERLAP",
				contentHashA: expect.stringMatching(/^[0-9a-f]{64}$/),
				contentHashB: expect.stringMatching(/^[0-9a-f]{64}$/),
			}),
		);
	});

	it("records a distinct verdict (with hashes) instead of flagging, so the pair is never re-paid", async () => {
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Login",
				description: null,
			},
			{ id: "new", identifier: "F-2", title: "Login", description: null },
		];
		arrange(stories, (id) =>
			id === "existing" ? [1, 1, 0] : [1, 1, 0.02],
		);
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "distinct",
				confidence: 0.9,
				reasoning: "different work",
			},
		});

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.confirmed).toBe(0);
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
		expect(mockRecordDistinctVerdict).toHaveBeenCalledWith(
			expect.objectContaining({
				storyAId: "existing",
				storyBId: "new",
				contentHashA: expect.stringMatching(/^[0-9a-f]{64}$/),
				contentHashB: expect.stringMatching(/^[0-9a-f]{64}$/),
			}),
		);
	});

	it("skips a pair whose stored verdict is still valid at the current hashes (no LLM call)", async () => {
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Login",
				description: null,
			},
			{ id: "new", identifier: "F-2", title: "Login", description: null },
		];
		arrange(stories, (id) =>
			id === "existing" ? [1, 1, 0] : [1, 1, 0.02],
		);
		mockListVerdictValidPairKeys.mockResolvedValue(["existing:new"]);

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.candidates).toBe(0);
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("reuses cached embeddings — only stale items are embedded, and fresh vectors are persisted after verification", async () => {
		const { buildDetectionText, hashDetectionText } = await vi.importActual<
			typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
		>("@repo/database/prisma/queries/projects/duplicate-detection");
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Add SSO login",
				description: null,
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Add SSO login support",
				description: null,
			},
		];
		arrange(stories, () => [1, 1, 0.02]);
		// The existing story's cache row is current (hash + model match), so
		// only the NEW story's text must be embedded.
		mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([
			{
				storyId: "existing",
				contentHash: hashDetectionText(
					buildDetectionText("Add SSO login", null),
				),
				model: "text-embedding-3-small",
			},
		]);
		mockListStoryDuplicateEmbeddings.mockResolvedValue([
			{ storyId: "existing", embedding: [1, 1, 0] },
		]);

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
		expect(mockGenerateEmbeddings.mock.calls[0][0]).toEqual([
			buildDetectionText("Add SSO login support", null),
		]);
		expect(result.candidates).toBe(1);
		expect(result.confirmed).toBe(1);
		// Only the newly-embedded item's row is persisted, after verification.
		expect(mockUpsertStoryDuplicateEmbeddings).toHaveBeenCalledWith(
			"proj-1",
			[
				expect.objectContaining({
					storyId: "new",
					model: "text-embedding-3-small",
				}),
			],
		);
	});

	it("keeps only the FAILED pair's items stale — everything else is stamped (per-item cache persist)", async () => {
		// Embeddings chosen so the pair similarity ordering is deterministic:
		// (existing, new) ≈ 1.0 is verified first and FAILS; the two cross
		// pairs to n2 (~0.96) succeed. existing/new must stay stale so their
		// pair is re-selected next run; n2's work is complete and is stamped.
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Login",
				description: null,
			},
			{ id: "new", identifier: "F-2", title: "Login", description: null },
			{ id: "n2", identifier: "F-3", title: "Login!", description: null },
		];
		arrange(stories, (id) =>
			id === "existing"
				? [1, 1, 0]
				: id === "new"
					? [1, 1, 0.001]
					: [1, 1, 0.4],
		);
		let call = 0;
		mockGenerateObject.mockImplementation(async () => {
			call += 1;
			if (call === 1) {
				throw new Error("verifier 429");
			}
			return {
				object: {
					relationship: "same_work_item",
					confidence: 0.95,
					reasoning: "dup",
				},
			};
		});

		await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new", "n2"],
		});

		expect(mockUpsertStoryDuplicateEmbeddings).toHaveBeenCalledTimes(1);
		const [, persistedRows] = mockUpsertStoryDuplicateEmbeddings.mock
			.calls[0] as [string, Array<{ storyId: string }>];
		expect(persistedRows.map((r) => r.storyId)).toEqual(["n2"]);
	});

	it("refuses a keyless tenant with a type Temporal will not retry", async () => {
		// `resolveModelWithProvider` does not throw for a tenant with no
		// provider — it returns `{ apiKey: null, _error }` with an empty model
		// string. Unchecked, that string matches no cached row's model, marks
		// the whole corpus stale, and ships every story to the embedder purely
		// to fail there. It must refuse up front, and refuse as
		// AIProviderNotConfiguredError: the surrounding catch rewraps anything
		// else into EmbeddingUnavailableError, which is not in
		// AI_NON_RETRYABLE_ERROR_TYPES, so the activity would spend its entire
		// retry budget on an answer that cannot change.
		mockResolveModelWithProvider.mockResolvedValue({
			modelString: "",
			apiKey: null,
			source: null,
			_error: "No embedding provider configured.",
		});

		await expect(
			detectAndFlagDuplicateStories({
				projectId: "p1",
				userId: "u1",
				organizationId: "o1",
				targetStoryIds: ["new"],
			}),
		).rejects.toMatchObject({ name: "AIProviderNotConfiguredError" });
	});
});

describe("feature pairs are judged mainly on their Scope sections", () => {
	type KindStory = Story & {
		kind: "FEATURE" | "BUG";
		acceptanceCriteria?: string | null;
	};

	const spec = (inScope: string, outOfScope: string) =>
		[
			"## Overview",
			"Help people get started with the product.",
			"## Scope",
			"### In Scope",
			`- ${inScope}`,
			"### Out of Scope",
			`- ${outOfScope}`,
		].join("\n");

	/** Embed every text — whole-document or focus section — through
	 * `vectorFor`, so each cosine in the run is deterministic. */
	function arrangeByText(
		stories: KindStory[],
		vectorFor: (text: string) => number[],
	) {
		mockListActiveStoriesForDetection.mockResolvedValue(stories);
		mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
			embeddings: texts.map(vectorFor),
			model: "text-embedding-3-small",
		}));
	}

	async function pure() {
		const detection = await vi.importActual<
			typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
		>("@repo/database/prisma/queries/projects/duplicate-detection");
		const focus = await vi.importActual<
			typeof import("@repo/database/prisma/queries/projects/duplicate-focus")
		>("@repo/database/prisma/queries/projects/duplicate-focus");
		return { ...detection, ...focus };
	}

	it("settles topic-alike features with non-overlapping Scope as distinct, without a verifier call", async () => {
		const { cosineSimilarity, weightedFocusSimilarity } = await pure();
		const stories: KindStory[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Clearer onboarding for new users",
				description: spec(
					"Guided first-run checklist for new users",
					"Developer integration setup",
				),
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Configure MCP for developers",
				description: spec(
					"MCP server configuration for developers",
					"End-user onboarding checklist",
				),
				kind: "FEATURE",
			},
		];
		arrangeByText(stories, (text) => {
			// Whole documents nearly identical; Scope sections orthogonal.
			if (text.startsWith("Clearer onboarding")) {
				return [1, 1, 0];
			}
			if (text.startsWith("Configure MCP")) {
				return [1, 1, 0.02];
			}
			return text.includes("Guided first-run checklist")
				? [1, 0, 0]
				: [0, 1, 0];
		});

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.candidates).toBe(1);
		expect(result.confirmed).toBe(0);
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
		// Second embedding call: the two Scope sections, polarity kept.
		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(2);
		expect(mockGenerateEmbeddings.mock.calls[1][0]).toEqual([
			"In scope:\n- Guided first-run checklist for new users\nOut of scope:\n- Developer integration setup",
			"In scope:\n- MCP server configuration for developers\nOut of scope:\n- End-user onboarding checklist",
		]);
		expect(mockGenerateEmbeddings.mock.calls[1][1]).toMatchObject({
			featureKey: "duplicate-scan",
		});
		const expected = weightedFocusSimilarity(
			0,
			cosineSimilarity([1, 1, 0], [1, 1, 0.02]),
		);
		expect(mockRecordDistinctVerdict).toHaveBeenCalledTimes(1);
		const arg = mockRecordDistinctVerdict.mock.calls[0][0] as {
			storyAId: string;
			storyBId: string;
			similarity: number;
			confidence: number;
			reasoning: string;
			contentHashA: string;
		};
		expect(arg).toMatchObject({
			storyAId: "existing",
			storyBId: "new",
			confidence: 1,
			contentHashA: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(arg.similarity).toBeCloseTo(expected, 10);
		expect(arg.similarity).toBeLessThan(0.7);
		expect(arg.reasoning).toMatch(/^Scope sections do not overlap/);
	});

	it("verifies features with overlapping Scope on their Scope blocks, and flags them at the weighted score", async () => {
		const { cosineSimilarity, weightedFocusSimilarity } = await pure();
		const stories: KindStory[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Clearer onboarding for new users",
				description: spec(
					"Guided first-run checklist for new users",
					"Developer integration setup",
				),
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Onboarding checklist revamp",
				description: spec(
					"Guided first-run checklist with progress",
					"Admin reporting",
				),
				kind: "FEATURE",
			},
		];
		arrangeByText(stories, (text) => {
			if (text.startsWith("Clearer onboarding")) {
				return [1, 0, 0];
			}
			if (text.startsWith("Onboarding checklist revamp")) {
				return [0.8, 0.6, 0];
			}
			return [1, 0, 0];
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "overlapping_scope",
				confidence: 0.85,
				reasoning: "both deliver the first-run checklist",
			},
		});

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.confirmed).toBe(1);
		const { prompt } = mockGenerateObject.mock.calls[0][0] as {
			prompt: string;
		};
		expect(prompt).toContain(
			"<scope_a>\nIn scope:\n- Guided first-run checklist for new users",
		);
		expect(prompt).toContain(
			"<scope_b>\nIn scope:\n- Guided first-run checklist with progress",
		);
		expect(prompt).toMatch(/PRIMARY signal/);
		const link = mockUpsertPendingDuplicateLink.mock.calls[0][0] as {
			similarity: number;
			linkType: string;
		};
		expect(link.linkType).toBe("OVERLAP");
		expect(link.similarity).toBeCloseTo(
			weightedFocusSimilarity(
				1,
				cosineSimilarity([1, 0, 0], [0.8, 0.6, 0]),
			),
			10,
		);
	});

	it("compares on acceptance criteria when a feature has no Scope section", async () => {
		const stories: KindStory[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Clearer onboarding for new users",
				description: spec(
					"Guided first-run checklist",
					"Admin reporting",
				),
				acceptanceCriteria:
					"AC1: Given a new user, when they sign in, then the checklist shows",
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Onboarding checklist revamp",
				description: "## Overview\nA better first run.",
				acceptanceCriteria:
					"  AC1: Given a new user, when they first sign in, then the checklist shows  ",
				kind: "FEATURE",
			},
		];
		arrangeByText(stories, (text) => {
			if (text.startsWith("Clearer onboarding")) {
				return [1, 0, 0];
			}
			if (text.startsWith("Onboarding checklist revamp")) {
				return [0.8, 0.6, 0];
			}
			return [1, 0, 0];
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "overlapping_scope",
				confidence: 0.85,
				reasoning: "same first-run checklist",
			},
		});

		await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(mockGenerateEmbeddings.mock.calls[1][0]).toEqual([
			"AC1: Given a new user, when they sign in, then the checklist shows",
			"AC1: Given a new user, when they first sign in, then the checklist shows",
		]);
		const { prompt } = mockGenerateObject.mock.calls[0][0] as {
			prompt: string;
		};
		expect(prompt).toContain(
			"<acceptance_criteria_a>\nAC1: Given a new user, when they sign in, then the checklist shows\n</acceptance_criteria_a>",
		);
		expect(prompt).not.toContain("<scope_a>");
	});

	const wholeDocumentPairs: Array<
		[label: string, kindA: KindStory["kind"], kindB: KindStory["kind"]]
	> = [
		["two bugs", "BUG", "BUG"],
		["a feature and a bug", "FEATURE", "BUG"],
	];
	it.each(wholeDocumentPairs)(
		"keeps the whole-document behaviour for %s",
		async (_label, kindA, kindB) => {
			const { cosineSimilarity } = await pure();
			const stories: KindStory[] = [
				{
					id: "existing",
					identifier: "F-1",
					title: "Login times out",
					description: spec("Session refresh", "Password reset"),
					kind: kindA,
				},
				{
					id: "new",
					identifier: "F-2",
					title: "Login timeout on refresh",
					description: spec("Token renewal", "Account lockout"),
					kind: kindB,
				},
			];
			arrangeByText(stories, (text) =>
				text.startsWith("Login times out") ? [1, 1, 0] : [1, 1, 0.02],
			);
			mockGenerateObject.mockResolvedValue({
				object: {
					relationship: "same_work_item",
					confidence: 0.95,
					reasoning: "same timeout",
				},
			});

			const result = await detectAndFlagDuplicateStories({
				...baseParams,
				targetStoryIds: ["new"],
			});

			expect(result.confirmed).toBe(1);
			// One embedding call: no focus sections are embedded.
			expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
			const { prompt } = mockGenerateObject.mock.calls[0][0] as {
				prompt: string;
			};
			expect(prompt).not.toContain("<scope_a>");
			expect(prompt).not.toMatch(/PRIMARY/);
			const link = mockUpsertPendingDuplicateLink.mock.calls[0][0] as {
				similarity: number;
			};
			expect(link.similarity).toBeCloseTo(
				cosineSimilarity([1, 1, 0], [1, 1, 0.02]),
				10,
			);
			expect(focusedPairLogCalls()).toHaveLength(0);
		},
	);

	/** The per-run tuning log calls ("feature pairs scored on …"). */
	function focusedPairLogCalls() {
		return mockLoggerInfo.mock.calls.filter(([message]) =>
			String(message).includes("feature pairs scored"),
		);
	}

	it("logs every focused pair once per run — identifiers, kind, scores and outcome, never story text", async () => {
		const stories: KindStory[] = [
			{
				id: "e1",
				identifier: "F-1",
				title: "Clearer onboarding for new users",
				description: spec(
					"Guided first-run checklist for new users",
					"Developer integration setup",
				),
				kind: "FEATURE",
			},
			{
				id: "e2",
				identifier: "F-2",
				title: "Configure MCP for developers",
				description: spec(
					"MCP server configuration for developers",
					"End-user onboarding checklist",
				),
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-3",
				title: "Onboarding checklist revamp",
				description: spec(
					"Guided first-run checklist with progress",
					"Admin reporting",
				),
				kind: "FEATURE",
			},
		];
		arrangeByText(stories, (text) => {
			if (text.startsWith("Clearer onboarding")) {
				return [1, 0, 0];
			}
			if (
				text.startsWith("Configure MCP") ||
				text.startsWith("Onboarding checklist revamp")
			) {
				return [0.8, 0.6, 0];
			}
			// Focus sections: the checklist scopes overlap, the MCP one does not.
			return text.includes("Guided first-run checklist")
				? [1, 0, 0]
				: [0, 1, 0];
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "overlapping_scope",
				confidence: 0.85,
				reasoning: "both deliver the first-run checklist",
			},
		});

		await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		const calls = focusedPairLogCalls();
		expect(calls).toHaveLength(1);
		const payload = calls[0][1] as {
			projectId: string;
			pairs: Array<Record<string, unknown>>;
		};
		expect(payload.projectId).toBe("proj-1");
		expect(payload.pairs).toHaveLength(2);
		expect(payload.pairs).toEqual(
			expect.arrayContaining([
				// Verified: overlapping Scope (focus 1.0, document 0.8).
				expect.objectContaining({
					a: "F-1",
					b: "F-3",
					focus: "scope",
					focusSimilarity: 1,
					documentSimilarity: 0.8,
					weighted: 0.95,
					threshold: 0.7,
					outcome: "linked:OVERLAP",
				}),
				// Settled: identical documents, orthogonal Scope sections.
				expect.objectContaining({
					a: "F-2",
					b: "F-3",
					focus: "scope",
					focusSimilarity: 0,
					documentSimilarity: 1,
					weighted: 0.25,
					outcome: "settled",
				}),
			]),
		);
		// Worker-log redaction: identifiers and numbers only.
		const logged = JSON.stringify(payload).toLowerCase();
		for (const fragment of [
			"onboarding",
			"checklist",
			"mcp",
			"first-run",
		]) {
			expect(logged).not.toContain(fragment);
		}
	});
});

describe("embedding configuration refusals", () => {
	it("preserves the embedding-step verdict", async () => {
		arrange(
			[
				{
					id: "a",
					identifier: "F-1",
					title: "Example one",
					description: null,
				},
				{
					id: "b",
					identifier: "F-2",
					title: "Example two",
					description: null,
				},
			],
			() => [1, 0],
		);
		const error = new UnsupportedEmbeddingModelError(
			"databricks-gte-large-en",
		);
		mockGenerateEmbeddings.mockRejectedValue(error);
		await expect(
			detectAndFlagDuplicateStories({
				projectId: "example-project",
				userId: "example-user",
				organizationId: "example-org",
				targetStoryIds: ["b"],
			}),
		).rejects.toBe(error);
	});
});
