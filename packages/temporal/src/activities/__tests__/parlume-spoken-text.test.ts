import { describe, expect, it } from "vitest";
import {
	PARLUME_MORE_LINE,
	ParlumeSentenceQueue,
	ParlumeSpokenReply,
	toSpokenText,
} from "../parlume-spoken-text";

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

	it("keeps the words before a tool apart from the agent's words after it, as written", () => {
		const spoken = new ParlumeSpokenReply(new ParlumeSentenceQueue(800));
		spoken.push("Let me check the roadmap's open features.");
		spoken.speech.flush();
		// The agent's next block starts with no space of its own.
		spoken.push("There's **one open feature** on the project roadmap.");
		spoken.end();

		expect(spoken.unheardText(0)).toBe(
			"Let me check the roadmap's open features. There's **one open feature** on the project roadmap.",
		);
	});

	it("keeps an overflowing block before a tool apart from the next one", () => {
		const queue = new ParlumeSentenceQueue(10);
		queue.push("I'll check the roadmap for all features.");
		queue.flush();
		queue.push("I'll retrieve the feature's full details.");
		queue.flush();
		queue.end();

		expect(queue.overflowText).toBe(
			"I'll check the roadmap for all features. I'll retrieve the feature's full details.",
		);
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

const HEADLINE = "F-12 ships on Friday, and the export work is done.";
const DETAIL =
	"The two open items are the CSV header fix and the release note.\nBoth are assigned.";

function reply(maxChars = 350) {
	const queue = new ParlumeSentenceQueue(maxChars);
	return { queue, reply: new ParlumeSpokenReply(queue) };
}

/** Pushes `text` cut into pieces of `size` characters. */
function pushInPieces(target: ParlumeSpokenReply, text: string, size: number) {
	for (let index = 0; index < text.length; index += size) {
		target.push(text.slice(index, index + size));
	}
}

describe("Parlume headline and detail", () => {
	it.each([1, 2, 3, 4, 5, 7, 11, 64])(
		"speaks the headline and keeps the detail for the chat, with the text cut every %i characters",
		async (size) => {
			const { queue, reply: spoken } = reply();
			const speaking = collect(queue);

			pushInPieces(spoken, `${HEADLINE}\n---\n${DETAIL}`, size);
			spoken.end();

			await expect(speaking).resolves.toEqual([HEADLINE]);
			expect(spoken.chatText).toBe(DETAIL);
		},
	);

	it("treats a marker on the last line as the end of the headline", async () => {
		const { queue, reply: spoken } = reply();
		const speaking = collect(queue);
		pushInPieces(spoken, `${HEADLINE}\n--`, 3);
		spoken.push("-");
		spoken.end();

		await expect(speaking).resolves.toEqual([HEADLINE]);
		expect(spoken.chatText).toBe("");
	});

	it("speaks dashes that are not a marker line of their own", async () => {
		const { queue, reply: spoken } = reply();
		const speaking = collect(queue);
		spoken.push("The range is 3---5 days, as planned last week.\n----\n");
		spoken.end();

		const sentences = await speaking;
		expect(sentences.join(" ")).toContain("3---5 days");
		expect(spoken.chatText).toBe("");
	});

	it("never takes dashes that end a line for the marker", async () => {
		const { queue, reply: spoken } = reply();
		const speaking = collect(queue);
		spoken.push("Sprint total is 12");
		spoken.push("---");
		spoken.push("\nand that is everything for today.");
		spoken.end();

		const sentences = await speaking;
		expect(sentences.join(" ")).toContain("everything for today");
		expect(spoken.chatText).toBe("");
	});

	it("sends the chat what did not fit when there is no marker, instead of dropping it", async () => {
		const { queue, reply: spoken } = reply(60);
		const speaking = collect(queue);
		const second =
			"The second sentence would take the reply past the limit.";
		const third = "So would the third one.";
		spoken.push(`${HEADLINE} ${second} ${third}`);
		spoken.end();

		await expect(speaking).resolves.toEqual([HEADLINE]);
		expect(spoken.chatText).toBe(`${second} ${third}`);
	});

	it("speaks the detail too, up to the longer limit, and says there is more when the chat is out of reach", async () => {
		const { queue, reply: spoken } = reply(60);
		const speaking = collect(queue);
		spoken.speakEverything(130);
		spoken.push(
			`${HEADLINE}\n---\n${DETAIL}\nA third sentence that no longer fits.`,
		);
		spoken.end();

		const sentences = await speaking;
		expect(sentences[0]).toBe(HEADLINE);
		expect(sentences.join(" ")).toContain("CSV header fix");
		expect(sentences.at(-1)).toBe(PARLUME_MORE_LINE);
	});

	it("keeps detail written before the chat was found out of reach, and speaks it", async () => {
		const { queue, reply: spoken } = reply();
		const speaking = collect(queue);
		spoken.push(`${HEADLINE}\n---\nThe export ships on Friday too.`);
		spoken.speakEverything(800);
		spoken.end();

		await expect(speaking).resolves.toEqual([
			HEADLINE,
			"The export ships on Friday too.",
		]);
		expect(spoken.chatText).toBe("");
	});

	it("gives the chat everything not heard to its end, as written, without narration", async () => {
		const { queue, reply: spoken } = reply();
		const speaking = collect(queue);
		queue.narrate("Let me check.");
		spoken.push(
			"**F-12** ships on Friday, as the roadmap says. The export is done, see https://example.com/f/12 for it.\n---\nDetail here.",
		);
		spoken.end();
		await speaking;

		expect(spoken.unheardText(2)).toBe(
			"The export is done, see https://example.com/f/12 for it.\n\nDetail here.",
		);
		expect(spoken.unheardText(0)).toContain("**F-12** ships on Friday");
		expect(spoken.unheardText(0)).not.toContain("Let me check");
	});

	it("counts only the answer as received, not narration", () => {
		const { queue, reply: spoken } = reply();
		queue.narrate("Let me check.");
		expect(spoken.received).toBe(false);
		spoken.push("Done.");
		expect(spoken.received).toBe(true);
	});
});
