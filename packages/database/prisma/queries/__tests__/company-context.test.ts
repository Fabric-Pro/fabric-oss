/**
 * Company context queries (Fizzy #2719), without a database.
 *
 * The load-bearing property is tenancy: every read and write carries the
 * organization id in its WHERE (or on the row it creates), so a source or page
 * id alone never reaches another organization's row. The fake below stores
 * rows for two organizations and answers each call only from the WHERE it is
 * given, so a helper that dropped the organization from its filter would read
 * or write the other organization's row and fail here.
 *
 * That the database itself refuses a page naming a different organization
 * from its parent is `__tests__/company-context-constraints.test.ts`, which
 * needs a real Postgres.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
/** The arguments a read is called with; the tests inspect every field. */
type ReadArgs = { where?: Row; select?: Row; orderBy?: Row };

const { store, fake, KnownRequestError } = vi.hoisted(() => {
	class KnownRequestError extends Error {
		constructor(
			message: string,
			readonly code: string,
		) {
			super(message);
		}
	}

	const store = {
		sources: [] as Row[],
		pages: [] as Row[],
	};

	/**
	 * Equality match over plain fields, `in`, `notIn`, `not: null` and `OR`.
	 * A field a row never set reads as null, as an unset nullable column does.
	 */
	function matches(row: Row, where: Row = {}): boolean {
		return Object.entries(where).every(([key, condition]) => {
			if (key === "OR") {
				return (condition as Row[]).some((arm) => matches(row, arm));
			}
			if (key === "id_organizationId") {
				const { id, organizationId } = condition as Row;
				return row.id === id && row.organizationId === organizationId;
			}
			if (
				condition !== null &&
				typeof condition === "object" &&
				!(condition instanceof Date)
			) {
				const c = condition as Row;
				if ("in" in c) {
					return (c.in as unknown[]).includes(row[key]);
				}
				if ("notIn" in c) {
					return !(c.notIn as unknown[]).includes(row[key]);
				}
				if ("not" in c) {
					return row[key] !== c.not;
				}
			}
			if (condition === null) {
				return row[key] === null || row[key] === undefined;
			}
			return row[key] === condition;
		});
	}

	function table(rows: () => Row[]) {
		return {
			findMany: vi.fn(async ({ where }: ReadArgs) =>
				rows().filter((row) => matches(row, where)),
			),
			findFirst: vi.fn(
				async ({ where }: { where?: Row }) =>
					rows().find((row) => matches(row, where)) ?? null,
			),
			findFirstOrThrow: vi.fn(async ({ where }: { where?: Row }) => {
				const row = rows().find((r) => matches(r, where));
				if (!row) {
					throw new Error("not found");
				}
				return row;
			}),
			findUnique: vi.fn(
				async ({ where }: { where?: Row }) =>
					rows().find((row) => matches(row, where)) ?? null,
			),
			count: vi.fn(async (_args?: { where?: Row }) => 0),
			create: vi.fn(async ({ data }: { data: Row }) => ({
				id: "created-1",
				...data,
			})),
			createMany: vi.fn(
				async ({
					data,
				}: {
					data: Row[];
					skipDuplicates?: boolean;
				}) => ({
					count: data.length,
				}),
			),
			updateMany: vi.fn(
				async ({ where, data }: { where: Row; data: Row }) => {
					const hit = rows().filter((row) => matches(row, where));
					for (const row of hit) {
						Object.assign(row, data);
					}
					return { count: hit.length };
				},
			),
			deleteMany: vi.fn(async ({ where }: { where: Row }) => ({
				count: rows().filter((row) => matches(row, where)).length,
			})),
		};
	}

	const fake = {
		companyContextSource: table(() => store.sources),
		companyContextUrlPage: table(() => store.pages),
		$transaction: vi.fn(),
	};
	fake.$transaction.mockImplementation(
		async (fn: (tx: typeof fake) => unknown) => fn(fake),
	);

	return { store, fake, KnownRequestError };
});

vi.mock("../../client", () => ({
	db: fake,
	Prisma: {
		PrismaClientKnownRequestError: KnownRequestError,
		sql: vi.fn(),
		join: vi.fn(),
	},
}));

import {
	COMPANY_CONTEXT_SOURCE_TYPES,
	COMPANY_CONTEXT_STORAGE_SEGMENT,
	cancelUnfinishedCompanyContextUrlPages,
	claimCompanyContextSourceForReprocess,
	claimCompanyFileSourceForProcessing,
	claimCompanyLinkSourceCrawl,
	clearCompanyContextSourceEmbedding,
	companyContextReadyWhere,
	companyContextStoragePrefix,
	countCompanyContextUrlPagesEmbeddedWith,
	createCompanyContextUrlPages,
	createCompanyFileSource,
	createCompanyLinkSource,
	createCompanyTextSource,
	deleteCompanyContextSource,
	finalizeCompanyLinkSourceCrawl,
	getCompanyContextReadiness,
	getCompanyContextSource,
	getCompanyContextSourceMeta,
	getCompanyContextUrlPage,
	getCompanyLinkSourceCrawlState,
	listCompanyContextSources,
	listCompanyContextUrlPages,
	listCompanyContextUrlScheduleIds,
	listReadyCompanyContextSourceIds,
	markCompanyContextSourceEmbedded,
	markCompanyContextUrlPageEmbedded,
	pruneCompanyContextUrlPages,
	recordCompanyContextSourceIndexingFailure,
	releaseCompanyContextSourceClaim,
	updateCompanyContextSourceMetadata,
	updateCompanyContextSourceStatus,
	updateCompanyContextUrlPage,
	updateCompanyLinkSourceCrawlState,
	upsertCompanyContextUrlPage,
} from "../company-context";
import { hashContextContent } from "../projects/context-content-hash";

const ORG_A = "org-a";
const ORG_B = "org-b";
const MODEL = "openai/text-embedding-3-small";

