/**
 * Tests for `scanDuplicatesProcedure` — the manual roadmap scan, now a thin
 * wrapper (auth → shared core → bookkeeping) around `runDuplicateScanCore`.
 *
 * Strategy: mock the embedding provider (`@repo/rag`), the LLM verifier
 * (`@repo/ai`), and the DB query helpers (`@repo/database`), but run the REAL
 * shared core (`@repo/temporal/duplicate-scan-core`, loaded via importActual
 * inside the `@repo/temporal` mock) and the REAL pure detection lib — so the
 * actual staleness/cosine/verdict-routing/per-item-persist logic is exercised
 * end-to-end through the procedure. Asserts:
 *   - the precision contract (unrelated never flagged; 3-way verdict routing:
 *     duplicate link / overlap link / cached negative verdict — including
 *     low-confidence non-distinct verdicts, which MUST persist a negative
 *     verdict so a large drain makes monotonic progress),
 *   - verdict-cache-driven verification (a pair with a stored verdict at the
 *     current content hashes is never re-paid; a warm embedding cache alone
 *     can NOT skip verification — the DETECTION_VERSION drain guarantee),
 *   - embedding-cache reuse (only stale items re-embedded; model change
 *     invalidates everything) and PER-ITEM persist (items in a failed or
 *     cap-dropped pair stay stale; everything else is stamped),
 *   - embedding/model-resolution failures surface the actionable settings
 *     hint; cross-tenant access denied; <2 items early-returns.
 */

// Deep import deliberately bypasses the "@repo/database" barrel mock below —
// the pure lib has no DB/AI imports, and the tests use it to compute the same
// content hashes the core computes.
import {
	buildDetectionText,
	hashDetectionText,
} from "@repo/database/prisma/queries/projects/duplicate-detection";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, uses } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	uses: [] as unknown[],
}));

const mockGenerateEmbeddings = vi.fn();
const mockGenerateObject = vi.fn();
const mockGetAIModelWithMetadata = vi.fn(async () => ({
	model: {},
	metadata: {},
	trackUsage: vi.fn(),
}));
const mockResolveModelWithProvider = vi.fn();
const mockHasProjectAccess = vi.fn(async () => true);
const mockListActiveStoriesForDetection = vi.fn();
const mockListDismissedDuplicatePairKeys = vi.fn(async () => [] as string[]);
const mockListVerdictValidPairKeys = vi.fn(async () => [] as string[]);
const mockUpsertPendingDuplicateLink = vi.fn(async () => ({}));
const mockRecordDistinctVerdict = vi.fn(async () => undefined);
const mockListStoryDuplicateEmbeddingMetadata = vi.fn();
const mockListStoryDuplicateEmbeddings = vi.fn();
const mockUpsertStoryDuplicateEmbeddings = vi.fn(async () => undefined);
const mockSetProjectLastDuplicateScanAt = vi.fn(async () => undefined);
const mockCountItemsWithPendingDuplicateLinks = vi.fn(async () => 0);

vi.mock("@repo/rag", () => ({
	generateEmbeddings: (...a: unknown[]) => mockGenerateEmbeddings(...a),
}));

