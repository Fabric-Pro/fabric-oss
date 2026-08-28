/**
 * Captured conversation bundles on the retrieval path (Fizzy #2228, U12).
 *
 * Retrieval treats the vector store as an index of ids and refetches the text
 * from Postgres. That refetch resolved `ProjectContext` (and its URL pages)
 * only — so a point belonging to a captured conversation bundle came back as
 * nothing, and embedding bundles would have meant writing into a store nothing
 * reads back: every capture-side test would still pass while the assistant
 * stayed unable to cite a single monitored channel.
 *
 * The database resolvers are mocked as a small tenant-aware store rather than
 * with canned return values, so the cross-tenant case fails for the reason it
 * would fail in production — the filter misses — instead of because a mock was
 * told to return null.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: vi.fn().mockResolvedValue({ organizationId: null }),
		},
		projectRepositoryIntegration: { findMany: vi.fn() },
	},
	getProjectRagSettings: vi.fn(),
	getRetrievableContextById: vi.fn(),
	getRetrievableConversationBundleById: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../embedding", () => ({ generateEmbedding: vi.fn() }));

vi.mock("../../embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [1], values: [1] })),
}));

vi.mock("../../reranking", () => ({ rerankContexts: vi.fn() }));

vi.mock("../store", () => ({ searchSimilarProjectContexts: vi.fn() }));

vi.mock("../summary-injection", () => ({
	applyContextSummary: vi.fn((list: unknown) => Promise.resolve(list)),
}));

import {
	getProjectRagSettings,
	getRetrievableContextById,
	getRetrievableConversationBundleById,
} from "@repo/database";
import { generateEmbedding } from "../../embedding";
import { retrieveProjectContexts } from "../retrieval";
import { searchSimilarProjectContexts } from "../store";

const BUNDLE_TEXT =
	"## Conversation in #delivery — 2026-08-01T09:00:00.000Z to 2026-08-01T09:30:00.000Z\n" +
	"\n**Ada** (2026-08-01T09:00:00.000Z): the migration lands Tuesday.";

/**
 * The bundle rows a tenant-filtered read can reach. Keyed the way the resolver
 * keys them: a bundle belongs to one project AND one tenant, never to a row id
 * on its own.
 */
const BUNDLE_STORE = [
	{
		bundleId: "bundle-personal",
		projectId: "proj-personal",
		userId: "user-1",
		organizationId: null,
		content: BUNDLE_TEXT,
		sourceTitle: "#delivery",
	},
	{
		bundleId: "bundle-org",
		projectId: "proj-org",
		userId: null,
		organizationId: "org-1",
		content: BUNDLE_TEXT,
		sourceTitle: "#delivery",
	},
	{
		bundleId: "bundle-other-tenant",
		projectId: "proj-org",
		userId: null,
		organizationId: "org-2",
		content: "## Conversation in #private — someone else's tenant",
		sourceTitle: "#private",
	},
];

const personalOptions = {
	projectId: "proj-personal",
	query: "when does the migration land?",
	userId: "user-1",
};

const orgOptions = {
	projectId: "proj-org",
	query: "when does the migration land?",
	userId: "user-1",
	organizationId: "org-1",
};

/** A search hit on a captured bundle, as `store.ts` maps the point payload. */
function bundleHit(bundleId: string, score = 0.9) {
	return {
		contextId: bundleId,
		projectId: "proj-1",
		score,
		type: "INTEGRATION",
		conversationBundleId: bundleId,
	};
}

/** A search hit on an ordinary context point — no bundle marker at all. */
function contextHit(contextId: string, score = 0.8) {
	return { contextId, projectId: "proj-1", score, type: "FILE" };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getProjectRagSettings).mockResolvedValue({
		topK: 10,
		similarityThreshold: 0.3,
		enableReranking: false,
		rerankTopK: 10,
	} as never);
	vi.mocked(generateEmbedding).mockResolvedValue({
		embedding: [0.1, 0.2, 0.3],
	} as never);
	vi.mocked(searchSimilarProjectContexts).mockResolvedValue([]);

	vi.mocked(getRetrievableContextById).mockImplementation((id: string) =>
		Promise.resolve({
			id,
			type: "FILE",
			content: `content-of-${id}`,
			createdAt: new Date("2026-08-01T00:00:00Z"),
			metadata: null,
			originalFilename: `${id}.md`,
			sourceUrl: null,
			sourceTitle: null,
			sourceType: null,
			aiInstructions: null,
		} as never),
	);

	// The real resolver's tenant XOR filter, reproduced over the fake store: an
	// organization read matches on organizationId, a personal read on userId
	// AND a null organizationId.
	vi.mocked(getRetrievableConversationBundleById).mockImplementation(
		(params: {
			bundleId: string;
			projectId: string;
			tenant: { userId: string; organizationId?: string | null };
		}) => {
			const organizationId = params.tenant.organizationId ?? null;
			const row = BUNDLE_STORE.find(
				(candidate) =>
					candidate.bundleId === params.bundleId &&
					candidate.projectId === params.projectId &&
					(organizationId
						? candidate.organizationId === organizationId
						: candidate.organizationId === null &&
							candidate.userId === params.tenant.userId),
			);
			if (!row) {
				return Promise.resolve(null);
			}
			return Promise.resolve({
				id: row.bundleId,
				type: "INTEGRATION",
				content: row.content,
				createdAt: new Date("2026-08-01T10:00:00Z"),
				metadata: {
					provider: "SLACK",
					conversationBundleId: row.bundleId,
				},
				originalFilename: null,
				sourceUrl: null,
				sourceTitle: row.sourceTitle,
				sourceType: null,
				aiInstructions: null,
			} as never);
		},
	);
});

