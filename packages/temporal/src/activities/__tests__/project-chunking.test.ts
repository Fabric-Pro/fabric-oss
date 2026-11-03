import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getProjectChunkingSettings: vi.fn(),
	contextFindFirst: vi.fn(),
	documentFindFirst: vi.fn(),
	markProjectContextChunkingVersion: vi.fn(),
	markProjectDocumentChunkingVersion: vi.fn(),
	reembedProjectContext: vi.fn(),
	rechunkProjectDocument: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getSystemEmbeddingRAGProviderConfig: vi.fn(async () => ({ apiKey: "k" })),
}));
vi.mock("@repo/database", () => ({
	db: {
		projectContext: { findFirst: m.contextFindFirst },
		projectDocument: { findFirst: m.documentFindFirst },
	},
	getProjectChunkingSettings: m.getProjectChunkingSettings,
	listProjectSourcesBehindChunkingVersion: vi.fn(),
	markProjectContextChunkingVersion: m.markProjectContextChunkingVersion,
	markProjectDocumentChunkingVersion: m.markProjectDocumentChunkingVersion,
	updateProjectChunkingRun: vi.fn(),
}));
vi.mock("@repo/rag", () => ({
	reembedProjectContext: m.reembedProjectContext,
	rechunkProjectDocument: m.rechunkProjectDocument,
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

import { rechunkProjectSourceActivity } from "../project-chunking";

const scope = {
	projectId: "proj-1",
	organizationId: "org-example",
	userId: "user-1",
	runId: "run-1",
	chunkingVersion: 2,
};

const CONTEXT = {
	id: "c1",
	type: "FILE",
	content: "# Doc\n\nBody",
	metadata: null,
	mimeType: "text/markdown",
	originalFilename: "doc.md",
	sourceUrl: null,
	sourceTitle: null,
	chunkProfile: "sectioned",
	chunkingVersion: 1,
};

beforeEach(() => {
	vi.clearAllMocks();
	m.getProjectChunkingSettings.mockResolvedValue({ chunkingVersion: 2 });
});

describe("rechunkProjectSourceActivity", () => {
	it("re-chunks a context from stored text with its override, then stamps the version", async () => {
		m.contextFindFirst.mockResolvedValue(CONTEXT);
		m.reembedProjectContext.mockResolvedValue({ success: true });

		const result = await rechunkProjectSourceActivity({
			...scope,
			source: "context",
			sourceId: "c1",
		});

		expect(result.outcome).toBe("rechunked");
		expect(m.contextFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "c1",
					projectId: "proj-1",
					organizationId: "org-example",
				},
			}),
		);
		expect(m.reembedProjectContext).toHaveBeenCalledWith(
			expect.objectContaining({
				content: CONTEXT.content,
				chunkProfile: "sectioned",
				organizationId: "org-example",
			}),
		);
		expect(m.markProjectContextChunkingVersion).toHaveBeenCalledWith(
			"c1",
			2,
		);
	});

	it("keeps the old points and the old version when the embed fails", async () => {
		m.contextFindFirst.mockResolvedValue(CONTEXT);
		m.reembedProjectContext.mockResolvedValue({
			success: false,
			error: "provider down",
		});
		const result = await rechunkProjectSourceActivity({
			...scope,
			source: "context",
			sourceId: "c1",
		});
		expect(result).toEqual({ outcome: "failed", error: "provider down" });
		expect(m.markProjectContextChunkingVersion).not.toHaveBeenCalled();
	});

	it("skips a source already at the run's version (idempotent retry)", async () => {
		m.contextFindFirst.mockResolvedValue({
			...CONTEXT,
			chunkingVersion: 2,
		});
		const result = await rechunkProjectSourceActivity({
			...scope,
			source: "context",
			sourceId: "c1",
		});
		expect(result.outcome).toBe("skipped");
		expect(m.reembedProjectContext).not.toHaveBeenCalled();
	});

	it("reports superseded once a newer change was saved", async () => {
		m.getProjectChunkingSettings.mockResolvedValue({ chunkingVersion: 3 });
		const result = await rechunkProjectSourceActivity({
			...scope,
			source: "document",
			sourceId: "d1",
		});
		expect(result.outcome).toBe("superseded");
		expect(m.documentFindFirst).not.toHaveBeenCalled();
	});

	it("re-chunks a document without the unchanged-body skip", async () => {
		m.documentFindFirst.mockResolvedValue({
			id: "d1",
			type: "PRD",
			title: "PRD",
			content: "# PRD",
			version: 7,
			isActive: true,
			userId: "author-1",
			chunkProfile: null,
			chunkingVersion: null,
		});
		m.rechunkProjectDocument.mockResolvedValue({ success: true });
		const result = await rechunkProjectSourceActivity({
			...scope,
			source: "document",
			sourceId: "d1",
		});
		expect(result.outcome).toBe("rechunked");
		expect(m.rechunkProjectDocument).toHaveBeenCalledWith(
			expect.objectContaining({ documentId: "d1", expectedVersion: 7 }),
		);
		expect(m.markProjectDocumentChunkingVersion).toHaveBeenCalledWith(
			"d1",
			2,
		);
	});
});
