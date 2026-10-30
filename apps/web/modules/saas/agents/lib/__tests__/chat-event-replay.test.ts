import { chatEventCursorSchema } from "@repo/utils/chat-event-cursor";
import { describe, expect, it } from "vitest";
import { createChatEventReplay } from "../chat-event-replay";
import { parseResearchStreamEvent } from "../orchestrator-stream-protocol";

const cursor = (sequence: string) => ({
	turnId: "example-turn",
	runId: "example-run",
	sequence,
});
describe("chat replay acknowledgement", () => {
	it("drops duplicates and older events only after the consumer commits", () => {
		const replay = createChatEventReplay();
		expect(replay.accept(cursor("2"))).toBe(true);
		expect(replay.cursor).toBeUndefined();
		replay.commit(cursor("2"));
		expect(replay.accept(cursor("2"))).toBe(false);
		expect(replay.accept(cursor("1"))).toBe(false);
		expect(replay.accept(cursor("3"))).toBe(true);
		expect(replay.accept(undefined)).toBe(true);
	});
	it("does not round sequences beyond JavaScript's safe integer range", () => {
		const replay = createChatEventReplay(cursor("9007199254740992"));
		expect(replay.accept(cursor("9007199254740993"))).toBe(true);
	});
	it.each(["turnId", "runId"] as const)("rejects a changed %s", (key) => {
		const replay = createChatEventReplay(cursor("1"));
		expect(() =>
			replay.accept({ ...cursor("2"), [key]: "example-other" }),
		).toThrow("changed runs");
	});
	it.each(["0", "-1", "1.5", "01", "9223372036854775808"])(
		"rejects invalid sequence %s",
		(sequence) => {
			expect(
				chatEventCursorSchema.safeParse(cursor(sequence)).success,
			).toBe(false);
		},
	);
	it("preserves valid metadata and fails closed on malformed metadata", () => {
		expect(
			parseResearchStreamEvent({
				type: "text_delta",
				content: "Example",
				eventCursor: cursor("1"),
			})?.eventCursor,
		).toEqual(cursor("1"));
		expect(() =>
			parseResearchStreamEvent({
				type: "text_delta",
				content: "Example",
				eventCursor: cursor("0"),
			}),
		).toThrow("invalid replay cursor");
	});
});
