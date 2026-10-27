import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	streamTextMock: vi.fn(),
	resolveImageAttachments: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	streamText: stubs.streamTextMock,
	tool: vi.fn((definition: { description?: string }) => ({
		__isAiSdkTool: true,
		description: definition?.description,
	})),
	jsonSchema: vi.fn((schema: unknown) => ({ __isJsonSchema: true, schema })),
	isStepCount: vi.fn((n: number) => ({ __stopWhen: "stepCount", n })),
}));

vi.mock("@repo/ai/capabilities", () => ({
	getModelCapabilities: vi.fn(() => ({ vision: true })),
}));

vi.mock("@repo/ai/limits", () => ({
	classifyLimitError: vi.fn(() => null),
}));

vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: vi.fn(async () => []),
	createSkillTools: vi.fn(() => ({})),
	buildSkillsSystemBlock: vi.fn(() => ""),
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

vi.mock("../../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));

vi.mock("../../utils", () => ({
	getAiModelWithSelection: vi.fn(async () => ({
		model: { __mockModel: true, modelId: "claude-sonnet-5" },
		provider: "ANTHROPIC_DIRECT",
		modelString: "claude-sonnet-5",
		canonicalName: "claude-sonnet-5",
		planSpentApiBilling: () => undefined,
	})),
}));

vi.mock("../vision-image-attachments", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vision-image-attachments")>()),
	resolveImageAttachments: stubs.resolveImageAttachments,
}));

import { getAiModelWithSelection } from "../../utils";

import {
	type RunAgentIterationInput,
	runAgentIteration,
} from "../run-agent-iteration";

const SAVED =
	"The brief generates its work-item cards from live data. I’ll add a direct link to each card so the links remain available when the data is refreshed.## Summary\nI located where …";

beforeEach(() => {
	vi.clearAllMocks();
	stubs.resolveImageAttachments.mockResolvedValue([]);
});

async function answer(
	parts: Array<Record<string, unknown>>,
	synthesisOutput = true,
) {
	stubs.streamTextMock.mockReturnValue({
		stream: (async function* () {
			yield* parts;
		})(),
		usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
		finishReason: Promise.resolve("stop"),
	});
	return runAgentIteration({
		conversationHistory: [
			{
				role: "user",
				content: "Summarize progress",
				timestamp: "2026-01-01T00:00:00Z",
			},
		],
		availableTools: {},
		systemPrompt: "Summarize",
		userId: "example-user",
		organizationId: "example-org",
		iteration: 1,
		enableSkillTools: false,
		synthesisOutput,
	} as RunAgentIterationInput);
}
const start = (id: string) => ({ type: "text-start", id });
const delta = (id: string, text: string) => ({ type: "text-delta", id, text });

describe("synthesis text assembly", () => {
	it("drops the preamble from the saved glued-heading fixture", async () => {
		expect(await answer([start("a"), delta("a", SAVED)])).toMatchObject({
			content: "## Summary\nI located where …",
		});
	});
	it("places required headings on separate lines", async () => {
		expect(
			await answer([
				delta(
					"a",
					"## Summary\nFound it.## What I did\n- Read.## What's still needed\n- Save.",
				),
			]),
		).toMatchObject({
			content:
				"## Summary\nFound it.\n\n## What I did\n- Read.\n\n## What's still needed\n- Save.",
		});
	});
	it.each([
		[
			[
				start("a"),
				delta("a", "First."),
				start("b"),
				delta("b", "Second."),
			],
			"First.\n\nSecond.",
		],
		[
			[
				start("a"),
				delta("a", "First. "),
				start("b"),
				delta("b", "Second."),
			],
			"First. Second.",
		],
		[
			[
				start("a"),
				delta("a", "First."),
				start("b"),
				delta("b", "\nSecond."),
			],
			"First.\nSecond.",
		],
		[[start("a"), delta("a", "con"), delta("a", "tinue")], "continue"],
	])("assembles segment boundaries %j", async (parts, content) => {
		expect(
			await answer(parts as Array<Record<string, unknown>>),
		).toMatchObject({ content });
	});
	it("leaves ordinary output unchanged", async () => {
		expect(await answer([delta("a", SAVED)], false)).toMatchObject({
			content: SAVED,
		});
	});
});

describe("synthesis heading boundaries", () => {
	it.each([
		"### What I did in detail",
		"    ## Summary\n    Example code.## What I did",
		"> ## Summary\n> Quoted example",
		"Use `## Summary` heading",
		"```markdown\n## Summary\nExample text.## What I did\n```",
		"~~~~markdown\n## Summary\nExample text.## What's still needed\n~~~~",
		"## Summary in the quoted example",
	])("preserves non-section text %j", async (content) => {
		expect(await answer([delta("a", content)])).toMatchObject({ content });
	});
	it("skips a fenced Summary when locating the real summary", async () => {
		const content =
			"Preface\n```markdown\n## Summary\nExample\n```\n## Summary\nThe real answer.";
		expect(await answer([delta("a", content)])).toMatchObject({
			content: "## Summary\nThe real answer.",
		});
	});
});

it.each(["What I did", "What's still needed"])(
	"keeps %s when it precedes Summary",
	async (first) => {
		const sections = `## ${first}\n- Verify example_write: outcome unknown.\n\n## Summary\nSaved progress.`;
		expect(
			await answer([delta("a", `Preface\n${sections}`)]),
		).toMatchObject({ content: sections });
	},
);

it("passes the main-round purpose through model selection", async () => {
	await answer([start("text-1"), delta("text-1", "Example answer")], false);
	expect(vi.mocked(getAiModelWithSelection).mock.calls[0][5]).toMatchObject({
		callPurpose: "main-round",
	});
});
