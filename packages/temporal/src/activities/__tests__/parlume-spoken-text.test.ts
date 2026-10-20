import { describe, expect, it } from "vitest";
import { ParlumeSentenceQueue, toSpokenText } from "../parlume-spoken-text";

async function collect(queue: ParlumeSentenceQueue): Promise<string[]> {
	const sentences: string[] = [];
	for await (const sentence of queue) {
		sentences.push(sentence);
	}
	return sentences;
}

describe("flushing a sentence before a tool runs", () => {
	it("releases a short sentence that has no text after it yet", async () => {
		const queue = new ParlumeSentenceQueue(800);
		const iterator = queue[Symbol.asyncIterator]();
		const first = iterator.next();

		queue.push("Let me check.");
		queue.flush();

		await expect(first).resolves.toEqual({
			done: false,
			value: "Let me check.",
		});
	});

	it("holds the same short sentence without a flush", async () => {
		const queue = new ParlumeSentenceQueue(800);
		queue.push("Let me check.");

		expect(queue.received).toBe(true);
		queue.end();
		await expect(collect(queue)).resolves.toEqual(["Let me check."]);
		const held = new ParlumeSentenceQueue(800);
		const pending = held[Symbol.asyncIterator]().next();
		held.push("Let me check.");
		const raced = await Promise.race([
			pending.then(() => "released"),
			new Promise((resolve) => setTimeout(() => resolve("held"), 20)),
		]);
		expect(raced).toBe("held");
	});

	it("does nothing when nothing is pending, and after the queue ended", async () => {
		const queue = new ParlumeSentenceQueue(800);
		queue.flush();
		queue.push("Done for now. ");
		queue.end();
		queue.flush();

		await expect(collect(queue)).resolves.toEqual(["Done for now."]);
	});

	it("still honors the spoken-length cap", async () => {
		const queue = new ParlumeSentenceQueue(5);
		queue.push("Creating that now.");
		queue.flush();
		queue.end();

		await expect(collect(queue)).resolves.toEqual(["Creat"]);
	});
});

describe("Parlume spoken sentences", () => {
	it("releases each sentence as soon as streamed text completes it", async () => {
		const queue = new ParlumeSentenceQueue(800);
		const iterator = queue[Symbol.asyncIterator]();
		const first = iterator.next();

		queue.push("Fabric is a project-level AI ");
		queue.push("platform for delivery teams. It keeps");

		await expect(first).resolves.toEqual({
			done: false,
			value: "Fabric is a project-level AI platform for delivery teams.",
		});
		queue.push(" shared context for every tool.");
		queue.end();
		await expect(iterator.next()).resolves.toEqual({
			done: false,
			value: "It keeps shared context for every tool.",
		});
		await expect(iterator.next()).resolves.toEqual({
			done: true,
			value: undefined,
		});
	});

	it("joins a short opening to the sentence after it instead of speaking a fragment", async () => {
		const queue = ParlumeSentenceQueue.fromText(
			"Sure. The roadmap has two hundred items in it. Done!",
			800,
		);

		await expect(collect(queue)).resolves.toEqual([
			"Sure. The roadmap has two hundred items in it.",
			"Done!",
		]);
	});

	it("does not read markdown aloud", () => {
		expect(
			toSpokenText(
				"There are **200 items** on the `roadmap`:\n- see [the board](https://example.com)",
			),
		).toBe("There are 200 items on the roadmap: see the board");
	});

	it("stops releasing speech at the spoken length limit", async () => {
		const queue = ParlumeSentenceQueue.fromText(
			"This first sentence is fairly long. This second one is cut off here.",
			50,
		);

		const sentences = await collect(queue);

		expect(sentences.join(" ").length).toBeLessThanOrEqual(51);
		expect(sentences[0]).toBe("This first sentence is fairly long.");
	});

	it("reports whether any text arrived", () => {
		const queue = new ParlumeSentenceQueue(800);
		expect(queue.received).toBe(false);
		queue.push("Partial answer");
		expect(queue.received).toBe(true);
	});
});
