import { describe, expect, it } from "vitest";
import { deriveTrajectorySteps } from "../derive-trajectory";
import type { DirectStreamMessage } from "../../hooks/useDirectStream";

describe("deriveTrajectorySteps — thinking step", () => {
	const base = (
		overrides: Partial<DirectStreamMessage> = {},
	): DirectStreamMessage => ({
		id: "m1",
		role: "assistant",
		content: "Final answer.",
		timestamp: new Date("2026-05-14T10:00:00Z"),
		isStreaming: false,
		toolCalls: [],
		...overrides,
	});

	it("prepends a thinking step when reasoningText is non-empty", () => {
		const steps = deriveTrajectorySteps(
			base({ reasoningText: "I considered the auth flow first." }),
		);
		expect(steps[0]?.type).toBe("thinking");
		expect(steps[0]?.description).toContain("auth flow");
	});

	it("omits the thinking step when reasoningText is undefined", () => {
		const steps = deriveTrajectorySteps(base());
		expect(steps.some((s) => s.type === "thinking")).toBe(false);
	});

	it("omits the thinking step when reasoningText is empty or whitespace", () => {
		expect(
			deriveTrajectorySteps(base({ reasoningText: "" })).some(
				(s) => s.type === "thinking",
			),
		).toBe(false);
		expect(
			deriveTrajectorySteps(base({ reasoningText: "   \n  " })).some(
				(s) => s.type === "thinking",
			),
		).toBe(false);
	});

	it("marks the thinking step as running while still streaming", () => {
		const steps = deriveTrajectorySteps(
			base({
				reasoningText: "thinking aloud…",
				isStreaming: true,
				content: "",
			}),
		);
		expect(steps[0]?.type).toBe("thinking");
		expect(steps[0]?.status).toBe("running");
		expect(steps[0]?.title).toBe("Thinking…");
		expect(steps[0]?.duration).toBeUndefined();
	});

	it("marks the thinking step as success and passes duration after streaming completes", () => {
		const steps = deriveTrajectorySteps(
			base({
				reasoningText: "Final reasoning.",
				reasoningDurationMs: 2400,
			}),
		);
		expect(steps[0]?.status).toBe("success");
		expect(steps[0]?.title).toMatch(/^Thought/);
		expect(steps[0]?.duration).toBe(2400);
	});

	it("passes undefined duration when reasoningDurationMs is not set", () => {
		const steps = deriveTrajectorySteps(
			base({ reasoningText: "Final reasoning." }),
		);
		expect(steps[0]?.status).toBe("success");
		expect(steps[0]?.duration).toBeUndefined();
	});

	it("prepends thinking step before tool-call steps", () => {
		const steps = deriveTrajectorySteps(
			base({
				reasoningText: "Let me check the workspace.",
				toolCalls: [
					{
						id: "tc1",
						name: "fabric_query_workspace",
						args: { query: "auth", workspaceId: "w1" },
						status: "complete",
					},
				],
			}),
		);
		expect(steps[0]?.type).toBe("thinking");
		expect(steps[1]?.type).toBe("tool_call");
		// Reflection is the LAST step
		expect(steps[steps.length - 1]?.type).toBe("reflection");
	});

	/**
	 * Full-pipeline integration test (Codex Finding 3):
	 * Verifies that reasoningDurationMs from DirectStreamMessage actually flows
	 * through deriveTrajectorySteps into the step.duration field — rather than
	 * only being tested with a hand-built step fixture in Task 9.
	 */
	it("full pipeline: reasoningDurationMs on message reaches step.duration", () => {
		const msg = base({
			reasoningText: "some thinking",
			reasoningDurationMs: 3000,
		});
		const steps = deriveTrajectorySteps(msg);
		const thinkingStep = steps.find((s) => s.type === "thinking");
		expect(thinkingStep?.duration).toBe(3000);
	});
});