function seed() {
	store.sources = [
		{
			id: "src-a",
			organizationId: ORG_A,
			type: "LINK",
			extractionStatus: "COMPLETED",
			sourceType: "Case study",
			aiInstructions: null,
			urlScheduleId: "sched-a",
		},
		{
			id: "src-b",
			organizationId: ORG_B,
			type: "LINK",
			extractionStatus: "COMPLETED",
			sourceType: "Case study",
			aiInstructions: null,
			urlScheduleId: "sched-b",
		},
		{
			id: "src-a-file",
			organizationId: ORG_A,
			type: "FILE",
			extractionStatus: "PENDING",
			urlScheduleId: null,
		},
	];
	store.pages = [
		{
			id: "page-a1",
			parentSourceId: "src-a",
			organizationId: ORG_A,
			pageUrl: "https://example.com/a",
			contentHash: hashContextContent("old"),
		},
		{
			id: "page-a2",
			parentSourceId: "src-a",
			organizationId: ORG_A,
			pageUrl: "https://example.com/b",
			contentHash: "",
		},
		{
			id: "page-b1",
			parentSourceId: "src-b",
			organizationId: ORG_B,
			pageUrl: "https://example.com/a",
			contentHash: "",
		},
	];
}

beforeEach(() => {
	vi.clearAllMocks();
	fake.$transaction.mockImplementation(
		async (fn: (tx: typeof fake) => unknown) => fn(fake),
	);
	seed();
});

describe("storage prefix", () => {
	it("keys company files under the organization's tenant prefix", () => {
		expect(companyContextStoragePrefix("org-x")).toBe(
			`org-x/${COMPANY_CONTEXT_STORAGE_SEGMENT}/`,
		);
		expect(COMPANY_CONTEXT_STORAGE_SEGMENT).toBe("company-context");
	});

	// An empty id would widen a sweep to every organization's files.
	it("refuses an empty organization id", () => {
		expect(() => companyContextStoragePrefix("")).toThrow();
	});
});

describe("Layer 1 source kinds", () => {
	it("accepts files, pasted text and websites only", () => {
		expect([...COMPANY_CONTEXT_SOURCE_TYPES]).toEqual([
			"FILE",
			"TEXT",
			"LINK",
		]);
	});
});

describe("reads are scoped by organization", () => {
	it("getCompanyContextSource returns null for another organization's source", async () => {
		await expect(
			getCompanyContextSource("src-b", ORG_A),
		).resolves.toBeNull();
		await expect(
			getCompanyContextSource("src-a", ORG_A),
		).resolves.toMatchObject({ id: "src-a", organizationId: ORG_A });
		expect(fake.companyContextSource.findUnique).toHaveBeenCalledWith({
			where: {
				id_organizationId: { id: "src-b", organizationId: ORG_A },
			},
		});
	});

	it("getCompanyContextSourceMeta is scoped the same way and never reads content", async () => {
		await expect(
			getCompanyContextSourceMeta("src-b", ORG_A),
		).resolves.toBeNull();
		await expect(
			getCompanyContextSourceMeta("src-a", ORG_A),
		).resolves.toMatchObject({ id: "src-a", organizationId: ORG_A });
		expect(fake.companyContextSource.findUnique).toHaveBeenCalledWith({
			where: {
				id_organizationId: { id: "src-b", organizationId: ORG_A },
			},
			omit: { content: true },
		});
	});

	it("listCompanyContextSources lists one organization's sources without content", async () => {
		const rows = await listCompanyContextSources(ORG_A);

		expect(rows.map((row) => row.id).sort()).toEqual([
			"src-a",
			"src-a-file",
		]);
		const args = fake.companyContextSource.findMany.mock.calls[0][0];
		expect(args.where).toEqual({ organizationId: ORG_A });
		expect(args.select?.content).toBeUndefined();
		expect(args.select?._count).toEqual({ select: { urlPages: true } });
		expect(args.orderBy).toEqual({ createdAt: "desc" });
	});

	it("listCompanyContextUrlPages cannot reach another organization's pages", async () => {
		await expect(
			listCompanyContextUrlPages("src-b", ORG_A),
		).resolves.toEqual([]);
		const args = fake.companyContextUrlPage.findMany.mock.calls[0][0];
		expect(args.where).toEqual({
			parentSourceId: "src-b",
			organizationId: ORG_A,
		});
		expect(args.select?.content).toBeUndefined();
	});

	it("getCompanyContextUrlPage returns null for another organization's page", async () => {
		await expect(
			getCompanyContextUrlPage("page-b1", ORG_A),
		).resolves.toBeNull();
		await expect(
			getCompanyContextUrlPage("page-a1", ORG_A),
		).resolves.toMatchObject({ id: "page-a1" });
	});

	it("lists only the organization's refresh schedules", async () => {
		await expect(listCompanyContextUrlScheduleIds(ORG_A)).resolves.toEqual([
			{ id: "src-a", urlScheduleId: "sched-a" },
		]);
		expect(fake.companyContextSource.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: ORG_A, urlScheduleId: { not: null } },
			}),
		);
	});
});

