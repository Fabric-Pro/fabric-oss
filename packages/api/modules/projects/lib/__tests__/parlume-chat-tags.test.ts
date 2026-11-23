import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindMany: vi.fn(),
	sessionUpdateMany: vi.fn(),
	segmentFindMany: vi.fn(),
	channelPostFindMany: vi.fn(),
	suggestionUpdateMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findMany: mocks.sessionFindMany,
			updateMany: mocks.sessionUpdateMany,
		},
		parlumeMeetingSegment: { findMany: mocks.segmentFindMany },
		parlumeChannelPost: { findMany: mocks.channelPostFindMany },
		parlumeSuggestion: { updateMany: mocks.suggestionUpdateMany },
	},
}));

const { parlumeChatTagStart, recordParlumeChatTag, recordParlumeRecapTag } =
	await import("../parlume-chat-tags");

const meeting = {
	organizationId: "org-1",
	meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.sessionFindMany.mockResolvedValue([]);
	mocks.segmentFindMany.mockResolvedValue([]);
	mocks.channelPostFindMany.mockResolvedValue([]);
});

describe("parlumeChatTagStart", () => {
	it("starts at P1 in a meeting Parlume has not been in", async () => {
		await expect(parlumeChatTagStart(meeting)).resolves.toBe(1);
		expect(mocks.sessionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId: "org-1",
					meetingUrl: {
						equals: meeting.meetingUrl,
						mode: "insensitive",
					},
				},
			}),
		);
		expect(mocks.segmentFindMany).not.toHaveBeenCalled();
	});

	it("continues after the highest tag an earlier session posted in the meeting chat", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			{ id: "session-2" },
			{ id: "session-1" },
		]);
		mocks.segmentFindMany.mockResolvedValue([
			{ text: "[P3] Created F-12." },
			{ text: "[P12] Rest of P3: the detail." },
			{ text: "[P2] Two open features." },
		]);

		await expect(parlumeChatTagStart(meeting)).resolves.toBe(13);
		expect(mocks.segmentFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					sessionId: { in: ["session-2", "session-1"] },
					source: "CHAT",
					text: { startsWith: "[P" },
					speakerName: {
						startsWith: "Fabric Parlume",
						mode: "insensitive",
					},
				},
			}),
		);
	});

	it("counts the channel posts an earlier session made", async () => {
		mocks.sessionFindMany.mockResolvedValue([{ id: "session-1" }]);
		mocks.segmentFindMany.mockResolvedValue([{ text: "[P2] Done." }]);
		mocks.channelPostFindMany.mockResolvedValue([
			{ tag: "P7" },
			{ tag: "bogus" },
		]);

		await expect(parlumeChatTagStart(meeting)).resolves.toBe(8);
	});

	it("counts the tag Fabric relayed last, which no chat segment recorded", async () => {
		// The notice an ending session posts as it leaves shows back in the
		// chat only after the session has ended, so no segment holds its tag.
		mocks.sessionFindMany.mockResolvedValue([
			{ id: "session-2", lastChatTag: 5 },
			{ id: "session-1", lastChatTag: null },
		]);
		mocks.segmentFindMany.mockResolvedValue([
			{ text: "[P4] Done · P3 confirmed." },
		]);

		await expect(parlumeChatTagStart(meeting)).resolves.toBe(6);
	});

	// Sessions stored before the join path was taken out of a web link kept
	// the thread id unescaped, and a link may end in a slash: the numbering
	// restarted at P1 in the same meeting chat.
	it("finds an earlier session in the same meeting whichever way its link spelled the join path", async () => {
		const joinPath = "https://teams.microsoft.com/l/meetup-join";
		mocks.sessionFindMany.mockResolvedValue([
			{
				id: "unescaped",
				lastChatTag: 43,
				meetingUrl: `${joinPath}/19:meeting_example@thread.v2/0/`,
			},
			{
				id: "escaped",
				lastChatTag: 7,
				meetingUrl: `${joinPath}/19%3ameeting_example%40thread.v2/0`,
			},
			{
				id: "other-meeting",
				lastChatTag: 90,
				meetingUrl: `${joinPath}/19:meeting_example@thread.v2/1`,
			},
		]);

		await expect(
			parlumeChatTagStart({
				organizationId: "org-1",
				meetingUrl: `${joinPath}/19:meeting_example@thread.v2/0`,
			}),
		).resolves.toBe(44);
		expect(mocks.sessionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId: "org-1",
					meetingUrl: { contains: "meeting_example" },
				},
			}),
		);
		expect(mocks.segmentFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					sessionId: { in: ["unescaped", "escaped"] },
				}),
			}),
		);
	});

	// The web client's `/v2/#/meet/<id>?p=...` link was stored as the bare
	// `/v2/`, so meetings invited that way shared one tag count.
	it("finds the earlier sessions of a short link whether it came from the web client or directly", async () => {
		for (const meetingUrl of [
			"https://teams.microsoft.com/v2/#/meet/1234567890123?p=example",
			"https://teams.microsoft.com/meet/1234567890123?p=example",
		]) {
			mocks.sessionFindMany.mockClear();
			await parlumeChatTagStart({ organizationId: "org-1", meetingUrl });
			expect(mocks.sessionFindMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						organizationId: "org-1",
						meetingUrl: {
							equals: "https://teams.microsoft.com/meet/1234567890123",
							mode: "insensitive",
						},
					},
				}),
			);
		}
	});

	it("finds an earlier session through the web client's link to the same meeting", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			{
				id: "direct",
				lastChatTag: 15,
				meetingUrl:
					"https://teams.microsoft.com/l/meetup-join/19%3ameeting_example%40thread.v2/0",
			},
		]);

		await expect(
			parlumeChatTagStart({
				organizationId: "org-1",
				meetingUrl:
					"https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_example@thread.v2/0?context=%7b%7d",
			}),
		).resolves.toBe(16);
		expect(mocks.sessionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId: "org-1",
					meetingUrl: { contains: "meeting_example" },
				},
			}),
		);
	});

	it("starts at P1 without looking up a link that names no meeting", async () => {
		await expect(
			parlumeChatTagStart({
				organizationId: "org-1",
				meetingUrl: "https://teams.microsoft.com/v2/",
			}),
		).resolves.toBe(1);
		expect(mocks.sessionFindMany).not.toHaveBeenCalled();
	});

	it("never starts past the highest first tag the bridge accepts", async () => {
		mocks.sessionFindMany.mockResolvedValue([{ id: "session-1" }]);
		mocks.channelPostFindMany.mockResolvedValue([{ tag: "P999999" }]);

		await expect(parlumeChatTagStart(meeting)).resolves.toBe(100_000);
	});
});

describe("recordParlumeChatTag", () => {
	it("raises the session's last tag to the post's tag", async () => {
		await recordParlumeChatTag(
			"session-1",
			"[P12] Rest of P3: the detail.",
		);

		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "session-1",
				OR: [{ lastChatTag: null }, { lastChatTag: { lt: 12 } }],
			},
			data: { lastChatTag: 12 },
		});
	});

	it("records nothing for a post without a tag", async () => {
		await recordParlumeChatTag("session-1", "Answer without a tag.");

		expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
	});
});

describe("recordParlumeRecapTag", () => {
	it("gives the session's untagged recap the post's tag", async () => {
		await recordParlumeRecapTag("session-1", "[P35] Since last time…");

		expect(mocks.suggestionUpdateMany).toHaveBeenCalledWith({
			where: { sessionId: "session-1", kind: "RECAP", chatTag: null },
			data: { chatTag: "P35" },
		});
	});

	it("records nothing for a post without a tag", async () => {
		await recordParlumeRecapTag("session-1", "Since last time…");

		expect(mocks.suggestionUpdateMany).not.toHaveBeenCalled();
	});
});
