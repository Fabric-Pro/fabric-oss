import { beforeEach, describe, expect, it, vi } from "vitest";

const conversations = vi.hoisted(() => ({
	findMany: vi.fn(),
	findFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { agentConversation: conversations },
}));

import { createAdvisorTools, summarizeSession } from "../advisor-tools";

type ExecutableTool = { execute: (params: unknown) => Promise<unknown> };

function advisorTool(name: string, organizationId?: string): ExecutableTool {
	return createAdvisorTools("user-1", organizationId)[name] as ExecutableTool;
}

describe("summarizeSession", () => {
	it("summarises requests, tools and errors from stored messages", () => {
		const summary = summarizeSession([
			{ role: "user", content: "  Review   my PRs " },
			{
				role: "assistant",
				content: "Looking.",
				toolCalls: [
					{ name: "list_workflows", status: "success" },
					{
						name: "workspace_rag_query",
						status: "error",
						error: "x",
					},
					{ toolName: "list_workflows", status: "success" },
				],
			},
			{ role: "user", content: [{ type: "text", text: "Try again" }] },
			{ role: "assistant", content: "Error: nope", isError: true },
		]);

		expect(summary.messageCount).toBe(4);
		expect(summary.userMessageCount).toBe(2);
		expect(summary.userRequests).toEqual(["Review my PRs", "Try again"]);
		expect(summary.toolsUsed).toEqual([
			"list_workflows",
			"workspace_rag_query",
		]);
		expect(summary.errorCount).toBe(2);
		expect(summary.lastAssistantExcerpt).toBe("Error: nope");
	});

	it("handles missing or malformed message arrays", () => {
		expect(summarizeSession(null)).toEqual({
			messageCount: 0,
			userMessageCount: 0,
			userRequests: [],
			toolsUsed: [],
			errorCount: 0,
			lastAssistantExcerpt: null,
		});
		expect(summarizeSession([{ role: "assistant" }]).messageCount).toBe(1);
	});

	it("trims long user requests to an excerpt", () => {
		const long = "a".repeat(400);
		const [request] = summarizeSession([
			{ role: "user", content: long },
		]).userRequests;
		expect(request.length).toBe(200);
		expect(request.endsWith("…")).toBe(true);
	});
});

describe("session tools read only the caller's own conversations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		conversations.findMany.mockResolvedValue([]);
		conversations.findFirst.mockResolvedValue(null);
	});

	it("lists the caller's sessions in the organization, not every member's", async () => {
		await advisorTool("list_recent_sessions", "org-1").execute({});

		expect(conversations.findMany.mock.calls[0][0].where).toMatchObject({
			organizationId: "org-1",
			userId: "user-1",
		});
	});

	it("lists only sessions outside any organization when the chat has none", async () => {
		await advisorTool("list_recent_sessions").execute({});

		expect(conversations.findMany.mock.calls[0][0].where).toMatchObject({
			organizationId: null,
			userId: "user-1",
		});
	});

	it("reads one session only when it is the caller's in the organization", async () => {
		const result = await advisorTool("get_session", "org-1").execute({
			conversationId: "conv-of-another-member",
		});

		expect(conversations.findFirst.mock.calls[0][0].where).toEqual({
			id: "conv-of-another-member",
			organizationId: "org-1",
			userId: "user-1",
		});
		expect(result).toEqual({
			error: "Conversation not found in this workspace.",
		});
	});

	it("reads one session outside any organization only when it is the caller's", async () => {
		await advisorTool("get_session").execute({ conversationId: "conv-1" });

		expect(conversations.findFirst.mock.calls[0][0].where).toEqual({
			id: "conv-1",
			organizationId: null,
			userId: "user-1",
		});
	});
});