describe("ready for retrieval", () => {
	it("requires a completed source embedded with the current model", () => {
		const where = companyContextReadyWhere(MODEL);

		expect(where).toMatchObject({
			extractionStatus: "COMPLETED",
			embeddedAt: { not: null },
			embeddingModel: MODEL,
		});
	});

	// A page holding another model's vectors keeps the source out. A page
	// holding none passes whatever its status, so the PENDING page a
	// scheduled refresh adds, or one a cancelled crawl never reached, does
	// not take a ready website out of retrieval.
	it("requires every crawled page to hold no vectors from another model", () => {
		const where = companyContextReadyWhere(MODEL);

		expect(where.AND).toContainEqual({
			urlPages: {
				every: {
					OR: [
						{ embeddedAt: { not: null }, embeddingModel: MODEL },
						{ embeddedAt: null },
					],
				},
			},
		});
	});

	// Without it, a website none of whose pages could be indexed passes the
	// every-page clause (each page holds no vectors) and reads as ready with
	// nothing to search. A source with no page rows is unaffected.
	it("requires a source with crawled pages to have at least one holding the current model's vectors", () => {
		const where = companyContextReadyWhere(MODEL);

		expect(where.AND).toContainEqual({
			OR: [
				{ urlPages: { none: {} } },
				{
					urlPages: {
						some: {
							embeddedAt: { not: null },
							embeddingModel: MODEL,
						},
					},
				},
			],
		});
		// Both page clauses sit under AND, so neither overwrites the other.
		expect(where).not.toHaveProperty("urlPages");
		expect(where.AND).toHaveLength(2);
	});

	it("refuses a missing model identity rather than matching unembedded rows", () => {
		expect(() => companyContextReadyWhere("")).toThrow();
	});

	// A source whose delete has started stays out whatever an embed that
	// finishes late writes to its status and markers.
	it("never counts a source being deleted as ready", () => {
		const where = companyContextReadyWhere(MODEL);

		expect(where).toMatchObject({ deletingAt: null });
	});

	it("counts total and ready sources for one organization", async () => {
		fake.companyContextSource.count
			.mockResolvedValueOnce(3)
			.mockResolvedValueOnce(1);

		await expect(getCompanyContextReadiness(ORG_A, MODEL)).resolves.toEqual(
			{
				total: 3,
				ready: 1,
			},
		);
		const [totalArgs, readyArgs] =
			fake.companyContextSource.count.mock.calls.map(([args]) => args);
		expect(totalArgs).toEqual({ where: { organizationId: ORG_A } });
		expect(readyArgs).toEqual({
			where: {
				organizationId: ORG_A,
				...companyContextReadyWhere(MODEL),
			},
		});
	});

	it("lists ready ids through the same predicate", async () => {
		await listReadyCompanyContextSourceIds(ORG_A, MODEL);

		expect(fake.companyContextSource.findMany).toHaveBeenCalledWith({
			where: {
				organizationId: ORG_A,
				...companyContextReadyWhere(MODEL),
			},
			select: { id: true },
		});
	});
});

describe("creates", () => {
	it("stores pasted text with its hash, normalized labels and its creator", async () => {
		await createCompanyTextSource({
			organizationId: ORG_A,
			createdByUserId: "user-1",
			content: "We build things.",
			sourceType: "  Positioning  ",
			aiInstructions: "   ",
		});

		const { data } = fake.companyContextSource.create.mock.calls[0][0];
		expect(data).toMatchObject({
			organizationId: ORG_A,
			createdByUserId: "user-1",
			type: "TEXT",
			content: "We build things.",
			contentHash: hashContextContent("We build things."),
			sourceType: "Positioning",
			aiInstructions: null,
		});
	});

	it("creates a file source pending extraction", async () => {
		await createCompanyFileSource({
			organizationId: ORG_A,
			createdByUserId: "user-1",
			s3Path: `${ORG_A}/company-context/deck.pdf`,
			s3Bucket: "project-contexts",
			originalFilename: "deck.pdf",
			mimeType: "application/pdf",
			fileSize: 1024,
		});

		const { data } = fake.companyContextSource.create.mock.calls[0][0];
		expect(data).toMatchObject({
			organizationId: ORG_A,
			type: "FILE",
			content: "",
			s3Path: `${ORG_A}/company-context/deck.pdf`,
		});
		expect(data.extractionStatus).toBeUndefined();
	});

	it("creates a website source with its crawl configuration", async () => {
		await createCompanyLinkSource({
			organizationId: ORG_A,
			createdByUserId: null,
			sourceUrl: "https://example.com",
			urlScope: "PATH_PREFIX",
			urlMaxPages: 25,
			urlRefreshMode: "WEEKLY",
		});

		const { data } = fake.companyContextSource.create.mock.calls[0][0];
		expect(data).toMatchObject({
			organizationId: ORG_A,
			createdByUserId: null,
			type: "LINK",
			content: "",
			sourceUrl: "https://example.com",
			urlScope: "PATH_PREFIX",
			urlMaxPages: 25,
			urlRefreshMode: "WEEKLY",
		});
	});
});

