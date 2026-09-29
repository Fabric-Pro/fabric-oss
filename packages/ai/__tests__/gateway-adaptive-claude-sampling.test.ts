/**
 * Adaptive-only Claude (Opus 4.7/4.8, the 5.x generation) returns HTTP 400
 * for any non-default temperature / top_p / top_k. `@ai-sdk/anthropic` drops
 * them client-side, but `@ai-sdk/gateway` forwards call options unchanged, so
 * `getModel` guards every gateway route itself. These tests capture the body
 * the gateway client actually sends through `getModel`.
 */
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdaptiveClaudeSamplingMiddleware } from "../lib/adaptive-claude-sampling-middleware";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("undici", async () => {
	const actual = await vi.importActual<typeof import("undici")>("undici");
	return { ...actual, fetch: fetchMock };
});

const SAMPLING = { temperature: 0.2, topP: 0.5, topK: 7 } as const;

async function sentBody(
	modelName: string,
	context: { apiKey: string; provider: string },
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
		body = JSON.parse(String(init?.body));
		return new Response("stubbed", { status: 500 });
	});
	const { getModel } = await import("../model-factory");
	await generateText({
		model: getModel(modelName, context),
		prompt: "hello",
		maxRetries: 0,
		...SAMPLING,
	}).catch(() => undefined);
	if (!body) {
		throw new Error("gateway request was never sent");
	}
	return body;
}

afterEach(() => {
	fetchMock.mockReset();
});

describe("gateway routes drop sampling params for adaptive-only Claude", () => {
	it.each([
		["VERCEL_GATEWAY", "anthropic/claude-sonnet-5"],
		["VERCEL_GATEWAY", "anthropic/claude-sonnet-5.5"],
		["VERCEL_GATEWAY", "anthropic/claude-opus-4.8"],
		["OPENROUTER", "anthropic/claude-opus-5.5"],
		["CLOUDFLARE_AI", "anthropic/claude-sonnet-5"],
	])("%s %s", async (provider, modelName) => {
		const body = await sentBody(modelName, {
			apiKey: "example-gateway-key",
			provider,
		});
		expect(body).not.toHaveProperty("temperature");
		expect(body).not.toHaveProperty("topP");
		expect(body).not.toHaveProperty("topK");
	});

	it("covers a Vercel gateway key configured under a direct provider", async () => {
		const body = await sentBody("claude-sonnet-5", {
			apiKey: "vck_example_tenant_key",
			provider: "ANTHROPIC_DIRECT",
		});
		expect(body).not.toHaveProperty("temperature");
		expect(body).not.toHaveProperty("topP");
		expect(body).not.toHaveProperty("topK");
	});

	it.each([
		"anthropic/claude-haiku-4.5",
		"anthropic/claude-sonnet-4-6",
		"openai/gpt-4o",
	])("keeps sampling params for %s", async (modelName) => {
		const body = await sentBody(modelName, {
			apiKey: "example-gateway-key",
			provider: "VERCEL_GATEWAY",
		});
		expect(body).toMatchObject(SAMPLING);
	});
});

describe("createAdaptiveClaudeSamplingMiddleware", () => {
	const transform = createAdaptiveClaudeSamplingMiddleware().transformParams;

	it("returns the same params object when nothing needs dropping", async () => {
		const params = { prompt: [], maxOutputTokens: 10 } as never;
		expect(
			await transform?.({ params, type: "generate", model: {} as never }),
		).toBe(params);
	});

	it("keeps every other call option", async () => {
		const params = {
			prompt: [],
			maxOutputTokens: 10,
			seed: 3,
			...SAMPLING,
		} as never;
		expect(
			await transform?.({ params, type: "stream", model: {} as never }),
		).toEqual({ prompt: [], maxOutputTokens: 10, seed: 3 });
	});
});
