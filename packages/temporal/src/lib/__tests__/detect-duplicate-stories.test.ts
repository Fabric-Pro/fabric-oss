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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	mockListStoryDuplicateFocusEmbeddings,
	mockUpsertStoryDuplicateFocusEmbeddings,
	mockUpsertPendingDuplicateLink,
	mockRecordDistinctVerdict,
	mockListPendingDuplicatePairs,
	mockWithdrawPendingDuplicateLinks,
	mockRefreshPendingDuplicateSimilarities,
	mockGetDuplicateLinkState,
	mockStampVerifiedHashes,
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
	mockListStoryDuplicateFocusEmbeddings: vi.fn(),
	mockUpsertStoryDuplicateFocusEmbeddings: vi.fn(),
	mockUpsertPendingDuplicateLink: vi.fn(),
	mockRecordDistinctVerdict: vi.fn(),
	mockListPendingDuplicatePairs: vi.fn(),
	mockWithdrawPendingDuplicateLinks: vi.fn(),
	mockRefreshPendingDuplicateSimilarities: vi.fn(),
	mockGetDuplicateLinkState: vi.fn(),
	mockStampVerifiedHashes: vi.fn(),
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
		listStoryDuplicateFocusEmbeddings:
			mockListStoryDuplicateFocusEmbeddings,
		upsertStoryDuplicateFocusEmbeddings:
			mockUpsertStoryDuplicateFocusEmbeddings,
		upsertPendingDuplicateLink: mockUpsertPendingDuplicateLink,
		recordDistinctVerdict: mockRecordDistinctVerdict,
		listPendingDuplicatePairs: mockListPendingDuplicatePairs,
		withdrawPendingDuplicateLinks: mockWithdrawPendingDuplicateLinks,
		refreshPendingDuplicateSimilarities:
			mockRefreshPendingDuplicateSimilarities,
		getDuplicateLinkState: mockGetDuplicateLinkState,
		stampVerifiedHashes: mockStampVerifiedHashes,
	};
});

import { detectAndFlagDuplicateStories } from "../detect-duplicate-stories";
import { RUN_TIME_BUDGET_MS } from "../duplicate-scan-core";

