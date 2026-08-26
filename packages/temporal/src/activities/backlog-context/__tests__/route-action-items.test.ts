/**
 * Tests for `routeActionItemsToExistingTickets` — the Create-vs-Enrich pass
 * that runs over the create-only proposal produced by the four capture-as-is
 * ingestion flows.
 *
 * Strategy mirrors `detect-duplicate-stories.test.ts`: mock the embedding
 * provider (@repo/rag), the judge (@repo/ai), the logger and the one DB query,
 * but run the REAL pure routing lib (spread back in via `vi.importActual`) so
 * the shortlist, the 6,000-char text and the thresholds are genuinely exercised
 * rather than stubbed.
 *
 * The behaviours worth pinning:
 *   - a confident match is rewritten into an update against that ticket, with
 *     the action item's ORIGINAL content kept on the routing stamp,
 *   - below-threshold confidence, an identifier the judge invented, and a judge
 *     error all leave the item a create — the safe direction,
 *   - a wholesale outage never throws and never silently looks like a clean
 *     "everything is new",
 *   - closed tickets are not candidates.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test src/activities/backlog-context/__tests__/route-action-items.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGenerateEmbeddings,
	mockGenerateObject,
	mockTrackUsage,
	mockGetAIModelWithMetadata,
	mockListActiveStories,
	mockFindUniqueProject,
	mockHeartbeat,
	mockResolveModelWithProvider,
	mockListCacheMeta,
	mockListCacheRows,
	mockUpsertCache,
	mockGetBoundPrompt,
} = vi.hoisted(() => ({
	mockGenerateEmbeddings: vi.fn(),
	mockGenerateObject: vi.fn(),
	mockTrackUsage: vi.fn(),
	mockGetAIModelWithMetadata: vi.fn(),
	mockListActiveStories: vi.fn(),
	mockFindUniqueProject: vi.fn(),
	mockHeartbeat: vi.fn(),
	mockResolveModelWithProvider: vi.fn(),
	mockListCacheMeta: vi.fn(),
	mockListCacheRows: vi.fn(),
	mockUpsertCache: vi.fn(),
	mockGetBoundPrompt: vi.fn(),
}));

vi.mock("@repo/rag", () => ({ generateEmbeddings: mockGenerateEmbeddings }));

vi.mock("@temporalio/activity", () => ({ heartbeat: mockHeartbeat }));

vi.mock("@repo/ai", () => ({
	generateObject: mockGenerateObject,
	getAIModelWithMetadata: mockGetAIModelWithMetadata,
	resolveModelWithProvider: mockResolveModelWithProvider,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", async () => {
	// Keep the REAL pure routing lib running — it has no DB/AI imports, and
	// stubbing it would leave the shortlist and the 6,000-char text untested.
	const pure = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/action-item-routing")
	>("@repo/database/prisma/queries/projects/action-item-routing");
	// `baseModelName` and `cosineSimilarity` live in the sibling
	// duplicate-detection module; keep both real so staleness and scoring are
	// genuinely exercised.
	const detection = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
	>("@repo/database/prisma/queries/projects/duplicate-detection");
	return {
		...detection,
		...pure,
		listActiveStoriesForDetection: mockListActiveStories,
		listStoryDuplicateEmbeddingMetadata: mockListCacheMeta,
		listStoryDuplicateEmbeddings: mockListCacheRows,
		upsertStoryDuplicateEmbeddings: mockUpsertCache,
		getBoundPromptForAgent: mockGetBoundPrompt,
		db: { project: { findUnique: mockFindUniqueProject } },
	};
});

import {
	buildDetectionText,
	hashDetectionText,
} from "@repo/database/prisma/queries/projects/duplicate-detection";
import { routeActionItemsToExistingTickets } from "../route-action-items";

type Change = Parameters<
	typeof routeActionItemsToExistingTickets
>[0]["changes"][number];

const BASE_PARAMS = {
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-1",
};

function createChange(overrides: Partial<Change> = {}): Change {
	return {
		type: "feature",
		action: "create",
		title: { to: "Rate limit the export endpoint" },
		description: { to: "Large exports lock the worker." },
		reasoning: "Raised twice in the meeting",
		sourceContext: "meeting_transcript",
		...overrides,
	} as Change;
}

const TICKET = {
	id: "story-1",
	identifier: "F-12",
	title: "Export throttling",
	description: "Exports need a queue.",
	acceptanceCriteria: "GIVEN a large export THEN it is queued.",
};

/**
 * Wire the mocks so the single action item and the single candidate embed to
 * identical vectors (cosine 1.0), clearing any floor. The judge returns
 * `verdict`.
 */
