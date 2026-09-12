import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ db: {} }));

import { summarizeSession } from "../advisor-tools";

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
