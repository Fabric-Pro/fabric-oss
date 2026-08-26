/**
 * Unit tests for `refineDescriptionProcedure`, focused on the H4 fix from
 * the unified-context-uploader-wizard static review (2026-05-23):
 *
 *   Files added in the wizard write to `ProjectContext` on a DRAFT project
 *   (DRAFT-as-host pattern). Earlier `refineDescription` only queried the
 *   sessionId-keyed wizard-contexts Qdrant collection — so wizard uploads
 *   were invisible to refine. This procedure now ALSO queries the
 *   projectId-keyed project-contexts collection when a `projectId` is
 *   provided, gated by `hasProjectAccess`.
 *
 * Scenarios:
 *   (a) projectId omitted → only wizard-contexts queried (legacy backward-compat).
 *   (b) projectId provided + access ok → BOTH paths queried, results merged.
 *   (c) projectId provided + access denied → project-contexts skipped, wizard-contexts still queried.
 *   (d) Both retrieval paths return empty + attachmentSummaries provided → fallback fires.
 *   (e) Both retrieval paths throw → fallback to attachmentSummaries (existing behavior preserved).
 *   (f) Project-context throws but wizard-context succeeds → wizard results used; refine still works.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGenerateText,
	mockGetAIModelWithMetadata,
	mockGetRAGProviderConfig,
	mockLogModelUsageAsync,
	mockHasProjectAccess,
	mockRetrieveWizardContexts,
	mockRetrieveProjectContexts,
	mockFormatWizardContextsForPrompt,
	mockFormatContextsForPrompt,
} = vi.hoisted(() => ({
	mockGenerateText: vi.fn(),
	mockGetAIModelWithMetadata: vi.fn(),
	mockGetRAGProviderConfig: vi.fn(),
	mockLogModelUsageAsync: vi.fn(),
	mockHasProjectAccess: vi.fn(),
	mockRetrieveWizardContexts: vi.fn(),
	mockRetrieveProjectContexts: vi.fn(),
	mockFormatWizardContextsForPrompt: vi.fn(),
	mockFormatContextsForPrompt: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mockHasProjectAccess,
}));

vi.mock("@repo/rag", () => ({
	retrieveWizardContexts: mockRetrieveWizardContexts,
	retrieveProjectContexts: mockRetrieveProjectContexts,
	formatWizardContextsForPrompt: mockFormatWizardContextsForPrompt,
	formatContextsForPrompt: mockFormatContextsForPrompt,
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mockGetAIModelWithMetadata,
	getRAGProviderConfig: mockGetRAGProviderConfig,
	logModelUsageAsync: mockLogModelUsageAsync,
}));

vi.mock("ai", () => ({
	generateText: mockGenerateText,
}));

vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: {
		sessionId: string;
		description: string;
		projectName?: string;
		projectTypes?: string[];
		projectId?: string;
		attachmentSummaries?: string[];
		organizationId?: string | null;
	};
	context: { user: { id: string } };
}) => Promise<{
	refinedDescription: string;
	originalDescription: string;
	contextUsed: boolean;
	contextCount: number;
}>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../refine-description");
	return (mod.refineDescriptionProcedure as unknown as { handler: Handler })
		.handler;
}

const baseContext = { user: { id: "user-1" } };

beforeEach(() => {
	vi.clearAllMocks();
	mockGetAIModelWithMetadata.mockResolvedValue({
		model: { type: "mock-model" },
		metadata: {},
		trackUsage: vi.fn(),
	});
	mockGetRAGProviderConfig.mockResolvedValue({
		apiKey: "test-api-key",
		provider: "openai",
	});
	mockLogModelUsageAsync.mockResolvedValue(undefined);
	mockGenerateText.mockResolvedValue({
		text: "Refined description text",
		usage: { promptTokens: 100, completionTokens: 50 },
	});
	mockHasProjectAccess.mockResolvedValue(true);
	mockRetrieveWizardContexts.mockResolvedValue([]);
	mockRetrieveProjectContexts.mockResolvedValue([]);
	mockFormatWizardContextsForPrompt.mockImplementation((contexts) =>
		contexts.length > 0
			? `<reference_documents>wizard:${contexts.length}</reference_documents>`
			: "",
	);
	mockFormatContextsForPrompt.mockImplementation((contexts) =>
		contexts.length > 0
			? `<project_context>project:${contexts.length}</project_context>`
			: "",
	);
});

describe("refineDescription — (a) projectId omitted (legacy backward-compat)", () => {
	it("only queries wizard-contexts; never calls retrieveProjectContexts", async () => {
		mockRetrieveWizardContexts.mockResolvedValue([
			{ id: "ctx-w1", type: "DOCUMENT", content: "wizard 1", score: 0.9 },
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				sessionId: "session-1",
				description: "A SaaS for project management",
			},
			context: baseContext,
		});

		expect(mockRetrieveWizardContexts).toHaveBeenCalledOnce();
		expect(mockRetrieveProjectContexts).not.toHaveBeenCalled();
		expect(mockHasProjectAccess).not.toHaveBeenCalled();
		expect(result.contextCount).toBe(1);
		expect(result.contextUsed).toBe(true);
	});
});

describe("refineDescription — (b) projectId provided + access ok", () => {
	it("queries BOTH paths and merges the result counts", async () => {
		mockRetrieveProjectContexts.mockResolvedValue([
			{ id: "ctx-p1", type: "FILE", content: "project 1", score: 0.95 },
			{ id: "ctx-p2", type: "LINK", content: "project 2", score: 0.85 },
		]);
		mockRetrieveWizardContexts.mockResolvedValue([
			{ id: "ctx-w1", type: "DOCUMENT", content: "wizard 1", score: 0.8 },
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				sessionId: "session-1",
				description: "A SaaS for project management",
				projectId: "proj-draft-1",
				organizationId: "org-1",
			},
			context: baseContext,
		});

		expect(mockHasProjectAccess).toHaveBeenCalledWith(
			"proj-draft-1",
			"user-1",
			"org-1",
		);
		expect(mockRetrieveProjectContexts).toHaveBeenCalledOnce();
		expect(mockRetrieveProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-draft-1",
				query: "A SaaS for project management",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
		expect(mockRetrieveWizardContexts).toHaveBeenCalledOnce();

		// 2 project chunks + 1 wizard chunk = 3 total
		expect(result.contextCount).toBe(3);
		expect(result.contextUsed).toBe(true);
	});

	it("formats project-context AND wizard-context sections side-by-side in the prompt", async () => {
		mockRetrieveProjectContexts.mockResolvedValue([
			{ id: "ctx-p1", type: "FILE", content: "project 1", score: 0.95 },
		]);
		mockRetrieveWizardContexts.mockResolvedValue([
			{ id: "ctx-w1", type: "DOCUMENT", content: "wizard 1", score: 0.8 },
		]);

		const handler = await loadHandler();
		await handler({
			input: {
				sessionId: "session-1",
				description: "Desc",
				projectId: "proj-1",
			},
			context: baseContext,
		});

		expect(mockFormatContextsForPrompt).toHaveBeenCalled();
		expect(mockFormatWizardContextsForPrompt).toHaveBeenCalled();
		// generateText receives a prompt containing both sentinels
		const callArg = mockGenerateText.mock.calls[0]?.[0];
		expect(callArg?.prompt).toContain("project:1");
		expect(callArg?.prompt).toContain("wizard:1");
	});
});

describe("refineDescription — (c) projectId provided + access denied", () => {
	it("skips project-contexts query when hasProjectAccess returns false; still queries wizard-contexts", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		mockRetrieveWizardContexts.mockResolvedValue([
			{ id: "ctx-w1", type: "DOCUMENT", content: "wizard 1", score: 0.8 },
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				sessionId: "session-1",
				description: "Desc",
				projectId: "proj-other-tenant",
			},
			context: baseContext,
		});

		expect(mockHasProjectAccess).toHaveBeenCalled();
		expect(mockRetrieveProjectContexts).not.toHaveBeenCalled();
		expect(mockRetrieveWizardContexts).toHaveBeenCalled();
		expect(result.contextCount).toBe(1); // wizard only
	});
});

describe("refineDescription — (d) empty RAG results + attachmentSummaries fallback", () => {
	it("uses attachmentSummaries as text fallback when BOTH paths return empty", async () => {
		mockRetrieveWizardContexts.mockResolvedValue([]);
		mockRetrieveProjectContexts.mockResolvedValue([]);

		const handler = await loadHandler();
		await handler({
			input: {
				sessionId: "session-1",
				description: "Desc",
				projectId: "proj-1",
				attachmentSummaries: ["PRD.pdf", "design-spec.docx"],
			},
			context: baseContext,
		});

		const callArg = mockGenerateText.mock.calls[0]?.[0];
		expect(callArg?.prompt).toContain("Context from attached documents");
		expect(callArg?.prompt).toContain("PRD.pdf");
		expect(callArg?.prompt).toContain("design-spec.docx");
	});
});

describe("refineDescription — (e) both paths throw + attachmentSummaries", () => {
	it("falls back to attachmentSummaries when both retrievals reject", async () => {
		mockRetrieveWizardContexts.mockRejectedValue(new Error("Qdrant down"));
		mockRetrieveProjectContexts.mockRejectedValue(
			new Error("Embedding model unavailable"),
		);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				sessionId: "session-1",
				description: "Desc",
				projectId: "proj-1",
				attachmentSummaries: ["spec.pdf"],
			},
			context: baseContext,
		});

		// Refine still produces output (degraded, not broken)
		expect(result.refinedDescription).toBeTruthy();
		expect(result.contextCount).toBe(0);
		// Fallback text injected
		const callArg = mockGenerateText.mock.calls[0]?.[0];
		expect(callArg?.prompt).toContain("Context from attached documents");
		expect(callArg?.prompt).toContain("spec.pdf");
	});
});

describe("refineDescription — (f) one path errors + the other succeeds", () => {
	it("uses wizard-context results when project-context retrieval throws", async () => {
		mockRetrieveProjectContexts.mockRejectedValue(
			new Error("project Qdrant unavailable"),
		);
		mockRetrieveWizardContexts.mockResolvedValue([
			{ id: "ctx-w1", type: "DOCUMENT", content: "wizard 1", score: 0.8 },
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				sessionId: "session-1",
				description: "Desc",
				projectId: "proj-1",
			},
			context: baseContext,
		});

		expect(result.contextCount).toBe(1);
		expect(result.contextUsed).toBe(true);
		const callArg = mockGenerateText.mock.calls[0]?.[0];
		expect(callArg?.prompt).toContain("wizard:1");
		expect(callArg?.prompt).not.toContain("project:");
	});

	it("uses project-context results when wizard-context retrieval throws", async () => {
		mockRetrieveWizardContexts.mockRejectedValue(
			new Error("wizard Qdrant unavailable"),
		);
		mockRetrieveProjectContexts.mockResolvedValue([
			{ id: "ctx-p1", type: "FILE", content: "project 1", score: 0.9 },
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				sessionId: "session-1",
				description: "Desc",
				projectId: "proj-1",
			},
			context: baseContext,
		});

		expect(result.contextCount).toBe(1);
		expect(result.contextUsed).toBe(true);
		const callArg = mockGenerateText.mock.calls[0]?.[0];
		expect(callArg?.prompt).toContain("project:1");
		expect(callArg?.prompt).not.toContain("wizard:");
	});
});