vi.mock("@repo/ai", () => ({
	generateObject: (...a: unknown[]) => mockGenerateObject(...a),
	getAIModelWithMetadata: (...a: unknown[]) =>
		mockGetAIModelWithMetadata(...a),
	resolveModelWithProvider: (...a: unknown[]) =>
		mockResolveModelWithProvider(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", async () => {
	// Keep the REAL pure detection lib (cosine/threshold/verdict-routing)
	// running — it has no DB/AI imports, so it is safe to load directly
	// without pulling in the Prisma client.
	const pure = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
	>("@repo/database/prisma/queries/projects/duplicate-detection");
	return {
		...pure,
		hasProjectAccess: (...a: unknown[]) => mockHasProjectAccess(...a),
		listActiveStoriesForDetection: (...a: unknown[]) =>
			mockListActiveStoriesForDetection(...a),
		listDismissedDuplicatePairKeys: (...a: unknown[]) =>
			mockListDismissedDuplicatePairKeys(...a),
		listVerdictValidPairKeys: (...a: unknown[]) =>
			mockListVerdictValidPairKeys(...a),
		upsertPendingDuplicateLink: (...a: unknown[]) =>
			mockUpsertPendingDuplicateLink(...a),
		recordDistinctVerdict: (...a: unknown[]) =>
			mockRecordDistinctVerdict(...a),
		listStoryDuplicateEmbeddingMetadata: (...a: unknown[]) =>
			mockListStoryDuplicateEmbeddingMetadata(...a),
		listStoryDuplicateEmbeddings: (...a: unknown[]) =>
			mockListStoryDuplicateEmbeddings(...a),
		upsertStoryDuplicateEmbeddings: (...a: unknown[]) =>
			mockUpsertStoryDuplicateEmbeddings(...a),
		setProjectLastDuplicateScanAt: (...a: unknown[]) =>
			mockSetProjectLastDuplicateScanAt(...a),
		countItemsWithPendingDuplicateLinks: (...a: unknown[]) =>
			mockCountItemsWithPendingDuplicateLinks(...a),
		// Required by transitively imported modules (e.g. @repo/ai).
		GATEWAY_PROVIDERS: [],
		DB_GATEWAY_PROVIDERS: [],
	};
});

vi.mock("@repo/temporal", async () => {
	// The procedure needs only the shared core; load the REAL implementation
	// (its @repo/database / @repo/ai / @repo/rag imports resolve to the mocks
	// above) instead of the full barrel, which would drag the Temporal SDK
	// into the test process.
	const core = await vi.importActual<
		typeof import("@repo/temporal/duplicate-scan-core")
	>("@repo/temporal/duplicate-scan-core");
	return {
		runDuplicateScanCore: core.runDuplicateScanCore,
		EmbeddingUnavailableError: core.EmbeddingUnavailableError,
	};
});

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: (...args: unknown[]) => {
			uses.push(...args);
			return chainable;
		},
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.scan = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: (perm: string) => {
			uses.push({ requireProjectPermission: perm });
			return (c: unknown) => c;
		},
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

import "../scan-duplicates";

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

function runScan() {
	return handlers.scan({
		input: { projectId: "proj-1", organizationId: null },
		context: ctx,
	}) as Promise<{
		scanned: number;
		candidates: number;
		confirmed: number;
		truncated: number;
		verifierFailures: number;
		flaggedItems: number;
	}>;
}

/** Base name the resolver and the embedding generator agree on (the core
 * strips the provider prefix from the resolver's modelString). */
const EMBEDDING_MODEL = "text-embedding-3-small";

const HASH_RE = /^[0-9a-f]{64}$/;

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockListDismissedDuplicatePairKeys.mockResolvedValue([]);
	mockListVerdictValidPairKeys.mockResolvedValue([]);
	mockRecordDistinctVerdict.mockResolvedValue(undefined);
	mockGetAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: vi.fn(),
	});
	mockResolveModelWithProvider.mockResolvedValue({
		modelString: `openai/${EMBEDDING_MODEL}`,
	});
	// Empty cache by default: every item is stale, so first-run behaviour is
	// a full scan (embed everything, compare every pair).
	mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([]);
	mockListStoryDuplicateEmbeddings.mockResolvedValue([]);
	mockUpsertStoryDuplicateEmbeddings.mockResolvedValue(undefined);
	mockSetProjectLastDuplicateScanAt.mockResolvedValue(undefined);
	mockCountItemsWithPendingDuplicateLinks.mockResolvedValue(0);
});

/** Up-to-date cache metadata row for a story (hash of its CURRENT detection
 * text) unless overridden. */
function cacheRowFor(
	story: { id: string; title: string; description: string | null },
	embedding: number[],
	overrides?: Partial<{ contentHash: string; model: string }>,
) {
	return {
		storyId: story.id,
		contentHash:
			overrides?.contentHash ??
			hashDetectionText(
				buildDetectionText(story.title, story.description),
			),
		model: overrides?.model ?? EMBEDDING_MODEL,
		embedding,
	};
}

