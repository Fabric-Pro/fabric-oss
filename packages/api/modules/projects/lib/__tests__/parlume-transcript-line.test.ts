import { parlumeTranscriptLineContinues } from "@repo/utils/parlume-notes";
import { describe, expect, it } from "vitest";
import { parlumeTranscriptLine } from "../parlume-transcript-line";

const NO_MARKS = { memberSpeakerIds: [], guestSpeakerIds: [] };

function chatLine(text: string): string {
	return parlumeTranscriptLine(
		{
			text,
			speakerName: "Sam Example",
			speakerId: "8:orgid:sam-example",
			source: "CHAT",
		},
		NO_MARKS,
	);
}

describe("parlumeTranscriptLine", () => {
	it("writes every line break of a chat message as CRLF, whichever the chat sent", () => {
		expect(chatLine("Agenda:\nPricing page\r\nRoadmap\rRisks")).toBe(
			"[chat] Sam Example: Agenda:\r\nPricing page\r\nRoadmap\r\nRisks",
		);
	});

	it("marks where the message ends: only its last line does not continue", () => {
		const content = `${chatLine("Agenda:\nPricing page")}\nDana Example: next item\n`;
		const continues = content
			.split("\n")
			.map((line) => parlumeTranscriptLineContinues(line));
		expect(continues).toEqual([true, false, false, false]);
	});

	describe("Parlume's own posts", () => {
		function postBy(speakerId: string | null): string {
			return parlumeTranscriptLine(
				{
					text: "[P9] Fabric Parlume (AI assistant) is in this meeting",
					speakerName: "Fabric Parlume",
					speakerId,
					source: "CHAT",
				},
				NO_MARKS,
			);
		}

		it("names the bot without a mark: the bridge saves its own post with no speaker id", () => {
			expect(postBy(null)).toBe(
				"[chat] Fabric Parlume: [P9] Fabric Parlume (AI assistant) is in this meeting",
			);
		});

		it("keeps the guest mark on an anonymous guest who uses the bot's name", () => {
			expect(postBy("8:teamsvisitor:guest-1")).toBe(
				"[chat] Fabric Parlume (unverified speaker): [P9] Fabric Parlume (AI assistant) is in this meeting",
			);
		});
	});

	it("leaves a line of one segment as it was", () => {
		expect(chatLine("Ship it on Friday.")).toBe(
			"[chat] Sam Example: Ship it on Friday.",
		);
	});
});
