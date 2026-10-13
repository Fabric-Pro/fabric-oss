/**
 * `POST /api/ai/generate` writes no usage row of its own.
 *
 * The model `getAIModelWithMetadata` returns records one `AiUsageLog` row per
 * provider call (the usage-logging middleware in `@repo/ai`), so a route row
 * on top of it counted each call twice in usage reports, estimated cost and
 * the token and cost usage limits (Fizzy #2913).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (args: unknown) => getSession(args) } },
}));

// Every AiUsageLog write attempt, whichever writer made it: the route's own,
// or the one row the resolved model's usage-logging middleware writes for each
// call. The `streamText` mock below stands in for that middleware row, so these
// tests prove the route adds no write of its own; that the resolver really
// wraps its models is a separate contract (Fizzy #2915).
const usageRows: unknown[] = [];
const recordUsageRow = async (row: unknown) => {
	usageRows.push(row);
};
vi.mock("@repo/database", () => ({
	logAiUsage: recordUsageRow,
	logAiUsageAsync: recordUsageRow,
}));

const getAIModelWithMetadata = vi.fn();
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		getAIModelWithMetadata(...args),
}));

const streamText = vi.fn();
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: (...args: unknown[]) => streamText(...args),
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class extends Error {},
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// `after` needs a live request scope; run the callback inline so any usage
// row deferred through it is counted.
vi.mock("next/server", () => ({
	after: (fn: () => unknown) => {
		fn();
	},
}));

const { POST } = await import("../route");

const USER_ID = "user-1";
const ACTIVE_ORG = "org-active";
const RESOLVED_MODEL = { id: "stub-model" };

function generate() {
	return POST(
		new Request("http://localhost/api/ai/generate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "Write a haiku" }),
		}) as never,
	);
}

/** The model's own row for one provider call, as its middleware writes it. */
function recordModelCallRow(model: unknown, success: boolean) {
	if (model !== RESOLVED_MODEL) {
		throw new Error("streamText was not given the resolved model");
	}
	usageRows.push({ source: "model", success });
}

beforeEach(() => {
	vi.clearAllMocks();
	usageRows.length = 0;
	getSession.mockResolvedValue({
		user: { id: USER_ID },
		session: { activeOrganizationId: ACTIVE_ORG },
	});
	getAIModelWithMetadata.mockResolvedValue({
		model: RESOLVED_MODEL,
		metadata: {
			modelString: "stub-model",
			provider: "OPENAI_DIRECT",
			canonicalName: "stub",
			billingMode: "external_provider",
		},
		trackUsage: () => {},
	});
	streamText.mockImplementation((options: { model: unknown }) => {
		recordModelCallRow(options.model, true);
		return {
			textStream: (async function* () {
				yield "Hello";
			})(),
			usage: Promise.resolve({
				inputTokens: 1,
				outputTokens: 1,
				totalTokens: 2,
			}),
		};
	});
});

describe("POST /api/ai/generate — usage logging", () => {
	it("writes no usage row of its own beside the model's row for a successful call", async () => {
		const res = await generate();

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ text: "Hello" });
		expect(usageRows).toEqual([{ source: "model", success: true }]);
	});

	it("writes no usage row of its own beside the model's row when the model call fails", async () => {
		// The provider fails mid-stream, as the route reads the text.
		streamText.mockImplementation((options: { model: unknown }) => {
			recordModelCallRow(options.model, false);
			return {
				textStream: (async function* () {
					yield "partial";
					throw new Error("provider unavailable");
				})(),
				usage: new Promise(() => {}),
				finishReason: new Promise(() => {}),
			};
		});

		const res = await generate();

		expect(res.status).toBe(500);
		expect(usageRows).toEqual([{ source: "model", success: false }]);
	});

	it("resolves the model for the session's organization with per-call usage logging", async () => {
		await generate();

		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			expect.not.objectContaining({ usageLogging: "aggregate" }),
			{ userId: USER_ID, organizationId: ACTIVE_ORG, planEligible: true },
		);
	});
});

describe("POST /api/ai/generate — usage limit reached during the stream", () => {
	it("answers 429 AI_USAGE_LIMIT_EXCEEDED when the model's request is refused on an SDK retry", async () => {
		const actual = await vi.importActual<typeof import("ai")>("ai");
		const { MockLanguageModelV4 } = await import("ai/test");
		const { AiUsageLimitExceededError } = await import(
			"@repo/payments/lib/ai-usage-limit-error"
		);
		const { wrapModelWithUsageLimits } = await import(
			"@repo/ai/lib/usage-limit-middleware"
		);
		const limit = new AiUsageLimitExceededError({
			message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
			limitId: "limit-1",
			dimension: "TOKENS" as never,
			window: "MONTHLY" as never,
			used: BigInt(100),
			max: BigInt(100),
			manageLimitsUrl: "https://example.com/limits",
		});
		// The provider fails retryably; the SDK's retry is then refused by the
		// per-request limit check, so the stream's error is a RetryError.
		const provider = new MockLanguageModelV4({
			doStream: async () => {
				throw new actual.APICallError({
					message: "provider overloaded",
					url: "https://provider.example.com/v1",
					requestBodyValues: {},
					statusCode: 503,
					isRetryable: true,
				});
			},
		});
		let checks = 0;
		const model = wrapModelWithUsageLimits(provider, async () => {
			checks += 1;
			if (checks > 1) {
				throw limit;
			}
		});
		getAIModelWithMetadata.mockResolvedValue({
			model,
			metadata: {
				modelString: "stub-model",
				provider: "OPENAI_DIRECT",
				canonicalName: "stub",
				billingMode: "external_provider",
			},
			trackUsage: () => {},
		});
		streamText.mockImplementation(
			(options: Parameters<typeof actual.streamText>[0]) =>
				actual.streamText(options),
		);

		const res = await generate();

		expect(res.status).toBe(429);
		await expect(res.json()).resolves.toEqual({
			error: limit.message,
			code: "AI_USAGE_LIMIT_EXCEEDED",
			data: {
				limitId: "limit-1",
				dimension: "TOKENS",
				window: "MONTHLY",
				used: "100",
				max: "100",
				manageLimitsUrl: "https://example.com/limits",
			},
		});
		expect(provider.doStreamCalls).toHaveLength(1);
	});
});
