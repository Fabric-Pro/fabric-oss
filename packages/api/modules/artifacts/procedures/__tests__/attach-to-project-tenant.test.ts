/**
 * `attachToProjectProcedure` runs in the target project's organization.
 *
 * `requireProjectPermission(PROJECT_UPDATE)` authorizes the PROJECT. The
 * organization used to come from `input.organizationId`, the caller's own
 * string, and it picked the artifact lookup's tenant, the RAG provider (and
 * key) that embeds it, and the tenant stamped on the new project context. A
 * caller could name an organization they no longer belong to — their own old
 * artifact there still matched the lookup — and index it into a project in
 * another organization with the first organization's provider key. Every
 * tenant use now takes the project row's organization.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		projectFindUnique: vi.fn(),
		getChatArtifact: vi.fn(),
		attachArtifactToProject: vi.fn(),
		createContext: vi.fn(),
		markArtifactIndexed: vi.fn(),
		getEmbeddingRAGProviderConfig: vi.fn(),
		embedProjectContext: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@orpc/server", () => ({
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
	attachArtifactToProject: mocks.attachArtifactToProject,
	createContext: mocks.createContext,
	getChatArtifact: mocks.getChatArtifact,
	markArtifactIndexed: mocks.markArtifactIndexed,
}));
vi.mock("@repo/rag", () => ({
	embedProjectContext: mocks.embedProjectContext,
}));
vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.attach = fn;
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

await import("../attach-to-project");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: "org-b" },
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-a" });
	mocks.getChatArtifact.mockResolvedValue({
		id: "art-1",
		type: "RESEARCH_REPORT",
		title: "Report",
		description: null,
		content: "Findings",
		indexedAt: null,
	});
	mocks.attachArtifactToProject.mockResolvedValue({ count: 1 });
	mocks.createContext.mockResolvedValue({ id: "ctx-1" });
	mocks.getEmbeddingRAGProviderConfig.mockResolvedValue({
		apiKey: "key",
		provider: "OPENAI",
	});
	mocks.embedProjectContext.mockResolvedValue({
		success: true,
		qdrantId: "q-1",
	});
});

describe("attachToProjectProcedure — tenant comes from the project", () => {
	it("looks up, attaches and indexes in the project's organization when the input names another", async () => {
		await handlers.attach({
			input: {
				id: "art-1",
				projectId: "p1",
				organizationId: "org-b",
				indexInProjectKnowledge: true,
			},
			context: ctx,
		});

		expect(mocks.getChatArtifact).toHaveBeenCalledWith(
			"art-1",
			"user-1",
			"org-a",
		);
		expect(mocks.attachArtifactToProject).toHaveBeenCalledWith(
			"art-1",
			"p1",
			"user-1",
			"org-a",
		);
		expect(mocks.getEmbeddingRAGProviderConfig).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-a",
		});
		expect(mocks.createContext).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-a" }),
		);
		expect(mocks.embedProjectContext).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-a" }),
		);
	});

	it("does not reach another organization's artifact or RAG provider", async () => {
		// The caller's own artifact exists only under the organization the
		// input names; the project lives elsewhere.
		mocks.getChatArtifact.mockImplementation(
			async (_id: string, _userId: string, organizationId?: string) =>
				organizationId === "org-b"
					? { id: "art-1", content: "x" }
					: null,
		);

		await expect(
			handlers.attach({
				input: {
					id: "art-1",
					projectId: "p1",
					organizationId: "org-b",
					indexInProjectKnowledge: true,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.getEmbeddingRAGProviderConfig).not.toHaveBeenCalled();
		expect(mocks.attachArtifactToProject).not.toHaveBeenCalled();
	});

	it("refuses a project with no organization before any lookup, write or embedding", async () => {
		mocks.projectFindUnique.mockResolvedValue({ organizationId: null });

		await expect(
			handlers.attach({
				input: {
					id: "art-1",
					projectId: "p1",
					indexInProjectKnowledge: true,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.getChatArtifact).not.toHaveBeenCalled();
		expect(mocks.attachArtifactToProject).not.toHaveBeenCalled();
		expect(mocks.getEmbeddingRAGProviderConfig).not.toHaveBeenCalled();
		expect(mocks.createContext).not.toHaveBeenCalled();
		expect(mocks.embedProjectContext).not.toHaveBeenCalled();
	});
});
