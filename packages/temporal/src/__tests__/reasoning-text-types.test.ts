import { describe, expect, it } from "vitest";
import type {
	ActivityHeartbeatDetails,
	DirectChatProgressUpdate,
	DirectChatWorkflowOutput,
} from "../types";

describe("reasoning text type fields", () => {
	it("DirectChatWorkflowOutput accepts reasoningText and reasoningDurationMs", () => {
		const out: DirectChatWorkflowOutput = {
			success: true,
			reasoningText: "I considered the auth flow first…",
			reasoningDurationMs: 2400,
		};
		expect(out.reasoningText).toContain("auth flow");
		expect(out.reasoningDurationMs).toBe(2400);
	});

	it("ActivityHeartbeatDetails accepts reasoningText and reasoningDurationMs", () => {
		const hb: ActivityHeartbeatDetails = {
			phase: "streaming",
			message: "Generating response",
			progress: 70,
			toolCalls: [],
			reasoningText: "partial thinking…",
			reasoningDurationMs: undefined,
			timestamp: 1,
		};
		expect(hb.reasoningText).toBe("partial thinking…");
		expect(hb.reasoningDurationMs).toBeUndefined();
	});

	it("DirectChatProgressUpdate accepts reasoningText and reasoningDurationMs", () => {
		const u: DirectChatProgressUpdate = {
			phase: "executing_ai",
			message: "",
			progress: 60,
			toolCalls: [],
			reasoningText: "thought so far",
			reasoningDurationMs: 1200,
		};
		expect(u.reasoningText).toBe("thought so far");
		expect(u.reasoningDurationMs).toBe(1200);
	});
});
