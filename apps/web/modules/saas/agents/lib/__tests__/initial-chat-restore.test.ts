import { describe, expect, it } from "vitest";
import { isInitialChatRestorePending } from "../initial-chat-restore";

describe("initial conversation restore gate", () => {
	it("keeps genuine new chats immediately available", () => {
		expect(
			isInitialChatRestorePending({
				initialId: null,
				requestedId: null,
				conversation: null,
				engineReady: false,
			}),
		).toBe(false);
	});
	it("waits for the requested identity and its restored engine", () => {
		const input = {
			initialId: "saved",
			requestedId: "saved",
			engineReady: false,
		};
		expect(
			isInitialChatRestorePending({ ...input, conversation: null }),
		).toBe(true);
		expect(
			isInitialChatRestorePending({
				...input,
				conversation: { id: "other", isOwn: true },
			}),
		).toBe(true);
		expect(
			isInitialChatRestorePending({
				...input,
				conversation: { id: "saved", isOwn: true },
			}),
		).toBe(true);
		expect(
			isInitialChatRestorePending({
				...input,
				conversation: { id: "saved", isOwn: true },
				engineReady: true,
			}),
		).toBe(false);
	});
	it("does not change the reader's engine for a shared conversation", () => {
		expect(
			isInitialChatRestorePending({
				initialId: "saved",
				requestedId: "saved",
				conversation: { id: "saved", isOwn: false },
				engineReady: false,
			}),
		).toBe(false);
	});
	it.each([null, "new-turn"])(
		"does not unmount a new turn after the initial URL is cleared or replaced: %s",
		(requestedId) => {
			expect(
				isInitialChatRestorePending({
					initialId: "saved",
					requestedId,
					conversation: null,
					engineReady: false,
				}),
			).toBe(false);
		},
	);
});