describe("ingestion writes are scoped by organization", () => {
	it("a status write for another organization's source matches nothing", async () => {
		await expect(
			updateCompanyContextSourceStatus("src-b", ORG_A, "FAILED"),
		).resolves.toBe(false);
		expect(store.sources[1].extractionStatus).toBe("COMPLETED");
	});

	it("a completed status stamps extractedAt and hashes the content it writes", async () => {
		await expect(
			updateCompanyContextSourceStatus("src-a-file", ORG_A, "COMPLETED", {
				content: "Extracted text",
				extractionError: null,
			}),
		).resolves.toBe(true);

		const { where, data } =
			fake.companyContextSource.updateMany.mock.calls[0][0];
		expect(where).toEqual({
			id: "src-a-file",
			organizationId: ORG_A,
			deletingAt: null,
		});
		expect(data).toMatchObject({
			extractionStatus: "COMPLETED",
			content: "Extracted text",
			contentHash: hashContextContent("Extracted text"),
			extractionError: null,
		});
		expect(data.extractedAt).toBeInstanceOf(Date);
	});

	it("marks a source embedded with its model identity", async () => {
		await expect(
			markCompanyContextSourceEmbedded("src-a", ORG_A, {
				embeddingModel: MODEL,
				qdrantId: "point-1",
			}),
		).resolves.toBe(true);

		expect(store.sources[0]).toMatchObject({
			embeddingModel: MODEL,
			qdrantId: "point-1",
		});
		expect(store.sources[0].embeddedAt).toBeInstanceOf(Date);
		await expect(
			markCompanyContextSourceEmbedded("src-b", ORG_A, {
				embeddingModel: MODEL,
			}),
		).resolves.toBe(false);
	});

	it("refuses to mark a source embedded without a model identity", async () => {
		await expect(
			markCompanyContextSourceEmbedded("src-a", ORG_A, {
				embeddingModel: "",
			}),
		).rejects.toThrow();
		expect(fake.companyContextSource.updateMany).not.toHaveBeenCalled();
	});

	it("clears the embedding markers together", async () => {
		await clearCompanyContextSourceEmbedding("src-a", ORG_A);

		expect(fake.companyContextSource.updateMany).toHaveBeenCalledWith({
			where: { id: "src-a", organizationId: ORG_A },
			data: { embeddedAt: null, embeddingModel: null, qdrantId: null },
		});
	});

	it("an indexing failure keeps a completed extraction's status", async () => {
		await expect(
			recordCompanyContextSourceIndexingFailure("src-a", ORG_A, "boom"),
		).resolves.toBe(true);

		const { data } = fake.companyContextSource.updateMany.mock.calls[0][0];
		expect(data).toEqual({ extractionError: "boom" });
	});

	it("an indexing failure that removed points clears the model with embeddedAt", async () => {
		await recordCompanyContextSourceIndexingFailure(
			"src-a",
			ORG_A,
			"boom",
			{
				pointsRemoved: true,
			},
		);

		const { data } = fake.companyContextSource.updateMany.mock.calls[0][0];
		expect(data).toEqual({
			extractionError: "boom",
			embeddedAt: null,
			embeddingModel: null,
		});
	});

	it("an indexing failure for another organization's source writes nothing", async () => {
		await expect(
			recordCompanyContextSourceIndexingFailure("src-b", ORG_A, "boom"),
		).resolves.toBe(false);
		expect(fake.companyContextSource.updateMany).not.toHaveBeenCalled();
	});

	it("crawl state lands only on the organization's LINK sources", async () => {
		await expect(
			updateCompanyLinkSourceCrawlState("src-a-file", ORG_A, {
				urlScheduleId: "sched-x",
			}),
		).resolves.toBe(false);
		await expect(
			updateCompanyLinkSourceCrawlState("src-a", ORG_A, {
				urlActiveWorkflowId: null,
				urlLastSyncedAt: new Date("2026-09-30T10:00:00Z"),
			}),
		).resolves.toBe(true);
		expect(fake.companyContextSource.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { id: "src-a", organizationId: ORG_A, type: "LINK" },
			}),
		);
	});
});

describe("claiming a source for re-processing", () => {
	const sourceA = () =>
		store.sources.find((row) => row.id === "src-a") as Row;

	beforeEach(() => {
		for (const row of store.sources) {
			row.urlActiveWorkflowId = null;
			row.extractionError = "an earlier run's message";
		}
	});

	it("sets an idle source PENDING and clears its message, and a second claim loses", async () => {
		const claim = () =>
			claimCompanyContextSourceForReprocess({
				id: "src-a",
				organizationId: ORG_A,
			});

		await expect(claim()).resolves.toBe(true);
		expect(sourceA()).toMatchObject({
			extractionStatus: "PENDING",
			extractionError: null,
		});
		expect(fake.companyContextSource.updateMany).toHaveBeenCalledWith({
			where: {
				id: "src-a",
				organizationId: ORG_A,
				extractionStatus: { notIn: ["PENDING", "EXTRACTING"] },
				urlActiveWorkflowId: null,
				deletingAt: null,
			},
			data: { extractionStatus: "PENDING", extractionError: null },
		});

		await expect(claim()).resolves.toBe(false);
	});

	it("loses to a source that is processing, or a website a crawl holds", async () => {
		sourceA().extractionStatus = "EXTRACTING";
		await expect(
			claimCompanyContextSourceForReprocess({
				id: "src-a",
				organizationId: ORG_A,
			}),
		).resolves.toBe(false);

		// A scheduled refresh leaves the status COMPLETED and holds the slot.
		sourceA().extractionStatus = "COMPLETED";
		sourceA().urlActiveWorkflowId = "wf-scheduled";
		await expect(
			claimCompanyContextSourceForReprocess({
				id: "src-a",
				organizationId: ORG_A,
			}),
		).resolves.toBe(false);
		expect(sourceA()).toMatchObject({
			extractionStatus: "COMPLETED",
			extractionError: "an earlier run's message",
		});
	});

	it("never claims another organization's source", async () => {
		await expect(
			claimCompanyContextSourceForReprocess({
				id: "src-b",
				organizationId: ORG_A,
			}),
		).resolves.toBe(false);
		expect(
			store.sources.find((row) => row.id === "src-b")?.extractionStatus,
		).toBe("COMPLETED");
	});
});

describe("claiming an uploaded file for processing", () => {
	const fileA = () =>
		store.sources.find((row) => row.id === "src-a-file") as Row;

	it("sets a PENDING file EXTRACTING, and a second claim loses", async () => {
		const claim = () =>
			claimCompanyFileSourceForProcessing({
				id: "src-a-file",
				organizationId: ORG_A,
			});

		await expect(claim()).resolves.toBe(true);
		expect(fileA().extractionStatus).toBe("EXTRACTING");
		expect(fake.companyContextSource.updateMany).toHaveBeenCalledWith({
			where: {
				id: "src-a-file",
				organizationId: ORG_A,
				type: "FILE",
				extractionStatus: "PENDING",
				deletingAt: null,
			},
			data: { extractionStatus: "EXTRACTING" },
		});

		await expect(claim()).resolves.toBe(false);
	});

	it("never claims another organization's file or a source that is not a file", async () => {
		await expect(
			claimCompanyFileSourceForProcessing({
				id: "src-a-file",
				organizationId: ORG_B,
			}),
		).resolves.toBe(false);
		const link = store.sources.find((row) => row.id === "src-a") as Row;
		link.extractionStatus = "PENDING";
		await expect(
			claimCompanyFileSourceForProcessing({
				id: "src-a",
				organizationId: ORG_A,
			}),
		).resolves.toBe(false);
		expect(fileA().extractionStatus).toBe("PENDING");
		expect(link.extractionStatus).toBe("PENDING");
	});
});

