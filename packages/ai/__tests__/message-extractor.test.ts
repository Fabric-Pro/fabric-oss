/**
 * Message Extractor Tests
 *
 * Unit tests for extractRelevantExcerpts. The extractor is the primary
 * mechanism that keeps Teams/Slack-style integration tool responses inside
 * the model's context budget, so the critical invariants are:
 *
 * 1. It never returns more than `maxExcerpts` entries.
 * 2. Each excerpt's text is HTML-stripped and length-capped.
 * 3. On LLM error / timeout / bad JSON, it falls back to a deterministic
 *    reducer (top-N by createdAt, char-capped) — it must NEVER leak the
 *    raw payload.
 * 4. Unknown messageIds returned by the LLM are dropped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/database BEFORE the module graph loads anything that reaches
// the AI SDK's provider loaders.
vi.mock("@repo/database", () => ({
	db: {},
	getAiProviderApiKey: vi.fn(),
	getAiProviderApiKeyByProvider: vi.fn(),
	logAiUsageAsync: vi.fn(),
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY"] as const,
	DIRECT_PROVIDERS: ["ANTHROPIC_DIRECT"] as const,
	AI_PROVIDER_METADATA: {},
}));

vi.mock("@repo/payments", () => ({
	trackMeterEvent: vi.fn(),
}));

const generateObjectMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importActual) => {
	const actual = await importActual<typeof import("ai")>();
	return {
		...actual,
		generateObject: generateObjectMock,
	};
});

vi.mock("../lib/dynamic-model-selector", () => ({
	getAIModelWithMetadata: vi.fn().mockResolvedValue({
		model: { id: "stub" } as unknown,
		metadata: {
			provider: "VERCEL_GATEWAY",
			model: "stub/simple",
			billingMode: "external_byok",
		},
		trackUsage: vi.fn(),
	}),
}));

vi.mock("../lib/usage-logging", () => ({
	logModelUsageAsync: vi.fn(),
}));

import { extractRelevantExcerpts } from "../lib/message-extractor";

const HUGE = `<p>${"a".repeat(50_000)}</p>`;

function raw(count: number) {
	const now = Date.now();
	return Array.from({ length: count }, (_, i) => ({
		messageId: `m${i}`,
		from: `user${i}`,
		createdAt: new Date(now - i * 60_000).toISOString(),
		webLink: `https://teams/m${i}`,
		content:
			i % 3 === 0
				? HUGE
				: `<div>Message body number ${i} about <b>feature F-042</b></div>`,
	}));
}

describe("extractRelevantExcerpts", () => {
	beforeEach(() => {
		generateObjectMock.mockReset();
	});

	it("returns empty for empty input without calling the model", async () => {
		const res = await extractRelevantExcerpts({
			rawMessages: [],
			query: "anything",
			userId: "u",
		});
		expect(res.excerpts).toEqual([]);
		expect(res.returned).toBe(0);
		expect(res.fallback).toBe(false);
		expect(generateObjectMock).not.toHaveBeenCalled();
	});

	it("short-circuits when the raw payload already fits the budget", async () => {
		const rawMessages = [
			{
				messageId: "a",
				from: "u1",
				createdAt: new Date().toISOString(),
				webLink: "l1",
				content: "hello world",
			},
			{
				messageId: "b",
				from: "u2",
				createdAt: new Date().toISOString(),
				webLink: "l2",
				content: "<p>short message</p>",
			},
		];
		const res = await extractRelevantExcerpts({
			rawMessages,
			query: "anything",
			userId: "u",
			maxExcerpts: 8,
			maxCharsPerExcerpt: 400,
		});
		expect(generateObjectMock).not.toHaveBeenCalled();
		expect(res.fallback).toBe(false);
		expect(res.returned).toBe(2);
		expect(res.excerpts.map((e) => e.messageId).sort()).toEqual(["a", "b"]);
	});

	it("respects maxExcerpts and caps each excerpt at maxCharsPerExcerpt", async () => {
		generateObjectMock.mockResolvedValue({
			object: {
				excerpts: raw(20).map((m, i) => ({
					messageId: m.messageId,
					from: m.from,
					createdAt: m.createdAt,
					webLink: m.webLink,
					excerpt: "x".repeat(5_000),
					relevance: 1 - i / 100,
				})),
			},
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});

		const res = await extractRelevantExcerpts({
			rawMessages: raw(20),
			query: "F-042",
			userId: "u",
			maxExcerpts: 8,
			maxCharsPerExcerpt: 400,
		});

		expect(res.excerpts.length).toBeLessThanOrEqual(8);
		for (const e of res.excerpts) {
			expect(e.excerpt.length).toBeLessThanOrEqual(401); // 400 + ellipsis
		}
		expect(res.fallback).toBe(false);
	});

	it("drops excerpts with unknown messageIds", async () => {
		generateObjectMock.mockResolvedValue({
			object: {
				excerpts: [
					{
						messageId: "nope",
						from: "ghost",
						createdAt: null,
						webLink: null,
						excerpt: "should be dropped",
						relevance: 1,
					},
					{
						messageId: "m1",
						from: "user1",
						createdAt: null,
						webLink: null,
						excerpt: "kept",
						relevance: 0.9,
					},
				],
			},
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});

		const res = await extractRelevantExcerpts({
			rawMessages: raw(5),
			query: "x",
			userId: "u",
		});
		expect(res.excerpts.map((e) => e.messageId)).toEqual(["m1"]);
	});

	it("falls back to deterministic reducer when the LLM throws", async () => {
		generateObjectMock.mockRejectedValue(new Error("provider 500"));
		const input = raw(12);

		const res = await extractRelevantExcerpts({
			rawMessages: input,
			query: "anything",
			userId: "u",
			maxExcerpts: 5,
			maxCharsPerExcerpt: 100,
		});

		expect(res.fallback).toBe(true);
		expect(res.excerpts.length).toBe(5);
		// All excerpts must be HTML-stripped and char-capped
		for (const e of res.excerpts) {
			expect(e.excerpt).not.toContain("<");
			expect(e.excerpt.length).toBeLessThanOrEqual(101);
			expect(e.relevance).toBeNull();
		}
	});

	it("falls back when the LLM returns malformed output (Zod rejects)", async () => {
		generateObjectMock.mockRejectedValue(
			new Error("Expected object, got undefined at .excerpts"),
		);

		const res = await extractRelevantExcerpts({
			rawMessages: raw(4),
			query: "anything",
			userId: "u",
			maxExcerpts: 3,
			maxCharsPerExcerpt: 50,
		});
		expect(res.fallback).toBe(true);
		expect(res.excerpts.length).toBeLessThanOrEqual(3);
	});

	it("falls back when the LLM call times out", async () => {
		// Simulate a hang that exceeds the timeout.
		generateObjectMock.mockImplementation(
			async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
				await new Promise((resolve, reject) => {
					if (abortSignal) {
						abortSignal.addEventListener("abort", () =>
							reject(new Error("aborted")),
						);
					}
					setTimeout(resolve, 10_000);
				});
				return {
					object: { excerpts: [] },
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				};
			},
		);

		const res = await extractRelevantExcerpts({
			rawMessages: raw(3),
			query: "x",
			userId: "u",
			timeoutMs: 10,
		});
		expect(res.fallback).toBe(true);
	});
});
