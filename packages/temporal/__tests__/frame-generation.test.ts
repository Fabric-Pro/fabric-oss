/**
 * The pages of a frame nobody wrote the HTML of. The model is replaced by a
 * stream that answers from a queue, so each case says what the model returned
 * and asserts on the pages that came out: one page for a frame, an outline and
 * a slide for each entry of a slideshow, and a stand-in page when the model
 * gave nothing - except when the chat turn has stopped, which is not a failure
 * to cover for.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/frame-generation
 */

import { getAIModelWithMetadata } from "@repo/ai";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { RetryError } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	streamText: vi.fn(),
	answers: [] as Array<string | Error>,
	loggerError: vi.fn(),
	prompts: [] as Array<{ instructions: string; user: string }>,
}));

vi.mock("@repo/logs", () => ({ logger: { error: stubs.loggerError } }));

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: stubs.streamText,
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: vi.fn(async () => ({
		model: { __mockModel: true },
		metadata: { modelString: "test-model", provider: "test" },
	})),
}));
vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeMaxOutputTokenBudget: () => undefined,
}));
vi.mock("@repo/utils/dispatch-guard", () => ({
	throwIfDispatchStopped: () => undefined,
	rethrowIfDispatchStopped: (error: unknown) => {
		if (error instanceof Error && error.message === "turn stopped") {
			throw error;
		}
	},
}));

import type { FrameGenerationSpec } from "../src/activities/shared/frame-args";
import { generateFrameBlocks } from "../src/activities/shared/frame-generation";

const USER = "user-1";
const ORG = "org-1";

function spec(
	overrides: Partial<FrameGenerationSpec> = {},
): FrameGenerationSpec {
	return {
		title: "Weekly report",
		description: "Open work by status",
		format: "html",
		components: [],
		kind: "frame",
		...overrides,
	};
}

function generate(overrides: Partial<FrameGenerationSpec> = {}) {
	return generateFrameBlocks({
		userId: USER,
		organizationId: ORG,
		spec: spec(overrides),
	});
}

beforeEach(() => {
	stubs.streamText.mockReset();
	stubs.loggerError.mockReset();
	stubs.answers.length = 0;
	stubs.prompts.length = 0;
	stubs.streamText.mockImplementation(
		(call: {
			instructions: string;
			messages: Array<{ content: string }>;
		}) => {
			stubs.prompts.push({
				instructions: call.instructions,
				user: call.messages[0].content,
			});
			const answer = stubs.answers.shift() ?? "";
			return {
				textStream: (async function* () {
					if (answer instanceof Error) {
						throw answer;
					}
					yield answer;
				})(),
			};
		},
	);
});

describe("a frame with one page", () => {
	it("is the model's page, with its title, as an html block", async () => {
		stubs.answers.push("<html><body>Generated</body></html>");

		const blocks = await generate();

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			type: "html",
			language: "html",
			title: "Weekly report",
			content: "<html><body>Generated</body></html>",
		});
		expect(blocks[0].id).toMatch(/^block-\d+-0$/);
		expect(stubs.prompts[0].user).toContain('Title: "Weekly report"');
		expect(stubs.prompts[0].user).toContain("Open work by status");
	});

	it("loses the markdown fence the model wrapped it in", async () => {
		stubs.answers.push("```html\n<p>fenced</p>\n```");

		const [block] = await generate();

		expect(block.content).toBe("<p>fenced</p>");
	});

	it("tells the model which components to include", async () => {
		stubs.answers.push("<p>x</p>");

		await generate({
			components: [{ type: "chart", label: "Burn-down" }],
		});

		expect(stubs.prompts[0].user).toContain("- chart: Burn-down");
	});

	it.each([
		["json", "json", /"components"/],
		["mermaid", "mermaid", /graph TD/],
		["markdown", "markdown", /^# Weekly report/],
	] as const)(
		"is a %s stand-in when the model gave nothing",
		async (format, type, pattern) => {
			stubs.answers.push("");

			const [block] = await generate({ format });

			expect(block.type).toBe(type);
			expect(block.content).toMatch(pattern);
		},
	);

	it("is a plain page with the title when the model gave nothing for html", async () => {
		stubs.answers.push("");

		const [block] = await generate();

		expect(block.type).toBe("html");
		expect(block.content).toContain("<h1>Weekly report</h1>");
	});

	it("is a stand-in rather than an error when the model fails", async () => {
		stubs.answers.push(new Error("model offline"));

		const [block] = await generate();

		expect(block.content).toContain("<h1>Weekly report</h1>");
	});

	it("is not covered for when the chat turn has stopped", async () => {
		stubs.answers.push(new Error("turn stopped"));

		await expect(generate()).rejects.toThrow("turn stopped");
	});
});

