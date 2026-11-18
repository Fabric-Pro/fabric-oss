import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PARLUME_CHAT_POST_CHARS,
	sendParlumeChatReply,
} from "../parlume-chat-reply";

const post = vi.hoisted(() => vi.fn());
vi.mock("../parlume-voice", () => ({ postParlumeMeetingChat: post }));

beforeEach(() => {
	vi.resetAllMocks();
});

describe("sendParlumeChatReply", () => {
	const reply = {
		sessionId: "session-1",
		turnId: "turn-1",
		voiceGeneration: 4,
	};

	it("leaves room in a post for the bridge's tag", () => {
		expect(PARLUME_CHAT_POST_CHARS + "[P9999] ".length).toBeLessThanOrEqual(
			1_500,
		);
	});

	it("sends a long reply as one final post, for the bridge to shorten", async () => {
		post.mockResolvedValueOnce({ sent: true, tag: "P1" });
		const paragraph = "word ".repeat(700).trim();

		const delivery = await sendParlumeChatReply({
			...reply,
			text: `  ${paragraph}\n\n${paragraph}  `,
		});

		expect(delivery).toEqual({ sent: true, tags: ["P1"] });
		expect(post).toHaveBeenCalledTimes(1);
		expect(post).toHaveBeenCalledWith({
			...reply,
			final: true,
			message: `${paragraph}\n\n${paragraph}`,
		});
	});

	it("reports a post the chat refuses", async () => {
		post.mockResolvedValueOnce({ sent: false, reason: "chat_unavailable" });

		await expect(
			sendParlumeChatReply({ ...reply, text: "The plan is ready." }),
		).resolves.toEqual({
			sent: false,
			tags: [],
			reason: "chat_unavailable",
		});
	});

	it("sends nothing for an empty reply", async () => {
		await expect(
			sendParlumeChatReply({ ...reply, text: "   " }),
		).resolves.toEqual({ sent: false, tags: [], reason: "failed" });
		expect(post).not.toHaveBeenCalled();
	});
});