type Story = {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	kind?: "FEATURE" | "BUG";
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
	// Empty section cache too: every feature section is embedded.
	mockListStoryDuplicateFocusEmbeddings.mockResolvedValue([]);
	mockUpsertStoryDuplicateFocusEmbeddings.mockResolvedValue(undefined);
	mockUpsertPendingDuplicateLink.mockResolvedValue({});
	mockRecordDistinctVerdict.mockResolvedValue(undefined);
	mockListPendingDuplicatePairs.mockResolvedValue([]);
	mockWithdrawPendingDuplicateLinks.mockResolvedValue(0);
	mockRefreshPendingDuplicateSimilarities.mockResolvedValue(0);
	// No stored row for any pair: every verdict is a first verdict.
	mockGetDuplicateLinkState.mockResolvedValue(null);
	mockStampVerifiedHashes.mockResolvedValue(undefined);
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
			verifierFailures: 0,
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
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Login",
				description: null,
				kind: "FEATURE",
			},
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
				clearsPendingFlag: true,
			}),
		);
	});

	it.each([
		["two bugs", "BUG", "BUG"],
		["a bug and a feature", "BUG", "FEATURE"],
	] as const)(
		"caches a distinct verdict on %s without withdrawing an existing flag — their logic is unchanged",
		async (_label, kindA, kindB) => {
			const stories: Story[] = [
				{
					id: "existing",
					identifier: "B-1",
					title: "Login",
					description: null,
					kind: kindA,
				},
				{
					id: "new",
					identifier: "B-2",
					title: "Login",
					description: null,
					kind: kindB,
				},
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

			await detectAndFlagDuplicateStories({
				...baseParams,
				targetStoryIds: ["new"],
			});

			expect(mockRecordDistinctVerdict).toHaveBeenCalledWith(
				expect.objectContaining({ clearsPendingFlag: false }),
			);
		},
	);

	it("caches an unsure 'same work' verdict without withdrawing an existing flag", async () => {
		const stories: Story[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Login",
				description: null,
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Login",
				description: null,
				kind: "FEATURE",
			},
		];
		arrange(stories, (id) =>
			id === "existing" ? [1, 1, 0] : [1, 1, 0.02],
		);
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "same_work_item",
				confidence: 0.6,
				reasoning: "probably the same login work",
			},
		});

		await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
		expect(mockRecordDistinctVerdict).toHaveBeenCalledWith(
			expect.objectContaining({ clearsPendingFlag: false }),
		);
	});

	it("attributes the verifier's usage to duplicate detection", async () => {
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

		await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(mockGetAIModelWithMetadata).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				projectId: "proj-1",
				featureKey: "duplicate-scan",
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

	it("never verifies or flags topic-alike features whose Scope sections do not overlap, and withdraws an old flag on them", async () => {
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
		// Flagged under the earlier rule, which let the near-identical
		// documents alone select the pair; nobody has reviewed it.
		const oldFlag = { storyAId: "existing", storyBId: "new" };
		mockListPendingDuplicatePairs.mockResolvedValue([oldFlag]);
		mockWithdrawPendingDuplicateLinks.mockResolvedValue(1);

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		// Near-identical documents, yet orthogonal Scope sections score the
		// pair far under the bar: no candidate, no verifier call, no flag.
		expect(result.candidates).toBe(0);
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
		expect(mockWithdrawPendingDuplicateLinks).toHaveBeenCalledWith(
			"proj-1",
			[oldFlag],
		);
		// The pair the Scope kept out is logged, by identifier only.
		const excludedLog = mockLoggerInfo.mock.calls.find(
			([message]) =>
				message ===
				"[Auto Dup Detect] feature pairs kept out by their sections",
		);
		expect(excludedLog?.[1]).toEqual({
			projectId: "proj-1",
			scopeExcluded: [
				expect.objectContaining({ a: "F-1", b: "F-2", focus: "scope" }),
			],
		});
		// Second embedding call: the two Scope sections, polarity kept.
		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(2);
		expect(mockGenerateEmbeddings.mock.calls[1][0]).toEqual([
			"In scope:\n- Guided first-run checklist for new users\nOut of scope:\n- Developer integration setup",
			"In scope:\n- MCP server configuration for developers\nOut of scope:\n- End-user onboarding checklist",
		]);
		expect(mockGenerateEmbeddings.mock.calls[1][1]).toMatchObject({
			featureKey: "duplicate-scan",
		});
	});

	it("keeps a feature flag the current rule still raises", async () => {
		const stories: KindStory[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Clearer onboarding for new users",
				description: spec(
					"Guided first-run checklist",
					"Admin reporting",
				),
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Onboarding checklist revamp",
				description: spec(
					"Guided first-run checklist",
					"Admin reporting",
				),
				kind: "FEATURE",
			},
		];
		arrangeByText(stories, () => [1, 0, 0]);
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "same_work_item",
				confidence: 0.9,
				reasoning: "the same checklist",
			},
		});
		mockListPendingDuplicatePairs.mockResolvedValue([
			{ storyAId: "existing", storyBId: "new" },
		]);

		await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(mockWithdrawPendingDuplicateLinks).toHaveBeenCalledWith(
			"proj-1",
			[],
		);
	});

	it("verifies features with overlapping Scope on their Scope blocks, and flags them at the weighted score", async () => {
		const {
			CANDIDATE_COSINE_THRESHOLD,
			calibratedFocusScore,
			cosineSimilarity,
			weightedFocusSimilarity,
		} = await pure();
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
		// Stored on the threshold's scale, as every pair's score is.
		expect(link.similarity).toBeCloseTo(
			calibratedFocusScore(
				weightedFocusSimilarity(
					1,
					cosineSimilarity([1, 0, 0], [0.8, 0.6, 0]),
				),
				CANDIDATE_COSINE_THRESHOLD,
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

		// Every section each feature has is embedded once; the pair is then
		// compared on the one both have.
		expect(mockGenerateEmbeddings.mock.calls[1][0]).toEqual([
			"In scope:\n- Guided first-run checklist\nOut of scope:\n- Admin reporting",
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

	it("verifies a feature pair whose weighted score falls just under the threshold", async () => {
		const {
			CANDIDATE_COSINE_THRESHOLD,
			calibratedFocusScore,
			cosineSimilarity,
			weightedFocusSimilarity,
		} = await pure();
		const stories: KindStory[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Capture images from proposal channels",
				description:
					"## Overview\nKeep screenshots posted with proposals.",
				acceptanceCriteria:
					"GIVEN a proposal posted in a monitored channel includes images WHEN the ticket is generated THEN the images are attached to it",
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Attach screenshots to proposals",
				description: "## Overview\nShow visual context on proposals.",
				acceptanceCriteria:
					"- A user can attach one or more screenshots to a feature proposal",
				kind: "FEATURE",
			},
		];
		// Two takes on images in proposals: criteria written for different
		// surfaces score 0.62 — under the threshold once weighted, but within
		// FOCUS_CANDIDATE_MARGIN — and the verifier sees the overlap.
		arrangeByText(stories, (text) => {
			if (text.startsWith("Capture images") || text.startsWith("GIVEN")) {
				return [1, 0, 0];
			}
			if (text.startsWith("Attach screenshots")) {
				return [0.72, 0.69, 0];
			}
			return [0.62, Math.sqrt(1 - 0.62 ** 2), 0];
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "overlapping_scope",
				confidence: 0.85,
				reasoning: "both put images on feature proposals",
			},
		});

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		const weighted = weightedFocusSimilarity(
			0.62,
			cosineSimilarity([1, 0, 0], [0.72, 0.69, 0]),
		);
		expect(weighted).toBeLessThan(0.7);
		expect(weighted).toBeGreaterThanOrEqual(0.62);
		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		expect(mockRecordDistinctVerdict).not.toHaveBeenCalled();
		expect(result.confirmed).toBe(1);
		const { prompt } = mockGenerateObject.mock.calls[0][0] as {
			prompt: string;
		};
		expect(prompt).toContain("<acceptance_criteria_a>");
		const link = mockUpsertPendingDuplicateLink.mock.calls[0][0] as {
			similarity: number;
			linkType: string;
		};
		expect(link.linkType).toBe("OVERLAP");
		// Shown at/above the threshold, like every flag: the raw score's bar
		// maps onto it.
		expect(link.similarity).toBeCloseTo(
			calibratedFocusScore(weighted, CANDIDATE_COSINE_THRESHOLD),
			10,
		);
		expect(link.similarity).toBeGreaterThanOrEqual(
			CANDIDATE_COSINE_THRESHOLD,
		);
	});

	it("checks features whose Scope sections match even when their documents read apart", async () => {
		const stories: KindStory[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Bulk export of invoices",
				description: spec(
					"CSV export of all invoices",
					"PDF statements",
				),
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Finance team reporting",
				description: spec("CSV export of every invoice", "Dashboards"),
				kind: "FEATURE",
			},
		];
		// Documents at 0.5 — far under the threshold — but the Scope sections
		// match: weighted 0.75 × 1 + 0.25 × 0.5 = 0.875.
		arrangeByText(stories, (text) => {
			if (text.startsWith("Bulk export")) {
				return [1, 0, 0];
			}
			if (text.startsWith("Finance team")) {
				return [0.5, Math.sqrt(0.75), 0];
			}
			return [1, 0, 0];
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "overlapping_scope",
				confidence: 0.85,
				reasoning: "both deliver the invoice CSV export",
			},
		});

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result.candidates).toBe(1);
		expect(result.confirmed).toBe(1);
		const { prompt } = mockGenerateObject.mock.calls[0][0] as {
			prompt: string;
		};
		expect(prompt).toContain(
			"<scope_b>\nIn scope:\n- CSV export of every invoice",
		);
		const link = mockUpsertPendingDuplicateLink.mock.calls[0][0] as {
			similarity: number;
		};
		const { calibratedFocusScore, CANDIDATE_COSINE_THRESHOLD } =
			await pure();
		expect(link.similarity).toBeCloseTo(
			calibratedFocusScore(0.875, CANDIDATE_COSINE_THRESHOLD),
			10,
		);
		const payload = focusedPairLogCalls()[0][1] as {
			pairs: Array<Record<string, unknown>>;
		};
		expect(payload.pairs).toEqual([
			expect.objectContaining({
				a: "F-1",
				b: "F-2",
				documentSimilarity: 0.5,
				weighted: 0.875,
				byDocument: false,
				outcome: "linked:OVERLAP",
			}),
		]);
	});

	it("reuses cached section vectors and embeds and stores only changed sections", async () => {
		const { hashDetectionText } = await pure();
		const existingScope =
			"In scope:\n- Guided first-run checklist for new users\nOut of scope:\n- Developer integration setup";
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
		arrangeByText(stories, () => [1, 0, 0]);
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "overlapping_scope",
				confidence: 0.85,
				reasoning: "same checklist",
			},
		});
		mockListStoryDuplicateFocusEmbeddings.mockResolvedValue([
			{
				storyId: "existing",
				kind: "scope",
				contentHash: hashDetectionText(existingScope),
				model: "text-embedding-3-small",
				embedding: [1, 0, 0],
			},
		]);

		await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		const newScope =
			"In scope:\n- Guided first-run checklist with progress\nOut of scope:\n- Admin reporting";
		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(2);
		expect(mockGenerateEmbeddings.mock.calls[1][0]).toEqual([newScope]);
		expect(mockUpsertStoryDuplicateFocusEmbeddings).toHaveBeenCalledWith(
			"proj-1",
			[
				{
					storyId: "new",
					kind: "scope",
					contentHash: hashDetectionText(newScope),
					model: "text-embedding-3-small",
					embedding: [1, 0, 0],
				},
			],
		);
		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
	});

	it("re-checks a feature pair when Scope changes past where the document text is cut", async () => {
		const longSpec = (inScope: string) =>
			[
				"## Overview",
				"Background ".repeat(900),
				"## Scope",
				"### In Scope",
				`- ${inScope}`,
			].join("\n");
		const run = async (inScope: string) => {
			vi.clearAllMocks();
			mockListDismissedDuplicatePairKeys.mockResolvedValue([]);
			mockListVerdictValidPairKeys.mockResolvedValue([]);
			mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([]);
			mockListStoryDuplicateFocusEmbeddings.mockResolvedValue([]);
			mockGenerateObject.mockResolvedValue({
				object: {
					relationship: "distinct",
					confidence: 0.9,
					reasoning: "different exports",
				},
			});
			arrangeByText(
				[
					{
						id: "existing",
						identifier: "F-1",
						title: "Invoice export",
						description: longSpec("CSV export"),
						kind: "FEATURE",
					},
					{
						id: "new",
						identifier: "F-2",
						title: "Invoice tools",
						description: longSpec(inScope),
						kind: "FEATURE",
					},
				],
				(text) => (text.startsWith("Invoice export") ? [1, 0] : [0, 1]),
			);
			await detectAndFlagDuplicateStories({
				...baseParams,
				targetStoryIds: ["new"],
			});
			const verdictHashes = mockListVerdictValidPairKeys.mock
				.calls[0][1] as Map<string, string>;
			const cacheRows = mockUpsertStoryDuplicateEmbeddings.mock
				.calls[0][1] as Array<{ storyId: string; contentHash: string }>;
			return {
				verdictHash: verdictHashes.get("new"),
				documentHash: cacheRows.find((row) => row.storyId === "new")
					?.contentHash,
			};
		};

		const first = await run("CSV export");
		const second = await run("PDF statements");

		// The edit sits past the detection-text cut, so the document hash —
		// and the shared vector cache — are unchanged ...
		expect(second.documentHash).toBe(first.documentHash);
		// ... but the verdict hash moves, so the stored verdict no longer
		// applies and the pair is verified again.
		expect(second.verdictHash).not.toBe(first.verdictHash);
	});

	it("tells the verifier that an undefined placeholder feature is distinct", async () => {
		const stories: KindStory[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Test item",
				description: "A placeholder feature stub. No description yet.",
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Test link",
				description: "A placeholder feature stub. No description yet.",
				kind: "FEATURE",
			},
		];
		arrangeByText(stories, () => [1, 0, 0]);
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "distinct",
				confidence: 0.9,
				reasoning: "neither defines any work",
			},
		});

		await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		const { prompt } = mockGenerateObject.mock.calls[0][0] as {
			prompt: string;
		};
		expect(prompt).toMatch(
			/If either feature is only a placeholder[\s\S]*answer "distinct"/,
		);
		// No sections, so no focus blocks — only the placeholder rule.
		expect(prompt).not.toContain("<scope_a>");
		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
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
			// A bug's sections are never embedded; a feature's are, for its
			// pairs with other features.
			expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(
				kindA === "FEATURE" ? 2 : 1,
			);
			const { prompt } = mockGenerateObject.mock.calls[0][0] as {
				prompt: string;
			};
			expect(prompt).not.toContain("<scope_a>");
			expect(prompt).not.toMatch(/PRIMARY/);
			expect(prompt).not.toMatch(/placeholder/);
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
			// Focus sections: the checklist scopes overlap; the MCP one only
			// partly, close enough to be checked.
			return text.includes("MCP server")
				? [0.66, Math.sqrt(1 - 0.66 ** 2), 0]
				: [1, 0, 0];
		});
		// The verifier links the pair whose Scope blocks share the checklist
		// and calls the MCP one distinct.
		mockGenerateObject.mockImplementation(
			async ({ prompt }: { prompt: string }) => ({
				object: prompt.includes("<scope_a>\nIn scope:\n- MCP server")
					? {
							relationship: "distinct",
							confidence: 0.9,
							reasoning: "different scopes",
						}
					: {
							relationship: "overlapping_scope",
							confidence: 0.85,
							reasoning: "both deliver the first-run checklist",
						},
			}),
		);

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
					byDocument: true,
					outcome: "linked:OVERLAP",
				}),
				// Verified distinct: identical documents, partly overlapping Scope.
				expect.objectContaining({
					a: "F-2",
					b: "F-3",
					focus: "scope",
					focusSimilarity: 0.66,
					documentSimilarity: 1,
					weighted: 0.745,
					outcome: "distinct",
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

	describe("a re-check that would change a pair's state", () => {
		/** Two features with identical documents and Scope: always a
		 * candidate. */
		const twins: KindStory[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Clearer onboarding for new users",
				description: spec(
					"Guided first-run checklist",
					"Admin reporting",
				),
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Onboarding checklist revamp",
				description: spec(
					"Guided first-run checklist",
					"Admin reporting",
				),
				kind: "FEATURE",
			},
		];
		const verdicts = (...relationships: string[]) => {
			for (const relationship of relationships) {
				mockGenerateObject.mockResolvedValueOnce({
					object: {
						relationship,
						confidence: 0.9,
						reasoning: "test",
					},
				});
			}
		};
		const prior = (
			status: "PENDING" | "NOT_DUPLICATE" | "DISMISSED",
			linkType: "DUPLICATE" | "OVERLAP" = "DUPLICATE",
		) =>
			mockGetDuplicateLinkState.mockResolvedValue({
				status,
				linkType,
				verifiedContentHashA: "old",
				verifiedContentHashB: "old",
			});
		const run = () =>
			detectAndFlagDuplicateStories({
				...baseParams,
				targetStoryIds: ["new"],
			});

		beforeEach(() => {
			arrangeByText(twins, () => [1, 0, 0]);
		});

		it("takes a first verdict on a new pair without a second opinion", async () => {
			verdicts("same_work_item");

			await run();

			expect(mockGenerateObject).toHaveBeenCalledTimes(1);
			expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledTimes(1);
		});

		it("clears an unreviewed flag only when a second opinion agrees", async () => {
			prior("PENDING");
			verdicts("distinct", "distinct");

			await run();

			expect(mockGenerateObject).toHaveBeenCalledTimes(2);
			expect(mockTrackUsage).toHaveBeenCalledTimes(2);
			expect(mockRecordDistinctVerdict).toHaveBeenCalledWith(
				expect.objectContaining({ clearsPendingFlag: true }),
			);
			expect(mockStampVerifiedHashes).not.toHaveBeenCalled();
		});

		it("keeps the flag and stamps its hashes when the second opinion disagrees", async () => {
			prior("PENDING");
			verdicts("distinct", "same_work_item");

			const result = await run();

			expect(mockGenerateObject).toHaveBeenCalledTimes(2);
			expect(mockRecordDistinctVerdict).not.toHaveBeenCalled();
			expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
			expect(mockStampVerifiedHashes).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj-1",
					storyAId: "existing",
					storyBId: "new",
				}),
			);
			expect(result.confirmed).toBe(0);
		});

		it("confirms moving a flag to the other tier", async () => {
			prior("PENDING", "DUPLICATE");
			verdicts("overlapping_scope", "same_work_item");

			await run();

			expect(mockGenerateObject).toHaveBeenCalledTimes(2);
			expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
			expect(mockStampVerifiedHashes).toHaveBeenCalledTimes(1);
		});

		it("confirms raising a flag over a cached negative verdict", async () => {
			prior("NOT_DUPLICATE");
			verdicts("same_work_item", "same_work_item");

			await run();

			expect(mockGenerateObject).toHaveBeenCalledTimes(2);
			expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledWith(
				expect.objectContaining({ linkType: "DUPLICATE" }),
			);
		});

		it("re-checks a flag at the same tier with one call", async () => {
			prior("PENDING", "DUPLICATE");
			verdicts("same_work_item");

			await run();

			expect(mockGenerateObject).toHaveBeenCalledTimes(1);
			expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledTimes(1);
		});

		it("lets an overlapping run's verdict on the same content stand", async () => {
			// One run records the verdict hashes the scan computes.
			verdicts("same_work_item");
			await run();
			const written = mockUpsertPendingDuplicateLink.mock.calls[0][0] as {
				contentHashA: string;
				contentHashB: string;
			};
			mockGenerateObject.mockClear();
			mockUpsertPendingDuplicateLink.mockClear();
			// Between the next run's selection and its verification, another
			// run verified the same content.
			mockGetDuplicateLinkState.mockResolvedValue({
				status: "PENDING",
				linkType: "DUPLICATE",
				verifiedContentHashA: written.contentHashA,
				verifiedContentHashB: written.contentHashB,
			});

			const result = await run();

			expect(mockGenerateObject).not.toHaveBeenCalled();
			expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
			expect(result.candidates).toBe(1);
		});

		it("never asks for a second opinion on a dismissed pair", async () => {
			prior("DISMISSED");
			verdicts("distinct");

			await run();

			expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		});

		it("raises a flag at the softer tier when two verdicts flag it at different tiers", async () => {
			prior("NOT_DUPLICATE");
			verdicts("same_work_item", "overlapping_scope");

			const result = await run();

			expect(mockGenerateObject).toHaveBeenCalledTimes(2);
			expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledWith(
				expect.objectContaining({ linkType: "OVERLAP" }),
			);
			expect(mockStampVerifiedHashes).not.toHaveBeenCalled();
			expect(result.confirmed).toBe(1);
		});

		it("keeps a cached negative verdict when the second opinion does not flag the pair", async () => {
			prior("NOT_DUPLICATE");
			verdicts("same_work_item", "distinct");

			await run();

			expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
			expect(mockRecordDistinctVerdict).not.toHaveBeenCalled();
			expect(mockStampVerifiedHashes).toHaveBeenCalledTimes(1);
		});

		it("asks a second opinion before flagging a bug pair over a cached negative verdict too", async () => {
			const bugs: KindStory[] = twins.map((s) => ({ ...s, kind: "BUG" }));
			arrangeByText(bugs, () => [1, 0, 0]);
			prior("NOT_DUPLICATE");
			verdicts("same_work_item", "same_work_item");

			await run();

			expect(mockGenerateObject).toHaveBeenCalledTimes(2);
			expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledWith(
				expect.objectContaining({ linkType: "DUPLICATE" }),
			);
		});

		it("lets a verdict another run wrote during the verifier calls stand", async () => {
			const { hashDetectionText } = await pure();
			verdicts("same_work_item");
			await run();
			const written = mockUpsertPendingDuplicateLink.mock.calls[0][0] as {
				contentHashA: string;
				contentHashB: string;
			};
			expect(written.contentHashA).not.toBe(hashDetectionText(""));
			mockUpsertPendingDuplicateLink.mockClear();
			mockGenerateObject.mockClear();
			// Nothing stored when this run reads the pair; by the time its
			// verdict is in, an overlapping run has stored one on the same
			// content.
			mockGetDuplicateLinkState
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					status: "PENDING",
					linkType: "OVERLAP",
					verifiedContentHashA: written.contentHashA,
					verifiedContentHashB: written.contentHashB,
				});
			verdicts("same_work_item");

			await run();

			expect(mockGenerateObject).toHaveBeenCalledTimes(1);
			expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
		});

		it("fails the activity for retry when every pair's state read fails", async () => {
			mockGetDuplicateLinkState.mockRejectedValue(new Error("db down"));

			await expect(run()).rejects.toThrow(/verifier failed for all 1/);
			expect(mockGenerateObject).not.toHaveBeenCalled();
		});
	});

	it("verifies a sectionless feature's pairs again once it is no longer a bug", async () => {
		const { hashDetectionText } = await pure();
		const asKind = (kind: "FEATURE" | "BUG"): KindStory[] => [
			{
				id: "existing",
				identifier: "1",
				title: "Export fails on large invoices",
				description: "The export times out.",
				kind,
			},
			{
				id: "new",
				identifier: "2",
				title: "Export fails on large invoices again",
				description: "The export times out.",
				kind: "BUG",
			},
		];
		const hashOf = async (kind: "FEATURE" | "BUG") => {
			mockUpsertPendingDuplicateLink.mockClear();
			arrangeByText(asKind(kind), () => [1, 0, 0]);
			mockGenerateObject.mockResolvedValue({
				object: {
					relationship: "same_work_item",
					confidence: 0.9,
					reasoning: "test",
				},
			});
			await detectAndFlagDuplicateStories({
				...baseParams,
				targetStoryIds: ["new"],
			});
			return (
				mockUpsertPendingDuplicateLink.mock.calls[0][0] as {
					contentHashA: string;
				}
			).contentHashA;
		};

		const asBug = await hashOf("BUG");
		const asFeature = await hashOf("FEATURE");

		expect(asFeature).not.toBe(asBug);
		expect(asFeature).not.toBe(hashDetectionText(""));
	});

	it("stores a kept flag's score on the threshold's scale", async () => {
		const stories: KindStory[] = [
			{
				id: "existing",
				identifier: "F-1",
				title: "Clearer onboarding for new users",
				description: spec(
					"Guided first-run checklist",
					"Admin reporting",
				),
				kind: "FEATURE",
			},
			{
				id: "new",
				identifier: "F-2",
				title: "Onboarding checklist revamp",
				description: spec(
					"Guided first-run checklist",
					"Admin reporting",
				),
				kind: "FEATURE",
			},
		];
		arrangeByText(stories, () => [1, 0, 0]);
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "same_work_item",
				confidence: 0.9,
				reasoning: "the same checklist",
			},
		});
		// Raised under the old scale at the raw weighted score.
		mockListPendingDuplicatePairs.mockResolvedValue([
			{ storyAId: "existing", storyBId: "new", similarity: 0.98 },
		]);

		await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(mockRefreshPendingDuplicateSimilarities).toHaveBeenCalledWith(
			"proj-1",
			[
				{
					storyAId: "existing",
					storyBId: "new",
					similarity: expect.closeTo(1, 10),
				},
			],
		);
	});
});

