import { describe, expect, it } from "vitest";
import { buildTurnsFromHistory } from "../conversation-turns";

describe("failed Research history", () => {
	it("restores the partial answer and failure reason separately", () => {
		const turns = buildTurnsFromHistory([
			{
				id: "user-1",
				role: "user",
				content: "Research this",
				turnId: "turn-1",
			},
			{
				id: "reply-1",
				role: "assistant",
				content: "Partial answer",
				errorMessage: "Connection interrupted",
				streamStatus: "error",
				turnId: "turn-1",
				agentId: "agent-1",
				agentName: "Example",
			},
		]);
		expect(turns[0]?.agentResponses.get("agent-1")).toMatchObject({
			content: "Partial answer",
			errorMessage: "Connection interrupted",
			status: "error",
			isLoading: false,
			isError: true,
		});
	});
});
