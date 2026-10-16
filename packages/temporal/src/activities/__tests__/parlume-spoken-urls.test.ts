import { describe, expect, it } from "vitest";
import {
	ParlumeSentenceQueue,
	ReplayableSentences,
	toSpokenText,
} from "../parlume-spoken-text";

describe("spoken text never reads a URL aloud", () => {
	it.each([
		[
			"See https://fabric.example/app/example-org/projects/p1/roadmap/F-12 for it.",
			"See the link for it.",
		],
		["Open http://example.com/a?b=1&c=2.", "Open the link."],
		[
			"The page is at www.example.com/docs, I think.",
			"The page is at the link, I think.",
		],
		["(https://example.com/x) is the page", "(the link) is the page"],
		[
			"Two: https://a.example/1 and https://b.example/2!",
			"Two: the link and the link!",
		],
	])("%s", (input, expected) => {
		expect(toSpokenText(input)).toBe(expected);
	});

	it("keeps a markdown link's label and drops its address", () => {
		expect(
			toSpokenText("Read [the plan](https://example.com/plan) now."),
		).toBe("Read the plan now.");
	});

	it("leaves words that merely contain a dot alone", () => {
		expect(toSpokenText("Version 2.5 is out. Ask the team.")).toBe(
			"Version 2.5 is out. Ask the team.",
		);
	});

	it("never releases a URL from the sentence queue", async () => {
		const queue = new ParlumeSentenceQueue(800);
		queue.push("The work item is at https://fabric.example/app/x/F-1. ");
		queue.push("Anything else I can do for you today?");
		queue.end();

		const spoken: string[] = [];
		for await (const sentence of queue) {
			spoken.push(sentence);
		}

		expect(spoken.join(" ")).not.toMatch(/https?:|fabric\.example/);
		expect(spoken.join(" ")).toContain("the link");
	});
});

async function* counted(...texts: string[]) {
	for (const text of texts) {
		yield text;
	}
}

describe("ReplayableSentences", () => {
	it("replays what was read from any index", async () => {
		const sentences = new ReplayableSentences(counted("A.", "B.", "C."));
		const read = async (start: number) => {
			const out: string[] = [];
			for await (const text of sentences.from(start)) {
				out.push(text);
			}
			return out;
		};

		expect(await read(0)).toEqual(["A.", "B.", "C."]);
		expect(await read(1)).toEqual(["B.", "C."]);
		expect(await read(3)).toEqual([]);
	});

	it("reads its source once, however many consumers there are", async () => {
		let pulls = 0;
		async function* source() {
			for (const text of ["A.", "B."]) {
				pulls++;
				yield text;
			}
		}
		const sentences = new ReplayableSentences(source());
		const drain = async (start: number) => {
			const out: string[] = [];
			for await (const text of sentences.from(start)) {
				out.push(text);
			}
			return out;
		};

		const results = await Promise.all([drain(0), drain(0), drain(1)]);

		expect(results).toEqual([["A.", "B."], ["A.", "B."], ["B."]]);
		expect(pulls).toBe(2);
	});

	it("lets a second consumer continue after the first stopped early", async () => {
		const sentences = new ReplayableSentences(counted("A.", "B.", "C."));
		const first = sentences.from(0);
		expect((await first.next()).value).toBe("A.");
		await first.return(undefined);

		const rest: string[] = [];
		for await (const text of sentences.from(1)) {
			rest.push(text);
		}

		expect(rest).toEqual(["B.", "C."]);
	});

	it("hands a source failure to every consumer", async () => {
		async function* failing() {
			yield "A.";
			throw new Error("model stream broke");
		}
		const sentences = new ReplayableSentences(failing());

		await expect(async () => {
			for await (const _ of sentences.from(0)) {
				// Reading.
			}
		}).rejects.toThrow("model stream broke");
		await expect(async () => {
			for await (const _ of sentences.from(1)) {
				// Reading.
			}
		}).rejects.toThrow("model stream broke");
	});
});
