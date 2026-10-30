/**
 * The Test button on a ChatGPT plan (Fizzy #2770), with the real model
 * resolution, plan model, breaker and plan fetch; only OpenAI and the stored
 * sign-in are simulated.
 *
 * - A plan that answers reports the light model it ran on and how long it
 *   took, and its usage row is tagged `chatgpt-plan-test`.
 * - A refused sign-in reads as "needs reconnect".
 * - A spent window reads as "spent" with its reset time, is remembered by the
 *   breaker as a real call's would be, and the next test answers from it
 *   without a request.
 * - Any other refusal reads as an error with the provider's reason.
 * - The test answers only once the plan's reported usage is stored, so the
 *   card it refreshes shows the report rather than the estimate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	rows: new Map<string, { openUntil: Date | null; resetAt: Date | null }>(),
	logUsage: vi.fn(),
	recordExhausted: vi.fn(),
	authFailure: null as Error | null,
	recordReported: vi.fn(async (_input: unknown) => true),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	CHATGPT_PLAN_LABEL_SUFFIX: " (ChatGPT plan)",
	DEFAULT_CHATGPT_PLAN_FALLBACK_MODEL: "gpt-6-astra",
	getCachedChatGptPlanOrgPolicy: async () => ({ fallbackModel: null }),
	getModelForTask: async () => null,
	getProviderModelIdForCanonical: async () => null,
	getChatGptPlanServedModels: async () => [],
	ensureChatGptPlanCatalogModels: async () => {},
	replaceChatGptPlanServedModels: async () => {},
	listChatGptPlanModels: async () => [
		{
			canonicalName: "gpt-6.1-terra",
			slug: "gpt-6.1-terra",
			displayName: "GPT-6.1 Terra (ChatGPT plan)",
			description: null,
			autoDetected: false,
		},
	],
	getChatGptPlanSourceStates: async (kind: string, ids: string[]) =>
		ids
			.filter((id) => state.rows.has(`${kind}:${id}`))
			.map((id) => ({
				sourceKind: kind,
				sourceId: id,
				consecutiveUnknownResets: 0,
				...state.rows.get(`${kind}:${id}`),
			})),
	recordChatGptPlanSourceExhausted: async (input: {
		sourceKind: string;
		sourceId: string;
		openUntil: Date;
		resetAt: Date | null;
	}) => {
		state.recordExhausted(input);
		state.rows.set(`${input.sourceKind}:${input.sourceId}`, {
			openUntil: input.openUntil,
			resetAt: input.resetAt,
		});
		return true;
	},
	recordChatGptPlanBudgetObservation: async () => true,
	markChatGptPlanSourceAnswered: async () => true,
	getChatGptPlanOrgAccountWindows: async () => new Map(),
	logAiUsageAsync: state.logUsage,
	recordChatGptPlanReportedUsage: (input: unknown) =>
		state.recordReported(input),
}));

vi.mock("../lib/chatgpt-plan/plan-credentials", () => {
	const token = (name: string) => {
		if (state.authFailure) {
			throw state.authFailure;
		}
		return {
			accessToken: name,
			expiresAt: new Date(Date.now() + 3_600_000),
			credentialFingerprint: `sign-in-of-${name}`,
		};
	};
	return {
		getChatGptPlanAccessToken: async (userId: string) =>
			token(`user:${userId}`),
		refreshChatGptPlanAfterUnauthorized: async (userId: string) =>
			token(`user:${userId}`),
		getChatGptPlanSourceAccessToken: async (ref: { accountId: string }) =>
			token(`org:${ref.accountId}`),
		refreshChatGptPlanSourceAfterUnauthorized: async (ref: {
			accountId: string;
		}) => token(`org:${ref.accountId}`),
	};
});

import { __resetChatGptPlanBreaker } from "../lib/chatgpt-plan/exhaustion-breaker";
import { ChatGptPlanAuthError } from "../lib/chatgpt-plan/oauth";
import { testChatGptPlanSource } from "../lib/chatgpt-plan/plan-check";
import { __resetChatGptPlanServedModelProbes } from "../lib/chatgpt-plan/served-models";
import { __resetChatGptPlanWindowCache } from "../lib/chatgpt-plan/window-cache";

function sse(events: object[]): Response {
	return new Response(
		events
			.map(
				(event, index) =>
					`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
			)
			.join(""),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

const message = (text: string) => ({
	type: "message",
	id: "msg_1",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text, annotations: [] }],
});

const response = (output: object[], status = "completed") => ({
	id: "resp_1",
	object: "response",
	created_at: 1_790_000_000,
	status,
	model: "gpt-6.1-terra",
	output,
	incomplete_details: null,
	usage: {
		input_tokens: 12,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: 2,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: 14,
	},
});

const answered = () =>
	sse([
		{ type: "response.created", response: response([], "in_progress") },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: message("OK"),
		},
		{ type: "response.completed", response: response([message("OK")]) },
	]);

const RESET_AT = new Date(
	Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000,
).toISOString();

const refusedSpent = () =>
	new Response(
		JSON.stringify({
			error: {
				code: "subscription_sharing_usage_limit_exceeded",
				message: "Usage limit reached",
				resets_at: RESET_AT,
			},
		}),
		{ status: 429, headers: { "content-type": "application/json" } },
	);

const refusedOther = () =>
	new Response(
		JSON.stringify({
			error: {
				code: "subscription_sharing_user_not_eligible",
				message: "This account cannot use plan access",
			},
		}),
		{ status: 403, headers: { "content-type": "application/json" } },
	);

/** OpenAI, simulated: records each request's plan token and model. */
function openai(reply: () => Response) {
	const calls: Array<{ token: string; model: string }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: unknown, init?: RequestInit) => {
			calls.push({
				token:
					new Headers(init?.headers).get("authorization")?.slice(7) ??
					"",
				model: JSON.parse(String(init?.body)).model,
			});
			return reply();
		}),
	);
	return calls;
}