function arrange(
	verdict: {
		decision: "create" | "enrich";
		targetIdentifier?: string | null;
		confidence: number;
		reasoning?: string;
	},
	tickets = [TICKET],
) {
	mockListActiveStories.mockResolvedValue(tickets);
	mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
		embeddings: texts.map(() => [1, 0, 0]),
		model: "text-embedding-3-small",
	}));
	mockGetAIModelWithMetadata.mockResolvedValue({
		model: { id: "test-model" },
		trackUsage: mockTrackUsage,
	});
	mockGenerateObject.mockResolvedValue({ object: verdict });
}

beforeEach(() => {
	vi.clearAllMocks();
	// Routing is opt-in; the pass reads the flag itself. Default the suite to
	// enabled so each test exercises the algorithm, and flip it off explicitly
	// in the opt-in tests below.
	mockFindUniqueProject.mockResolvedValue({ actionItemRoutingEnabled: true });
	// Embedding cache: default to empty (everything stale), so the existing
	// tests keep exercising the full embed-and-compare path.
	mockResolveModelWithProvider.mockResolvedValue({
		modelString: "text-embedding-3-small",
	});
	mockListCacheMeta.mockResolvedValue([]);
	mockListCacheRows.mockResolvedValue([]);
	mockUpsertCache.mockResolvedValue(undefined);
	// Default: no operator has bound a judge prompt, so the shipped wording runs.
	mockGetBoundPrompt.mockResolvedValue(null);
	delete process.env.ACTION_ITEM_ROUTING_COSINE_FLOOR;
	delete process.env.ACTION_ITEM_ROUTING_CONFIDENCE_THRESHOLD;
});