describe("a slideshow", () => {
	const outline = JSON.stringify([
		{ title: "Intro", content: "Why" },
		{ title: "Numbers", content: "What" },
		{ title: "Next", content: "Then" },
	]);

	it("is a slide for each entry of the outline the model planned", async () => {
		stubs.answers.push(outline, "<p>1</p>", "<p>2</p>", "<p>3</p>");

		const blocks = await generate({
			kind: "slideshow",
			description: "A 3-slide deck",
		});

		expect(blocks.map((block) => block.title)).toEqual([
			"Intro",
			"Numbers",
			"Next",
		]);
		expect(blocks.every((block) => block.type === "html")).toBe(true);
		const slidePrompts = stubs.prompts.slice(1);
		expect(slidePrompts).toHaveLength(3);
		expect(slidePrompts[0].instructions).toContain("single slide");
		expect(
			slidePrompts.map(
				(prompt) => prompt.user.match(/Slide \d of \d/)?.[0],
			),
		).toEqual(
			expect.arrayContaining([
				"Slide 1 of 3",
				"Slide 2 of 3",
				"Slide 3 of 3",
			]),
		);
	});

	it("asks the model for as many slides as the description names", async () => {
		stubs.answers.push(outline);

		await generate({ kind: "slideshow", description: "A 3-slide deck" });

		expect(stubs.prompts[0].user).toContain("Create a 3-slide outline");
	});

	it("plans five slides when the description names no number", async () => {
		stubs.answers.push("[]");

		const blocks = await generate({
			kind: "slideshow",
			description: "A deck about the roadmap",
		});

		expect(stubs.prompts[0].user).toContain("Create a 5-slide outline");
		expect(blocks).toHaveLength(5);
	});

	it("falls back to evenly titled slides when the outline cannot be read", async () => {
		stubs.answers.push("not json");

		const blocks = await generate({
			kind: "slideshow",
			title: "Roadmap",
			description: "A 2-slide deck",
		});

		expect(blocks.map((block) => block.title)).toEqual([
			"Roadmap",
			"Part 2",
		]);
	});

	it("is a single page, with no outline, when its format is not html", async () => {
		stubs.answers.push("graph TD; A-->B");

		const blocks = await generate({
			kind: "slideshow",
			format: "mermaid",
		});

		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe("mermaid");
		expect(stubs.prompts).toHaveLength(1);
	});

	it("is not planned over when the chat turn has stopped", async () => {
		stubs.answers.push(new Error("turn stopped"));

		await expect(
			generate({ kind: "slideshow", description: "A 3-slide deck" }),
		).rejects.toThrow("turn stopped");
	});
});

describe("usage attribution", () => {
	function resolverContexts(): Array<Record<string, unknown>> {
		return vi
			.mocked(getAIModelWithMetadata)
			.mock.calls.map(
				(call) => call[1] as unknown as Record<string, unknown>,
			);
	}

	beforeEach(() => {
		vi.mocked(getAIModelWithMetadata).mockClear();
	});

	it("records every generation call of a slideshow against the chat", async () => {
		const outline = JSON.stringify([
			{ title: "Intro", content: "Why" },
			{ title: "Numbers", content: "What" },
			{ title: "Next", content: "Then" },
		]);
		stubs.answers.push(outline, "<p>1</p>", "<p>2</p>", "<p>3</p>");

		await generateFrameBlocks({
			userId: USER,
			organizationId: ORG,
			conversationId: "conv-1",
			spec: spec({ kind: "slideshow", description: "A 3-slide deck" }),
		});

		const contexts = resolverContexts();
		// The outline and one call per slide.
		expect(contexts).toHaveLength(4);
		for (const context of contexts) {
			expect(context.conversationId).toBe("conv-1");
		}
	});

	it("adds no conversation when the frame has none", async () => {
		stubs.answers.push("<p>page</p>");

		await generate();

		const [context] = resolverContexts();
		expect(context).not.toHaveProperty("conversationId");
	});
});

describe.each(["frame", "slideshow"] as const)("%s usage refusal", (kind) => {
	it.each(["resolution", "stream", "wrapped"])(
		"rejects a %s refusal without defaults",
		async (phase) => {
			const refusal = new AiUsageLimitExceededError({
				message: "Example COMPLEX limit exhausted",
				limitId: "example-limit",
				dimension: "TOKENS" as never,
				window: "MONTHLY" as never,
				used: 100n,
				max: 100n,
				manageLimitsUrl: "https://example.com/limits",
			});
			if (phase === "resolution") {
				vi.mocked(getAIModelWithMetadata).mockRejectedValueOnce(
					refusal,
				);
			} else {
				const error =
					phase === "wrapped"
						? new RetryError({
								message: "Retry refused",
								reason: "errorNotRetryable",
								errors: [refusal],
							})
						: refusal;
				const sdk = await vi.importActual<typeof import("ai")>("ai");
				stubs.streamText.mockImplementationOnce((options) =>
					sdk.streamText({
						...options,
						model: new MockLanguageModelV4({
							doStream: async () => ({
								stream: simulateReadableStream({
									chunks: [
										{ type: "stream-start", warnings: [] },
										{
											type: "text-start",
											id: "example-text",
										},
										{
											type: "text-delta",
											id: "example-text",
											delta: "partial",
										},
										{
											type: "text-end",
											id: "example-text",
										},
										{ type: "error", error },
									],
								}),
							}),
						}),
					}),
				);
			}
			await expect(generate({ kind })).rejects.toBe(refusal);
		},
	);
});

it("logs a non-limit SDK error part before returning fallback content", async () => {
	const error = new Error("Example provider offline");
	stubs.streamText.mockImplementationOnce((options) => ({
		textStream: (async function* () {
			options.onError?.({ error });
			yield "";
		})(),
	}));
	const [block] = await generate();
	expect(block.content).toContain("<h1>Weekly report</h1>");
	expect(stubs.loggerError).toHaveBeenCalledWith(
		"Frame generation stream failed",
		{ error },
	);
});