const OWN = { kind: "user" as const, userId: "user_1" };
const SHARED = {
	kind: "org" as const,
	organizationId: "org_a",
	accountId: "acc_1",
};

const run = (source: typeof OWN | typeof SHARED) =>
	testChatGptPlanSource({
		userId: "user_1",
		organizationId: "org_a",
		source,
	});

beforeEach(() => {
	__resetChatGptPlanBreaker();
	__resetChatGptPlanWindowCache();
	__resetChatGptPlanServedModelProbes();
	vi.clearAllMocks();
	state.recordReported.mockImplementation(async () => true);
	state.rows = new Map();
	state.authFailure = null;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("testChatGptPlanSource", () => {
	it("answers on the plan's light model and tags the usage row", async () => {
		const calls = openai(answered);
		const result = await run(SHARED);

		expect(result).toEqual({
			outcome: "ok",
			model: "gpt-6.1-terra",
			modelName: "GPT-6.1 Terra",
			latencyMs: expect.any(Number),
		});
		expect(calls).toEqual([{ token: "org:acc_1", model: "gpt-6.1-terra" }]);
		expect(state.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				featureKey: "chatgpt-plan-test",
				provider: "OPENAI_CHATGPT_PLAN",
				providerConfigId: "acc_1",
				userId: "user_1",
				organizationId: "org_a",
			}),
		);
	});

	it("tests the member's own plan with their own sign-in", async () => {
		const calls = openai(answered);
		expect((await run(OWN)).outcome).toBe("ok");
		expect(calls.map((call) => call.token)).toEqual(["user:user_1"]);
	});

	it("reads a refused sign-in as needs reconnect, without a request", async () => {
		const calls = openai(answered);
		state.authFailure = new ChatGptPlanAuthError(
			"Your ChatGPT connection needs to be reconnected.",
			"invalid_grant",
			true,
		);
		expect(await run(SHARED)).toEqual({
			outcome: "needs_reconnect",
			message: "Your ChatGPT connection needs to be reconnected.",
		});
		expect(calls).toEqual([]);
	});

	it("reads a missing sign-in as an error, not a reconnect", async () => {
		openai(answered);
		state.authFailure = new ChatGptPlanAuthError(
			"No ChatGPT plan is connected",
			"not_connected",
			true,
		);
		expect(await run(OWN)).toEqual({
			outcome: "error",
			message: "No ChatGPT plan is connected",
		});
	});

	it("reads a spent window as spent until its reset, and the breaker remembers it", async () => {
		const calls = openai(refusedSpent);
		expect(await run(SHARED)).toEqual({
			outcome: "spent",
			resetAt: new Date(RESET_AT),
		});
		expect(state.recordExhausted).toHaveBeenCalledWith(
			expect.objectContaining({ sourceKind: "ORG", sourceId: "acc_1" }),
		);

		// The breaker is open now: the next test answers from it alone.
		const again = await run(SHARED);
		expect(again.outcome).toBe("spent");
		expect(calls).toHaveLength(1);
	});

	it("reads any other refusal as an error with the provider's reason", async () => {
		openai(refusedOther);
		const result = await run(SHARED);
		expect(result.outcome).toBe("error");
		expect(result).toMatchObject({
			message: expect.stringContaining(
				"This account cannot use plan access",
			),
		});
	});

	it("reads a 401 that survives the token refresh as needs reconnect", async () => {
		const calls = openai(
			() =>
				new Response(
					JSON.stringify({
						error: {
							code: "subscription_sharing_invalid_user",
							message: "Invalid user",
						},
					}),
					{
						status: 401,
						headers: { "content-type": "application/json" },
					},
				),
		);
		expect(await run(SHARED)).toEqual({
			outcome: "needs_reconnect",
			message: expect.stringContaining("needs to be reconnected"),
		});
		// One request, one refresh, one retry with the new token: no more.
		expect(calls).toHaveLength(2);
	});

	it("keeps a fault on Fabric's side out of the message", async () => {
		const calls = openai(answered);
		state.authFailure = new Error(
			"Invalid `prisma.chatGptPlanOrgAccount.findFirst()` invocation: connect ECONNREFUSED 10.0.0.5:5432",
		);
		expect(await run(SHARED)).toEqual({
			outcome: "error",
			message: "The ChatGPT plan did not answer the test.",
		});
		expect(calls).toEqual([]);
	});

	it("answers only after the plan's reported usage is stored", async () => {
		let releaseWrite = () => {};
		state.recordReported.mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					releaseWrite = () => resolve(true);
				}),
		);
		openai(() => {
			const reply = answered();
			reply.headers.set("x-codex-primary-used-percent", "37");
			reply.headers.set("x-codex-primary-window-minutes", "300");
			return reply;
		});

		let settled = false;
		const result = run(OWN).then((value) => {
			settled = true;
			return value;
		});
		await vi.waitFor(() =>
			expect(state.recordReported).toHaveBeenCalledWith(
				expect.objectContaining({
					sourceKind: "USER",
					sourceId: "user_1",
					credentialFingerprint: "sign-in-of-user:user_1",
				}),
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);

		releaseWrite();
		await expect(result).resolves.toMatchObject({ outcome: "ok" });
	});
});