describe("releasing a claim whose run could not start", () => {
	const fileA = () =>
		store.sources.find((row) => row.id === "src-a-file") as Row;

	it("writes the status, and the message only when given", async () => {
		fileA().extractionStatus = "EXTRACTING";
		fileA().extractionError = "an earlier run's message";

		await expect(
			releaseCompanyContextSourceClaim({
				id: "src-a-file",
				organizationId: ORG_A,
				status: "PENDING",
			}),
		).resolves.toBe(true);
		expect(fileA()).toMatchObject({
			extractionStatus: "PENDING",
			extractionError: "an earlier run's message",
		});
		expect(fake.companyContextSource.updateMany).toHaveBeenLastCalledWith({
			where: {
				id: "src-a-file",
				organizationId: ORG_A,
				deletingAt: null,
			},
			data: { extractionStatus: "PENDING" },
		});

		await expect(
			releaseCompanyContextSourceClaim({
				id: "src-a-file",
				organizationId: ORG_A,
				status: "FAILED",
				extractionError: "Failed to start: boom",
			}),
		).resolves.toBe(true);
		expect(fileA()).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: "Failed to start: boom",
		});
	});

	it("never writes another organization's source", async () => {
		await expect(
			releaseCompanyContextSourceClaim({
				id: "src-b",
				organizationId: ORG_A,
				status: "FAILED",
				extractionError: "Failed to start: boom",
			}),
		).resolves.toBe(false);
		expect(store.sources.find((row) => row.id === "src-b")).toMatchObject({
			extractionStatus: "COMPLETED",
		});
	});
});

describe("a source being deleted", () => {
	const DELETING_AT = new Date("2026-09-30T12:00:00.000Z");
	const sourceA = () =>
		store.sources.find((row) => row.id === "src-a") as Row;
	const fileA = () =>
		store.sources.find((row) => row.id === "src-a-file") as Row;

	// What the delete leaves on the row before it starts the deletion.
	beforeEach(() => {
		for (const row of [sourceA(), fileA()]) {
			Object.assign(row, {
				deletingAt: DELETING_AT,
				extractionStatus: "FAILED",
				extractionError: "This source is being deleted.",
				urlActiveWorkflowId: null,
				embeddedAt: null,
				embeddingModel: null,
			});
		}
	});

	it("cannot be claimed for re-processing", async () => {
		await expect(
			claimCompanyContextSourceForReprocess({
				id: "src-a",
				organizationId: ORG_A,
			}),
		).resolves.toBe(false);
		expect(sourceA()).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: "This source is being deleted.",
			deletingAt: DELETING_AT,
		});
	});

	it("cannot be claimed for file processing, even with a late PENDING status", async () => {
		fileA().extractionStatus = "PENDING";

		await expect(
			claimCompanyFileSourceForProcessing({
				id: "src-a-file",
				organizationId: ORG_A,
			}),
		).resolves.toBe(false);
		expect(fileA()).toMatchObject({
			extractionStatus: "PENDING",
			deletingAt: DELETING_AT,
		});
	});

	it("keeps the delete's status and message when a claim on it is released", async () => {
		await expect(
			releaseCompanyContextSourceClaim({
				id: "src-a-file",
				organizationId: ORG_A,
				status: "PENDING",
			}),
		).resolves.toBe(false);
		await expect(
			releaseCompanyContextSourceClaim({
				id: "src-a",
				organizationId: ORG_A,
				status: "FAILED",
				extractionError: "Failed to start crawl: boom",
			}),
		).resolves.toBe(false);
		for (const row of [sourceA(), fileA()]) {
			expect(row).toMatchObject({
				deletingAt: DELETING_AT,
				extractionStatus: "FAILED",
				extractionError: "This source is being deleted.",
			});
		}
	});

	// Neither a scheduled crawl's claim at its gate nor the API's record of
	// a crawl it started.
	it("gives no crawl its slot", async () => {
		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-scheduled",
			}),
		).resolves.toBe(false);
		sourceA().extractionStatus = "PENDING";
		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-api",
				onlyWhileInFlight: true,
			}),
		).resolves.toBe(false);
		expect(sourceA().urlActiveWorkflowId).toBeNull();
	});

	it("refuses the late writes that would make it ready again", async () => {
		await expect(
			markCompanyContextSourceEmbedded("src-a-file", ORG_A, {
				embeddingModel: MODEL,
				qdrantId: "point-late",
			}),
		).resolves.toBe(false);
		await expect(
			updateCompanyContextSourceStatus("src-a-file", ORG_A, "COMPLETED", {
				content: "Extracted text",
				extractionError: null,
			}),
		).resolves.toBe(false);
		await expect(
			finalizeCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-late",
				outcome: {
					status: "COMPLETED",
					extractionError: null,
					embeddingModel: MODEL,
				},
			}),
		).resolves.toBe(false);

		for (const row of [sourceA(), fileA()]) {
			expect(row).toMatchObject({
				deletingAt: DELETING_AT,
				extractionStatus: "FAILED",
				extractionError: "This source is being deleted.",
				embeddedAt: null,
				embeddingModel: null,
			});
		}
		expect(fileA().qdrantId).toBeUndefined();
	});

	// Only a write that would make the source ready is refused: a status
	// that says it is not usable changes nothing that matters.
	it("still takes a failure status, which cannot make it ready", async () => {
		await expect(
			updateCompanyContextSourceStatus("src-a-file", ORG_A, "FAILED", {
				extractionError: "boom",
			}),
		).resolves.toBe(true);
		expect(fileA()).toMatchObject({
			extractionStatus: "FAILED",
			deletingAt: DELETING_AT,
		});
	});

	it("stays listed, with its tombstone, until the deletion removes the row", async () => {
		const rows = await listCompanyContextSources(ORG_A);

		expect(rows.find((row) => row.id === "src-a")).toMatchObject({
			deletingAt: DELETING_AT,
		});
		const args = fake.companyContextSource.findMany.mock.calls[0][0];
		expect(args.select?.deletingAt).toBe(true);
	});
});