describe("routeActionItemsToExistingTickets", () => {
	it("rewrites a confident match into an update against that ticket", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.92,
			reasoning: "Same export throttling work.",
		});

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(result.enriched).toBe(1);
		const change = result.changes[0];
		expect(change.action).toBe("update");
		expect(change.existingId).toBe("story-1");
		expect(change.existingIdentifier).toBe("F-12");
		// The row now edits an existing ticket, so its title stands — a
		// from === to title renders no title change in the review diff.
		expect(change.title.from).toBe("Export throttling");
		expect(change.title.to).toBe("Export throttling");
		// `from` seeded with the target's TRUE current body so the diff is
		// honest even if the structure-preserving pass later safe-holds.
		expect(change.description?.from).toBe("Exports need a queue.");
		expect(change.routing?.decision).toBe("enrich");
		expect(change.routing?.confidence).toBe(0.92);
		expect(change.routing?.matchedIdentifier).toBe("F-12");
		expect(change.routing?.matchedTitle).toBe("Export throttling");
	});

	it("keeps the action item as captured so a reviewer's override cannot re-submit the wrong ticket's body", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.92,
		});

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		// This is what the review UI re-submits when the reviewer re-targets the
		// enrichment. Without it, the body already merged for F-12 would be
		// written onto whatever ticket they chose instead.
		expect(result.changes[0].routing?.proposedTitle).toBe(
			"Rate limit the export endpoint",
		);
		expect(result.changes[0].routing?.proposedDescription).toBe(
			"Large exports lock the worker.",
		);
	});

	it("leaves the item a create when the judge is below the confidence threshold", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.5,
		});

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(result.created).toBe(1);
		expect(result.enriched).toBe(0);
		expect(result.changes[0].action).toBe("create");
		expect(result.changes[0].existingId).toBeUndefined();
		expect(result.changes[0].routing?.decision).toBe("create");
	});

	it("honours a configured confidence threshold", async () => {
		process.env.ACTION_ITEM_ROUTING_CONFIDENCE_THRESHOLD = "0.95";
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.92,
		});

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		// 0.92 cleared the 0.7 default in the first test; it must not clear 0.95.
		expect(result.changes[0].action).toBe("create");
	});

	it("degrades to create when the judge names a ticket that was not on the shortlist", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-999",
			confidence: 0.99,
		});

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		// A hallucinated identifier must never address some other row.
		expect(result.changes[0].action).toBe("create");
		expect(result.changes[0].existingId).toBeUndefined();
	});

	it("matches the identifier case-insensitively", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: " f-12 ",
			confidence: 0.9,
		});

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(result.changes[0].action).toBe("update");
		expect(result.changes[0].existingIdentifier).toBe("F-12");
	});

	it("contains a single item's judge failure and stamps the error", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockGenerateObject.mockRejectedValue(new Error("model exploded"));

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(result.failed).toBe(1);
		expect(result.changes[0].action).toBe("create");
		// The NFR: a failed evaluation must surface an error state, not pass as
		// a considered "this is new work".
		expect(result.changes[0].routing?.error).toContain("model exploded");
	});

	it("never throws when embeddings are unavailable, and marks every item as unevaluated", async () => {
		mockListActiveStories.mockResolvedValue([TICKET]);
		mockGenerateEmbeddings.mockRejectedValue(new Error("embedding outage"));

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange(), createChange({ title: { to: "Other" } })],
		});

		// Routing is an enhancement; an outage must not lose the meeting's
		// content by failing the whole ingest.
		expect(result.failed).toBe(2);
		expect(result.changes.every((c) => c.action === "create")).toBe(true);
		expect(result.changes[0].routing?.error).toContain("embedding outage");
		expect(result.changes[1].routing?.error).toContain("embedding outage");
	});

	it("never throws when the candidate query fails", async () => {
		mockListActiveStories.mockRejectedValue(new Error("db down"));

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(result.failed).toBe(1);
		expect(result.changes[0].routing?.error).toContain("db down");
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
	});

	it("classifies everything as create — without an LLM call — when the project has no tickets", async () => {
		mockListActiveStories.mockResolvedValue([]);

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(result.created).toBe(1);
		expect(result.changes[0].routing?.decision).toBe("create");
		expect(result.changes[0].routing?.error).toBeUndefined();
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("skips the judge entirely when nothing clears the cosine floor", async () => {
		mockListActiveStories.mockResolvedValue([TICKET]);
		// Orthogonal vectors: cosine 0, far below any floor.
		mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
			embeddings: texts.map((_t, i) => (i === 0 ? [1, 0] : [0, 1])),
			model: "text-embedding-3-small",
		}));
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: { id: "test-model" },
			trackUsage: mockTrackUsage,
		});

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(result.created).toBe(1);
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("embeds the ticket's acceptance criteria, not just title and description", async () => {
		arrange({ decision: "create", confidence: 1 });

		await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		const embeddedTexts = mockGenerateEmbeddings.mock
			.calls[0][0] as string[];
		expect(
			embeddedTexts.some((t) => t.includes(TICKET.acceptanceCriteria)),
		).toBe(true);
	});

	it("does nothing when there is no create to route", async () => {
		const update = createChange({
			action: "update",
			existingId: "story-9",
		});

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [update],
		});

		expect(result).toEqual({
			changes: [update],
			enriched: 0,
			created: 0,
			failed: 0,
		});
		expect(mockListActiveStories).not.toHaveBeenCalled();
	});

	it("routes only the creates in a mixed proposal, leaving updates untouched", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.9,
		});
		const preexistingUpdate = createChange({
			action: "update",
			existingId: "story-9",
			existingIdentifier: "F-9",
		});

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [preexistingUpdate, createChange()],
		});

		expect(result.changes[0].existingIdentifier).toBe("F-9");
		expect(result.changes[0].routing).toBeUndefined();
		expect(result.changes[1].existingIdentifier).toBe("F-12");
		expect(result.enriched).toBe(1);
	});
});

describe("project opt-in", () => {
	it("returns the proposal untouched — no stamps at all — when the project has not opted in", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.99,
		});
		mockFindUniqueProject.mockResolvedValue({
			actionItemRoutingEnabled: false,
		});
		const changes = [createChange()];

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes,
		});

		// Byte-identical to today's behaviour: the review row must render
		// exactly as it always has, with no routing control at all.
		expect(result).toEqual({
			changes,
			enriched: 0,
			created: 0,
			failed: 0,
		});
		expect(result.changes[0].routing).toBeUndefined();
		expect(mockListActiveStories).not.toHaveBeenCalled();
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
	});

	it("reads as opted out for a project that no longer exists", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockFindUniqueProject.mockResolvedValue(null);

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(result.changes[0].routing).toBeUndefined();
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
	});

	it("does not throw when the opt-in lookup itself fails", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockFindUniqueProject.mockRejectedValue(
			new Error("db connection lost"),
		);

		// The pass is documented never to throw. A DB blip on a lookup this
		// trivial must not propagate out through the analyzer and fail an ingest
		// whose LLM analysis had already succeeded.
		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(result).toEqual({
			changes: result.changes,
			enriched: 0,
			created: 0,
			failed: 0,
		});
		expect(result.changes[0].routing).toBeUndefined();
	});
});