describe("candidates left over by the per-run cap", () => {
	/** One new bug matching 61 identical existing bugs: 61 candidates, one
	 * more than one run verifies. */
	const overCap: Story[] = [
		{ id: "new", identifier: "B-new", title: "Target", description: "x" },
		...Array.from({ length: 61 }, (_, i) => ({
			id: `old-${String(i).padStart(2, "0")}`,
			identifier: `B-${i}`,
			title: `Existing ${i}`,
			description: "x",
		})),
	];

	it("runs once and reports the pairs it left for the workflow's next run", async () => {
		arrange(overCap, () => [1, 0, 0]);

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(mockListActiveStoriesForDetection).toHaveBeenCalledTimes(1);
		expect(mockGenerateObject).toHaveBeenCalledTimes(60);
		expect(result).toMatchObject({
			candidates: 60,
			confirmed: 60,
			truncated: 1,
			verifierFailures: 0,
		});
	});

	it("reports the pairs it could not verify so the workflow stops", async () => {
		arrange(overCap, () => [1, 0, 0]);
		mockGenerateObject.mockRejectedValueOnce(new Error("rate limited"));

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(result).toMatchObject({ truncated: 1, verifierFailures: 1 });
	});
});

describe("candidates left over by the run's time budget", () => {
	/** One new bug matching 30 identical existing bugs: 30 candidates. */
	const thirty: Story[] = [
		{ id: "new", identifier: "B-new", title: "Target", description: "x" },
		...Array.from({ length: 30 }, (_, i) => ({
			id: `old-${String(i).padStart(2, "0")}`,
			identifier: `B-${i}`,
			title: `Existing ${i}`,
			description: "x",
		})),
	];
	let clock = 0;
	let now: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		clock = 0;
		now = vi.spyOn(Date, "now").mockImplementation(() => clock);
	});

	afterEach(() => {
		now.mockRestore();
	});

	it("stops starting verifications once the budget is spent and reports the rest for the next run", async () => {
		arrange(thirty, () => [1, 0, 0]);
		// Each verification takes a tenth of the budget, so ten fit.
		mockGenerateObject.mockImplementation(async () => {
			clock += RUN_TIME_BUDGET_MS / 10;
			return {
				object: {
					sameWorkItem: true,
					confidence: 0.95,
					reasoning: "test",
				},
			};
		});

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(mockGenerateObject).toHaveBeenCalledTimes(10);
		expect(result).toMatchObject({
			candidates: 10,
			confirmed: 10,
			truncated: 20,
			verifierFailures: 0,
		});
		// The new bug is in every pair not reached, so it stays stale for the
		// next run to re-select them.
		const persisted = mockUpsertStoryDuplicateEmbeddings.mock.calls.flatMap(
			([, rows]) =>
				(rows as Array<{ storyId: string }>).map((r) => r.storyId),
		);
		expect(persisted).not.toContain("new");
	});

	it("verifies one pair even when the budget was spent before verification began", async () => {
		arrange(thirty, () => [1, 0, 0]);
		const embed = mockGenerateEmbeddings.getMockImplementation();
		mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => {
			clock = RUN_TIME_BUDGET_MS;
			return embed?.(texts);
		});

		const result = await detectAndFlagDuplicateStories({
			...baseParams,
			targetStoryIds: ["new"],
		});

		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ candidates: 1, truncated: 29 });
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
