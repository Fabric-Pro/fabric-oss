import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	codeSearchExecute: vi.fn(),
	createCodeSearchTool: vi.fn(),
	createFabricTool: vi.fn(),
	handlerExecute: vi.fn(),
}));

vi.mock("../../../direct-chat/built-in-tools", () => ({
	createCodeSearchTool: h.createCodeSearchTool,
	createFabricTool: h.createFabricTool,
}));
vi.mock("../handlers/fabric-ai-handler", () => ({
	FabricAiHandler: class {
		execute = h.handlerExecute;
	},
}));

const { runFabricCatalogTool } = await import("../fabric-catalog-adapter");

const call = {
	args: { query: "directChatWorkflow" },
	userId: "u1",
	organizationId: "org-1",
	projectId: "p1",
};

beforeEach(() => {
	vi.clearAllMocks();
	h.createCodeSearchTool.mockResolvedValue({
		code_search: { execute: h.codeSearchExecute },
	});
});

describe("runFabricCatalogTool — Direct builders", () => {
	it("runs code_search with the chat's tenant and project", async () => {
		h.codeSearchExecute.mockResolvedValue({
			success: true,
			results: [{ filePath: "workflows/direct-chat.ts" }],
		});

		const res = await runFabricCatalogTool({
			...call,
			toolName: "code_search",
		});

		expect(h.createCodeSearchTool).toHaveBeenCalledWith({
			userId: "u1",
			organizationId: "org-1",
			projectId: "p1",
		});
		expect(h.codeSearchExecute).toHaveBeenCalledWith(
			call.args,
			expect.objectContaining({ messages: [] }),
		);
		expect(res).toEqual({
			success: true,
			output: {
				success: true,
				results: [{ filePath: "workflows/direct-chat.ts" }],
			},
		});
	});

	it("maps a returned { error } to a failure with a string error", async () => {
		h.codeSearchExecute.mockResolvedValue({
			error: { code: -32603, message: "index offline" },
		});
		const res = await runFabricCatalogTool({
			...call,
			toolName: "code_search",
		});
		expect(res).toEqual({ success: false, error: "index offline" });
	});

	it("maps code search's { success: false, message } to a failure", async () => {
		h.codeSearchExecute.mockResolvedValue({
			success: false,
			message: "Code index is not ready for this project yet.",
			status: "missing",
		});
		const res = await runFabricCatalogTool({
			...call,
			toolName: "code_search",
		});
		expect(res).toEqual({
			success: false,
			error: "Code index is not ready for this project yet.",
		});
	});

	it("maps a thrown error to a failure", async () => {
		h.codeSearchExecute.mockRejectedValue({ message: "qdrant down" });
		const res = await runFabricCatalogTool({
			...call,
			toolName: "code_search",
		});
		expect(res).toEqual({ success: false, error: "qdrant down" });
	});

	it("says a project is needed when the builder has nothing to build", async () => {
		h.createCodeSearchTool.mockResolvedValue({});
		const res = await runFabricCatalogTool({
			...call,
			projectId: undefined,
			toolName: "code_search",
		});
		expect(res.success).toBe(false);
		expect(res).toMatchObject({
			error: expect.stringContaining("project"),
		});
	});
});

describe("runFabricCatalogTool — plan-mode step handlers", () => {
	it("runs the tool as a one-step plan and returns its response", async () => {
		h.handlerExecute.mockResolvedValue({
			handled: true,
			output: {
				response: "transcript text",
				toolCalls: [{ status: "success", result: {} }],
			},
		});
		const res = await runFabricCatalogTool({
			...call,
			args: { url: "https://example.com/v" },
			toolName: "fabric_youtube_transcript",
		});

		expect(res).toEqual({ success: true, output: "transcript text" });
		const context = h.handlerExecute.mock.calls[0][0];
		expect(context.input.step).toMatchObject({
			app: "fabric_youtube_transcript",
			inputs: { url: "https://example.com/v" },
		});
		expect(context.input.executionId).toBeUndefined();
		expect(context.input).toMatchObject({
			userId: "u1",
			organizationId: "org-1",
			projectId: "p1",
		});
	});

	it("reports an unhandled step as a failure", async () => {
		h.handlerExecute.mockResolvedValue({
			handled: false,
			error: "Fabric AI tool fabric_readability failed: bad url",
		});
		const res = await runFabricCatalogTool({
			...call,
			toolName: "fabric_readability",
		});
		expect(res).toEqual({
			success: false,
			error: "Fabric AI tool fabric_readability failed: bad url",
		});
	});

	it("refuses a name outside the catalog", async () => {
		const res = await runFabricCatalogTool({ ...call, toolName: "nope" });
		expect(res.success).toBe(false);
	});
});