describe("output token budget", () => {
	it("sends a maxOutputTokens ceiling when the resolved model reports metadata", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: { id: "test-model" },
			metadata: {
				provider: "DATABRICKS",
				maxOutputTokens: 8192,
				contextWindow: 128000,
			},
			trackUsage: mockTrackUsage,
		});

		await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		// Unbounded generation fails as a hang, not an error — and a hung judge
		// inside a heartbeated batch reads as a broken feature rather than a
		// slow one.
		const call = mockGenerateObject.mock.calls[0][0];
		expect(call.maxOutputTokens).toBeGreaterThan(0);
		expect(call.maxOutputTokens).toBeLessThanOrEqual(8192);
	});

	it("still runs when the resolved model reports no metadata", async () => {
		arrange({ decision: "create", confidence: 1 });
		// The budget clamp dereferences metadata; without the guard this throws
		// inside a pass documented never to throw.
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: { id: "test-model" },
			trackUsage: mockTrackUsage,
		});

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(result.created).toBe(1);
		expect(
			mockGenerateObject.mock.calls[0][0].maxOutputTokens,
		).toBeUndefined();
	});
});

describe("candidate embedding cache", () => {
	it("re-embeds nothing when every candidate is cached and unchanged", async () => {
		arrange({ decision: "create", confidence: 1 });
		const text = buildDetectionText(
			TICKET.title,
			TICKET.description,
			TICKET.acceptanceCriteria,
		);
		mockListCacheMeta.mockResolvedValue([
			{
				storyId: TICKET.id,
				contentHash: hashDetectionText(text),
				model: "text-embedding-3-small",
			},
		]);
		mockListCacheRows.mockResolvedValue([
			{
				storyId: TICKET.id,
				contentHash: hashDetectionText(text),
				model: "text-embedding-3-small",
				embedding: [1, 0, 0],
			},
		]);

		await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		// Only the ONE action item is embedded — the backlog is not. Without
		// this the pass re-embeds every active ticket on every ingestion run,
		// which is what took the duplicate scan down at ~350 tickets.
		const embedded = mockGenerateEmbeddings.mock.calls[0][0] as string[];
		expect(embedded).toHaveLength(1);
		expect(mockUpsertCache).toHaveBeenCalledWith("proj-1", []);
	});

	it("re-embeds a candidate whose cached row vanished between the two reads", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.9,
		});
		const text = buildDetectionText(
			TICKET.title,
			TICKET.description,
			TICKET.acceptanceCriteria,
		);
		// Metadata says the vector is fresh...
		mockListCacheMeta.mockResolvedValue([
			{
				storyId: TICKET.id,
				contentHash: hashDetectionText(text),
				model: "text-embedding-3-small",
			},
		]);
		// ...but the row is gone by the time the vectors are read (story deleted
		// mid-run). Trusting the metadata would drop this ticket out of every
		// shortlist for the run — the enrichment below would never be found.
		mockListCacheRows.mockResolvedValue([]);

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		// The candidate is re-embedded rather than skipped: one item + it.
		expect(mockGenerateEmbeddings.mock.calls[0][0]).toHaveLength(2);
		// And it is still routable, which is the point of not dropping it.
		expect(result.enriched).toBe(1);
	});

	it("re-embeds a candidate whose routing text changed", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockListCacheMeta.mockResolvedValue([
			{
				storyId: TICKET.id,
				contentHash: "stale-hash-from-an-older-body",
				model: "text-embedding-3-small",
			},
		]);

		await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		// One item + the one stale candidate.
		expect(mockGenerateEmbeddings.mock.calls[0][0]).toHaveLength(2);
		expect(mockUpsertCache).toHaveBeenCalledWith("proj-1", [
			expect.objectContaining({ storyId: TICKET.id }),
		]);
	});

	it("re-embeds everything when the embedding model changed", async () => {
		arrange({ decision: "create", confidence: 1 });
		const text = buildDetectionText(
			TICKET.title,
			TICKET.description,
			TICKET.acceptanceCriteria,
		);
		mockListCacheMeta.mockResolvedValue([
			{
				storyId: TICKET.id,
				contentHash: hashDetectionText(text),
				model: "a-different-embedding-model",
			},
		]);

		await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		// Cosine across vectors from two different models is meaningless, so a
		// model change must invalidate the whole cache.
		expect(mockGenerateEmbeddings.mock.calls[0][0]).toHaveLength(2);
	});

	it("still routes when the cache read fails", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.9,
		});
		mockListCacheMeta.mockRejectedValue(new Error("cache table missing"));

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		// Degrades to the pre-cache behaviour rather than failing the ingest.
		expect(result.enriched).toBe(1);
		expect(mockGenerateEmbeddings.mock.calls[0][0]).toHaveLength(2);
	});

	it("still routes when the cache write fails", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.9,
		});
		mockUpsertCache.mockRejectedValue(new Error("write conflict"));

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		// A failed write-back costs the next run some re-embedding; it must not
		// make this run wrong.
		expect(result.enriched).toBe(1);
	});

	it("does not embed action items that the cap will discard", async () => {
		arrange({ decision: "create", confidence: 1 });
		const changes = Array.from({ length: 45 }, (_, i) =>
			createChange({ title: { to: `Item ${i}` } }),
		);

		await routeActionItemsToExistingTickets({ ...BASE_PARAMS, changes });

		// 40 judged items + 1 stale candidate. The 5 over the cap are never
		// embedded, because they are never judged.
		expect(mockGenerateEmbeddings.mock.calls[0][0]).toHaveLength(41);
	});
});

