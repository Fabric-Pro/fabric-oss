/**
 * Tests for `semanticSearchProcedure` — roadmap AI search (Fizzy #1937).
 *
 * Strategy mirrors scan-duplicates.test.ts: mock the embedding provider
 * (`@repo/rag`), model resolution (`@repo/ai`) and the DB helpers
 * (`@repo/database`), but run the REAL pure detection lib — so the actual
 * staleness/cosine logic is exercised end-to-end through the procedure.
 *
 * Small 2-D vectors keep every expected cosine exact: [1,0]·[1,0]=1,
 * [1,0]·[0,1]=0 (below the 0.25 floor), etc.
 */

const { handlers, uses } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	uses: [] as unknown[],
}));

import {
	buildDetectionText,
	hashDetectionText,
} from "@repo/database/prisma/queries/projects/duplicate-detection";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateEmbeddings = vi.fn();
const mockResolveModelWithProvider = vi.fn();
const mockHasProjectAccess = vi.fn(async () => true);
const mockGetProjectTenantId = vi.fn();
const mockListSearchableStories = vi.fn();
const mockListStoryDuplicateEmbeddingMetadata = vi.fn();
const mockListStoryDuplicateEmbeddings = vi.fn();
const mockUpsertStoryDuplicateEmbeddings = vi.fn(async () => undefined);

vi.mock("@repo/rag", () => ({
	generateEmbeddings: (...a: unknown[]) => mockGenerateEmbeddings(...a),
}));

vi.mock("@repo/ai", () => ({
	resolveModelWithProvider: (...a: unknown[]) =>
		mockResolveModelWithProvider(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", async () => {
	const pure = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
	>("@repo/database/prisma/queries/projects/duplicate-detection");
	return {
		...pure,
		hasProjectAccess: (...a: unknown[]) => mockHasProjectAccess(...a),
		getProjectTenantId: (...a: unknown[]) => mockGetProjectTenantId(...a),
		listSearchableStories: (...a: unknown[]) =>
			mockListSearchableStories(...a),
		listStoryDuplicateEmbeddingMetadata: (...a: unknown[]) =>
			mockListStoryDuplicateEmbeddingMetadata(...a),
		listStoryDuplicateEmbeddings: (...a: unknown[]) =>
			mockListStoryDuplicateEmbeddings(...a),
		upsertStoryDuplicateEmbeddings: (...a: unknown[]) =>
			mockUpsertStoryDuplicateEmbeddings(...a),
		GATEWAY_PROVIDERS: [],
		DB_GATEWAY_PROVIDERS: [],
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
			handlers.semanticSearch = fn;
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

import "../semantic-search";

/** The shape `listSearchableStories` returns (what `detectionTextForStory`
 * consumes). Declared locally — importing Prisma types would drag the client
 * into the test process. */
type SearchableStory = {
	id: string;
	draftingStage: string;
	title: string;
	description: string | null;
	acceptanceCriteria: string | null;
	tasks: Array<{ title?: string | null; description?: string | null }>;
};

function makeStory(
	overrides: Partial<SearchableStory> & { id: string },
): SearchableStory {
	return {
		id: overrides.id,
		draftingStage: overrides.draftingStage ?? "DRAFT",
		title: overrides.title ?? "Test story",
		description:
			overrides.description === undefined ? null : overrides.description,
		acceptanceCriteria:
			overrides.acceptanceCriteria === undefined
				? null
				: overrides.acceptanceCriteria,
		tasks: overrides.tasks ?? [],
	};
}

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

function runSearch(query = "oauth login") {
	return handlers.semanticSearch({
		input: { projectId: "proj-1", organizationId: null, query },
		context: ctx,
	}) as Promise<{
		results: Array<{ storyId: string; score: number }>;
		coverage: {
			total: number;
			embedded: number;
			cached: number;
			skipped: number;
		};
	}>;
}

async function errorFrom(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (err) {
		return err as { code?: string; message?: string };
	}
	throw new Error("expected the handler to throw");
}

/** Cache metadata row whose hash matches the story's CURRENT detection text. */
function freshMetaRow(
	story: SearchableStory,
	model = "text-embedding-3-small",
) {
	return {
		storyId: story.id,
		contentHash: hashDetectionText(
			buildDetectionText(
				story.title,
				story.description,
				story.acceptanceCriteria,
				story.tasks,
			),
		),
		model,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	// Personal project by default; the org-project billing path is covered by
	// the tenant-derivation assertions below.
	mockGetProjectTenantId.mockResolvedValue({ organizationId: null });
	mockResolveModelWithProvider.mockResolvedValue({
		modelString: "openai/text-embedding-3-small",
	});
	mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([]);
	mockListStoryDuplicateEmbeddings.mockResolvedValue([]);
	mockUpsertStoryDuplicateEmbeddings.mockResolvedValue(undefined);
});

describe("semanticSearchProcedure — auth and gating", () => {
	it("requires STORY_READ and project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const err = await errorFrom(runSearch());
		expect(err.code).toBe("FORBIDDEN");
		expect(uses).toContainEqual({
			requireProjectPermission: "STORY_READ",
		});
	});

	it("bills AI usage against the project's OWN tenant, never caller input", async () => {
		// The security fix: the tenant comes from the access-checked project
		// row, so a forged organizationId in the request cannot redirect whose
		// provider key / credits are spent. (There is deliberately no way to
		// inject one — the schema no longer accepts it.)
		mockGetProjectTenantId.mockResolvedValue({
			organizationId: "org-project-owner",
		});
		mockListSearchableStories.mockResolvedValue([
			makeStory({ id: "a", title: "Login" }),
		]);
		mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [[1, 0]],
			model: "text-embedding-3-small",
		});
		await runSearch("login");
		expect(mockResolveModelWithProvider).toHaveBeenCalledWith(
			"EMBEDDING",
			expect.objectContaining({ organizationId: "org-project-owner" }),
		);
		expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: "org-project-owner",
				projectId: "proj-1",
			}),
		);
	});
});

