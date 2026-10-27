import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workspace: vi.fn(),
	project: vi.fn(),
	analysis: vi.fn(),
	image: vi.fn(),
	speech: vi.fn(),
}));
vi.mock("@repo/ai", () => ({ tool: (definition: unknown) => definition }));
vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("../../lib/get-search-provider", () => ({
	resolveSearchProviderForTenant: async () => null,
}));
vi.mock("../rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: mocks.workspace,
}));
vi.mock("../../project-metadata", () => ({
	retrieveProjectContextsActivity: mocks.project,
}));
vi.mock("../../fabric-ai", () => ({
	searchAndAnalyzeActivity: mocks.analysis,
	scrapeAndAnalyzeActivity: mocks.analysis,
}));
vi.mock("../../image-generation", () => ({
	generateImageActivity: mocks.image,
}));
vi.mock("../../../lib/text-to-speech", () => ({
	synthesizeToolSpeech: mocks.speech,
}));

import { createBuiltInTools } from "../built-in-tools";

const usageOrigin = {
	projectId: "origin-project",
	frameId: "origin-frame",
	workflowExecutionId: "origin-execution",
};
const context = {
	userId: "user-example",
	organizationId: "org-example",
	projectId: "retrieval-project",
	workspaceIds: ["retrieval-workspace"],
	usageOrigin,
};

async function execute(tools: Record<string, unknown>, name: string) {
	const selected = tools[name];
	if (
		!selected ||
		typeof selected !== "object" ||
		!("execute" in selected) ||
		typeof selected.execute !== "function"
	) {
		throw new Error(`Missing tool executor: ${name}`);
	}
	return selected.execute({
		query: "summary",
		prompt: "boat",
		text: "speech",
		url: "https://example.com",
		usageOrigin: { frameId: "spoofed" },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.workspace.mockResolvedValue({
		context: "context",
		chunkCount: 1,
		sources: [],
	});
	mocks.project.mockResolvedValue({ context: "context", chunkCount: 1 });
	mocks.analysis.mockResolvedValue({ success: true, analysis: "summary" });
	mocks.image.mockResolvedValue({ success: false, error: "fixture" });
	mocks.speech.mockResolvedValue({ ok: false, error: "fixture" });
});

describe("nested workflow tool usage", () => {
	it.each(["workspace_rag_query", "workspace_rag_summarize"])(
		"passes origin through %s without changing retrieval scope",
		async (name) => {
			const tools = await createBuiltInTools({
				...context,
				enabledFabricToolIds: [name],
			});
			await execute(tools, name);
			expect(mocks.workspace.mock.calls[0][3]).toEqual([
				"retrieval-workspace",
			]);
			expect(mocks.workspace.mock.calls[0].at(-1)).toEqual({
				usageConversationId: undefined,
				usageOrigin,
			});
		},
	);

	it("passes project RAG accounting separately from its authorization project", async () => {
		const tools = await createBuiltInTools({
			...context,
			enabledFabricToolIds: ["project_rag_query"],
		});
		await execute(tools, "project_rag_query");
		expect(mocks.project.mock.calls[0][1]).toBe("retrieval-project");
		expect(mocks.project.mock.calls[0].at(-1)).toEqual({
			usageConversationId: undefined,
			usageOrigin,
		});
	});

	it.each(["fabric_search_and_analyze", "fabric_scrape_and_analyze"])(
		"forwards accounting to %s",
		async (name) => {
			const tools = await createBuiltInTools({
				...context,
				enabledFabricToolIds: [name],
			});
			await execute(tools, name);
			expect(mocks.analysis.mock.calls[0][0]).toMatchObject(usageOrigin);
		},
	);

	it.each(["fabric_generate_image", "fabric_text_to_speech"])(
		"forwards explicit secondary metadata to %s",
		async (name) => {
			const tools = await createBuiltInTools({
				...context,
				enabledFabricToolIds: [name],
			});
			await execute(tools, name);
			const mock =
				name === "fabric_generate_image" ? mocks.image : mocks.speech;
			expect(mock.mock.calls[0][0].usageOrigin).toEqual(usageOrigin);
		},
	);

	it.each([usageOrigin, undefined])(
		"preserves additional-tool and absent-origin behavior (%j)",
		async (origin) => {
			const tools = await createBuiltInTools({
				userId: context.userId,
				organizationId: context.organizationId,
				workspaceIds: context.workspaceIds,
				...(origin ? { usageOrigin: origin } : {}),
				additionalFabricToolIds: ["workspace_rag_query"],
			});
			await execute(tools, "workspace_rag_query");
			expect(mocks.workspace.mock.calls[0].at(-1)).toEqual({
				usageConversationId: undefined,
				...(origin ? { usageOrigin: origin } : {}),
			});
		},
	);
});
