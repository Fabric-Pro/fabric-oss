import { describe, expect, it } from "vitest";
import {
	EXPLORE_EMPTY_STATE_MESSAGE,
	resolveBacklogChatIntake,
	shouldAutoOpenBacklogChat,
} from "../backlog-chat-intake";

describe("resolveBacklogChatIntake", () => {
	it("opens EXPLORE projects in explore mode with the hunch prompt and no document requirement", () => {
		const intake = resolveBacklogChatIntake("EXPLORE", "Heritage");
		expect(intake.intakeMode).toBe("explore");
		if (intake.intakeMode !== "explore") {
			throw new Error("expected explore intake");
		}
		expect(
			intake.initialMessage.startsWith(EXPLORE_EMPTY_STATE_MESSAGE),
		).toBe(true);
		expect(intake.initialMessage).toContain("**Heritage**");
		expect(intake.initialMessage).toMatch(/no document needed/);
		expect(intake.initialMessage).not.toMatch(/Connect Teams|tech stack/i);
		expect(intake.suggestions).toHaveLength(1);
	});

	it("keeps the standard chat for every other profile and while the profile is unknown", () => {
		expect(resolveBacklogChatIntake("PROPOSAL").intakeMode).toBe(
			"standard",
		);
		expect(resolveBacklogChatIntake("GOVERNED").intakeMode).toBe(
			"standard",
		);
		expect(resolveBacklogChatIntake("DELEGATED").intakeMode).toBe(
			"standard",
		);
		expect(resolveBacklogChatIntake(null).intakeMode).toBe("standard");
		expect(resolveBacklogChatIntake(undefined).intakeMode).toBe("standard");
	});
});

describe("shouldAutoOpenBacklogChat", () => {
	it("opens the chat once an empty EXPLORE backlog has loaded", () => {
		expect(
			shouldAutoOpenBacklogChat({
				profile: "EXPLORE",
				backlogLoaded: true,
				storyCount: 0,
			}),
		).toBe(true);
	});

	it("waits until the profile and backlog are known", () => {
		expect(
			shouldAutoOpenBacklogChat({
				profile: undefined,
				backlogLoaded: true,
				storyCount: 0,
			}),
		).toBe(false);
		expect(
			shouldAutoOpenBacklogChat({
				profile: "EXPLORE",
				backlogLoaded: false,
				storyCount: 0,
			}),
		).toBe(false);
	});

	it("leaves the board alone once the backlog has work in it", () => {
		expect(
			shouldAutoOpenBacklogChat({
				profile: "EXPLORE",
				backlogLoaded: true,
				storyCount: 3,
			}),
		).toBe(false);
	});

	it("never auto-opens for document-first profiles", () => {
		for (const profile of ["PROPOSAL", "GOVERNED", "DELEGATED"] as const) {
			expect(
				shouldAutoOpenBacklogChat({
					profile,
					backlogLoaded: true,
					storyCount: 0,
				}),
			).toBe(false);
		}
	});
});
