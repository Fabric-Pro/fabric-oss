import { afterEach, expect, it, vi } from "vitest";
import { getAICredentialsFromHeaders } from "../src/services/token-exchange";

afterEach(() => vi.unstubAllGlobals());

it.each([true, undefined])(
	"carries the exchanged model pin through the client and cache (%s)",
	async (modelPinned) => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						apiKey: "example-key",
						provider: "GROQ",
						model: "selected-model",
						canonicalModelName: "claude-sonnet-5",
						expiresIn: 300,
						...(modelPinned && {
							modelPinned,
							isReasoningModel: true,
							maxOutputTokens: 8192,
							contextWindow: 32768,
						}),
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const headers = new Headers({
			"X-AI-Token": `example-pin-token-${modelPinned}`,
		});
		for (let i = 0; i < 2; i++) {
			const result = await getAICredentialsFromHeaders(headers, {
				fabricBaseUrl: "https://fabric.example.com",
			});
			expect(result?.modelPinned).toBe(modelPinned === true);
			expect(result?.model).toBe("selected-model");
			expect(result?.canonicalModelName).toBe("claude-sonnet-5");
			if (modelPinned) {
				expect(result).toMatchObject({
					isReasoningModel: true,
					maxOutputTokens: 8192,
					contextWindow: 32768,
				});
			}
		}
		expect(fetchMock).toHaveBeenCalledTimes(1);
	},
);
