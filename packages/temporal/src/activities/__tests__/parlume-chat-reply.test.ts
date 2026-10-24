import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	chunkParlumeChatReply,
	PARLUME_CHAT_POST_CHARS,
	sendParlumeChatReply,
} from "../parlume-chat-reply";

const post = vi.hoisted(() => vi.fn());
vi.mock("../parlume-voice", () => ({ postParlumeMeetingChat: post }));

beforeEach(() => {
	vi.resetAllMocks();
});

describe("chunkParlumeChatReply", () => {
	it("keeps a short reply as one post", () => {
		expect(chunkParlumeChatReply("  The plan is ready.  ")).toEqual([
			"The plan is ready.",
		]);
	});

	it("leaves room in every post for the bridge's tag", () => {
		expect(PARLUME_CHAT_POST_CHARS + "[P9999] ".length).toBeLessThanOrEqual(
			4_000,
		);
	});

	it("cuts at a paragraph, then a sentence, then a word", () => {
		expect(chunkParlumeChatReply("aaaa bbbb\n\ncccc", 12)).toEqual([
			"aaaa bbbb",
			"cccc",
		]);
		expect(chunkParlumeChatReply("One two. Three four five", 14)).toEqual([
			"One two.",
			"Three four",
			"five",
		]);
	});

	it("cuts a word longer than a post rather than loop", () => {
		expect(chunkParlumeChatReply("x".repeat(25), 10)).toEqual([
			"x".repeat(10),
			"x".repeat(10),
			"x".repeat(5),
		]);
	});
});

describe("sendParlumeChatReply", () => {
	const reply = {
		sessionId: "session-1",
		turnId: "turn-1",
		voiceGeneration: 4,
	};

	it("sends each post in order and marks only the last one final", async () => {
		post.mockResolvedValueOnce({
			sent: true,
			tag: "P1",
		}).mockResolvedValueOnce({ sent: true, tag: "P2" });
		const paragraph = "word ".repeat(700).trim();

		const delivery = await sendParlumeChatReply({
			...reply,
			text: `${paragraph}\n\n${paragraph}`,
		});

		expect(delivery).toEqual({ sent: true, tags: ["P1", "P2"] });
		expect(post.mock.calls.map(([input]) => input.final)).toEqual([
			false,
			true,
		]);
		expect(post).toHaveBeenCalledWith(
			expect.objectContaining({ ...reply, message: paragraph }),
		);
	});

	it("stops at the first post the chat refuses", async () => {
		post.mockResolvedValueOnce({
			sent: true,
			tag: "P1",
		}).mockResolvedValueOnce({ sent: false, reason: "chat_unavailable" });
		const paragraph = "word ".repeat(700).trim();

		const delivery = await sendParlumeChatReply({
			...reply,
			text: `${paragraph}\n\n${paragraph}\n\n${paragraph}`,
		});

		expect(delivery).toEqual({
			sent: false,
			tags: ["P1"],
			reason: "chat_unavailable",
		});
		expect(post).toHaveBeenCalledTimes(2);
	});

	it("sends nothing for an empty reply", async () => {
		await expect(
			sendParlumeChatReply({ ...reply, text: "   " }),
		).resolves.toEqual({ sent: false, tags: [], reason: "failed" });
		expect(post).not.toHaveBeenCalled();
	});
});
