import { beforeEach, describe, expect, it, vi } from "vitest";

// The activity dynamically imports `ai` (generateText) + `@repo/ai`
// (getAIModel). vitest's vi.mock intercepts both static and dynamic imports,
// so these factories back the `await import(...)` calls inside the activity.
const generateText = vi.fn();
vi.mock("ai", () => ({
	generateText: (...a: unknown[]) => generateText(...a),
}));
vi.mock("@repo/ai", () => ({
	getAIModel: vi.fn().mockResolvedValue({}),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { analyzeIntentClarityActivity } from "../clarification";

describe("analyzeIntentClarityActivity", () => {
	beforeEach(() => {
		generateText.mockReset();
	});

	it("returns needsClarification:false for an empty message without calling the model", async () => {
		const res = await analyzeIntentClarityActivity({
			message: "   ",
			userId: "u",
		});
		expect(res.needsClarification).toBe(false);
		expect(generateText).not.toHaveBeenCalled();
	});

	it("returns the question and caps options at 3 when the model flags ambiguity", async () => {
		generateText.mockResolvedValue({
			text: JSON.stringify({
				needsClarification: true,
				question: "Which environment should I target?",
				options: ["staging", "production", "local", "a fourth option"],
				reasoning: "unclear deploy target",
			}),
		});

		const res = await analyzeIntentClarityActivity({
			message: "deploy it",
			userId: "u",
		});

		expect(res.needsClarification).toBe(true);
		expect(res.question).toBe("Which environment should I target?");
		// 4 supplied → capped to 3.
		expect(res.options).toEqual(["staging", "production", "local"]);
	});

	it("returns needsClarification:false when the model judges the request clear", async () => {
		generateText.mockResolvedValue({
			text: JSON.stringify({
				needsClarification: false,
				reasoning: "clear enough to act",
			}),
		});

		const res = await analyzeIntentClarityActivity({
			message: "add a dark-mode toggle to the settings page",
			userId: "u",
		});

		expect(res.needsClarification).toBe(false);
	});

	it("does not pause when the model flags ambiguity but supplies no question", async () => {
		generateText.mockResolvedValue({
			text: JSON.stringify({ needsClarification: true, question: "   " }),
		});

		const res = await analyzeIntentClarityActivity({
			message: "do the thing",
			userId: "u",
		});

		expect(res.needsClarification).toBe(false);
	});

	it("is fail-safe: returns needsClarification:false when the model call throws", async () => {
		generateText.mockRejectedValue(new Error("provider unavailable"));

		const res = await analyzeIntentClarityActivity({
			message: "anything",
			userId: "u",
		});

		expect(res.needsClarification).toBe(false);
	});

	it("returns needsClarification:false when the model output has no JSON object", async () => {
		generateText.mockResolvedValue({
			text: "Sorry, I can't structure that.",
		});

		const res = await analyzeIntentClarityActivity({
			message: "anything",
			userId: "u",
		});

		expect(res.needsClarification).toBe(false);
	});

	it("drops non-string / empty options entries", async () => {
		generateText.mockResolvedValue({
			text: JSON.stringify({
				needsClarification: true,
				question: "Pick one",
				options: ["valid", "", 42, "  trimmed  "],
			}),
		});

		const res = await analyzeIntentClarityActivity({
			message: "ambiguous",
			userId: "u",
		});

		expect(res.needsClarification).toBe(true);
		expect(res.options).toEqual(["valid", "trimmed"]);
	});

	// The gate used to be called with only the current message, so it re-asked
	// questions the conversation had already answered (Fizzy #2406). These pin
	// that the conversation actually reaches the model, and that the prompt
	// tells it what to do with it — in BOTH directions, since suppressing a
	// genuinely needed question is also a failure (AC-3).
	describe("conversation context", () => {
		const clearResponse = JSON.stringify({
			needsClarification: false,
			reasoning: "clear",
		});

		function promptFor(call: unknown) {
			const args = call as {
				system: string;
				messages: Array<{ content: string }>;
			};
			return { system: args.system, user: args.messages[0].content };
		}

		it("sends the conversation to the model, ahead of the request", async () => {
			generateText.mockResolvedValue({ text: clearResponse });

			await analyzeIntentClarityActivity({
				message: "generate 10 of them",
				conversationSummary:
					"User: Let's talk about Fabric Open source\nAssistant: Sure.",
				userId: "u",
			});

			const { user } = promptFor(generateText.mock.calls[0][0]);
			expect(user).toContain("## Conversation so far");
			expect(user).toContain("Let's talk about Fabric Open source");
			// Context must precede the request, or the reviewer anchors on the
			// bare message and re-asks what the conversation settled.
			expect(user.indexOf("## Conversation so far")).toBeLessThan(
				user.indexOf("## User request"),
			);
		});

		it("omits the conversation section entirely when there is none", async () => {
			generateText.mockResolvedValue({ text: clearResponse });

			await analyzeIntentClarityActivity({
				message: "deploy it",
				userId: "u",
			});

			const { user } = promptFor(generateText.mock.calls[0][0]);
			expect(user).not.toContain("## Conversation so far");
			expect(user).toContain("## User request");
		});

		it("instructs the model never to re-ask what the conversation answered", async () => {
			generateText.mockResolvedValue({ text: clearResponse });

			await analyzeIntentClarityActivity({
				message: "anything",
				userId: "u",
			});

			const { system } = promptFor(generateText.mock.calls[0][0]);
			expect(system).toContain("NEVER ask something the conversation");
			expect(system).toContain("Clarification —");
		});

		it("still instructs the model to ask when the conversation does not settle it", async () => {
			generateText.mockResolvedValue({ text: clearResponse });

			await analyzeIntentClarityActivity({
				message: "anything",
				userId: "u",
			});

			const { system } = promptFor(generateText.mock.calls[0][0]);
			// Guards AC-3: the fix must not turn into blanket suppression.
			expect(system).toContain("do NOT stay silent on a real gap");
		});

		it("still asks when the model judges the conversation insufficient", async () => {
			generateText.mockResolvedValue({
				text: JSON.stringify({
					needsClarification: true,
					question: "Which project should I target?",
					options: ["Project A", "Project B"],
				}),
			});

			const res = await analyzeIntentClarityActivity({
				message: "ship it",
				conversationSummary: "User: hello\nAssistant: hi",
				userId: "u",
			});

			expect(res.needsClarification).toBe(true);
			expect(res.question).toBe("Which project should I target?");
		});
	});
});
