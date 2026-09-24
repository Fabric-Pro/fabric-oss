/**
 * The chat's live reads of a project's documents and Context-tab sources
 * (Fizzy #2578). Pinned here: the access gate runs before any query, a get by
 * id never reads a row from another project, paging and the summary sentence
 * the model reports counts from, the code-index exclusion, and the body cap
 * with its continuation offset.
 *
 * The body reader shared with the MCP gateway runs for real; only the storage
 * readers under it are mocked, by the module paths it imports them from.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getProjectAccessContext: vi.fn(),
	listDocuments: vi.fn(),
	getDocumentById: vi.fn(),
	documentFindMany: vi.fn(),
	listProjectContextSummaries: vi.fn(),
	getContextById: vi.fn(),
	getCrawledUrlSourceMarkdownPage: vi.fn(),
	getCapturedConversationMarkdown: vi.fn(),
}));

vi.mock("@repo/database/prisma/queries/projects/contexts", () => ({
	getCrawledUrlSourceMarkdownPage: h.getCrawledUrlSourceMarkdownPage,
}));
vi.mock("@repo/database/prisma/queries/projects/conversation-bundles", () => ({
	getCapturedConversationMarkdown: h.getCapturedConversationMarkdown,
}));

// The real shared body reader, bound once it has loaded; the factory itself
// stays synchronous so every lazy import of the barrel gets the mock.
const bodyReader = vi.hoisted(() => ({
	read: undefined as undefined | ((...args: unknown[]) => unknown),
}));

vi.mock("@repo/database", () => ({
	getProjectAccessContext: h.getProjectAccessContext,
	listDocuments: h.listDocuments,
	getDocumentById: h.getDocumentById,
	listProjectContextSummaries: h.listProjectContextSummaries,
	getContextById: h.getContextById,
	readProjectContextBodyPage: (...args: unknown[]) =>
		bodyReader.read?.(...args),
	db: { projectDocument: { findMany: h.documentFindMany } },
}));

bodyReader.read = (
	(await vi.importActual(
		"@repo/database/prisma/queries/projects/context-body",
	)) as { readProjectContextBodyPage: (...args: unknown[]) => unknown }
).readProjectContextBodyPage;

const {
	getProjectDocument,
	getProjectSource,
	listProjectDocuments,
	listProjectSources,
	PROJECT_DOCUMENT_TOOL_IDS,
} = await import("../src/activities/shared/project-document-reads");
const { PROJECT_DOCUMENT_TYPES, PROJECT_SOURCE_TYPES } = await import(
	"../src/workflows/orchestrator/project-document-tool-schemas"
);

const CTX = { projectId: "p-1", userId: "u-1" };
const DATE = new Date("2026-09-20T00:00:00Z");

function doc(overrides: Record<string, unknown> = {}) {
	return {
		id: "d-1",
		projectId: "p-1",
		title: "Product Requirements",
		type: "PRD",
		status: "COMPLETE",
		version: 3,
		content: "Users sign in with SSO.",
		generationError: null,
		createdAt: DATE,
		updatedAt: DATE,
		...overrides,
	};
}

function sourceSummary(overrides: Record<string, unknown> = {}) {
	return {
		id: "c-1",
		type: "FILE",
		sourceTitle: null,
		originalFilename: "architecture.pdf",
		mimeType: "application/pdf",
		fileSize: 1024,
		sourceUrl: null,
		extractionStatus: "COMPLETED",
		extractionError: null,
		urlScope: null,
		metadata: {},
		createdAt: DATE,
		updatedAt: DATE,
		hasStoredFile: true,
		hasContent: true,
		...overrides,
	};
}

function sourceRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "c-1",
		projectId: "p-1",
		type: "TEXT",
		sourceTitle: "Kickoff notes",
		originalFilename: null,
		sourceUrl: null,
		extractionStatus: "COMPLETED",
		extractionError: null,
		urlScope: null,
		metadata: {},
		content: "Scope agreed.",
		createdAt: DATE,
		updatedAt: DATE,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	h.getProjectAccessContext.mockResolvedValue({ organizationId: "org-host" });
	h.listDocuments.mockResolvedValue({ documents: [doc()], total: 1 });
	h.getDocumentById.mockResolvedValue(doc());
	h.documentFindMany.mockResolvedValue([]);
	h.listProjectContextSummaries.mockResolvedValue({
		contexts: [sourceSummary()],
		total: 1,
		hasMore: false,
		excludedCodeContexts: 0,
	});
	h.getContextById.mockResolvedValue(sourceRow());
	h.getCapturedConversationMarkdown.mockResolvedValue("");
});

describe("access", () => {
	it("refuses a project the user cannot reach and queries nothing", async () => {
		h.getProjectAccessContext.mockResolvedValue(null);

		const results = [
			await listProjectDocuments({}, CTX),
			await getProjectDocument({ document: "d-1" }, CTX),
			await listProjectSources({}, CTX),
			await getProjectSource({ source: "c-1" }, CTX),
		];

		for (const res of results) {
			expect(res).toEqual({
				error: "Project not found or access denied.",
			});
		}
		expect(h.getProjectAccessContext).toHaveBeenCalledWith("p-1", "u-1");
		expect(h.listDocuments).not.toHaveBeenCalled();
		expect(h.getDocumentById).not.toHaveBeenCalled();
		expect(h.listProjectContextSummaries).not.toHaveBeenCalled();
		expect(h.getContextById).not.toHaveBeenCalled();
	});

	it("asks for a project when none is attached", async () => {
		for (const read of [
			listProjectDocuments,
			listProjectSources,
		] as const) {
			expect(await read({}, { userId: "u-1" })).toMatchObject({
				error: expect.stringContaining("No project is attached"),
			});
		}
		expect(h.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("never reads a document or source from another project by id", async () => {
		h.getDocumentById.mockResolvedValue(doc({ projectId: "p-other" }));
		h.getContextById.mockResolvedValue(sourceRow({ projectId: "p-other" }));

		expect(
			await getProjectDocument({ document: "d-1" }, CTX),
		).toMatchObject({
			error: expect.stringContaining('No document "d-1" in this project'),
		});
		expect(await getProjectSource({ source: "c-1" }, CTX)).toMatchObject({
			error: expect.stringContaining('No source "c-1" in this project'),
		});
	});

	it("exports exactly the four read tool ids", () => {
		expect([...PROJECT_DOCUMENT_TOOL_IDS]).toEqual([
			"fabric_list_project_documents",
			"fabric_get_project_document",
			"fabric_list_project_sources",
			"fabric_get_project_source",
		]);
	});

	// The schemas are hand-written so the workflow bundle stays Prisma-free;
	// this keeps them from drifting away from the database enums.
	it("offers exactly the database's document and source types", async () => {
		const zod = await import("@repo/database/prisma/zod");
		expect([...PROJECT_DOCUMENT_TYPES]).toEqual(
			zod.ProjectDocumentTypeSchema.options,
		);
		expect([...PROJECT_SOURCE_TYPES]).toEqual(
			zod.ProjectContextTypeSchema.options,
		);
	});
});

describe("listProjectDocuments", () => {
	it("scopes the query to the chat's project and pages it", async () => {
		h.listDocuments.mockResolvedValue({
			documents: [doc(), doc({ id: "d-2", title: "Tech spec" })],
			total: 7,
		});

		const res = await listProjectDocuments(
			{ type: "prd", search: "requirements", limit: 2, offset: 2 },
			CTX,
		);

		expect(h.listDocuments).toHaveBeenCalledWith({
			projectId: "p-1",
			type: "PRD",
			search: "requirements",
			limit: 2,
			offset: 2,
		});
		expect(res).toMatchObject({
			total: 7,
			hasMore: true,
			summary:
				"7 documents in this project's Documents tab matching these filters. This page lists 2 starting at offset 2; total covers every page.",
		});
		expect((res as { documents: unknown[] }).documents[0]).toEqual({
			id: "d-1",
			title: "Product Requirements",
			type: "PRD",
			status: "COMPLETE",
			version: 3,
			createdAt: DATE,
			updatedAt: DATE,
		});
	});

	it("never returns bodies in the listing", async () => {
		const res = await listProjectDocuments({}, CTX);
		expect(JSON.stringify(res)).not.toContain("Users sign in with SSO");
	});

	it("clamps the page size", async () => {
		await listProjectDocuments({ limit: 5000 }, CTX);
		expect(h.listDocuments).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 100, offset: 0 }),
		);
	});

	it("refuses an unknown type with the valid ones", async () => {
		expect(await listProjectDocuments({ type: "MEMO" }, CTX)).toMatchObject(
			{
				error: expect.stringContaining("PRD"),
			},
		);
		expect(h.listDocuments).not.toHaveBeenCalled();
	});
});

describe("getProjectDocument", () => {
	it("reads a long document in pages with a continuation offset", async () => {
		const body = "a".repeat(25_000);
		h.getDocumentById.mockResolvedValue(doc({ content: body }));

		const first = (await getProjectDocument({ document: "d-1" }, CTX)) as {
			content: string;
			truncated: boolean;
			nextOffset: number;
			contentLength: number;
		};
		expect(first.content).toHaveLength(15_000);
		expect(first).toMatchObject({
			truncated: true,
			nextOffset: 15_000,
			contentLength: 25_000,
			contentAvailable: true,
		});

		const second = (await getProjectDocument(
			{ document: "d-1", offset: first.nextOffset },
			CTX,
		)) as Record<string, unknown>;
		expect(second).toMatchObject({
			offset: 15_000,
			returnedLength: 10_000,
			truncated: false,
		});
		expect(second).not.toHaveProperty("nextOffset");
	});

	it("caps a requested page at the maximum", async () => {
		h.getDocumentById.mockResolvedValue(
			doc({ content: "b".repeat(90_000) }),
		);
		const res = (await getProjectDocument(
			{ document: "d-1", maxLength: 1_000_000 },
			CTX,
		)) as { returnedLength: number };
		expect(res.returnedLength).toBe(40_000);
	});

	it("finds a document by its exact title in the chat's project", async () => {
		h.getDocumentById.mockImplementation(async (id: string) =>
			id === "d-9" ? doc({ id: "d-9" }) : null,
		);
		h.documentFindMany.mockResolvedValue([
			{ id: "d-9", title: "Product Requirements", type: "PRD" },
		]);

		const res = await getProjectDocument(
			{ document: "product requirements" },
			CTX,
		);

		expect(h.documentFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "p-1",
					title: {
						equals: "product requirements",
						mode: "insensitive",
					},
				},
			}),
		);
		expect(res).toMatchObject({ id: "d-9", title: "Product Requirements" });
	});

	it("says why a document has no text yet", async () => {
		h.getDocumentById.mockResolvedValue(
			doc({ content: "", status: "GENERATING" }),
		);
		expect(
			await getProjectDocument({ document: "d-1" }, CTX),
		).toMatchObject({
			contentAvailable: false,
			unavailableReason: expect.stringContaining("still being generated"),
		});
	});
});

describe("listProjectSources", () => {
	it("excludes code-index entries by default and says how many", async () => {
		h.listProjectContextSummaries.mockResolvedValue({
			contexts: [sourceSummary()],
			total: 1,
			hasMore: false,
			excludedCodeContexts: 1843,
		});

		const res = await listProjectSources({}, CTX);

		expect(h.listProjectContextSummaries).toHaveBeenCalledWith({
			projectId: "p-1",
			type: undefined,
			search: undefined,
			includeCodeContexts: false,
			limit: 25,
			offset: 0,
		});
		expect(res).toMatchObject({
			total: 1,
			excludedCodeContexts: 1843,
			summary:
				"1 source on this project's Context tab. 1843 repository code-index entries are not counted (use code_search for code).",
		});
	});

	it("labels each source's kind and resolves its title", async () => {
		h.listProjectContextSummaries.mockResolvedValue({
			contexts: [
				sourceSummary(),
				sourceSummary({
					id: "c-2",
					type: "MEETING_TRANSCRIPT",
					originalFilename: null,
					metadata: { title: "Weekly sync" },
				}),
				sourceSummary({
					id: "c-3",
					type: "LINK",
					originalFilename: null,
					sourceTitle: "API docs",
					sourceUrl: "https://example.com/docs",
				}),
			],
			total: 3,
			hasMore: false,
			excludedCodeContexts: 0,
		});

		const res = (await listProjectSources({}, CTX)) as {
			sources: Array<Record<string, unknown>>;
		};

		expect(res.sources.map((s) => [s.title, s.kind, s.type])).toEqual([
			["architecture.pdf", "file", "FILE"],
			["Weekly sync", "transcript", "MEETING_TRANSCRIPT"],
			["API docs", "link", "LINK"],
		]);
	});

	it("explains an empty file without pointing at a link the chat never returns", async () => {
		h.listProjectContextSummaries.mockResolvedValue({
			contexts: [sourceSummary({ hasContent: false })],
			total: 1,
			hasMore: false,
			excludedCodeContexts: 0,
		});
		const res = (await listProjectSources({}, CTX)) as {
			sources: Array<{ unavailableReason?: string }>;
		};
		expect(res.sources[0].unavailableReason).toContain("Context tab");
		expect(res.sources[0].unavailableReason).not.toContain("originalFile");
	});

	it("passes an explicit type and paging through", async () => {
		await listProjectSources(
			{ type: "link", includeCodeContexts: true, limit: 10, offset: 20 },
			CTX,
		);
		expect(h.listProjectContextSummaries).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "LINK",
				includeCodeContexts: true,
				limit: 10,
				offset: 20,
			}),
		);
	});
});

describe("getProjectSource", () => {
	it("pages a long source and gives the continuation offset", async () => {
		h.getContextById.mockResolvedValue(
			sourceRow({ content: "x".repeat(20_000) }),
		);

		const res = await getProjectSource(
			{ source: "c-1", maxLength: 5000 },
			CTX,
		);

		expect(res).toMatchObject({
			title: "Kickoff notes",
			kind: "note",
			contentAvailable: true,
			contentLength: 20_000,
			returnedLength: 5000,
			truncated: true,
			nextOffset: 5000,
		});
	});

	it("reads a crawled link's pages under the project's hosting organization", async () => {
		h.getContextById.mockResolvedValue(
			sourceRow({ type: "LINK", urlScope: "PATH_PREFIX", content: "" }),
		);
		h.getCrawledUrlSourceMarkdownPage.mockResolvedValue({
			content: "## Docs",
			contentLength: 7,
			hasReadableText: true,
		});

		const res = await getProjectSource({ source: "c-1" }, CTX);

		expect(h.getCrawledUrlSourceMarkdownPage).toHaveBeenCalledWith(
			"c-1",
			{ userId: "u-1", organizationId: "org-host" },
			{ offset: 0, maxLength: 15_000 },
		);
		expect(res).toMatchObject({ content: "## Docs", truncated: false });
	});

	it("says why a monitored conversation has no text instead of calling it empty", async () => {
		h.getContextById.mockResolvedValue(
			sourceRow({
				type: "INTEGRATION",
				content: "",
				metadata: { provider: "SLACK", channelId: "C1" },
			}),
		);

		expect(await getProjectSource({ source: "c-1" }, CTX)).toMatchObject({
			kind: "integration",
			contentAvailable: false,
			unavailableReason: expect.stringContaining(
				"does not mean an empty conversation",
			),
		});
	});
});