describe("the crawl slot of a LINK source", () => {
	const sourceA = () =>
		store.sources.find((row) => row.id === "src-a") as Row;
	const sourceB = () =>
		store.sources.find((row) => row.id === "src-b") as Row;

	beforeEach(() => {
		for (const row of store.sources) {
			row.urlActiveWorkflowId = null;
		}
	});

	it("reads a LINK source's crawl state for its organization only", async () => {
		await expect(
			getCompanyLinkSourceCrawlState("src-b", ORG_A),
		).resolves.toBeNull();
		await expect(
			getCompanyLinkSourceCrawlState("src-a-file", ORG_A),
		).resolves.toBeNull();
		expect(fake.companyContextSource.findFirst).toHaveBeenLastCalledWith({
			where: { id: "src-a-file", organizationId: ORG_A, type: "LINK" },
			select: {
				extractionStatus: true,
				embeddedAt: true,
				urlRefreshMode: true,
				urlActiveWorkflowId: true,
			},
		});
	});

	it("claims a free slot, and the slot a crawl already holds", async () => {
		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-1",
			}),
		).resolves.toBe(true);
		expect(sourceA().urlActiveWorkflowId).toBe("wf-1");

		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-1",
			}),
		).resolves.toBe(true);
	});

	it("refuses a slot another crawl holds, unless it replaces that crawl", async () => {
		sourceA().urlActiveWorkflowId = "wf-running";

		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-2",
			}),
		).resolves.toBe(false);
		expect(sourceA().urlActiveWorkflowId).toBe("wf-running");

		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-2",
				replacing: "wf-other",
			}),
		).resolves.toBe(false);
		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-2",
				replacing: "wf-running",
			}),
		).resolves.toBe(true);
		expect(sourceA().urlActiveWorkflowId).toBe("wf-2");
	});

	it("claims only while the source is still queued or crawling when asked to, and not otherwise", async () => {
		sourceA().extractionStatus = "COMPLETED";

		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-api",
				onlyWhileInFlight: true,
			}),
		).resolves.toBe(false);
		expect(sourceA().urlActiveWorkflowId).toBeNull();
		expect(fake.companyContextSource.updateMany).toHaveBeenLastCalledWith({
			where: {
				id: "src-a",
				organizationId: ORG_A,
				type: "LINK",
				deletingAt: null,
				extractionStatus: { in: ["PENDING", "EXTRACTING"] },
				OR: [
					{ urlActiveWorkflowId: null },
					{ urlActiveWorkflowId: "wf-api" },
				],
			},
			data: { urlActiveWorkflowId: "wf-api" },
		});

		sourceA().extractionStatus = "EXTRACTING";
		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-api",
				onlyWhileInFlight: true,
			}),
		).resolves.toBe(true);
		expect(sourceA().urlActiveWorkflowId).toBe("wf-api");

		// Without the option the status is not part of the claim.
		sourceA().extractionStatus = "COMPLETED";
		sourceA().urlActiveWorkflowId = null;
		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-scheduled",
			}),
		).resolves.toBe(true);
		expect(fake.companyContextSource.updateMany).toHaveBeenLastCalledWith({
			where: {
				id: "src-a",
				organizationId: ORG_A,
				type: "LINK",
				deletingAt: null,
				OR: [
					{ urlActiveWorkflowId: null },
					{ urlActiveWorkflowId: "wf-scheduled" },
				],
			},
			data: { urlActiveWorkflowId: "wf-scheduled" },
		});
	});

	it("never claims another organization's source or a non-LINK source", async () => {
		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-b",
				organizationId: ORG_A,
				workflowId: "wf-1",
			}),
		).resolves.toBe(false);
		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a-file",
				organizationId: ORG_A,
				workflowId: "wf-1",
			}),
		).resolves.toBe(false);
		expect(sourceB().urlActiveWorkflowId).toBeNull();
		await expect(
			claimCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "",
			}),
		).rejects.toThrow();
	});

	it("finalizes the crawl holding the slot in one write, and frees the slot", async () => {
		sourceA().urlActiveWorkflowId = "wf-1";
		const syncedAt = new Date("2026-09-30T10:00:00.000Z");

		await expect(
			finalizeCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-1",
				outcome: {
					status: "COMPLETED",
					extractionError: null,
					urlLastSyncedAt: syncedAt,
					embeddingModel: MODEL,
				},
			}),
		).resolves.toBe(true);

		expect(fake.companyContextSource.updateMany).toHaveBeenCalledTimes(1);
		expect(sourceA()).toMatchObject({
			extractionStatus: "COMPLETED",
			extractionError: null,
			urlLastSyncedAt: syncedAt,
			embeddingModel: MODEL,
			urlActiveWorkflowId: null,
		});
		expect(sourceA().extractedAt).toBeInstanceOf(Date);
		expect(sourceA().embeddedAt).toBeInstanceOf(Date);
	});

	it("does not finalize a source another crawl holds", async () => {
		sourceA().urlActiveWorkflowId = "wf-running";

		await expect(
			finalizeCompanyLinkSourceCrawl({
				id: "src-a",
				organizationId: ORG_A,
				workflowId: "wf-old",
				outcome: { status: "FAILED", extractionError: "boom" },
			}),
		).resolves.toBe(false);
		expect(sourceA()).toMatchObject({
			extractionStatus: "COMPLETED",
			urlActiveWorkflowId: "wf-running",
		});
		expect(sourceA().extractionError).toBeUndefined();
	});

	it("leaves the fields an outcome omits alone, and stores single-page content with its hash", async () => {
		await finalizeCompanyLinkSourceCrawl({
			id: "src-a",
			organizationId: ORG_A,
			workflowId: "wf-1",
			outcome: { extractionError: "Firecrawl returned 429" },
		});
		expect(sourceA()).toMatchObject({
			extractionStatus: "COMPLETED",
			extractionError: "Firecrawl returned 429",
		});
		expect(sourceA()).not.toHaveProperty("urlLastSyncedAt");
		expect(sourceA()).not.toHaveProperty("extractedAt");

		await finalizeCompanyLinkSourceCrawl({
			id: "src-a",
			organizationId: ORG_A,
			workflowId: "wf-1",
			outcome: { status: "COMPLETED", content: "# Overview" },
		});
		expect(sourceA()).toMatchObject({
			content: "# Overview",
			contentHash: hashContextContent("# Overview"),
		});
	});

	it("never finalizes another organization's source", async () => {
		await expect(
			finalizeCompanyLinkSourceCrawl({
				id: "src-b",
				organizationId: ORG_A,
				workflowId: "wf-1",
				outcome: { status: "FAILED" },
			}),
		).resolves.toBe(false);
		expect(sourceB().extractionStatus).toBe("COMPLETED");
	});

	it("settles only its own source's PENDING pages that hold no vectors", async () => {
		store.pages = [
			{
				id: "never-reached",
				parentSourceId: "src-a",
				organizationId: ORG_A,
				extractionStatus: "PENDING",
				embeddedAt: null,
			},
			{
				id: "re-embed-pending",
				parentSourceId: "src-a",
				organizationId: ORG_A,
				extractionStatus: "PENDING",
				embeddedAt: new Date(),
			},
			{
				id: "failed",
				parentSourceId: "src-a",
				organizationId: ORG_A,
				extractionStatus: "FAILED",
				embeddedAt: null,
			},
			{
				id: "other-org",
				parentSourceId: "src-b",
				organizationId: ORG_B,
				extractionStatus: "PENDING",
				embeddedAt: null,
			},
		];

		await expect(
			cancelUnfinishedCompanyContextUrlPages("src-a", ORG_A),
		).resolves.toBe(1);
		expect(
			store.pages.map((page) => [page.id, page.extractionStatus]),
		).toEqual([
			["never-reached", "CANCELLED"],
			["re-embed-pending", "PENDING"],
			["failed", "FAILED"],
			["other-org", "PENDING"],
		]);
	});
});

