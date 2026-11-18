import { expect, it, vi } from "vitest";
import { sharedDocumentChat } from "../orchestrator/shared-document-chat";

it("serializes concurrent chat establishment after the first create rejects", async () => {
	const requests: Array<{
		input: { chatId?: string; name: string };
		resolve: (result: { chatId: string }) => void;
		reject: (error: Error) => void;
	}> = [];
	let unboundInFlight = 0;
	let maxUnboundInFlight = 0;
	const create = vi.fn((input: { chatId?: string; name: string }) => {
		if (!input.chatId) {
			unboundInFlight++;
			maxUnboundInFlight = Math.max(maxUnboundInFlight, unboundInFlight);
		}
		return new Promise<{ chatId: string }>((resolve, reject) => {
			requests.push({ input, resolve, reject });
		}).finally(() => {
			if (!input.chatId) {
				unboundInFlight--;
			}
		});
	});
	const upload = sharedDocumentChat(create);
	const results = Promise.allSettled([
		upload({ name: "first" }),
		upload({ name: "second" }),
		upload({ name: "third" }),
		upload({ name: "fourth" }),
	]);
	expect(create).toHaveBeenCalledTimes(1);
	requests[0].reject(new Error("Example create failure"));
	await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
	expect(requests[1].input).toEqual({ name: "second" });
	expect(maxUnboundInFlight).toBe(1);
	requests[1].resolve({ chatId: "example-chat" });
	await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(4));
	expect(requests.slice(2).map((request) => request.input.chatId)).toEqual([
		"example-chat",
		"example-chat",
	]);
	requests[3].resolve({ chatId: "example-chat" });
	requests[2].resolve({ chatId: "example-chat" });
	expect((await results).map((result) => result.status)).toEqual([
		"rejected",
		"fulfilled",
		"fulfilled",
		"fulfilled",
	]);
	expect(maxUnboundInFlight).toBe(1);
});
