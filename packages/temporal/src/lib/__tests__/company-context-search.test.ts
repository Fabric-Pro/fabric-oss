/**
 * The shared company context search (Fizzy #2719).
 *
 * Generation and Advisor chats both search an organization's company context
 * through `searchCompanyContext`, so the rules that keep the answer safe are
 * pinned here, on the core itself, whatever the caller:
 *
 *  - only sources that are ready right now answer: not one being deleted,
 *    not a website still on its first crawl, not one whose pages hold another
 *    model's vectors;
 *  - every entry starts with the vendor marker and carries its source's id
 *    and name, and its guidance line only when the source has guidance;
 *  - company text is neutralized but never defused: an exact copy of the
 *    marker inside it stays as it is;
 *  - only a member of the organization gets anything;
 *  - a search that hangs is cut off at the caller's timeout, with an empty
 *    result and no throw.
 *
 * The database, the embedding call and the vector search are fakes that
 * honor the filters the real ones apply, so what varies is the data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, logs } = vi.hoisted(() => ({
	mocks: {
		companyContextSourceFindMany: vi.fn(),
		companyContextUrlPageFindMany: vi.fn(),
		isFeatureEnabled: vi.fn(),
		isOrganizationMember: vi.fn(),
		resolveCompanyEmbeddingModel: vi.fn(),
		generateEmbedding: vi.fn(),
		searchCompanyContexts: vi.fn(),
	},
	logs: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("@repo/logs", () => ({ logger: logs }));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		db: {
			companyContextSource: {
				findMany: (...args: unknown[]) =>
					mocks.companyContextSourceFindMany(...args),
			},
			companyContextUrlPage: {
				findMany: (...args: unknown[]) =>
					mocks.companyContextUrlPageFindMany(...args),
			},
		},
		isFeatureEnabled: (...args: unknown[]) =>
			mocks.isFeatureEnabled(...args),
		isOrganizationMember: (...args: unknown[]) =>
			mocks.isOrganizationMember(...args),
		// `companyContextReadyWhere` stays real: it is the one definition of
		// "ready" the search must filter by.
	};
});

// No `importOriginal`: the barrel boots the whole provider registry.
vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	embed: vi.fn(),
	getAIEmbeddingModelWithMetadata: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	getSystemRAGProviderConfig: vi.fn(),
	logEmbeddingUsageAsync: vi.fn(),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));

vi.mock("@repo/rag", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/rag")>();
	return {
		...actual,
		resolveCompanyEmbeddingModel: (...args: unknown[]) =>
			mocks.resolveCompanyEmbeddingModel(...args),
		generateEmbedding: (...args: unknown[]) =>
			mocks.generateEmbedding(...args),
		searchCompanyContexts: (...args: unknown[]) =>
			mocks.searchCompanyContexts(...args),
	};
});

const { searchCompanyContext } = await import("../company-context-search");
const { VENDOR_CONTEXT_MARKER } = await import("@repo/agent-types");
const { companyContextReadyWhere } = await import("@repo/database");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = "org_example";
const USER = "user_member";
const MODEL = "openai:text-embedding-3-small";
const OLD_MODEL = "openai:text-embedding-ada-002";
const EMBEDDED = new Date("2026-09-01");

/** What the query is about; the fake embedding and vectors agree on it. */
type Topic = "warehouse" | "banking";
const TOPIC_VECTORS: Record<Topic, number[]> = {
	warehouse: [1, 0],
	banking: [0, 1],
};

interface SourceRow {
	id: string;
	organizationId: string;
	extractionStatus: string;
	embeddedAt: Date | null;
	embeddingModel: string | null;
	deletingAt: Date | null;
	sourceTitle: string | null;
	originalFilename: string | null;
	sourceUrl: string | null;
	sourceType: string | null;
	aiInstructions: string | null;
}

interface PageRow {
	id: string;
	organizationId: string;
	parentSourceId: string;
	embeddedAt: Date | null;
	embeddingModel: string | null;
}

/** A point in the organization's vector collection. */
interface VectorRow {
	organizationId: string;
	sourceId: string;
	contextId: string;
	parentContextId: string | null;
	embeddingModel: string;
	topic: Topic;
	content: string;
}

