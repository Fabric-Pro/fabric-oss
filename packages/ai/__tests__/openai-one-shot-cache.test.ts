import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIOneShotCacheMiddleware } from "../lib/openai-one-shot-cache-middleware";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("undici", async () => ({
	...(await vi.importActual<typeof import("undici")>("undici")),
	fetch: fetchMock,
}));
afterEach(() => {
	fetchMock.mockReset();
	vi.unstubAllGlobals();
});
const base = () => ({
	prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
});
async function transform(
	params = base(),
	model = "gpt-6.1-sol",
	provider = "OPENAI_DIRECT",
	gateway = false,
) {
	return createOpenAIOneShotCacheMiddleware(
		model,
		provider,
		gateway,
	).transformParams?.({
		params: params as never,
		type: "generate",
		model: {} as never,
	});
}
describe("one-shot cache policy", () => {
	it.each([
		"gpt-6.1-sol",
		"gpt-6.1-terra",
		"gpt-6-astra",
		"gpt-5.6",
		"gpt-5.6-mini",
		"gpt-5.10",
	])("applies to %s", async (model) => {
		expect(
			(await transform(base(), model))?.providerOptions?.openai
				?.promptCacheOptions,
		).toEqual({ mode: "explicit" });
	});
	it.each(["gpt-5.5", "gpt-5", "gpt-4o", "o3", "gpt-5.1", "gpt-5.60oops"])(
		"leaves %s unchanged",
		async (model) => {
			const params = base();
			expect(await transform(params, model)).toBe(params);
		},
	);
	it.each(["AZURE", "ANTHROPIC_DIRECT", "UNKNOWN"])(
		"leaves %s unchanged",
		async (provider) => {
			const params = base();
			expect(await transform(params, undefined, provider)).toBe(params);
		},
	);
	it("leaves gateways unchanged", async () => {
		const params = base();
		expect(await transform(params, undefined, undefined, true)).toBe(
			params,
		);
	});
	it.each([
		{ tools: [{ type: "function", name: "lookup", inputSchema: {} }] },
		{ prompt: [{ role: "assistant", content: [] }] },
		{ prompt: [{ role: "tool", content: [] }] },
		{
			providerOptions: {
				openai: { promptCacheOptions: { mode: "auto" } },
			},
		},
		{ providerOptions: { openai: { promptCacheKey: "example" } } },
		{
			prompt: [
				{
					role: "user",
					content: [],
					providerOptions: {
						openai: { promptCacheBreakpoint: true },
					},
				},
			],
		},
		{
			prompt: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "hello",
							providerOptions: {
								openai: { promptCacheBreakpoint: true },
							},
						},
					],
				},
			],
		},
	])("preserves caller policy/history %j", async (extra) => {
		const params = { ...base(), ...extra };
		expect(await transform(params as never)).toBe(params);
	});
	it("keeps other provider options", async () => {
		const providerOptions = {
			openai: { strictJsonSchema: true, reasoningEffort: "low" },
			other: { value: true },
		};
		expect(
			(await transform({ ...base(), providerOptions } as never))
				?.providerOptions,
		).toEqual({
			...providerOptions,
			openai: {
				...providerOptions.openai,
				promptCacheOptions: { mode: "explicit" },
			},
		});
	});
});
it.each([
	["OPENAI_DIRECT", "example-key", false, true],
	["OPENAI_DIRECT", "example-key", true, false],
	["OPENAI_DIRECT", "vck_example_key", false, false],
	["ANTHROPIC_DIRECT", "example-key", false, false],
	["AZURE_AI_FOUNDRY", "example-key", false, false],
] as const)(
	"factory wiring %s %s tools=%s",
	async (provider, apiKey, tools, expected) => {
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({ error: { message: "stop after capture" } }),
				{
					status: 400,
					headers: { "content-type": "application/json" },
				},
			),
		);
		const { getModel } = await import("../model-factory");
		const model = getModel("openai/gpt-6.1-sol", {
			provider,
			apiKey,
			baseUrl: "https://example.com",
		});
		await (
			model as never as { doGenerate: (p: unknown) => Promise<unknown> }
		)
			.doGenerate({
				...base(),
				...(tools
					? {
							tools: [
								{
									type: "function",
									name: "lookup",
									inputSchema: {
										type: "object",
										properties: {},
									},
								},
							],
						}
					: {}),
			})
			.catch(() => {});
		expect(fetchMock).toHaveBeenCalled();
		const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
		expect(body.prompt_cache_options).toEqual(
			expected ? { mode: "explicit" } : undefined,
		);
		expect(
			body.providerOptions?.openai?.promptCacheOptions,
		).toBeUndefined();
	},
);
