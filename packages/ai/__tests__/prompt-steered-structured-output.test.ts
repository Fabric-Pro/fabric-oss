/**
 * Databricks serves structured output to Claude through a forced tool call,
 * which Sonnet/Opus 5.5 and Fable/Mythos 5.1 reject (Fizzy #2823). `getModel`
 * swaps the JSON response format for a schema instruction on those models.
 * The end-to-end cases capture the body the Databricks fetch actually sends.
 */
import { generateObject, generateText, Output, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createPromptSteeredStructuredOutputMiddleware,
	databricksModelNeedsPromptSteeredStructuredOutput,
} from "../lib/prompt-steered-structured-output-middleware";

// The Databricks fetch captures the global fetch when model-factory loads, so
// the stub has to be in place before any import runs.
const { fetchMock } = vi.hoisted(() => {
	const fetchMock = vi.fn();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return { fetchMock };
});

const schema = z.object({ title: z.string() });

function chatCompletion(content: string): Response {
	return new Response(
		JSON.stringify({
			id: "chatcmpl-test",
			created: 1700000000,
			model: "us.anthropic.claude-sonnet-5-5",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content },
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

async function generateViaDatabricks(
	endpointName: string,
	canonicalModelName?: string,
	reply = '{"title":"Cats"}',
): Promise<{ body: Record<string, unknown>; object: unknown }> {
	let body: Record<string, unknown> | undefined;
	fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
		body = JSON.parse(String(init?.body));
		return chatCompletion(reply);
	});
	const { getModel } = await import("../model-factory");
	const { object } = await generateObject({
		model: getModel(endpointName, {
			apiKey: "example-databricks-token",
			provider: "DATABRICKS",
			baseUrl: "https://example.com/ai-gateway/mlflow/v1",
			canonicalModelName,
		}),
		schema,
		system: "You summarize.",
		prompt: "Cats sleep a lot.",
		maxRetries: 0,
	});
	if (!body) {
		throw new Error("Databricks request was never sent");
	}
	return { body, object };
}

function systemText(body: Record<string, unknown>): string {
	const messages = body.messages as Array<{ role: string; content: unknown }>;
	const system = messages.find((m) => m.role === "system");
	return JSON.stringify(system?.content ?? "");
}

afterEach(() => {
	fetchMock.mockReset();
});

describe("getModel on DATABRICKS (Fizzy #2823)", () => {
	it("steers an opaque endpoint alias whose canonical model is Sonnet 5.5", async () => {
		const { body, object } = await generateViaDatabricks(
			"prod-chat",
			"claude-sonnet-5-5",
		);
		expect(object).toEqual({ title: "Cats" });
		expect(body).not.toHaveProperty("response_format");
		expect(systemText(body)).toContain("You summarize.");
		expect(systemText(body)).toContain("JSON Schema:");
		// The serialized schema itself, not just its label, reaches the model.
		const instruction = JSON.parse(systemText(body)) as string;
		const serialized = JSON.parse(
			instruction.slice(instruction.indexOf("JSON Schema:\n") + 13),
		);
		expect(serialized).toMatchObject({
			type: "object",
			properties: { title: { type: "string" } },
			required: ["title"],
		});
	});

	it.each([
		"system.ai.claude-sonnet-5-5",
		"system.ai.claude-opus-5-5",
		"databricks-claude-fable-5-1",
		"system.ai.claude-mythos-5-1",
	])(
		"falls back to the endpoint name %s when no canonical name is given",
		async (endpoint) => {
			const { body } = await generateViaDatabricks(endpoint);
			expect(body).not.toHaveProperty("response_format");
			expect(systemText(body)).toContain("JSON Schema:");
		},
	);

	it("keeps response_format for a model that accepts the forced-tool translation", async () => {
		const { body } = await generateViaDatabricks(
			"system.ai.claude-sonnet-5",
		);
		expect(body).toHaveProperty("response_format.type", "json_schema");
		expect(systemText(body)).not.toContain("JSON Schema:");
	});

	it("trusts the canonical name over a misleading endpoint name", async () => {
		const { body } = await generateViaDatabricks(
			"system.ai.claude-sonnet-5-5",
			"claude-sonnet-5",
		);
		expect(body).toHaveProperty("response_format.type", "json_schema");
	});

	it("rejects a reply that does not match the schema", async () => {
		await expect(
			generateViaDatabricks(
				"prod-chat",
				"claude-sonnet-5-5",
				'{"heading":"Cats"}',
			),
		).rejects.toThrow(/schema|No object generated/i);
	});

	it("keeps tools when Output.object is combined with tool calling", async () => {
		let body: Record<string, unknown> | undefined;
		fetchMock.mockImplementation(
			async (_url: unknown, init?: RequestInit) => {
				body = JSON.parse(String(init?.body));
				return chatCompletion('{"title":"Cats"}');
			},
		);
		const { getModel } = await import("../model-factory");
		const result = await generateText({
			model: getModel("prod-chat", {
				apiKey: "example-databricks-token",
				provider: "DATABRICKS",
				baseUrl: "https://example.com/ai-gateway/mlflow/v1",
				canonicalModelName: "claude-sonnet-5-5",
			}),
			output: Output.object({ schema }),
			tools: {
				lookup: tool({
					description: "Look something up",
					inputSchema: z.object({ q: z.string() }),
					execute: async () => "ok",
				}),
			},
			prompt: "Cats sleep a lot.",
			maxRetries: 0,
		});
		expect(result.output).toEqual({ title: "Cats" });
		expect(body).not.toHaveProperty("response_format");
		expect(body).toHaveProperty("tools");
		expect(body).not.toHaveProperty("tool_choice.type", "function");
	});
});

describe("createPromptSteeredStructuredOutputMiddleware", () => {
	const transform = async (params: Record<string, unknown>) => {
		const middleware = createPromptSteeredStructuredOutputMiddleware();
		return (await middleware.transformParams?.({
			type: "generate",
			params: params as never,
			model: {} as never,
		})) as Record<string, unknown>;
	};

	it("prepends a system message when the prompt has none", async () => {
		const out = await transform({
			prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
			responseFormat: { type: "json" },
		});
		expect(out).not.toHaveProperty("responseFormat");
		const prompt = out.prompt as Array<{ role: string; content: unknown }>;
		expect(prompt).toHaveLength(2);
		expect(prompt[0].role).toBe("system");
		expect(prompt[0].content).toContain("single JSON object");
		expect(prompt[0].content).not.toContain("JSON Schema:");
	});

	it("leaves a text response format untouched", async () => {
		const params = {
			prompt: [{ role: "system", content: "You summarize." }],
			responseFormat: { type: "text" },
		};
		expect(await transform(params)).toBe(params);
	});
});

describe("databricksModelNeedsPromptSteeredStructuredOutput", () => {
	it.each([
		["prod-chat", "claude-sonnet-5-5", true],
		["prod-chat", "claude-opus-5", false],
		["prod-chat", undefined, false],
		["system.ai.claude-sonnet-5-5", undefined, true],
		["system.ai.claude-sonnet-5-5", "claude-sonnet-5", false],
		["databricks-claude-sonnet-4-5", null, false],
	])("%s (canonical %s) → %s", (endpoint, canonical, expected) => {
		expect(
			databricksModelNeedsPromptSteeredStructuredOutput(
				endpoint,
				canonical,
			),
		).toBe(expected);
	});
});