describe("crawled pages", () => {
	it("creates only the missing pages, each carrying the organization", async () => {
		const result = await createCompanyContextUrlPages({
			parentSourceId: "src-a",
			organizationId: ORG_A,
			pageUrls: [
				"https://example.com/a",
				"https://example.com/c",
				"https://example.com/c",
			],
		});

		expect(result).toEqual({ createdCount: 1, existingCount: 1 });
		const args = fake.companyContextUrlPage.createMany.mock.calls[0][0];
		expect(args.skipDuplicates).toBe(true);
		expect(args.data).toEqual([
			expect.objectContaining({
				parentSourceId: "src-a",
				organizationId: ORG_A,
				pageUrl: "https://example.com/c",
				extractionStatus: "PENDING",
			}),
		]);
	});

	it("keeps an unchanged page's content and embedding", async () => {
		const result = await upsertCompanyContextUrlPage({
			parentSourceId: "src-a",
			organizationId: ORG_A,
			pageUrl: "https://example.com/a",
			content: "old",
		});

		expect(result).toMatchObject({ pageId: "page-a1", unchanged: true });
		const { data } = fake.companyContextUrlPage.updateMany.mock.calls[0][0];
		expect(data.content).toBeUndefined();
		expect(data.extractionStatus).toBeUndefined();
	});

	it("rewrites a changed page and queues it for embedding", async () => {
		const result = await upsertCompanyContextUrlPage({
			parentSourceId: "src-a",
			organizationId: ORG_A,
			pageUrl: "https://example.com/a",
			content: "new",
		});

		expect(result).toMatchObject({ pageId: "page-a1", unchanged: false });
		const { where, data } =
			fake.companyContextUrlPage.updateMany.mock.calls[0][0];
		expect(where).toEqual({ id: "page-a1", organizationId: ORG_A });
		expect(data).toMatchObject({
			content: "new",
			contentHash: hashContextContent("new"),
			extractionStatus: "PENDING",
		});
	});

	it("a forced re-sync rewrites even an unchanged page", async () => {
		const result = await upsertCompanyContextUrlPage({
			parentSourceId: "src-a",
			organizationId: ORG_A,
			pageUrl: "https://example.com/a",
			content: "old",
			force: true,
		});

		expect(result.unchanged).toBe(false);
		const { data } = fake.companyContextUrlPage.updateMany.mock.calls[0][0];
		expect(data.content).toBe("old");
	});

	// Another organization holds a page at the same URL; it must not be
	// mistaken for this source's page.
	it("creates a new page rather than touching another organization's", async () => {
		const result = await upsertCompanyContextUrlPage({
			parentSourceId: "src-b",
			organizationId: ORG_A,
			pageUrl: "https://example.com/a",
			content: "text",
		});

		expect(result).toMatchObject({ pageId: "created-1", unchanged: false });
		expect(fake.companyContextUrlPage.updateMany).not.toHaveBeenCalled();
		const { data } = fake.companyContextUrlPage.create.mock.calls[0][0];
		expect(data).toMatchObject({
			parentSourceId: "src-b",
			organizationId: ORG_A,
		});
	});

	it("updates the page a concurrent writer created first", async () => {
		fake.companyContextUrlPage.findFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ id: "page-raced", contentHash: "" });
		fake.companyContextUrlPage.create.mockRejectedValueOnce(
			new KnownRequestError("unique", "P2002"),
		);

		const result = await upsertCompanyContextUrlPage({
			parentSourceId: "src-a",
			organizationId: ORG_A,
			pageUrl: "https://example.com/new",
			content: "text",
		});

		expect(result).toMatchObject({
			pageId: "page-raced",
			unchanged: false,
		});
	});

	it("rethrows any other create failure", async () => {
		fake.companyContextUrlPage.create.mockRejectedValueOnce(
			new Error("connection reset"),
		);

		await expect(
			upsertCompanyContextUrlPage({
				parentSourceId: "src-a",
				organizationId: ORG_A,
				pageUrl: "https://example.com/new",
				content: "text",
			}),
		).rejects.toThrow("connection reset");
	});

	it("page writes are scoped by organization", async () => {
		await expect(
			updateCompanyContextUrlPage("page-b1", ORG_A, {
				extractionStatus: "FAILED",
			}),
		).resolves.toBe(false);
		await expect(
			markCompanyContextUrlPageEmbedded("page-a1", ORG_A, {
				embeddingModel: MODEL,
				chunkCount: 3,
			}),
		).resolves.toBe(true);
		expect(store.pages[0]).toMatchObject({
			embeddingModel: MODEL,
			chunkCount: 3,
			extractionStatus: "COMPLETED",
			extractionError: null,
		});
	});

	it("prunes pages the crawl no longer returned and reports their ids", async () => {
		await expect(
			pruneCompanyContextUrlPages({
				parentSourceId: "src-a",
				organizationId: ORG_A,
				keptUrls: ["https://example.com/a"],
			}),
		).resolves.toEqual({ deletedPageIds: ["page-a2"] });
		expect(fake.companyContextUrlPage.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["page-a2"] }, organizationId: ORG_A },
		});
	});

	it("an empty crawl prunes nothing", async () => {
		await expect(
			pruneCompanyContextUrlPages({
				parentSourceId: "src-a",
				organizationId: ORG_A,
				keptUrls: [],
			}),
		).resolves.toEqual({ deletedPageIds: [] });
		expect(fake.companyContextUrlPage.deleteMany).not.toHaveBeenCalled();
	});

	it("counts the organization's pages under a source that hold the given model's vectors", async () => {
		fake.companyContextUrlPage.count.mockResolvedValueOnce(2);

		await expect(
			countCompanyContextUrlPagesEmbeddedWith({
				parentSourceId: "src-a",
				organizationId: ORG_A,
				embeddingModel: MODEL,
			}),
		).resolves.toBe(2);
		expect(fake.companyContextUrlPage.count).toHaveBeenCalledWith({
			where: {
				parentSourceId: "src-a",
				organizationId: ORG_A,
				embeddedAt: { not: null },
				embeddingModel: MODEL,
			},
		});
		await expect(
			countCompanyContextUrlPagesEmbeddedWith({
				parentSourceId: "src-a",
				organizationId: ORG_A,
				embeddingModel: "",
			}),
		).rejects.toThrow();
	});
});