describe("scanDuplicatesProcedure — verdict routing", () => {
	it("requires STORY_UPDATE permission", () => {
		const found = uses.some(
			(u) =>
				typeof u === "object" &&
				u !== null &&
				(u as { requireProjectPermission?: string })
					.requireProjectPermission === "STORY_UPDATE",
		);
		expect(found).toBe(true);
	});

	it("early-returns when fewer than 2 detectable stories", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([
			{
				id: "s1",
				identifier: "F-1",
				title: "Only one",
				description: null,
			},
		]);
		mockCountItemsWithPendingDuplicateLinks.mockResolvedValue(2);
		const result = await runScan();
		expect(result).toEqual({
			scanned: 1,
			candidates: 0,
			confirmed: 0,
			truncated: 0,
			verifierFailures: 0,
			flaggedItems: 2,
		});
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
		// Even the early return stamps the scan time and reports the current
		// flagged state so the completion modal matches the roadmap filter.
		expect(mockSetProjectLastDuplicateScanAt).toHaveBeenCalledWith(
			"proj-1",
			expect.any(Date),
		);
	});

	it("flags a same-work-item verdict as a DUPLICATE link with the pair's hashes", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([
			{
				id: "s1",
				identifier: "F-1",
				title: "Login crashes",
				description: null,
			},
			{
				id: "s2",
				identifier: "F-2",
				title: "Login crashes",
				description: null,
			},
		]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[1, 0, 0],
			],
			model: EMBEDDING_MODEL,
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "same_work_item",
				confidence: 0.95,
				reasoning: "same bug",
			},
			usage: {},
		});
		const result = await runScan();
		expect(result.candidates).toBe(1);
		expect(result.confirmed).toBe(1);
		expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledTimes(1);
		expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				storyAId: "s1",
				storyBId: "s2",
				confidence: 0.95,
				linkType: "DUPLICATE",
				contentHashA: expect.stringMatching(HASH_RE),
				contentHashB: expect.stringMatching(HASH_RE),
			}),
		);
	});

	it("flags an overlapping-scope pair as an OVERLAP link (the 573/595 class)", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([
			{
				id: "s573",
				identifier: "F-573",
				title: "AI-Assisted Priority Management Page for Roadmap",
				description: null,
			},
			{
				id: "s595",
				identifier: "F-595",
				title: "Add AI-driven priority scoring and ranking for roadmap feature proposals",
				description: null,
			},
		]);
		// Strong-but-not-near-identical similarity (~0.78) — below the old
		// 0.86 gate, inside the new candidate band.
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[0.78, Math.sqrt(1 - 0.78 * 0.78), 0],
			],
			model: EMBEDDING_MODEL,
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "overlapping_scope",
				confidence: 0.85,
				reasoning: "same capability, different framing",
			},
			usage: {},
		});
		const result = await runScan();
		expect(result.candidates).toBe(1);
		expect(result.confirmed).toBe(1);
		expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledWith(
			expect.objectContaining({
				storyAId: "s573",
				storyBId: "s595",
				linkType: "OVERLAP",
			}),
		);
	});

	it("NEVER flags unrelated items (orthogonal embeddings → no candidate, no LLM call)", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([
			{
				id: "s1",
				identifier: "F-1",
				title: "Login crashes",
				description: null,
			},
			{
				id: "s2",
				identifier: "F-2",
				title: "Dark mode toggle",
				description: null,
			},
		]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[0, 1, 0],
			],
			model: EMBEDDING_MODEL,
		});
		const result = await runScan();
		expect(result.candidates).toBe(0);
		expect(result.confirmed).toBe(0);
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
	});

	it("caches a distinct verdict (with hashes) instead of flagging", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([
			{
				id: "s1",
				identifier: "F-1",
				title: "Add login button",
				description: null,
			},
			{
				id: "s2",
				identifier: "F-2",
				title: "Add login button",
				description: null,
			},
		]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[1, 0, 0],
			],
			model: EMBEDDING_MODEL,
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "distinct",
				confidence: 0.9,
				reasoning: "opposite changes",
			},
			usage: {},
		});
		const result = await runScan();
		expect(result.candidates).toBe(1);
		expect(result.confirmed).toBe(0);
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
		expect(mockRecordDistinctVerdict).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				storyAId: "s1",
				storyBId: "s2",
				contentHashA: expect.stringMatching(HASH_RE),
				contentHashB: expect.stringMatching(HASH_RE),
			}),
		);
	});

	it("surfaces verifierFailures without throwing when every candidate pair fails to verify (the manual path must not masquerade as a clean scan)", async () => {
		// A transient verifier/AI outage: generateObject rejects for the single
		// candidate pair. The manual scan does NOT throw on a wholesale verifier
		// failure (unlike the Temporal path), so the ONLY signal the UI has that
		// the scan couldn't check anything is verifierFailures === candidates.
		mockListActiveStoriesForDetection.mockResolvedValue([
			{
				id: "s1",
				identifier: "F-1",
				title: "Add login button",
				description: null,
			},
			{
				id: "s2",
				identifier: "F-2",
				title: "Add login button",
				description: null,
			},
		]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[1, 0, 0],
			],
			model: EMBEDDING_MODEL,
		});
		mockGenerateObject.mockRejectedValue(new Error("gateway timeout"));

		const result = await runScan();

		expect(result.candidates).toBe(1);
		expect(result.confirmed).toBe(0);
		expect(result.verifierFailures).toBe(1);
		// Neither verdict polarity was persisted — the pair stays unverified and
		// is retried next run.
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
		expect(mockRecordDistinctVerdict).not.toHaveBeenCalled();
	});

	it("a LOW-CONFIDENCE non-distinct verdict also persists a negative verdict (drain progress must be monotonic)", async () => {
		// If this pair persisted NOTHING, borderline pairs would re-enter
		// every scan's top-60 candidate list and livelock the
		// post-version-bump drain.
		mockListActiveStoriesForDetection.mockResolvedValue([
			{
				id: "s1",
				identifier: "F-1",
				title: "Same thing",
				description: null,
			},
			{
				id: "s2",
				identifier: "F-2",
				title: "Same thing",
				description: null,
			},
		]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[1, 0, 0],
			],
			model: EMBEDDING_MODEL,
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "overlapping_scope",
				confidence: 0.4,
				reasoning: "unsure",
			},
			usage: {},
		});
		const result = await runScan();
		expect(result.confirmed).toBe(0);
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
		expect(mockRecordDistinctVerdict).toHaveBeenCalledWith(
			expect.objectContaining({
				storyAId: "s1",
				storyBId: "s2",
				confidence: 0.4,
			}),
		);
	});

	it("skips a previously-dismissed pair (no LLM call, no upsert)", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([
			{ id: "s1", identifier: "F-1", title: "Dup", description: null },
			{ id: "s2", identifier: "F-2", title: "Dup", description: null },
		]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[1, 0, 0],
			],
			model: EMBEDDING_MODEL,
		});
		// canonical key is "s1:s2" (s1 < s2)
		mockListDismissedDuplicatePairKeys.mockResolvedValue(["s1:s2"]);
		const result = await runScan();
		expect(result.candidates).toBe(0);
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
	});

	it("skips a pair whose stored verdict is still valid at the current hashes (no LLM call)", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([
			{ id: "s1", identifier: "F-1", title: "Dup", description: null },
			{ id: "s2", identifier: "F-2", title: "Dup", description: null },
		]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[1, 0, 0],
			],
			model: EMBEDDING_MODEL,
		});
		mockListVerdictValidPairKeys.mockResolvedValue(["s1:s2"]);
		const result = await runScan();
		expect(result.candidates).toBe(0);
		expect(mockGenerateObject).not.toHaveBeenCalled();
		// The exclusion is computed from the CURRENT hashes — the query gets
		// the same hash map the staleness check uses.
		expect(mockListVerdictValidPairKeys).toHaveBeenCalledWith(
			"proj-1",
			expect.any(Map),
		);
	});

	it("denies access for a non-member tenant", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		await expect(runScan()).rejects.toThrow(/access/i);
		expect(mockListActiveStoriesForDetection).not.toHaveBeenCalled();
	});
});

