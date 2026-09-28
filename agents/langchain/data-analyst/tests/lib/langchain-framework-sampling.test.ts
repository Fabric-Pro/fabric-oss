/**
 * The LangChain framework path builds a real `ChatAnthropic` with
 * `temperature: 0`. Adaptive-only Claude (Opus 4.7/4.8 and the 5.x
 * generation — including this app's default, claude-sonnet-5) rejects any
 * non-default temperature, and `@langchain/anthropic` throws client-side
 * when it builds the request. The agent loop is mocked to build the real
 * request params (`invocationParams`), the exact step that throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	llm: undefined as undefined | { invocationParams: (o?: unknown) => unknown },
}));

vi.mock("@langchain/mcp-adapters", () => ({
	MultiServerMCPClient: class {
		async getTools() {
			return [];
		}
	},
}));

vi.mock("@langchain/langgraph/prebuilt", () => ({
	createReactAgent: ({ llm }: { llm: typeof captured.llm }) => {
		captured.llm = llm;
		return {
			invoke: async () => {
				const params = llm?.invocationParams({}) as Record<
					string,
					unknown
				>;
				return {
					messages: [{ content: `temperature=${String(params.temperature)}` }],
				};
			},
		};
	},
}));

import { handleLangchainFramework } from "@/lib/frameworks/langchain";

async function run(model: string): Promise<string> {
	vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
	const stream = await handleLangchainFramework(
		"http://localhost/mcp",
		undefined,
		[{ role: "user", content: "hi" }],
		"system",
		model,
	);
	const reader = stream.getReader();
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out += value;
	}
	return out;
}

beforeEach(() => {
	captured.llm = undefined;
});

describe("data-analyst LangChain framework — Anthropic sampling params", () => {
	it.each([
		"anthropic/claude-sonnet-5",
		"anthropic/claude-opus-4-8",
		"anthropic/claude-opus-5-5",
		// Unknown provider prefix falls back to the default Anthropic model
		// (claude-sonnet-5).
		"other/whatever",
	])("%s → no temperature sent, request builds", async (model) => {
		expect(await run(model)).toBe("temperature=undefined");
	});

	it("claude-sonnet-4-6 keeps temperature 0", async () => {
		expect(await run("anthropic/claude-sonnet-4-6")).toBe("temperature=0");
	});
});
