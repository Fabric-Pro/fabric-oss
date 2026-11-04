import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	create: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findFirst: mocks.session },
		parlumeSuggestion: { create: mocks.create },
	},
}));
vi.mock("../parlume-log", () => ({ parlumeLog: mocks.log }));

import { recordParlumeSuggestion } from "../parlume-suggestion-records";

const missedForTeam = {
	sessionId: "session-1",
	botId: "bot-1",
	kind: "missed_question",
	text: "Who signs off the migration?",
	speaker: "Dana",
	quote: "we cover the data migration",
	topic: "Data migration",
	chatTag: null,
} as const;

beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		suggestionAudience: "TEAM",
	});
	mocks.create.mockResolvedValue({ id: "suggestion-1" });
});

describe("recordParlumeSuggestion", () => {
	it("records the suggestion under the live session's own project and organization", async () => {
		await expect(recordParlumeSuggestion(missedForTeam)).resolves.toBe(
			true,
		);

		expect(mocks.session).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					providerBotId: "bot-1",
					status: "ACTIVE",
				},
			}),
		);
		expect(mocks.create).toHaveBeenCalledWith({
			data: {
				sessionId: "session-1",
				projectId: "project-1",
				organizationId: "org-1",
				userId: "user-1",
				kind: "MISSED_QUESTION",
				audience: "TEAM",
				text: "Who signs off the migration?",
				speaker: "Dana",
				quote: "we cover the data migration",
				topic: "Data migration",
				chatTag: null,
			},
			select: { id: true },
		});
	});

	it("stores an answer posted in the chat with its tag and the session's audience", async () => {
		mocks.session.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			suggestionAudience: "MEETING",
		});

		await recordParlumeSuggestion({
			...missedForTeam,
			kind: "answer",
			chatTag: "P8",
		});

		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					kind: "ANSWER",
					audience: "MEETING",
					chatTag: "P8",
				}),
			}),
		);
	});

	// Only the session decides who a suggestion was for.
	it("ignores an audience the caller adds", async () => {
		await recordParlumeSuggestion({
			...missedForTeam,
			...{ audience: "MEETING" },
		});

		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ audience: "TEAM" }),
			}),
		);
	});

	it("records nothing for a session that is not live or a bot that is not its own", async () => {
		mocks.session.mockResolvedValue(null);

		await expect(recordParlumeSuggestion(missedForTeam)).resolves.toBe(
			false,
		);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("migration");
	});
});
