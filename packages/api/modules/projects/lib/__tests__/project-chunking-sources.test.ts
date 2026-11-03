import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	contexts: vi.fn(),
	documents: vi.fn(),
	scroll: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectContext: { findMany: m.contexts },
		projectDocument: { findMany: m.documents },
	},
}));

vi.mock("@repo/rag", () => ({
	analyzeChunkQuality: vi.fn(),
	// Group by the context's filename extension, enough to tell rows apart.
	contentGroupFor: ({ filename }: { filename: string }) =>
		filename.endsWith(".md") ? "sectioned" : "prose",
	contentKindForContext: () => undefined,
	contentKindForDocumentType: () => "prd",
	scrollProjectChunks: m.scroll,
}));

import { listProjectChunkingSources } from "../project-chunking-quality";

const context = (id: string, filename: string, extra = {}) => ({
	id,
	type: "TEXT",
	metadata: null,
	content: "x".repeat(100),
	mimeType: null,
	originalFilename: filename,
	sourceTitle: null,
	sourcePath: null,
	sourceUrl: null,
	embeddedAt: new Date(),
	...extra,
});

beforeEach(() => {
	vi.clearAllMocks();
	m.contexts.mockResolvedValue([
		context("c1", "docs/b.md"),
		context("c2", "docs/a.md", { sourcePath: "docs/a.md" }),
		context("c3", "notes.txt"),
	]);
	m.documents.mockResolvedValue([]);
	m.scroll.mockResolvedValue({
		truncated: false,
		chunks: [
			{
				sourceId: "c2",
				chunkIndex: 0,
				content: "a",
				profile: "sectioned",
			},
			{
				sourceId: "c2",
				chunkIndex: 1,
				content: "b",
				profile: "sectioned",
			},
		],
	});
});

describe("listProjectChunkingSources", () => {
	it("lists only the sources of the asked type, by title, a page at a time", async () => {
		const page = await listProjectChunkingSources({
			projectId: "p1",
			organizationId: "org-example",
			contentType: "sectioned",
			offset: 0,
			limit: 1,
		});
		expect(page.total).toBe(2);
		expect(page.rows).toEqual([
			{
				id: "c2",
				title: "docs/a.md",
				origin: "context",
				location: "docs/a.md",
				characters: 100,
				chunks: 2,
				embedded: true,
				chunkedBy: ["sectioned"],
			},
		]);
		const next = await listProjectChunkingSources({
			projectId: "p1",
			organizationId: "org-example",
			contentType: "sectioned",
			offset: 1,
			limit: 1,
		});
		expect(next.rows.map((r) => r.id)).toEqual(["c1"]);
	});

	it("reads only the caller's organization", async () => {
		await listProjectChunkingSources({
			projectId: "p1",
			organizationId: "org-example",
			contentType: "prose",
			offset: 0,
			limit: 25,
		});
		expect(m.contexts).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organizationId: "org-example",
				}),
			}),
		);
		expect(m.scroll).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-example" }),
		);
	});
});
