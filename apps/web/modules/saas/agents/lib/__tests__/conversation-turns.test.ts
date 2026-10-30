import { describe, expect, it } from "vitest";
import { buildTurnsFromHistory } from "../conversation-turns";

describe("failed Research history", () => {
	it("restores the cursor belonging to the same saved output snapshot", () => {
		const eventCursor = {
			turnId: "example-turn",
			runId: "example-run",
			sequence: "42",
		};
		const turns = buildTurnsFromHistory([
			{ role: "user", content: "Example", turnId: "example-turn" },
			{
				role: "assistant",
				content: "Partial ",
				turnId: "example-turn",
				agentId: "example-agent",
				agentName: "Example",
				eventCursor,
				executionId: "orch-example",
				streamStatus: "streaming",
			},
		]);
		expect(turns[0]?.agentResponses.get("example-agent")).toMatchObject({
			content: "Partial ",
			eventCursor,
		});
	});
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