describe("scanDuplicatesProcedure — embedding cache + verdict-driven verification", () => {
	const STORIES = [
		{
			id: "s1",
			identifier: "F-1",
			title: "Login crashes on submit",
			description: null,
		},
		{
			id: "s2",
			identifier: "F-2",
			title: "Login crashes when submitting",
			description: null,
		},
		{
			id: "s3",
			identifier: "F-3",
			title: "Export report as PDF",
			description: null,
		},
	] as const;

	it("first run (empty cache): embeds every item and populates the cache after verification", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([...STORIES]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 1, 0],
				[1, 1, 0.01],
				[0, 0, 1],
			],
			model: EMBEDDING_MODEL,
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "same_work_item",
				confidence: 0.92,
				reasoning: "same",
			},
			usage: {},
		});
		mockCountItemsWithPendingDuplicateLinks.mockResolvedValue(2);

		const result = await runScan();

		// All three items embedded in one call (full scan).
		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
		expect(mockGenerateEmbeddings.mock.calls[0][0]).toEqual(
			STORIES.map((s) => buildDetectionText(s.title, s.description)),
		);
		// Cache populated for all three with the current hash + model, written
		// exactly once, AFTER the verifier processed the pairs.
		expect(mockUpsertStoryDuplicateEmbeddings).toHaveBeenCalledTimes(1);
		expect(mockUpsertStoryDuplicateEmbeddings).toHaveBeenCalledWith(
			"proj-1",
			STORIES.map((s, i) => ({
				storyId: s.id,
				contentHash: hashDetectionText(
					buildDetectionText(s.title, s.description),
				),
				model: EMBEDDING_MODEL,
				embedding: [
					[1, 1, 0],
					[1, 1, 0.01],
					[0, 0, 1],
				][i],
			})),
		);
		const persistOrder =
			mockUpsertStoryDuplicateEmbeddings.mock.invocationCallOrder[0];
		const lastVerifyOrder = Math.max(
			...mockGenerateObject.mock.invocationCallOrder,
		);
		expect(persistOrder).toBeGreaterThan(lastVerifyOrder);
		expect(result).toMatchObject({
			scanned: 3,
			candidates: 1,
			confirmed: 1,
			flaggedItems: 2,
		});
		expect(mockSetProjectLastDuplicateScanAt).toHaveBeenCalledWith(
			"proj-1",
			expect.any(Date),
		);
	});

	it("fully-verified re-scan: zero embedding calls and zero LLM calls (verdict cache covers every band pair)", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([...STORIES]);
		const cachedRows = [
			cacheRowFor(STORIES[0], [1, 1, 0]),
			cacheRowFor(STORIES[1], [1, 1, 0.01]),
			cacheRowFor(STORIES[2], [0, 0, 1]),
		];
		mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue(
			cachedRows.map(({ embedding: _embedding, ...meta }) => meta),
		);
		mockListStoryDuplicateEmbeddings.mockResolvedValue(cachedRows);
		// The only band pair (s1:s2) already has a stored verdict at the
		// current hashes.
		mockListVerdictValidPairKeys.mockResolvedValue(["s1:s2"]);
		mockCountItemsWithPendingDuplicateLinks.mockResolvedValue(26);

		const result = await runScan();

		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockUpsertStoryDuplicateEmbeddings).not.toHaveBeenCalled();
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
		expect(result).toEqual({
			scanned: 3,
			candidates: 0,
			confirmed: 0,
			truncated: 0,
			verifierFailures: 0,
			flaggedItems: 26,
		});
	});

	it("a warm embedding cache alone can NOT skip verification — unverified band pairs are still LLM-verified (the version-bump drain guarantee)", async () => {
		// Scenario: a background auto-detect run re-warmed the embedding cache
		// for the whole backlog (e.g. right after a DETECTION_VERSION bump),
		// but the pairs between pre-existing items have no stored verdicts
		// yet. The manual scan must verify them — embedding staleness is an
		// embedding-cost optimization, never the verification driver.
		mockListActiveStoriesForDetection.mockResolvedValue([...STORIES]);
		const cachedRows = [
			cacheRowFor(STORIES[0], [1, 1, 0]),
			cacheRowFor(STORIES[1], [1, 1, 0.01]),
			cacheRowFor(STORIES[2], [0, 0, 1]),
		];
		mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue(
			cachedRows.map(({ embedding: _embedding, ...meta }) => meta),
		);
		mockListStoryDuplicateEmbeddings.mockResolvedValue(cachedRows);
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "same_work_item",
				confidence: 0.9,
				reasoning: "same",
			},
			usage: {},
		});

		const result = await runScan();

		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
		expect(result.candidates).toBe(1);
		expect(result.confirmed).toBe(1);
		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledWith(
			expect.objectContaining({ storyAId: "s1", storyBId: "s2" }),
		);
	});

	it("one changed item: re-embeds only it; verdict-covered pairs between unchanged items are not re-paid", async () => {
		const changed = {
			id: "s1",
			identifier: "F-1",
			title: "Login crashes on submit (edited)",
			description: null,
		};
		const unchangedA = {
			id: "s2",
			identifier: "F-2",
			title: "Search filter resets",
			description: null,
		};
		const unchangedB = {
			id: "s3",
			identifier: "F-3",
			title: "Search filters reset",
			description: null,
		};
		mockListActiveStoriesForDetection.mockResolvedValue([
			changed,
			unchangedA,
			unchangedB,
		]);
		// s1's cached hash no longer matches its edited text; s2/s3 are
		// current. s2 and s3 are near-identical to EACH OTHER but their pair
		// already has a stored verdict at the current hashes — it must not be
		// re-paid.
		const cachedRows = [
			cacheRowFor(changed, [0, 1, 0], {
				contentHash: "hash-before-edit",
			}),
			cacheRowFor(unchangedA, [1, 1, 0]),
			cacheRowFor(unchangedB, [1, 1, 0.01]),
		];
		mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue(
			cachedRows.map(({ embedding: _embedding, ...meta }) => meta),
		);
		mockListStoryDuplicateEmbeddings.mockResolvedValue(cachedRows);
		mockListVerdictValidPairKeys.mockResolvedValue(["s2:s3"]);
		// Fresh s1 vector lands close to both unchanged items.
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [[1, 1, 0.02]],
			model: EMBEDDING_MODEL,
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "distinct",
				confidence: 0.9,
				reasoning: "no",
			},
			usage: {},
		});

		const result = await runScan();

		// Only the changed item's text was embedded…
		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
		expect(mockGenerateEmbeddings.mock.calls[0][0]).toEqual([
			buildDetectionText(changed.title, changed.description),
		]);
		// …and only its cache row rewritten.
		expect(mockUpsertStoryDuplicateEmbeddings).toHaveBeenCalledWith(
			"proj-1",
			[
				{
					storyId: changed.id,
					contentHash: hashDetectionText(
						buildDetectionText(changed.title, changed.description),
					),
					model: EMBEDDING_MODEL,
					embedding: [1, 1, 0.02],
				},
			],
		);
		// Exactly the two pairs touching the edited s1 were verified; the
		// verdict-covered s2:s3 pair was not.
		expect(result.candidates).toBe(2);
		expect(mockGenerateObject).toHaveBeenCalledTimes(2);
		for (const call of mockGenerateObject.mock.calls) {
			expect((call[0] as { prompt: string }).prompt).toContain("(F-1)");
		}
	});

	it("model change invalidates the whole cache (every item re-embedded)", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([
			STORIES[0],
			STORIES[2],
		]);
		// Hashes are current but the rows were embedded with a different
		// model — cosine across embedding spaces is meaningless, so both
		// must be re-embedded.
		const legacyRows = [
			cacheRowFor(STORIES[0], [1, 0, 0], { model: "legacy-embed-model" }),
			cacheRowFor(STORIES[2], [0, 1, 0], { model: "legacy-embed-model" }),
		];
		mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue(
			legacyRows.map(({ embedding: _embedding, ...meta }) => meta),
		);
		mockListStoryDuplicateEmbeddings.mockResolvedValue(legacyRows);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[0, 1, 0],
			],
			model: EMBEDDING_MODEL,
		});

		await runScan();

		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
		expect(mockGenerateEmbeddings.mock.calls[0][0]).toHaveLength(2);
		expect(mockUpsertStoryDuplicateEmbeddings).toHaveBeenCalledWith(
			"proj-1",
			expect.arrayContaining([
				expect.objectContaining({
					storyId: "s1",
					model: EMBEDDING_MODEL,
				}),
				expect.objectContaining({
					storyId: "s3",
					model: EMBEDDING_MODEL,
				}),
			]),
		);
	});

	it("embedding failure still throws the configured-model error", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([
			STORIES[0],
			STORIES[1],
		]);
		mockGenerateEmbeddings.mockRejectedValue(
			new Error("provider unavailable"),
		);

		await expect(runScan()).rejects.toThrow(
			"Could not generate embeddings. Ensure an embedding model is configured in Settings → AI Models.",
		);
		expect(mockUpsertStoryDuplicateEmbeddings).not.toHaveBeenCalled();
		expect(mockUpsertPendingDuplicateLink).not.toHaveBeenCalled();
	});

	it("model-resolution failure throws the same configured-model error before any embedding work", async () => {
		mockListActiveStoriesForDetection.mockResolvedValue([
			STORIES[0],
			STORIES[1],
		]);
		mockResolveModelWithProvider.mockRejectedValue(
			new Error("provider does not have a model mapping for embeddings"),
		);

		await expect(runScan()).rejects.toThrow(
			"Could not generate embeddings. Ensure an embedding model is configured in Settings → AI Models.",
		);
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
		expect(mockUpsertStoryDuplicateEmbeddings).not.toHaveBeenCalled();
	});

	it("verifier failure: successful pairs' links land; only the FAILED pair's items stay stale (per-item cache persist)", async () => {
		// Embeddings chosen so the pair similarity ordering is deterministic:
		// (s1,s2) ≈ 1.0 is verified first and FAILS; the two cross pairs to
		// s3 (~0.96) succeed. s1/s2 must stay stale for retry; s3's work is
		// complete and must be stamped.
		mockListActiveStoriesForDetection.mockResolvedValue([
			{
				id: "s1",
				identifier: "F-1",
				title: "Same thing",
				description: null,
			},
			{
				id: "s2",
				identifier: "F-2",
				title: "Same thing!",
				description: null,
			},
			{
				id: "s3",
				identifier: "F-3",
				title: "Same thing?",
				description: null,
			},
		]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 1, 0],
				[1, 1, 0.001],
				[1, 1, 0.4],
			],
			model: EMBEDDING_MODEL,
		});
		mockGenerateObject
			.mockRejectedValueOnce(new Error("verifier timeout"))
			.mockResolvedValue({
				object: {
					relationship: "same_work_item",
					confidence: 0.9,
					reasoning: "same",
				},
				usage: {},
			});

		const result = await runScan();

		// The scan completes and keeps the verdicts it did get…
		expect(result.candidates).toBe(3);
		expect(result.confirmed).toBe(2);
		expect(mockUpsertPendingDuplicateLink).toHaveBeenCalledTimes(2);
		// …and stamps only the item whose pairs all verified. s1/s2 (the
		// failed pair) stay stale so it is re-selected next scan.
		expect(mockUpsertStoryDuplicateEmbeddings).toHaveBeenCalledTimes(1);
		const [, persistedRows] = mockUpsertStoryDuplicateEmbeddings.mock
			.calls[0] as [string, Array<{ storyId: string }>];
		expect(persistedRows.map((r) => r.storyId)).toEqual(["s3"]);
	});

	it("cap truncation: verdicts persist per-pair (drain progress) and only dropped pairs' items stay stale", async () => {
		// 12 near-identical items ⇒ 66 candidate pairs, 6 beyond the cap of
		// 60. The 60 verified pairs each record a verdict; only items in the
		// 6 dropped pairs stay stale for the next scan.
		const many = Array.from({ length: 12 }, (_, i) => ({
			id: `s${String(i + 1).padStart(2, "0")}`,
			identifier: `F-${i + 1}`,
			title: `Same underlying ticket ${i + 1}`,
			description: null,
		}));
		mockListActiveStoriesForDetection.mockResolvedValue(many);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: many.map((_, i) => [1, 1, i * 0.0001]),
			model: EMBEDDING_MODEL,
		});
		mockGenerateObject.mockResolvedValue({
			object: {
				relationship: "distinct",
				confidence: 0.9,
				reasoning: "no",
			},
			usage: {},
		});

		const result = await runScan();

		expect(result.truncated).toBe(6);
		expect(mockGenerateObject).toHaveBeenCalledTimes(60);
		// Every verified pair recorded its (negative) verdict — that is what
		// guarantees the next scan verifies the REMAINING pairs instead of
		// re-paying these 60 forever.
		expect(mockRecordDistinctVerdict).toHaveBeenCalledTimes(60);
		// The cache write happened but excluded the items of the 6 dropped
		// pairs (they must stay stale so those pairs are retried).
		expect(mockUpsertStoryDuplicateEmbeddings).toHaveBeenCalledTimes(1);
		const [, persistedRows] = mockUpsertStoryDuplicateEmbeddings.mock
			.calls[0] as [string, Array<{ storyId: string }>];
		expect(persistedRows.length).toBeGreaterThan(0);
		expect(persistedRows.length).toBeLessThan(12);
	});
});
