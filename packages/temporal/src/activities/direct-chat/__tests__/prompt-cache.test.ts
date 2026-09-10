import { ANTHROPIC_EPHEMERAL_CACHE } from "@repo/ai/prompt-cache";
import { describe, expect, it } from "vitest";
import {
	buildDirectChatPromptCacheRequest,
	buildLegacyDirectChatSystemInstructions,
	DIRECT_CHAT_CACHEABLE_SYSTEM_PROMPT,
} from "../prompt-cache";

describe("buildLegacyDirectChatSystemInstructions", () => {
	it("preserves the legacy template bytes when optional sections are absent", () => {
		expect(
			buildLegacyDirectChatSystemInstructions({
				capabilitiesInstructions:
					"CAPABILITIES:\n- No tools connected.",
				webSearchInstructions: "",
				frameOutputInstructions: "",
				currentDateContext: "Today is September 9, 2026.",
			}),
		).toBe(`You are Fabric Loom, an intelligent assistant that helps users accomplish tasks.

CAPABILITIES:
- No tools connected.

TOOL USAGE GUIDELINES:
- CAREFULLY read the tool's input schema to understand ALL available filter/query parameters
- When the user specifies filters, ALWAYS use the appropriate filter parameters
- Do NOT fetch ALL data and filter client-side - use server-side filtering
- Only fetch the minimum data needed to answer the user's question
- When an MCP tool is available that matches the user's request, call it — do not give text instructions instead

RESPONSE GUIDELINES:
- Use markdown for formatting (tables, bullet points, code blocks)
- Be concise but complete
- Cite sources when using document context or web search results


Today is September 9, 2026.`);
	});

	it("preserves the legacy optional-section spacing", () => {
		const result = buildLegacyDirectChatSystemInstructions({
			capabilitiesInstructions: "CAPABILITIES:\n- Tools connected.",
			webSearchInstructions: "WEB SEARCH GUIDELINES:\n- Search first.",
			frameOutputInstructions: "FRAME OUTPUT REQUIREMENT:\n- Create it.",
			currentDateContext: "Today is September 9, 2026.",
		});

		expect(result).toContain(
			"text instructions instead\n\nWEB SEARCH GUIDELINES:\n- Search first.\n\nRESPONSE GUIDELINES:",
		);
		expect(result).toContain(
			"document context or web search results\n\nFRAME OUTPUT REQUIREMENT:\n- Create it.\n\nToday is",
		);
	});
});

describe("buildDirectChatPromptCacheRequest", () => {
	it("keeps changing context and the current image turn after reusable history", () => {
		const messages = [
			{ role: "user", content: "earlier question" },
			{ role: "assistant", content: "earlier answer" },
			{
				role: "user",
				content: [
					{ type: "text", text: "describe this image" },
					{
						type: "image",
						image: new Uint8Array([1, 2, 3]),
						mediaType: "image/png",
					},
				],
			},
		];

		const firstRequest = buildDirectChatPromptCacheRequest({
			promptCacheEnabled: true,
			rollingHistoryEnabled: true,
			systemPrompt: "caller and project context one",
			messages,
		});
		const secondRequest = buildDirectChatPromptCacheRequest({
			promptCacheEnabled: true,
			rollingHistoryEnabled: true,
			systemPrompt: "caller and project context two",
			messages,
		});

		expect(firstRequest.system).toEqual({
			role: "system",
			content: DIRECT_CHAT_CACHEABLE_SYSTEM_PROMPT,
			providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
		});
		expect(firstRequest.messages).toEqual([
			{ role: "user", content: "earlier question" },
			{
				role: "assistant",
				content: "earlier answer",
				providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
			},
			messages[2],
			{ role: "system", content: "caller and project context one" },
		]);
		expect(secondRequest.messages.slice(0, 2)).toEqual(
			firstRequest.messages.slice(0, 2),
		);
		expect(secondRequest.messages.at(-1)).toEqual({
			role: "system",
			content: "caller and project context two",
		});
		expect(firstRequest.messages.at(-2)).not.toHaveProperty(
			"providerOptions",
		);
		expect(messages[1]).not.toHaveProperty("providerOptions");
	});

	it("keeps the legacy request shape for non-Anthropic providers", () => {
		const messages = [
			{ role: "user", content: "earlier question" },
			{ role: "user", content: "current question" },
		];

		const request = buildDirectChatPromptCacheRequest({
			promptCacheEnabled: false,
			rollingHistoryEnabled: false,
			systemPrompt: "complete legacy system prompt",
			messages,
		});

		expect(request).toEqual({
			system: "complete legacy system prompt",
			messages,
		});
		expect(request.messages).not.toBe(messages);
		expect(request.messages[0]).not.toHaveProperty("providerOptions");
		expect(request.messages[1]).not.toHaveProperty("providerOptions");
	});

	it("does not mark a current turn when history is empty", () => {
		const currentMessage = { role: "user", content: "first question" };

		const request = buildDirectChatPromptCacheRequest({
			promptCacheEnabled: true,
			rollingHistoryEnabled: true,
			systemPrompt: "turn-specific context",
			messages: [currentMessage],
		});

		expect(request.messages).toEqual([
			currentMessage,
			{ role: "system", content: "turn-specific context" },
		]);
		expect(request.messages[0]).not.toHaveProperty("providerOptions");
	});

	it("uses only adjacent top-level system blocks for unsupported Claude models", () => {
		const messages = [
			{ role: "user", content: "earlier question" },
			{ role: "assistant", content: "earlier answer" },
			{ role: "user", content: "current question" },
		];

		const request = buildDirectChatPromptCacheRequest({
			promptCacheEnabled: true,
			rollingHistoryEnabled: false,
			systemPrompt: "changing context",
			messages,
		});

		expect(request.system).toEqual([
			{
				role: "system",
				content: DIRECT_CHAT_CACHEABLE_SYSTEM_PROMPT,
				providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
			},
			{ role: "system", content: "changing context" },
		]);
		expect(request.messages).toEqual(messages);
		expect(request.messages).not.toBe(messages);
		for (const message of request.messages) {
			expect(message).not.toHaveProperty("providerOptions");
			expect(message.role).not.toBe("system");
		}
	});
});
