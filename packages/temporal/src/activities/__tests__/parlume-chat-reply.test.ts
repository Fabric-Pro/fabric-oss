import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	finishParlumeChatReply,
	onlyNotesParlumeProposal,
	PARLUME_CHAT_ANSWER_CHARS,
	PARLUME_CHAT_POST_CHARS,
	sendParlumeChatReply,
} from "../parlume-chat-reply";

const post = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn());
vi.mock("../parlume-voice", () => ({
	postParlumeMeetingChat: post,
	closeParlumeMeetingChat: close,
}));

beforeEach(() => {
	vi.resetAllMocks();
});

describe("sendParlumeChatReply", () => {
	// The bridge writes the post's first lines from this.
	const reply = {
		sessionId: "session-1",
		turnId: "turn-1",
		voiceGeneration: 4,
		header: {
			kind: "answer",
			asker: "Alex",
			request: "What is the plan?",
		},
	} satisfies Partial<Parameters<typeof sendParlumeChatReply>[0]>;

	it("leaves room in a post for the bridge's tag, and in an answer for its header", () => {
		expect(PARLUME_CHAT_POST_CHARS + "[P9999] ".length).toBeLessThanOrEqual(
			600,
		);
		const header = `**Could not answer** ${"a".repeat(80)}\n*“${"r".repeat(120)}”*\n`;
		expect(
			PARLUME_CHAT_ANSWER_CHARS + "[P9999] ".length + header.length,
		).toBeLessThanOrEqual(600);
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

describe("finishParlumeChatReply", () => {
	const reply = {
		sessionId: "session-1",
		turnId: "turn-1",
		voiceGeneration: 4,
		header: {
			kind: "answer",
			asker: "Alex",
			request: "What is the plan?",
		},
	} satisfies Partial<Parameters<typeof finishParlumeChatReply>[0]>;
	const note = "P2 waits for a member to confirm it in Fabric.";

	it("tells a reply that only notes the turn's proposal from an answer", () => {
		expect(onlyNotesParlumeProposal(note, ["P2"])).toBe(true);
		expect(onlyNotesParlumeProposal(note, [])).toBe(false);
		expect(onlyNotesParlumeProposal(note, ["P20"])).toBe(false);
		const answer = `${note} ${"Detail. ".repeat(40)}`;
		expect(onlyNotesParlumeProposal(answer, ["P2"])).toBe(false);
	});

	// "P42 waits for a member to confirm the bug proposal in Fabric; syncing
	// it to the tracker and assigning it are not included." was dropped as a
	// repeat of the proposal, and the chat never said what was not done.
	it("keeps a short reply that also says what the proposal leaves out", () => {
		for (const reply of [
			"P2 waits for a member to confirm it in Fabric; syncing it to the tracker and assigning it to Sam are not included.",
			"P2 waits for a member to confirm it in Fabric. I can't assign it to Sam.",
			"P2 waits for a member to confirm it in Fabric, but the sync is unavailable.",
			// The form the proposal tool's result now asks for.
			"P2 waits for a member to confirm it in Fabric; syncing it to the tracker and assigning it to Sam are not done.",
		]) {
			expect(onlyNotesParlumeProposal(reply, ["P2"])).toBe(false);
		}
	});

	// Each proposal was followed by "[P3] P2 waits for a member to confirm
	// it in Fabric.", which the proposal post above it already said.
	it("posts nothing more when the proposal post already answered", async () => {
		close.mockResolvedValueOnce(true);

		await expect(
			finishParlumeChatReply({
				...reply,
				text: note,
				proposalTags: ["P2"],
			}),
		).resolves.toEqual({ sent: true, tags: [] });
		expect(close).toHaveBeenCalledWith(
			expect.objectContaining({ turnId: "turn-1", voiceGeneration: 4 }),
		);
		expect(post).not.toHaveBeenCalled();
	});

	it("posts the reply when it answers more, or the bridge does not take the close", async () => {
		post.mockResolvedValue({ sent: true, tag: "P3" });
		close.mockResolvedValueOnce(false);

		await finishParlumeChatReply({
			...reply,
			text: note,
			proposalTags: ["P2"],
		});
		await finishParlumeChatReply({
			...reply,
			text: "There are 4 open bugs.",
			proposalTags: ["P2"],
		});

		expect(close).toHaveBeenCalledTimes(1);
		expect(post).toHaveBeenCalledTimes(2);
	});
});
