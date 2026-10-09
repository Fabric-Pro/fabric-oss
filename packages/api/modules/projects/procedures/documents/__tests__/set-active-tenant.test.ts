/**
 * `setActiveDocumentProcedure` embeds the newly active document with the
 * project's organization's RAG provider, never one the input names.
 *
 * `requireProjectPermission` authorizes the PROJECT. `input.organizationId`
 * is the caller's own string; used as the tenant, it would hand the embedding
 * (and the provider key it needs) to an organization the caller may have no
 * tie to, and remove a deactivated document's embedding from that
 * organization's index. Every tenant use takes the project row's
 * organization instead.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		projectFindUnique: vi.fn(),
		hasProjectAccess: vi.fn(),
		setDocumentActive: vi.fn(),
		getDocumentById: vi.fn(),
		getEmbeddingRAGProviderConfig: vi.fn(),
		embedProjectDocument: vi.fn(),
		removeDocumentEmbedding: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@orpc/client", () => ({
	ORPCError: class extends Error {
		constructor(
			public code: string,
			opts?: { message?: string },
		) {
			super(opts?.message ?? code);
		}
	},
}));
vi.mock("@repo/ai", () => ({
	getEmbeddingRAGProviderConfig: mocks.getEmbeddingRAGProviderConfig,
}));
vi.mock("@repo/database", () => ({
	db: { project: { findUnique: mocks.projectFindUnique } },
	getDocumentById: mocks.getDocumentById,
	hasProjectAccess: mocks.hasProjectAccess,
	setDocumentActive: mocks.setDocumentActive,
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/rag", () => ({
	embedProjectDocument: mocks.embedProjectDocument,
	removeDocumentEmbedding: mocks.removeDocumentEmbedding,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.setActive = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		// Mirrors the real resolver: the input string, verbatim.
		resolveOrganizationId: (o: string | null | undefined) => o ?? undefined,
	};
});

await import("../set-active");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: "org-b" },
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-a" });
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.setDocumentActive.mockResolvedValue({
		deactivatedDocId: "doc-old",
		activatedDocId: "doc-new",
	});
	mocks.getDocumentById.mockResolvedValue({
		id: "doc-new",
		status: "COMPLETE",
		content: "content",
		type: "PRD",
		title: "PRD",
	});
	mocks.getEmbeddingRAGProviderConfig.mockResolvedValue({
		apiKey: "key",
		provider: "OPENAI",
		baseUrl: null,
	});
	mocks.embedProjectDocument.mockResolvedValue({ success: true });
	mocks.removeDocumentEmbedding.mockResolvedValue(undefined);
});

describe("setActiveDocumentProcedure — tenant comes from the project", () => {
	it("uses the project's organization for RAG config, embedding and removal when the input names another", async () => {
		await handlers.setActive({
			input: { projectId: "p1", id: "doc-new", organizationId: "org-b" },
			context: ctx,
		});

		expect(mocks.getEmbeddingRAGProviderConfig).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-a",
		});
		expect(mocks.embedProjectDocument).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-a" }),
		);
		expect(mocks.removeDocumentEmbedding).toHaveBeenCalledWith(
			"doc-old",
			"org-a",
		);
		for (const call of mocks.getEmbeddingRAGProviderConfig.mock.calls) {
			expect(call[0].organizationId).not.toBe("org-b");
		}
	});

	it("refuses a project with no organization before any toggle, embedding change or RAG call", async () => {
		mocks.projectFindUnique.mockResolvedValue({ organizationId: null });

		await expect(
			handlers.setActive({
				input: { projectId: "p1", id: "doc-new" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.setDocumentActive).not.toHaveBeenCalled();
		expect(mocks.removeDocumentEmbedding).not.toHaveBeenCalled();
		expect(mocks.getEmbeddingRAGProviderConfig).not.toHaveBeenCalled();
		expect(mocks.embedProjectDocument).not.toHaveBeenCalled();
	});
});
