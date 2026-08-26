import { describe, expect, it } from "vitest";
import { shouldShowAssistantActionCards } from "@saas/agents/components/FabricChat/shared/assistant-action-cards";

const base = {
	role: "assistant" as const,
	content: "here is an answer",
	isStreaming: false,
	isError: false,
};

describe("shouldShowAssistantActionCards", () => {
	it("shows cards for a completed assistant message with a project attached", () => {
		expect(shouldShowAssistantActionCards(base, "proj_1")).toBe(true);
	});

	it("hides cards when the message is an error", () => {
		expect(
			shouldShowAssistantActionCards(
				{ ...base, isError: true },
				"proj_1",
			),
		).toBe(false);
	});

	it("hides cards while streaming, when empty, for non-assistant, and with no project", () => {
		expect(
			shouldShowAssistantActionCards(
				{ ...base, isStreaming: true },
				"proj_1",
			),
		).toBe(false);
		expect(
			shouldShowAssistantActionCards({ ...base, content: "" }, "proj_1"),
		).toBe(false);
		expect(
			shouldShowAssistantActionCards({ ...base, role: "user" }, "proj_1"),
		).toBe(false);
		expect(shouldShowAssistantActionCards(base, undefined)).toBe(false);
	});
});
