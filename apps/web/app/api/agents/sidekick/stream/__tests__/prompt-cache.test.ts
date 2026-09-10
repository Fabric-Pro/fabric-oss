import { ANTHROPIC_EPHEMERAL_CACHE } from "@repo/ai/prompt-cache";
import {
	buildSidekickSystemPrompt,
	SIDEKICK_SYSTEM_PROMPT,
} from "@repo/ai/sidekick/prompt";
import { describe, expect, it } from "vitest";
import { buildSidekickPromptCacheRequest } from "../prompt-cache";

describe("buildSidekickPromptCacheRequest", () => {
	it("keeps fresh agent context after the reusable historical breakpoint", () => {
		const messages = [
			{ role: "user", content: "earlier request" },
			{ role: "assistant", content: "earlier response" },
			{
				role: "user",
				content:
					'<agent_context>\n{"name":"Current form"}\n</agent_context>\n\nUpdate it',
			},
		];

		const request = buildSidekickPromptCacheRequest({
			provider: "ANTHROPIC_DIRECT",
			modelString: "claude-sonnet-4-5",
			messages,
		});

		expect(Array.isArray(request.system)).toBe(true);
		if (!Array.isArray(request.system)) {
			throw new Error("expected cache-aware system messages");
		}
		expect(request.system).toEqual([
			{
				role: "system",
				content: SIDEKICK_SYSTEM_PROMPT,
				providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
			},
			{
				role: "system",
				content: expect.stringContaining("Today is "),
			},
		]);
		expect(request.system[1]).not.toHaveProperty("providerOptions");
		expect(request.messages).toEqual([
			{ role: "user", content: "earlier request" },
			{
				role: "assistant",
				content: "earlier response",
				providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
			},
			messages[2],
		]);
		expect(request.messages.at(-1)).not.toHaveProperty("providerOptions");
		expect(messages[1]).not.toHaveProperty("providerOptions");
	});

	it("does not mark the current turn when history is empty", () => {
		const currentMessage = {
			role: "user",
			content:
				'<agent_context>\n{"name":"New agent"}\n</agent_context>\n\nConfigure it',
		};

		const request = buildSidekickPromptCacheRequest({
			provider: "VERCEL_GATEWAY",
			modelString: "anthropic/claude-sonnet-4-5",
			messages: [currentMessage],
		});

		expect(request.messages).toEqual([currentMessage]);
		expect(request.messages[0]).not.toHaveProperty("providerOptions");
	});

	it("keeps the actual last user and trailing assistant/tool data unmarked", () => {
		const messages = [
			{ role: "user", content: "earlier request" },
			{ role: "assistant", content: "earlier response" },
			{
				role: "user",
				content:
					'<agent_context>\n{"name":"Fresh form"}\n</agent_context>\n\nUpdate it',
			},
			{ role: "assistant", content: "in-progress tool call" },
			{ role: "tool", content: "tool result" },
		];

		const request = buildSidekickPromptCacheRequest({
			provider: "ANTHROPIC_DIRECT",
			modelString: "claude-sonnet-4-5",
			messages,
		});

		expect(request.messages[1]).toEqual({
			...messages[1],
			providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
		});
		expect(request.messages.slice(2)).toEqual(messages.slice(2));
		for (const message of request.messages.slice(2)) {
			expect(message).not.toHaveProperty("providerOptions");
		}
	});

	it("preserves the exact legacy request shape for non-Anthropic models", () => {
		const messages = [
			{ role: "user", content: "earlier request" },
			{ role: "assistant", content: "earlier response" },
			{ role: "user", content: "current request" },
		];

		const request = buildSidekickPromptCacheRequest({
			provider: "VERCEL_GATEWAY",
			modelString: "openai/gpt-5",
			messages,
		});

		expect(request.system).toBe(buildSidekickSystemPrompt());
		expect(request.messages).toEqual(messages);
		expect(request.messages).not.toBe(messages);
		for (const message of request.messages) {
			expect(message).not.toHaveProperty("providerOptions");
		}
	});
});