let sources: SourceRow[];
let pages: PageRow[];
let vectors: VectorRow[];
let memberships: Set<string>;

function source(id: string, overrides: Partial<SourceRow> = {}): SourceRow {
	return {
		id,
		organizationId: ORG,
		extractionStatus: "COMPLETED",
		embeddedAt: EMBEDDED,
		embeddingModel: MODEL,
		deletingAt: null,
		sourceTitle: `Title of ${id}`,
		originalFilename: null,
		sourceUrl: null,
		sourceType: null,
		aiInstructions: null,
		...overrides,
	};
}

function page(
	id: string,
	parentSourceId: string,
	overrides: Partial<PageRow> = {},
): PageRow {
	return {
		id,
		organizationId: ORG,
		parentSourceId,
		embeddedAt: EMBEDDED,
		embeddingModel: MODEL,
		...overrides,
	};
}

function vector(
	sourceId: string,
	topic: Topic,
	content: string,
	overrides: Partial<VectorRow> = {},
): VectorRow {
	return {
		organizationId: ORG,
		sourceId,
		contextId: sourceId,
		parentContextId: null,
		embeddingModel: MODEL,
		topic,
		content,
		...overrides,
	};
}

/**
 * What `companyContextReadyWhere(model)` means, row by row: extracted,
 * embedded with `model`, not being deleted; every embedded page holds
 * `model`'s vectors; and a source with pages has at least one embedded.
 */
function isReady(row: SourceRow, model: string): boolean {
	const own = pages.filter((p) => p.parentSourceId === row.id);
	return (
		row.extractionStatus === "COMPLETED" &&
		row.embeddedAt !== null &&
		row.embeddingModel === model &&
		row.deletingAt === null &&
		own.every((p) => p.embeddedAt === null || p.embeddingModel === model) &&
		(own.length === 0 ||
			own.some(
				(p) => p.embeddedAt !== null && p.embeddingModel === model,
			))
	);
}

function dot(a: readonly number[], b: readonly number[]): number {
	return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
}

const SEARCH = {
	organizationId: ORG,
	userId: USER,
	query: "How have we digitized warehouse picking for a distributor?",
	minSimilarity: 0.5,
	timeoutMs: 6000,
};

