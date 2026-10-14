/**
 * Structured output on a ChatGPT plan (Fizzy #2770). The plan route is sent a
 * non-strict JSON schema, and the model answers optional fields it has nothing
 * for with `null` — the strict-mode convention — which a Zod `.optional()` or
 * `.default()` refuses. A Publishing short post failed on exactly this shape.
 */
import {
	generateObject,
	generateText,
	NoObjectGeneratedError,
	Output,
} from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	getChatGptPlanSourceStates: async () => [],
	recordChatGptPlanSourceExhausted: async () => true,
	markChatGptPlanSourceAnswered: async () => true,
	getChatGptPlanOrgAccountWindows: async () => new Map(),
	getUserModelPreference: vi.fn(),
	getModelForTask: vi.fn(),
}));

vi.mock("../lib/chatgpt-plan/plan-credentials", () => ({
	getChatGptPlanAccessToken: async () => ({
		accessToken: "access-1",
		expiresAt: new Date(Date.now() + 3_600_000),
	}),
	refreshChatGptPlanAfterUnauthorized: vi.fn(),
}));

import { CHATGPT_PLAN_HEAVY_MODEL } from "../lib/chatgpt-plan/models";
import { createChatGptPlanModel } from "../lib/chatgpt-plan/provider";
import { dropDisallowedNulls } from "../lib/chatgpt-plan/structured-output";

/** The shape of a Publishing short post (`PublishingShortPostSchema`). */
const ShortPostSchema = z.object({
	options: z
		.array(
			z.object({
				label: z.string().min(1).max(80),
				text: z.string().min(1).max(2000),
				estimatedCharacters: z.number().int().nonnegative(),
			}),
		)
		.length(3),
	hashtags: z.array(z.string().min(1).max(80)).max(8).default([]),
	inputsNeeded: z.array(z.string().min(1).max(400)).max(12).default([]),
	safetyNote: z.string().max(1000).nullable().default(null),
	meta: z.object({ tone: z.string().optional() }).optional(),
});

const option = (label: string) => ({
	label,
	text: `${label} take on the release.`,
	estimatedCharacters: 30,
});

/** What the plan answered on staging: valid JSON, unused fields as null. */
const planAnswer = {
	options: [option("Direct"), option("Story"), option("Question")],
	hashtags: null,
	inputsNeeded: null,
	safetyNote: null,
	meta: { tone: null },
};

function planReply(text: string): Response {
	const output = [
		{
			type: "reasoning",
			id: "rs_1",
			summary: [],
		},
		{
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text, annotations: [] }],
		},
	];
	const response = {
		id: "resp_1",
		object: "response",
		created_at: 1_790_000_000,
		status: "completed",
		model: CHATGPT_PLAN_HEAVY_MODEL,
		output,
		usage: {
			input_tokens: 1903,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 236,
			output_tokens_details: { reasoning_tokens: 57 },
			total_tokens: 2139,
		},
	};
	return new Response(
		[
			...output.map((item) => ({
				type: "response.output_item.done",
				item,
			})),
			{ type: "response.completed", response },
		]
			.map(
				(event) =>
					`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

const fetchImpl = vi.fn<typeof fetch>();

const planModel = () =>
	createChatGptPlanModel({
		userId: "user-1",
		modelId: CHATGPT_PLAN_HEAVY_MODEL,
		fetchImpl,
	});

beforeEach(() => {
	fetchImpl.mockReset();
});

describe("structured output on a ChatGPT plan", () => {
	it("accepts a draft whose unused optional fields came back null", async () => {
		fetchImpl.mockImplementation(async () =>
			planReply(JSON.stringify(planAnswer)),
		);

		const { object } = await generateObject({
			model: planModel(),
			schema: ShortPostSchema,
			prompt: "Write three short posts.",
			providerOptions: { openai: { strictJsonSchema: false } },
			maxRetries: 0,
		});

		expect(object).toEqual({
			options: planAnswer.options,
			hashtags: [],
			inputsNeeded: [],
			safetyNote: null,
			meta: {},
		});
		const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
		expect(sent.text.format).toMatchObject({
			type: "json_schema",
			strict: false,
		});
	});

	it("does the same for generateText with Output.object", async () => {
		fetchImpl.mockImplementation(async () =>
			planReply(JSON.stringify(planAnswer)),
		);

		const { output } = await generateText({
			model: planModel(),
			output: Output.object({ schema: ShortPostSchema }),
			prompt: "Write three short posts.",
			maxRetries: 0,
		});

		expect(output.hashtags).toEqual([]);
		expect(output.options).toHaveLength(3);
	});

	it("still refuses a draft that breaks the schema", async () => {
		fetchImpl.mockImplementation(async () =>
			planReply(
				JSON.stringify({
					...planAnswer,
					options: [option("Direct"), option("Story")],
				}),
			),
		);

		await expect(
			generateObject({
				model: planModel(),
				schema: ShortPostSchema,
				prompt: "Write three short posts.",
				maxRetries: 0,
			}),
		).rejects.toSatisfy((error) =>
			NoObjectGeneratedError.isInstance(error),
		);
	});

	it("still refuses null for a field the schema requires", async () => {
		fetchImpl.mockImplementation(async () =>
			planReply(JSON.stringify({ ...planAnswer, options: null })),
		);

		await expect(
			generateObject({
				model: planModel(),
				schema: ShortPostSchema,
				prompt: "Write three short posts.",
				maxRetries: 0,
			}),
		).rejects.toSatisfy((error) =>
			NoObjectGeneratedError.isInstance(error),
		);
	});
});

describe("dropDisallowedNulls", () => {
	const schema = {
		type: "object",
		properties: {
			name: { type: "string" },
			note: { anyOf: [{ type: "string" }, { type: "null" }] },
			tags: { type: "array", items: { $ref: "#/definitions/tag" } },
			child: { $ref: "#" },
		},
		required: ["name"],
		definitions: {
			tag: {
				type: "object",
				properties: { value: { type: ["string", "null"] }, extra: {} },
				required: [],
			},
		},
	};

	it("drops a null only where the schema neither allows nor requires it", () => {
		expect(
			dropDisallowedNulls(
				{
					name: null,
					note: null,
					tags: [{ value: null, extra: null }, null],
					child: { name: "x", child: null },
				},
				schema,
			),
		).toEqual({
			name: null,
			note: null,
			tags: [{ value: null, extra: null }, null],
			child: { name: "x" },
		});
	});

	it("leaves anything that is not an object or array alone", () => {
		expect(dropDisallowedNulls("text", schema)).toBe("text");
		expect(dropDisallowedNulls(null, schema)).toBeNull();
	});
});
