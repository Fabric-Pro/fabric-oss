import { describe, expect, it } from "vitest";
import { generateAgentObservabilitySummary } from "../observability-summary";

describe("generateAgentObservabilitySummary", () => {
	it("describes active usage clearly", () => {
		const summary = generateAgentObservabilitySummary({
			displayName: "Planner",
			conversationCount: 12,
			messagesLast7d: 21,
			activeDaysLast30d: 5,
			lastUsedAt: "2026-03-09T10:00:00.000Z",
			status: "ACTIVE",
			pendingApprovals: 0,
		});

		expect(summary).toContain("Planner has handled 12 conversations");
		expect(summary).toContain("21 messages");
		expect(summary).toContain("5 days");
	});

	it("highlights inactive or blocked agents", () => {
		const summary = generateAgentObservabilitySummary({
			displayName: "Ops Bot",
			conversationCount: 0,
			messagesLast7d: 0,
			activeDaysLast30d: 0,
			status: "ERROR",
			pendingApprovals: 2,
		});

		expect(summary).toContain("has not been used yet");
		expect(summary).toContain("pending");
		expect(summary).toContain("error");
	});
});
