import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { cacheableSystem } from "../prompt-cache";

describe("Anthropic adapter mid-conversation system support", () => {
	it("converts stable system, history, current, terminal system for Opus 4.8", async () => {
		let requestBody: Record<string, unknown> | undefined;
		let betaHeader: string | null = null;
		const fetchMock = vi.fn<typeof globalThis.fetch>(
			async (_input, init) => {
				requestBody = JSON.parse(String(init?.body));
				betaHeader = new Headers(init?.headers).get("anthropic-beta");

				return new Response(
					JSON.stringify({
						type: "message",
						id: "msg_test",
						model: "claude-opus-4-8",
						content: [{ type: "text", text: "done" }],
						stop_reason: "end_turn",
						stop_sequence: null,
						usage: { input_tokens: 12, output_tokens: 1 },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
		);
		const anthropic = createAnthropic({
			apiKey: "test-key",
			fetch: fetchMock,
		});

		const result = await generateText({
			model: anthropic("claude-opus-4-8"),
			system: cacheableSystem("stable system"),
			messages: [
				{ role: "user", content: "earlier question" },
				{ role: "assistant", content: "earlier answer" },
				{ role: "user", content: "current question" },
				{ role: "system", content: "request-specific context" },
			],
		});

		expect(result.text).toBe("done");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(requestBody).toMatchObject({
			system: [
				{
					type: "text",
					text: "stable system",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [
				{ role: "user" },
				{ role: "assistant" },
				{ role: "user" },
				{ role: "system" },
			],
		});
		expect(betaHeader).toContain("mid-conversation-system-2026-04-07");
	});
});
