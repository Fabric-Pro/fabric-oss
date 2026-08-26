/**
 * Tests for `getRetrievableContextById`.
 *
 * The helper exists because Qdrant chunks for URL Context Sources store the
 * PER-PAGE `ProjectContextUrlPage.id` as their `contextId` (not the parent
 * `ProjectContext.id`). The legacy `getContextById` only knows about the
 * parent table — so every retrieval flow that consumed it silently
 * dropped URL-page hits, leaving the AI blind to URL sources.
 *
 * These tests pin the dual-table resolution:
 *   - Hit in `ProjectContext` → return the parent row unchanged.
 *   - Miss in parent → fall back to `ProjectContextUrlPage` and synthesize
 *     a LINK-typed envelope carrying the parent's `sourceTitle`.
 *   - Both tables miss → null.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({
	db: {
		projectContext: { findUnique: vi.fn(), findFirst: vi.fn() },
		projectContextUrlPage: { findUnique: vi.fn() },
	},
}));

import { db } from "../prisma/client";
import { getRetrievableContextById } from "../prisma/queries/projects/contexts";

const mockProjectContextFindUnique = db.projectContext.findUnique as ReturnType<
	typeof vi.fn
>;
const mockUrlPageFindUnique = db.projectContextUrlPage.findUnique as ReturnType<
	typeof vi.fn
>;

describe("getRetrievableContextById", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the ProjectContext row when the id matches a top-level context", async () => {
		mockProjectContextFindUnique.mockResolvedValueOnce({
			id: "ctx-1",
			type: "FILE",
			content: "uploaded file content",
			createdAt: new Date("2026-04-01"),
			metadata: { foo: "bar" },
			originalFilename: "spec.pdf",
			sourceUrl: null,
			sourceTitle: null,
		});

		const result = await getRetrievableContextById("ctx-1");

		expect(result).toEqual({
			id: "ctx-1",
			type: "FILE",
			content: "uploaded file content",
			createdAt: new Date("2026-04-01"),
			metadata: { foo: "bar" },
			originalFilename: "spec.pdf",
			sourceUrl: null,
			sourceTitle: null,
		});
		// Critical: when the parent table hit, we MUST NOT also query the
		// url-page table. That second round-trip would balloon retrieval
		// latency for the common case (top-level contexts dominate).
		expect(mockUrlPageFindUnique).not.toHaveBeenCalled();
	});

	it("falls back to ProjectContextUrlPage when the id isn't a top-level context", async () => {
		// The bug case: Qdrant returned a per-page id from a URL crawl.
		// Without the fallback, the caller filters this hit out and the LLM
		// sees zero URL-source content even though Qdrant matched it.
		mockProjectContextFindUnique.mockResolvedValueOnce(null);
		mockUrlPageFindUnique.mockResolvedValueOnce({
			id: "page-1",
			content: "article body text…",
			pageUrl:
				"https://help.acme.com/hc/en-us/articles/12345-How-to-Use-Reports",
			pageTitle: "How to Use Reports",
			createdAt: new Date("2026-05-15T10:00:00Z"),
			parentContext: {
				id: "parent-ctx",
				sourceTitle: "Acme Help Center",
			},
		});

		const result = await getRetrievableContextById("page-1");

		expect(result).toEqual({
			id: "page-1",
			// Reports as LINK so downstream type-aware branches treat it
			// like a top-level URL source (e.g. prompt formatter renders
			// `## URL Source: <title>` instead of `## File: page-1`).
			type: "LINK",
			content: "article body text…",
			createdAt: new Date("2026-05-15T10:00:00Z"),
			metadata: {
				parentContextId: "parent-ctx",
				pageUrl:
					"https://help.acme.com/hc/en-us/articles/12345-How-to-Use-Reports",
				pageTitle: "How to Use Reports",
			},
			originalFilename: null,
			// `sourceUrl` is the PER-ARTICLE URL (citation target), NOT the
			// parent help-center root URL. The AI cites specific articles.
			sourceUrl:
				"https://help.acme.com/hc/en-us/articles/12345-How-to-Use-Reports",
			// `sourceTitle` is the user's parent label, not the article
			// title — keeps the prompt readable across many articles from
			// the same help center.
			sourceTitle: "Acme Help Center",
			// Type label + AI guidance ride on the PARENT source and apply
			// to every crawled page (#1888). Null here: the fixture's
			// parent carries none.
			sourceType: null,
			aiInstructions: null,
		});
	});

	it("falls back to the per-article title when the parent has no custom label", async () => {
		// Edge case: user added the URL source without typing a label,
		// so `parentContext.sourceTitle` is null. We use the article's own
		// title so the AI still has something human-readable to cite.
		mockProjectContextFindUnique.mockResolvedValueOnce(null);
		mockUrlPageFindUnique.mockResolvedValueOnce({
			id: "page-2",
			content: "another article",
			pageUrl: "https://x.com/article",
			pageTitle: "Some Article Title",
			createdAt: new Date(),
			parentContext: { id: "parent-ctx", sourceTitle: null },
		});

		const result = await getRetrievableContextById("page-2");

		expect(result?.sourceTitle).toBe("Some Article Title");
	});

	it("returns null when neither table has the id", async () => {
		// Defensive case: Qdrant chunks can outlive their backing rows if a
		// cascade-delete fires between search and fetch. Caller filters
		// nulls; we just have to not throw.
		mockProjectContextFindUnique.mockResolvedValueOnce(null);
		mockUrlPageFindUnique.mockResolvedValueOnce(null);

		const result = await getRetrievableContextById("ghost-id");

		expect(result).toBeNull();
	});
});