describe("bounded, heartbeated judging", () => {
	it("heartbeats while working through the items", async () => {
		arrange({ decision: "create", confidence: 1 });
		const changes = Array.from({ length: 9 }, (_, i) =>
			createChange({ title: { to: `Item ${i}` } }),
		);

		await routeActionItemsToExistingTickets({ ...BASE_PARAMS, changes });

		// Every workflow that reaches this pass sets heartbeatTimeout: 2 minutes,
		// and the analyzer's own heartbeat interval is already cleared by now — so
		// a run of sequential COMPLEX judge calls without this gets the worker
		// killed mid-ingest.
		expect(mockHeartbeat).toHaveBeenCalled();
	});

	it("caps the judged items and reports the overflow as unevaluated", async () => {
		arrange({ decision: "create", confidence: 1 });
		const changes = Array.from({ length: 45 }, (_, i) =>
			createChange({ title: { to: `Item ${i}` } }),
		);

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes,
		});

		// 40 judged, 5 over the cap.
		expect(mockGenerateObject).toHaveBeenCalledTimes(40);
		expect(result.created).toBe(40);
		expect(result.failed).toBe(5);
		// The overflow must SAY it was not evaluated. An unevaluated item
		// presented as a considered "this is new work" is the false reassurance
		// the error state exists to prevent.
		const last = result.changes[44];
		expect(last.action).toBe("create");
		expect(last.routing?.error).toMatch(/first 40 action items/i);
		expect(last.routing?.confidence).toBe(0);
	});
});

describe("the judge prompt comes from the prompt library", () => {
	/**
	 * The judge's wording IS this feature's precision — how firmly it prefers
	 * Create when unsure decides whether a wrong enrichment silently edits a
	 * ticket the team relies on. It has to be tunable without a deploy, and it
	 * has to degrade to the shipped wording rather than failing an ingest.
	 */
	function promptSentToJudge(): string {
		return mockGenerateObject.mock.calls[0][0].prompt as string;
	}

	it("renders the bound prompt when an operator has one", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockGetBoundPrompt.mockResolvedValue({
			format: "HANDLEBARS",
			version: {
				content:
					"HOUSE RULES: {{{action_item}}} || {{{candidates}}} || {{{first_identifier}}}",
			},
		});

		await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		const prompt = promptSentToJudge();
		expect(prompt).toContain("HOUSE RULES:");
		// The slots are really populated — an empty render would still contain
		// the literal prefix above and prove nothing.
		expect(prompt).toContain("Rate limit the export endpoint");
		expect(prompt).toContain("F-12");
	});

	it("falls back to the shipped wording when nothing is bound", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockGetBoundPrompt.mockResolvedValue(null);

		await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(promptSentToJudge()).toContain(
			'When you are unsure, answer "create"',
		);
	});

	it("falls back rather than failing the ingest when the binding lookup throws", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockGetBoundPrompt.mockRejectedValue(new Error("prompt service down"));

		const result = await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(result.failed).toBe(0);
		expect(promptSentToJudge()).toContain("## Candidate tickets");
	});

	it("falls back when the bound template renders to nothing usable", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockGetBoundPrompt.mockResolvedValue({
			format: "HANDLEBARS",
			version: { content: "   " },
		});

		await routeActionItemsToExistingTickets({
			...BASE_PARAMS,
			changes: [createChange()],
		});

		expect(promptSentToJudge()).toContain("## Candidate tickets");
	});
});