describe("semanticSearchProcedure — ranking", () => {
	it("ranks by descending similarity, drops sub-floor scores, and reports coverage", async () => {
		const strong = makeStory({ id: "strong", title: "OAuth login flow" });
		const weak = makeStory({ id: "weak", title: "Billing export" });
		const unrelated = makeStory({ id: "unrelated", title: "Theme picker" });
		mockListSearchableStories.mockResolvedValue([strong, weak, unrelated]);
		// Warm cache: every story has an up-to-date row.
		mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([
			freshMetaRow(strong),
			freshMetaRow(weak),
			freshMetaRow(unrelated),
		]);
		mockListStoryDuplicateEmbeddings.mockResolvedValue([
			{ storyId: "strong", embedding: [1, 0] },
			{ storyId: "weak", embedding: [0.9, 0.1] },
			// Orthogonal to the query → cosine 0 → below the floor.
			{ storyId: "unrelated", embedding: [0, 1] },
		]);
		// Query rides alone in the batch (cache is warm — nothing stale).
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [[1, 0]],
			model: "text-embedding-3-small",
		});

		const out = await runSearch();
		expect(out.results.map((r) => r.storyId)).toEqual(["strong", "weak"]);
		expect(out.results[1]?.score).toBeCloseTo(0.9938, 3);
		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
		expect(mockGenerateEmbeddings.mock.calls[0]?.[0]).toEqual([
			"oauth login",
		]);
		expect(mockUpsertStoryDuplicateEmbeddings).not.toHaveBeenCalled();
		expect(out.coverage).toEqual({
			total: 3,
			embedded: 0,
			cached: 3,
			skipped: 0,
		});
	});

	it("re-embeds only stale stories, upserts their vectors, and ranks on the FRESH vector", async () => {
		const changed = makeStory({ id: "changed", title: "New billing page" });
		const unchanged = makeStory({ id: "unchanged", title: "Audit log" });
		mockListSearchableStories.mockResolvedValue([changed, unchanged]);
		mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([
			// "changed" carries a STALE hash — edited since it was embedded.
			{
				storyId: "changed",
				contentHash: "0".repeat(64),
				model: "text-embedding-3-small",
			},
			freshMetaRow(unchanged),
		]);
		mockListStoryDuplicateEmbeddings.mockResolvedValue([
			// Old vector for "changed" must NOT be loaded back into ranking…
			{ storyId: "changed", embedding: [0, 1] },
			{ storyId: "unchanged", embedding: [0.9, 0.1] },
		]);
		// …the batch carries query + the one stale text, positionally.
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0],
				[1, 0],
			],
			model: "text-embedding-3-small",
		});

		const out = await runSearch("billing");
		const batchTexts = mockGenerateEmbeddings.mock
			.calls[0]?.[0] as string[];
		expect(batchTexts).toHaveLength(2);
		expect(batchTexts[0]).toBe("billing");
		expect(batchTexts[1]).toContain("New billing page");

		// Ranked on the fresh vector ([1,0] → 1.0), not the stale one (0.0).
		expect(out.results[0]?.storyId).toBe("changed");
		expect(out.results[0]?.score).toBeCloseTo(1, 5);
		expect(mockUpsertStoryDuplicateEmbeddings).toHaveBeenCalledWith(
			"proj-1",
			[
				expect.objectContaining({
					storyId: "changed",
					model: "text-embedding-3-small",
				}),
			],
		);
		expect(out.coverage.embedded).toBe(1);
		expect(out.coverage.cached).toBe(1);
	});

	it("excludes blank-title stories (no usable detection text)", async () => {
		mockListSearchableStories.mockResolvedValue([
			makeStory({ id: "blank", title: "   " }),
			makeStory({ id: "real", title: "Login page" }),
		]);
		mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0],
				[1, 0],
			],
			model: "text-embedding-3-small",
		});
		const out = await runSearch("login");
		expect(out.results.map((r) => r.storyId)).toEqual(["real"]);
		expect(out.coverage.total).toBe(1);
	});

	it("caps inline back-fill embedding and reports the overflow as skipped", async () => {
		// 210 stale stories, none cached: 200 embed inline, 10 skipped.
		const stories = Array.from({ length: 210 }, (_, i) =>
			makeStory({ id: `s${i}`, title: `Story ${i}` }),
		);
		mockListSearchableStories.mockResolvedValue(stories);
		mockListStoryDuplicateEmbeddingMetadata.mockResolvedValue([]);
		mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
			embeddings: texts.map(() => [1, 0]),
			model: "text-embedding-3-small",
		}));
		const out = await runSearch("story");
		expect(out.coverage.total).toBe(210);
		expect(out.coverage.embedded).toBe(200);
		expect(out.coverage.skipped).toBe(10);
		// Skipped items have no vector → cannot appear in results.
		const resultIds = new Set(out.results.map((r) => r.storyId));
		for (let i = 200; i < 210; i++) {
			expect(resultIds.has(`s${i}`)).toBe(false);
		}
	}, 20_000);
});

describe("semanticSearchProcedure — failure mapping", () => {
	it("maps model-resolution failure to the actionable settings hint", async () => {
		mockListSearchableStories.mockResolvedValue([makeStory({ id: "a" })]);
		mockResolveModelWithProvider.mockRejectedValue(
			new Error("no embedding model"),
		);
		const err = await errorFrom(runSearch());
		expect(err.code).toBe("INTERNAL_SERVER_ERROR");
		expect(err.message).toContain("Settings → AI Models");
	});

	it("maps embedding-generation failure to the same settings hint", async () => {
		mockListSearchableStories.mockResolvedValue([makeStory({ id: "a" })]);
		mockGenerateEmbeddings.mockRejectedValue(new Error("gateway timeout"));
		const err = await errorFrom(runSearch());
		expect(err.code).toBe("INTERNAL_SERVER_ERROR");
		expect(err.message).toContain("Settings → AI Models");
	});
});
