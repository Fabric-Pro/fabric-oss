/**
 * `excludeDocumentChunks` — source-only retrieval for the Living Documents
 * auto-refresh sweep.
 *
 * The load-bearing assertion here is the NEGATIVE one: with the option unset,
 * the Qdrant filter must come out byte-identical to what it is today. The
 * interactive "Update using context" button shares this code path, and a
 * regression there would silently change what every manual document update
 * sees.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchMock, ensureCollectionMock, getLayoutMock } = vi.hoisted(() => ({
	searchMock: vi.fn(),
	ensureCollectionMock: vi.fn(),
	getLayoutMock: vi.fn(),
}));

vi.mock("../client", () => ({
	qdrantClient: { search: searchMock, query: searchMock },
}));

vi.mock("../../collection-manager", () => ({
	ensureCollection: ensureCollectionMock,
	getCollectionLayout: getLayoutMock,
}));

import { searchSimilarProjectContexts } from "../store";

const BASE = {
	projectId: "proj_1",
	userId: "user_1",
	queryEmbedding: [0.1, 0.2, 0.3],
};

/** The `must` array the implementation handed to Qdrant. */
function capturedMust(): Array<Record<string, unknown>> {
	const call = searchMock.mock.calls[0]?.[1];
	return call?.filter?.must ?? [];
}

function hasDocumentIdIsNull(must: Array<Record<string, unknown>>): boolean {
	return must.some(
		(clause) =>
			(clause.is_null as { key?: string } | undefined)?.key ===
			"documentId",
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	ensureCollectionMock.mockResolvedValue(undefined);
	// Dense-only layout: keeps the code on the `qdrantClient.search` branch, so
	// the filter lands in the second argument of a single call.
	getLayoutMock.mockResolvedValue({
		supportsHybrid: false,
		denseVectorName: null,
	});
	searchMock.mockResolvedValue([]);
});

describe("excludeDocumentChunks", () => {
	it("adds a documentId is-null clause when set", async () => {
		await searchSimilarProjectContexts({
			...BASE,
			excludeDocumentChunks: true,
		});

		expect(hasDocumentIdIsNull(capturedMust())).toBe(true);
	});

	it("adds NO such clause when unset — the interactive path is unchanged", async () => {
		await searchSimilarProjectContexts({ ...BASE });

		expect(hasDocumentIdIsNull(capturedMust())).toBe(false);
	});

	it("adds NO such clause when explicitly false", async () => {
		await searchSimilarProjectContexts({
			...BASE,
			excludeDocumentChunks: false,
		});

		expect(hasDocumentIdIsNull(capturedMust())).toBe(false);
	});

	it("keeps the personal-tenant clauses alongside the exclusion", async () => {
		await searchSimilarProjectContexts({
			...BASE,
			excludeDocumentChunks: true,
		});

		const must = capturedMust();
		// Tenant isolation must survive the new clause: projectId match plus the
		// explicit organizationId is-null that keeps personal contexts from
		// leaking into an org's results.
		expect(must).toContainEqual({
			key: "projectId",
			match: { value: "proj_1" },
		});
		expect(must).toContainEqual({ is_null: { key: "organizationId" } });
		expect(hasDocumentIdIsNull(must)).toBe(true);
	});

	it("keeps the organization-tenant clause alongside the exclusion", async () => {
		await searchSimilarProjectContexts({
			...BASE,
			organizationId: "org_1",
			excludeDocumentChunks: true,
		});

		const must = capturedMust();
		expect(must).toContainEqual({
			key: "organizationId",
			match: { value: "org_1" },
		});
		expect(hasDocumentIdIsNull(must)).toBe(true);
	});

	it("composes with an explicit contextIds filter", async () => {
		await searchSimilarProjectContexts({
			...BASE,
			contextIds: ["ctx_1", "ctx_2"],
			excludeDocumentChunks: true,
		});

		const must = capturedMust();
		expect(must).toContainEqual({
			key: "contextId",
			match: { any: ["ctx_1", "ctx_2"] },
		});
		expect(hasDocumentIdIsNull(must)).toBe(true);
	});
});