describe("retrieveProjectContexts — captured conversation bundles", () => {
	it("resolves a bundle hit to that bundle's stored text in a personal project", async () => {
		vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
			bundleHit("bundle-personal"),
		]);

		const results = await retrieveProjectContexts(personalOptions);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: "bundle-personal",
			content: BUNDLE_TEXT,
			// The provider in the bundle's metadata is what turns a bare
			// INTEGRATION into a label the model can reason about.
			type: "SLACK_CHANNEL",
			sourceTitle: "#delivery",
			score: 0.9,
		});
		expect(getRetrievableConversationBundleById).toHaveBeenCalledWith({
			bundleId: "bundle-personal",
			projectId: "proj-personal",
			tenant: { userId: "user-1", organizationId: undefined },
		});
		// The bundle id never goes to the context resolver — it is not a
		// ProjectContext and looking for it there is what returned nothing.
		expect(getRetrievableContextById).not.toHaveBeenCalled();
	});

	it("resolves a bundle hit to that bundle's stored text in an organization project", async () => {
		vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
			bundleHit("bundle-org"),
		]);

		const results = await retrieveProjectContexts(orgOptions);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: "bundle-org",
			content: BUNDLE_TEXT,
			type: "SLACK_CHANNEL",
		});
		expect(getRetrievableConversationBundleById).toHaveBeenCalledWith({
			bundleId: "bundle-org",
			projectId: "proj-org",
			tenant: { userId: "user-1", organizationId: "org-1" },
		});
	});

	it("still resolves an ordinary context point exactly as before", async () => {
		vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
			contextHit("ctx-prd"),
		]);

		const results = await retrieveProjectContexts(orgOptions);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: "ctx-prd",
			type: "FILE",
			content: "content-of-ctx-prd",
			filename: "ctx-prd.md",
		});
		expect(getRetrievableContextById).toHaveBeenCalledWith("ctx-prd");
		expect(getRetrievableConversationBundleById).not.toHaveBeenCalled();
	});

	it("mixes bundle and context hits in one result set, in relevance order", async () => {
		vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
			bundleHit("bundle-org", 0.95),
			contextHit("ctx-prd", 0.7),
		]);

		const results = await retrieveProjectContexts(orgOptions);

		expect(results.map((ctx) => ctx.id)).toEqual(["bundle-org", "ctx-prd"]);
		expect(results[0].content).toBe(BUNDLE_TEXT);
		expect(results[1].content).toBe("content-of-ctx-prd");
	});

	it("does not resolve a bundle belonging to another tenant", async () => {
		vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
			bundleHit("bundle-other-tenant"),
		]);

		const results = await retrieveProjectContexts(orgOptions);

		// The filter missed, so nothing is returned — not the other tenant's
		// text, and not a fallback read of the row by id alone.
		expect(results).toEqual([]);
		expect(getRetrievableConversationBundleById).toHaveBeenCalledWith({
			bundleId: "bundle-other-tenant",
			projectId: "proj-org",
			tenant: { userId: "user-1", organizationId: "org-1" },
		});
	});

	it("does not resolve an organization's bundle for a personal caller", async () => {
		vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
			bundleHit("bundle-org"),
		]);

		const results = await retrieveProjectContexts({
			...personalOptions,
			projectId: "proj-org",
		});

		expect(results).toEqual([]);
	});

	it("resolves to nothing when the bundle row was deleted under a lingering point", async () => {
		vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
			bundleHit("bundle-unlinked"),
			contextHit("ctx-prd", 0.6),
		]);

		const results = await retrieveProjectContexts(orgOptions);

		// The unlinked channel's bundle drops out; the rest of the result set
		// is unaffected and nothing throws.
		expect(results.map((ctx) => ctx.id)).toEqual(["ctx-prd"]);
	});
});
