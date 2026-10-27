import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createChatGptPlanFetch } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	createGateway,
	generateText,
	jsonSchema,
	type LanguageModel,
	type ModelMessage,
	tool,
} from "ai";
import { afterEach, expect, it, vi } from "vitest";
import { buildIterationSystemPrompt } from "../../temporal/src/activities/orchestrator/execution/system-prompt";
import { createDatabricksFetch } from "../lib/databricks-compat";
import {
	CACHE_BREAKPOINT,
	withAdvisorCacheBreakpoints,
} from "../lib/prompt-cache";
import { applyAzureChatBodyCompat } from "../model-factory";

// Only fake transports: inspect the installed adapters' outbound JSON, then refuse it.
let body: Record<string, any>;
const capture: typeof fetch = async (_url, init) => {
	body = JSON.parse(String(init?.body));
	return Response.json(
		{
			type: "error",
			error: {
				message: "offline serialization complete",
				type: "invalid_request_error",
			},
		},
		{ status: 400 },
	);
};
afterEach(() => vi.unstubAllGlobals());
const parts = {
	reusable: "Example reusable instructions",
	variable: "Example variable memory",
};
async function send(
	model: LanguageModel,
	cache: boolean,
	messages: ModelMessage[] = [{ role: "user", content: "Example question" }],
) {
	const system = buildIterationSystemPrompt({
		systemPrompt: "Example full legacy prompt",
		systemPromptParts: parts,
		skillsSystemBlock: "Example skills",
		promptCacheTarget: cache,
	});
	await expect(
		generateText({
			model,
			instructions: system.instructions,
			messages,
			tools: {
				example_tool: tool({
					description: "Example tool",
					inputSchema: jsonSchema({
						type: "object",
						properties: { value: { type: "string" } },
					}),
				}),
			},
			maxRetries: 0,
		}),
	).rejects.toThrow("offline serialization complete");
	return body;
}
it.each(["chat", "responses", "plan", "databricks", "foundry"] as const)(
	"serializes reusable before variable via %s",
	async (route) => {
		vi.stubGlobal("fetch", capture);
		const client = createOpenAI({
			apiKey: "example-key",
			baseURL:
				route === "plan"
					? "https://api.openai.com/v1"
					: "https://example.com",
			fetch:
				route === "databricks"
					? createDatabricksFetch(capture)
					: route === "plan"
						? createChatGptPlanFetch({
								getAccessToken: async () => "example-key",
								baseFetch: capture,
							})
						: route === "foundry"
							? async (url, init) => {
									const outgoing = JSON.parse(
										String(init?.body),
									);
									applyAzureChatBodyCompat(
										outgoing,
										"example-deployment",
									);
									return capture(url, {
										...init,
										body: JSON.stringify(outgoing),
									});
								}
							: capture,
		});
		const model =
			route === "responses" || route === "plan"
				? client.responses("gpt-5")
				: client.chat(
						route === "databricks"
							? "databricks-claude-sonnet-4-5"
							: "example-deployment",
					);
		const request = await send(model, false);
		const system =
			route === "responses" || route === "plan"
				? request.input
				: request.messages;
		expect(system.slice(0, 2).map((m: any) => m.role)).toEqual(
			route === "plan" || route === "responses"
				? ["developer", "developer"]
				: ["system", "system"],
		);
		if (route === "databricks") {
			expect(system[0].content).toEqual([
				{
					type: "text",
					text: `${parts.reusable}\n\nExample skills`,
					cache_control: { type: "ephemeral" },
				},
			]);
		}
		const serialized = JSON.stringify(system);
		expect(serialized.indexOf(parts.reusable)).toBeLessThan(
			serialized.indexOf("Example skills"),
		);
		expect(serialized.indexOf("Example skills")).toBeLessThan(
			serialized.indexOf(parts.variable),
		);
	},
);
it.each(["direct", "gateway"] as const)(
	"serializes two leading Claude system blocks via %s on rounds 1 and 2",
	async (route) => {
		const model =
			route === "direct"
				? createAnthropic({
						apiKey: "example-key",
						baseURL: "https://example.com",
						fetch: capture,
					})("claude-sonnet-4-5")
				: createGateway({
						apiKey: "example-key",
						baseURL: "https://example.com",
						fetch: capture,
					})("anthropic/claude-sonnet-4-5");
		for (const round of [1, 2]) {
			const history: ModelMessage[] = [
				{
					role: "user",
					content: "Example question",
					providerOptions: CACHE_BREAKPOINT,
				},
			];
			if (round === 2) {
				history.push(
					{
						role: "assistant",
						content: "Example response",
						providerOptions: CACHE_BREAKPOINT,
					},
					{
						role: "user",
						content: "Example follow-up",
						providerOptions: CACHE_BREAKPOINT,
					},
				);
			}
			const request = await send(
				model,
				true,
				withAdvisorCacheBreakpoints(
					history,
					round === 2 ? 0 : undefined,
				),
			);
			const system =
				route === "direct"
					? request.system
					: request.prompt.filter((m: any) => m.role === "system");
			expect(system).toHaveLength(2);
			expect(JSON.stringify(request.tools)).not.toMatch(
				/cache_control|cacheControl/,
			);
			expect(JSON.stringify(system[0])).toContain(
				`${parts.reusable}\\n\\nExample skills`,
			);
			expect(JSON.stringify(system[0])).toMatch(
				/cache_control|cacheControl/,
			);
			expect(JSON.stringify(system[1])).toContain(parts.variable);
			expect(JSON.stringify(system[1])).not.toMatch(
				/cache_control|cacheControl/,
			);
			const count = (
				JSON.stringify(request).match(
					/"(?:cache_control|cacheControl)"/g,
				) ?? []
			).length;
			expect(count).toBe(round === 1 ? 2 : 3);
			expect(count).toBeLessThanOrEqual(4);
		}
	},
);