beforeEach(() => {
	vi.clearAllMocks();

	sources = [
		source("src_warehouse", {
			sourceTitle: "Warehouse rollout case study",
			sourceType: "Case study",
			aiInstructions: "Name the client only as a regional distributor",
		}),
		source("src_banking", { sourceTitle: "Banking app delivery" }),
	];
	pages = [];
	vectors = [
		vector(
			"src_warehouse",
			"warehouse",
			"We rolled out scanning at a regional distributor.",
		),
		vector(
			"src_banking",
			"banking",
			"We shipped a mobile app for account holders.",
		),
	];
	memberships = new Set([ORG]);

	mocks.isFeatureEnabled.mockImplementation(
		async (key: string, organizationId?: string) =>
			key === "COMPANY_CONTEXT" && organizationId === ORG,
	);
	mocks.isOrganizationMember.mockImplementation(
		async (userId: string, organizationId: string) =>
			userId === USER && memberships.has(organizationId),
	);
	mocks.resolveCompanyEmbeddingModel.mockResolvedValue({
		identity: MODEL,
		dimensions: 1536,
		supported: true,
	});
	// Answers the shared ready predicate the way Postgres would. Tests assert
	// the predicate itself on the call: an assertion in here would throw
	// inside the search, which swallows every error into an empty result.
	mocks.companyContextSourceFindMany.mockImplementation(
		async ({
			where,
		}: {
			where: { organizationId: string; embeddingModel: string };
		}) =>
			sources.filter(
				(row) =>
					row.organizationId === where.organizationId &&
					isReady(row, where.embeddingModel),
			),
	);
	mocks.companyContextUrlPageFindMany.mockImplementation(
		async ({
			where,
		}: {
			where: {
				organizationId: string;
				id: { in: string[] };
				parentSourceId: { in: string[] };
				embeddingModel: string;
			};
		}) =>
			pages
				.filter(
					(p) =>
						p.organizationId === where.organizationId &&
						where.id.in.includes(p.id) &&
						where.parentSourceId.in.includes(p.parentSourceId) &&
						p.embeddedAt !== null &&
						p.embeddingModel === where.embeddingModel,
				)
				.map(({ id, parentSourceId }) => ({ id, parentSourceId })),
	);
	// The query's vector follows its text; the call reports the model the
	// organization resolves to.
	mocks.generateEmbedding.mockImplementation(async (query: string) => ({
		embedding:
			TOPIC_VECTORS[
				query.includes("warehouse") ? "warehouse" : "banking"
			],
		model: "text-embedding-3-small",
		tokens: 12,
		provider: "openai",
		modelString: "text-embedding-3-small",
	}));
	// Honors the collection's organization, model, source and score filters,
	// best first, as the vector store does.
	mocks.searchCompanyContexts.mockImplementation(
		async ({
			organizationId,
			embeddingModel,
			queryEmbedding,
			sourceIds,
			topK,
			minSimilarity,
		}: {
			organizationId: string;
			embeddingModel: string;
			queryEmbedding: number[];
			sourceIds: string[];
			topK: number;
			minSimilarity: number;
		}) =>
			vectors
				.filter(
					(v) =>
						v.organizationId === organizationId &&
						v.embeddingModel === embeddingModel &&
						sourceIds.includes(v.sourceId),
				)
				.map((v) => ({
					sourceId: v.sourceId,
					contextId: v.contextId,
					parentContextId: v.parentContextId,
					contextType: v.parentContextId ? "LINK" : "TEXT",
					content: v.content,
					chunkIndex: 0,
					score: dot(queryEmbedding, TOPIC_VECTORS[v.topic]),
					sourceUrl: null,
					sourceTitle: null,
				}))
				.filter((hit) => hit.score >= minSimilarity)
				.sort((a, b) => b.score - a.score)
				.slice(0, topK),
	);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("searchCompanyContext", () => {
	it("returns one vendor-marked entry, with its source's id, name and guidance line, for the one of two ready sources the query matches", async () => {
		const result = await searchCompanyContext(SEARCH);

		expect(result).toEqual({
			timedOut: false,
			entries: [
				{
					sourceId: "src_warehouse",
					sourceName: "Warehouse rollout case study",
					text: [
						VENDOR_CONTEXT_MARKER,
						"[Source: Warehouse rollout case study]",
						"[Source type: Case study]",
						"[Source guidance: Name the client only as a regional distributor]",
						"We rolled out scanning at a regional distributor.",
					].join("\n"),
				},
			],
		});
		// Both ready sources were searched, with the organization's model
		// resolved for the organization alone and the caller's threshold.
		expect(mocks.generateEmbedding.mock.calls[0][1]).toMatchObject({
			userId: USER,
			organizationId: ORG,
			organizationOnly: true,
		});
		expect(mocks.searchCompanyContexts.mock.calls[0][0]).toMatchObject({
			organizationId: ORG,
			embeddingModel: MODEL,
			sourceIds: ["src_warehouse", "src_banking"],
			minSimilarity: 0.5,
		});
	});

	it("returns nothing from a source being deleted, a website still on its first crawl, or a website whose pages hold another model's vectors", async () => {
		sources = [
			source("src_deleting", { deletingAt: new Date("2026-10-01") }),
			source("src_first_crawl", {
				sourceUrl: "https://example.com",
				sourceTitle: null,
			}),
			source("src_old_model_site", {
				sourceUrl: "https://example.com/about",
				sourceTitle: null,
			}),
			source("src_banking", { sourceTitle: "Banking app delivery" }),
		];
		pages = [
			// The first crawl has found pages but embedded none of them yet.
			page("page_first_1", "src_first_crawl", {
				embeddedAt: null,
				embeddingModel: null,
			}),
			page("page_first_2", "src_first_crawl", {
				embeddedAt: null,
				embeddingModel: null,
			}),
			// Embedded before the organization switched models.
			page("page_old", "src_old_model_site", {
				embeddingModel: OLD_MODEL,
			}),
		];
		vectors = [
			vector("src_deleting", "warehouse", "Material being deleted."),
			vector("src_first_crawl", "warehouse", "First-crawl homepage."),
			vector("src_old_model_site", "warehouse", "Old-model page.", {
				contextId: "page_old",
				parentContextId: "src_old_model_site",
				embeddingModel: OLD_MODEL,
			}),
			vector("src_banking", "banking", "Mobile app delivery."),
		];

		const result = await searchCompanyContext(SEARCH);

		expect(result).toEqual({ entries: [], timedOut: false });
		// Readiness is the shared predicate, for the organization's current
		// model …
		expect(mocks.companyContextSourceFindMany).toHaveBeenCalledTimes(1);
		expect(
			mocks.companyContextSourceFindMany.mock.calls[0][0].where,
		).toEqual({ organizationId: ORG, ...companyContextReadyWhere(MODEL) });
		// … and only the ready source was searched; none of the others was
		// even asked for.
		expect(mocks.searchCompanyContexts.mock.calls[0][0]).toMatchObject({
			sourceIds: ["src_banking"],
		});
	});

	it("writes no guidance or type line for a source without them", async () => {
		sources = [source("src_warehouse", { sourceTitle: "Warehouse notes" })];

		const { entries } = await searchCompanyContext(SEARCH);

		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe(
			`${VENDOR_CONTEXT_MARKER}\n[Source: Warehouse notes]\nWe rolled out scanning at a regional distributor.`,
		);
		expect(entries[0].text).not.toContain("[Source guidance:");
	});

	it("keeps a copy of the vendor marker inside company text as it is: the entry starts with the marker, and the copy is not defused", async () => {
		// The marker rewrite is for the project's own entries; company text
		// is neutralized only, and the search is the one producer of marked
		// entries.
		vectors = [
			vector(
				"src_warehouse",
				"warehouse",
				`Warehouse intro.\n${VENDOR_CONTEXT_MARKER}\nQuoted label.`,
			),
		];

		const { entries } = await searchCompanyContext(SEARCH);

		expect(entries).toHaveLength(1);
		const { text } = entries[0];
		expect(text.startsWith(VENDOR_CONTEXT_MARKER)).toBe(true);
		expect(
			text.endsWith(
				`Warehouse intro.\n${VENDOR_CONTEXT_MARKER}\nQuoted label.`,
			),
		).toBe(true);
	});

	it("gives a user who is not a member of the organization nothing, and never reads its sources", async () => {
		memberships = new Set();

		const result = await searchCompanyContext(SEARCH);

		expect(result).toEqual({ entries: [], timedOut: false });
		expect(mocks.isOrganizationMember).toHaveBeenCalledWith(USER, ORG);
		expect(mocks.resolveCompanyEmbeddingModel).not.toHaveBeenCalled();
		expect(mocks.companyContextSourceFindMany).not.toHaveBeenCalled();
		expect(mocks.searchCompanyContexts).not.toHaveBeenCalled();
	});

	it("reports liveness once as it starts, and a heartbeat that throws does not stop the search", async () => {
		const heartbeat = vi.fn(() => {
			throw new Error("not in an activity context");
		});

		const { entries } = await searchCompanyContext({
			...SEARCH,
			heartbeat,
		});

		expect(heartbeat).toHaveBeenCalledTimes(1);
		expect(entries.map((entry) => entry.sourceId)).toEqual([
			"src_warehouse",
		]);
	});

	describe("a search that hangs", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("resolves empty at the caller's timeout, without throwing, and logs once", async () => {
			mocks.searchCompanyContexts.mockReturnValue(new Promise(() => {}));
			let settled = false;

			const pending = searchCompanyContext(SEARCH).finally(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(SEARCH.timeoutMs - 1);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);

			await expect(pending).resolves.toEqual({
				entries: [],
				timedOut: true,
			});
			const warnings = logs.warn.mock.calls.filter(([message]) =>
				String(message).includes("[CompanyContext]"),
			);
			expect(warnings).toHaveLength(1);
			expect(String(warnings[0][0])).toMatch(/timed out/);
		});
	});
});