describe("metadata edits", () => {
	it("reports another organization's source as not found", async () => {
		await expect(
			updateCompanyContextSourceMetadata("src-b", ORG_A, "user-1", {
				sourceType: "Brochure",
			}),
		).resolves.toEqual({ status: "not-found" });
		expect(fake.companyContextSource.updateMany).not.toHaveBeenCalled();
	});

	it("writes nothing when the value is already stored", async () => {
		const result = await updateCompanyContextSourceMetadata(
			"src-a",
			ORG_A,
			"user-1",
			{ sourceType: "  Case study " },
		);

		expect(result.status).toBe("unchanged");
		expect(fake.companyContextSource.updateMany).not.toHaveBeenCalled();
	});

	it("refuses a write against values the caller no longer holds", async () => {
		const result = await updateCompanyContextSourceMetadata(
			"src-a",
			ORG_A,
			"user-1",
			{ sourceType: "Brochure" },
			{
				expected: {
					sourceType: "Something else",
					aiInstructions: null,
				},
			},
		);

		expect(result.status).toBe("stale");
		expect(fake.companyContextSource.updateMany).not.toHaveBeenCalled();
	});

	it("stamps the editor on a real change", async () => {
		const result = await updateCompanyContextSourceMetadata(
			"src-a",
			ORG_A,
			"user-1",
			{ sourceType: "Brochure", aiInstructions: "Quote sparingly." },
			{ expected: { sourceType: "Case study", aiInstructions: null } },
		);

		expect(result).toMatchObject({
			status: "updated",
			before: { sourceType: "Case study", aiInstructions: null },
			after: {
				sourceType: "Brochure",
				aiInstructions: "Quote sparingly.",
			},
			changed: ["sourceType", "aiInstructions"],
		});
		const { where, data } =
			fake.companyContextSource.updateMany.mock.calls[0][0];
		expect(where).toMatchObject({ id: "src-a", organizationId: ORG_A });
		expect(data).toMatchObject({
			sourceType: "Brochure",
			aiInstructions: "Quote sparingly.",
			metadataUpdatedByUserId: "user-1",
		});
		expect(data.metadataUpdatedAt).toBeInstanceOf(Date);
	});
});

describe("delete", () => {
	it("does not delete another organization's source", async () => {
		await expect(
			deleteCompanyContextSource("src-b", ORG_A),
		).resolves.toBeNull();
		expect(fake.companyContextSource.deleteMany).not.toHaveBeenCalled();
	});

	it("returns what the caller must clean up outside Postgres", async () => {
		const deleted = await deleteCompanyContextSource("src-a", ORG_A);

		expect(deleted).toMatchObject({
			id: "src-a",
			urlScheduleId: "sched-a",
			urlPageIds: ["page-a1", "page-a2"],
		});
		expect(fake.companyContextSource.deleteMany).toHaveBeenCalledWith({
			where: { id: "src-a", organizationId: ORG_A },
		});
	});
});
