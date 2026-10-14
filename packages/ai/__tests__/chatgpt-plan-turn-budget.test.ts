/**
 * The turn token ledger on the ChatGPT plan path: one attempt per physical
 * send. Through the real selector, plan model, rotation middleware, model
 * fallback and plan fetch (only OpenAI is simulated), with an Advisor chat
 * turn's ledger on the ambient dispatch guard:
 *
 *  - the first send, the send moved to another plan account after a spent
 *    window, and the send moved to the organization's fallback model after
 *    an unsupported-model refusal each reserve before they go out (so each
 *    passes the ledger's admission check) and each settle on their own;
 *  - a send that went out and was refused keeps its charge (UNKNOWN): it
 *    was sent, so it is not provably free;
 *  - an allowance that cannot fit the resend refuses it with the ledger's
 *    own error, and no further plan or model is tried;
 *  - every attempt is MEASURED_ONLY (the plan strips the output cap) and
 *    reserves the output the caller asked for.
 *
 * Before, one reservation surrounded the whole rotating model: the refused
 * first send had no attempt of its own and the resend no admission check.
 */

import {
	type DispatchBudget,
	type DispatchBudgetRequest,
	type DispatchGuard,
	type DispatchRequestSizer,
	runOutsideDispatchGuard,
	runWithDispatchGuard,
	runWithDispatchRequestSizer,
} from "@repo/utils/dispatch-guard";
import { generateText, streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Account = {
	id: string;
	enabled: boolean;
	status: "ACTIVE";
	serveInteractive: boolean;
	serveBackground: boolean;
};

const state = vi.hoisted(() => ({
	accounts: [] as Account[],
	usage: new Map<string, number>(),
	rows: new Map<
		string,
		{
			openUntil: Date | null;
			resetAt: Date | null;
			credentialFingerprint?: string | null;
		}
	>(),
	limits: vi.fn(),
	fallbackModel: null as string | null,
	/** Runs inside the token refresh after a 401, before it resolves. */
	onRefresh: undefined as (() => void) | undefined,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	assertWithinAiUsageLimits: state.limits,
	getTenantAiGatewayBillingState: vi.fn(() => ({
		mode: "external_provider",
		headers: null,
	})),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: vi.fn(),
	getAiProviderApiKeyByProvider: vi.fn(),
	getEmbeddingProviderConfig: vi.fn(),
	getProviderModelIdForCanonical: vi.fn(),
	getSystemAiProviderApiKey: vi.fn(),
	getTaskDefaultModel: vi.fn(),
	updateProviderLastUsed: vi.fn(() => Promise.resolve()),
	isFeatureEnabled: async () => true,
	getActiveChatGptPlanOrgUse: async () => null,
	hasDeclinedChatGptPlanInOrganization: async () => false,
	getChatGptPlanOrgPolicy: async () => ({
		apiFallbackInteractive: "ASK",
		apiFallbackBackground: "NEVER",
		headroomPct: 40,
		termsAcknowledgedById: "owner_1",
		termsAcknowledgedAt: new Date("2026-10-01T00:00:00Z"),
	}),
	getCachedChatGptPlanOrgPolicy: async () => ({
		apiFallbackInteractive: "ASK",
		apiFallbackBackground: "NEVER",
		headroomPct: 40,
		termsAcknowledgedById: "owner_1",
		termsAcknowledgedAt: new Date("2026-10-01T00:00:00Z"),
		fallbackModel: state.fallbackModel,
	}),
	listChatGptPlanOrgAccounts: async () => state.accounts,
	getChatGptPlanOrgAccountWindows: async (params: { accountIds: string[] }) =>
		new Map(
			params.accountIds
				.filter((id) => state.usage.has(id))
				.map((id) => [
					id,
					{
						requests: 1,
						inputTokens: state.usage.get(id),
						weightedInputTokens: state.usage.get(id),
						outputTokens: 0,
						resetsAt: null,
					},
				]),
		),
	getChatGptPlanWindowBudget: async () => 750_000,
	getChatGptPlanWindowBudgets: async (_kind: string, ids: string[]) =>
		new Map(ids.map((id) => [id, 750_000])),
	getChatGptPlanWindowCalibrations: async (_kind: string, ids: string[]) =>
		new Map(ids.map((id) => [id, { budget: 750_000, calibrated: false }])),
	chatGptPlanReportedUsage: () => null,
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
		credentialFingerprint: string | null;
	}) => {
		state.rows.set(`${input.sourceKind}:${input.sourceId}`, {
			openUntil: input.openUntil,
			resetAt: input.resetAt,
			credentialFingerprint: input.credentialFingerprint,
		});
		return true;
	},
	markChatGptPlanSourceAnswered: async () => true,
	getUserModelPreference: async () => null,
	getModelForTask: async () => null,
	touchChatGptPlanCredential: async () => {},
	touchChatGptPlanOrgAccount: async () => {},
	logAiUsageAsync: vi.fn(),
	recordAudit: vi.fn(),
}));

vi.mock("../lib/chatgpt-plan/served-models", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../lib/chatgpt-plan/served-models")
	>()),
	refreshChatGptPlanServedModelsInBackground: vi.fn(),
}));

// Each source's access token names it, so the simulated OpenAI can tell
// which plan a request is billed to.
vi.mock("../lib/chatgpt-plan/plan-credentials", () => {
	const token = (name: string) => ({
		accessToken: name,
		expiresAt: new Date(Date.now() + 3_600_000),
		credentialFingerprint: `sign-in-of-${name}`,
	});
	return {
		getChatGptPlanAccessToken: async (userId: string) =>
			token(`user:${userId}`),
		refreshChatGptPlanAfterUnauthorized: async (userId: string) => {
			await Promise.resolve();
			state.onRefresh?.();
			return token(`user:${userId}`);
		},
		getChatGptPlanSourceAccessToken: async (ref: { accountId: string }) =>
			token(`org:${ref.accountId}`),
		refreshChatGptPlanSourceAfterUnauthorized: async (ref: {
			accountId: string;
		}) => {
			await Promise.resolve();
			state.onRefresh?.();
			return token(`org:${ref.accountId}`);
		},
	};
});

import { __resetChatGptPlanBreaker } from "../lib/chatgpt-plan/exhaustion-breaker";
import { __resetChatGptPlanWindowCache } from "../lib/chatgpt-plan/window-cache";
import { getAIModelWithMetadata } from "../lib/dynamic-model-selector";

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
	model: "gpt-6-astra",
	output,
	incomplete_details: null,
	usage: {
		input_tokens: 10,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: 5,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: 15,
	},
});

const answered = (text: string) =>
	sse([
		{ type: "response.created", response: response([], "in_progress") },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...message(""), status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			delta: text,
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: message(text),
		},
		{ type: "response.completed", response: response([message(text)]) },
	]);

const refusedSpent = () =>
	new Response(
		JSON.stringify({
			error: {
				code: "subscription_sharing_usage_limit_exceeded",
				message: "Usage limit reached",
			},
		}),
		{ status: 429, headers: { "content-type": "application/json" } },
	);

const refusedModel = () =>
	new Response(
		JSON.stringify({
			error: {
				message:
					"The model 'gpt-6.1-sol' is not supported on this plan.",
				code: "model_not_found",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);

/** Every physical send's request body, in order. */
const sentBodies: string[] = [];

/** OpenAI, simulated per plan. Records each physical send as "plan:model". */
function openai(replies: Record<string, (model: string) => Response>) {
	const sends: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: unknown, init?: RequestInit) => {
			const token =
				new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
			const { model } = JSON.parse(String(init?.body ?? "{}")) as {
				model: string;
			};
			sends.push(`${token}:${model}`);
			sentBodies.push(String(init?.body ?? ""));
			const reply = replies[token];
			if (!reply) {
				throw new Error(`unexpected plan ${token}`);
			}
			return reply(model);
		}),
	);
	return sends;
}

class BudgetDenied extends Error {}

/**
 * A recording ledger. `denyFrom` refuses the reservation with that number
 * and every later one, as an exhausted allowance does.
 */
function makeLedger(options: { denyFrom?: number; attemptKind?: string } = {}) {
	const events: string[] = [];
	const requests: DispatchBudgetRequest[] = [];
	let seq = 0;
	const budget: DispatchBudget = {
		attemptKind: options.attemptKind ?? "AUXILIARY",
		reserve: vi.fn(async (request: DispatchBudgetRequest) => {
			seq += 1;
			if (options.denyFrom !== undefined && seq >= options.denyFrom) {
				events.push(`denied:attempt-${seq}`);
				throw new BudgetDenied("the turn has used its token allowance");
			}
			requests.push(request);
			events.push(`reserve:attempt-${seq}`);
			return { attemptId: `attempt-${seq}`, outputCap: null };
		}),
		settle: vi.fn(async (attemptId, usage) => {
			events.push(
				`settle:${attemptId}:${usage.inputTokens}/${usage.outputTokens}`,
			);
		}),
		markUnknown: vi.fn(async (attemptId) => {
			events.push(`unknown:${attemptId}`);
		}),
		release: vi.fn(async (attemptId) => {
			events.push(`release:${attemptId}`);
		}),
	};
	return { budget, events, requests };
}

function turnGuard(budget: DispatchBudget): DispatchGuard {
	return {
		key: "turn-example-1",
		assertDispatchable: async () => undefined,
		abortSignal: () => undefined,
		rethrowIfStopped: () => undefined,
		budget,
	};
}

const account = (id: string): Account => ({
	id,
	enabled: true,
	status: "ACTIVE",
	serveInteractive: true,
	serveBackground: true,
});

const ELIGIBLE = {
	userId: "user_1",
	organizationId: "org_a",
	planEligible: true,
};

beforeEach(() => {
	__resetChatGptPlanWindowCache();
	__resetChatGptPlanBreaker();
	vi.clearAllMocks();
	state.accounts = [account("acc_A"), account("acc_B")];
	state.usage = new Map([
		["acc_A", 10],
		["acc_B", 20],
	]);
	state.rows = new Map();
	state.fallbackModel = null;
	state.onRefresh = undefined;
	state.limits.mockReset();
	sentBodies.length = 0;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function planModel() {
	return (await getAIModelWithMetadata({ taskType: "CHAT" }, ELIGIBLE)).model;
}

describe("a plan account rotation inside a ledgered chat turn", () => {
	it("gives the refused first send and the rotated resend an attempt each: the first stays charged, the second settles", async () => {
		const sends = openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("From B"),
		});
		const { budget, events, requests } = makeLedger();
		const model = await planModel();

		const result = await runWithDispatchGuard(turnGuard(budget), () =>
			generateText({ model, prompt: "Hi", maxOutputTokens: 900 }),
		);

		expect(result.text).toBe("From B");
		expect(sends).toEqual([
			"org:acc_A:gpt-6.1-sol",
			"org:acc_B:gpt-6.1-sol",
		]);
		expect(events).toEqual([
			"reserve:attempt-1",
			"unknown:attempt-1",
			"reserve:attempt-2",
			"settle:attempt-2:10/5",
		]);
		// MEASURED_ONLY, reserving the output the caller asked for (the plan
		// strips the cap from what it sends).
		for (const request of requests) {
			expect(request).toMatchObject({
				modality: "language",
				enforcesOutputCap: false,
				requestedOutputTokens: 900,
			});
		}
	});

	it("does the same for a streamed call", async () => {
		const sends = openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("From B"),
		});
		const { budget, events } = makeLedger();
		const model = await planModel();

		const text = await runWithDispatchGuard(turnGuard(budget), async () => {
			const result = streamText({ model, prompt: "Hi" });
			return result.text;
		});

		expect(text).toBe("From B");
		expect(sends).toHaveLength(2);
		expect(events).toEqual([
			"reserve:attempt-1",
			"unknown:attempt-1",
			"reserve:attempt-2",
			"settle:attempt-2:10/5",
		]);
	});

	it("refuses the resend when the allowance cannot fit it, sends it nowhere, and fails with the ledger's refusal", async () => {
		const sends = openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("must not run"),
		});
		const { budget, events } = makeLedger({ denyFrom: 2 });
		const model = await planModel();

		const outcome = await runWithDispatchGuard(turnGuard(budget), () =>
			generateText({ model, prompt: "Hi", maxRetries: 0 }),
		).then(
			() => "resolved",
			(error: unknown) => error,
		);

		expect(outcome).toBeInstanceOf(BudgetDenied);
		expect(sends).toEqual(["org:acc_A:gpt-6.1-sol"]);
		expect(events).toEqual([
			"reserve:attempt-1",
			"unknown:attempt-1",
			"denied:attempt-2",
		]);
	});
});

describe("the plan's fallback model inside a ledgered chat turn", () => {
	it("gives the refused primary send and the fallback send an attempt each", async () => {
		state.fallbackModel = "gpt-6-astra";
		const sends = openai({
			"org:acc_A": (model) =>
				model === "gpt-6-astra"
					? answered("From the fallback")
					: refusedModel(),
		});
		const { budget, events } = makeLedger();
		const model = await planModel();

		const result = await runWithDispatchGuard(turnGuard(budget), () =>
			generateText({ model, prompt: "Hi", maxRetries: 0 }),
		);

		expect(result.text).toBe("From the fallback");
		expect(sends).toEqual([
			"org:acc_A:gpt-6.1-sol",
			"org:acc_A:gpt-6-astra",
		]);
		expect(events).toEqual([
			"reserve:attempt-1",
			"unknown:attempt-1",
			"reserve:attempt-2",
			"settle:attempt-2:10/5",
		]);
	});

	it("refuses the fallback send when the allowance cannot fit it", async () => {
		state.fallbackModel = "gpt-6-astra";
		const sends = openai({
			"org:acc_A": (model) =>
				model === "gpt-6-astra"
					? answered("must not run")
					: refusedModel(),
		});
		const { budget, events } = makeLedger({ denyFrom: 2 });
		const model = await planModel();

		const outcome = await runWithDispatchGuard(turnGuard(budget), () =>
			generateText({ model, prompt: "Hi", maxRetries: 0 }),
		).then(
			() => "resolved",
			(error: unknown) => error,
		);

		expect(outcome).toBeInstanceOf(BudgetDenied);
		expect(sends).toEqual(["org:acc_A:gpt-6.1-sol"]);
		expect(events).toEqual([
			"reserve:attempt-1",
			"unknown:attempt-1",
			"denied:attempt-2",
		]);
	});
});

/**
 * A request sizer (the Advisor's finalization synthesis) answering each
 * physical send in turn with `sizes`, recording how often it was asked.
 */
function sizerOf(
	sizes: Array<{ text?: string; maxOutputTokens: number } | Error>,
) {
	const asked: number[] = [];
	const sizer: DispatchRequestSizer = async () => {
		asked.push(asked.length + 1);
		const size = sizes[asked.length - 1];
		if (!size) {
			return null;
		}
		if (size instanceof Error) {
			throw size;
		}
		return {
			...(size.text
				? {
						prompt: [
							{
								role: "user",
								content: [{ type: "text", text: size.text }],
							},
						],
					}
				: {}),
			maxOutputTokens: size.maxOutputTokens,
		};
	};
	return { sizer, asked };
}

describe("a sized request on the plan inside a ledgered chat turn", () => {
	it("sizes the rotated resend again and reserves the output the sizer validated for each send", async () => {
		const sends = openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("From B"),
		});
		const { budget, events, requests } = makeLedger({
			attemptKind: "FINALIZATION",
		});
		const { sizer, asked } = sizerOf([
			{ maxOutputTokens: 6_000 },
			{ text: "The bounded request.", maxOutputTokens: 1_500 },
		]);
		const model = await planModel();

		const text = await runWithDispatchGuard(turnGuard(budget), () =>
			runWithDispatchRequestSizer(sizer, async () => {
				const result = streamText({
					model,
					prompt: "The whole conversation.",
					maxOutputTokens: 16_384,
				});
				return result.text;
			}),
		);

		expect(text).toBe("From B");
		expect(sends).toEqual([
			"org:acc_A:gpt-6.1-sol",
			"org:acc_B:gpt-6.1-sol",
		]);
		expect(asked).toEqual([1, 2]);
		expect(requests.map((r) => r.requestedOutputTokens)).toEqual([
			6_000, 1_500,
		]);
		expect(sentBodies[0]).toContain("The whole conversation.");
		expect(sentBodies[1]).toContain("The bounded request.");
		expect(sentBodies[1]).not.toContain("The whole conversation.");
		// The plan still sends no output cap.
		expect(sentBodies[1]).not.toContain("max_output_tokens");
		expect(events).toEqual([
			"reserve:attempt-1",
			"unknown:attempt-1",
			"reserve:attempt-2",
			"settle:attempt-2:10/5",
		]);
	});

	it("sizes the fallback model's send again", async () => {
		state.fallbackModel = "gpt-6-astra";
		const sends = openai({
			"org:acc_A": (model) =>
				model === "gpt-6-astra"
					? answered("From the fallback")
					: refusedModel(),
		});
		const { budget, requests } = makeLedger({
			attemptKind: "FINALIZATION",
		});
		const { sizer, asked } = sizerOf([
			{ maxOutputTokens: 6_000 },
			{ text: "The bounded request.", maxOutputTokens: 1_500 },
		]);
		const model = await planModel();

		const result = await runWithDispatchGuard(turnGuard(budget), () =>
			runWithDispatchRequestSizer(sizer, () =>
				generateText({
					model,
					prompt: "The whole conversation.",
					maxRetries: 0,
				}),
			),
		);

		expect(result.text).toBe("From the fallback");
		expect(sends).toEqual([
			"org:acc_A:gpt-6.1-sol",
			"org:acc_A:gpt-6-astra",
		]);
		expect(asked).toEqual([1, 2]);
		expect(requests.map((r) => r.requestedOutputTokens)).toEqual([
			6_000, 1_500,
		]);
		expect(sentBodies[1]).toContain("The bounded request.");
	});

	it("sends nothing more when the sizer refuses the resend, and fails with its refusal", async () => {
		const sends = openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("must not run"),
		});
		const { budget, events } = makeLedger({ attemptKind: "FINALIZATION" });
		const refusal = new Error("FINALIZATION request does not fit");
		const { sizer } = sizerOf([{ maxOutputTokens: 6_000 }, refusal]);
		const model = await planModel();

		const outcome = await runWithDispatchGuard(turnGuard(budget), () =>
			runWithDispatchRequestSizer(sizer, () =>
				generateText({ model, prompt: "Hi", maxRetries: 0 }),
			),
		).then(
			() => "resolved",
			(error: unknown) => error,
		);

		expect(outcome).toBe(refusal);
		expect(sends).toEqual(["org:acc_A:gpt-6.1-sol"]);
		expect(events).toEqual(["reserve:attempt-1", "unknown:attempt-1"]);
	});
});

describe("a request sizer is bound to the guard that installed it", () => {
	const sizeEverything = () =>
		sizerOf([
			{ text: "A FINALIZATION PROMPT.", maxOutputTokens: 1_500 },
			{ text: "A FINALIZATION PROMPT.", maxOutputTokens: 1_500 },
			{ text: "A FINALIZATION PROMPT.", maxOutputTokens: 1_500 },
		]);

	it("leaves a nested guard's ordinary request alone, and sizes again after the nested scope exits", async () => {
		const sends = openai({ "org:acc_A": () => answered("ok") });
		const outer = makeLedger({ attemptKind: "FINALIZATION" });
		const inner = makeLedger({ attemptKind: "EXPLORATION" });
		const { sizer, asked } = sizeEverything();
		const model = await planModel();

		await runWithDispatchGuard(turnGuard(outer.budget), () =>
			runWithDispatchRequestSizer(sizer, async () => {
				await runWithDispatchGuard(turnGuard(inner.budget), () =>
					generateText({
						model,
						prompt: "NESTED ORDINARY QUESTION",
						maxOutputTokens: 4_000,
						maxRetries: 0,
					}),
				);
				expect(asked).toEqual([]);
				await generateText({
					model,
					prompt: "OUTER WHOLE REQUEST",
					maxRetries: 0,
				});
			}),
		);

		expect(sends).toHaveLength(2);
		expect(sentBodies[0]).toContain("NESTED ORDINARY QUESTION");
		expect(sentBodies[0]).not.toContain("A FINALIZATION PROMPT.");
		expect(inner.requests.map((r) => r.requestedOutputTokens)).toEqual([
			4_000,
		]);
		expect(sentBodies[1]).toContain("A FINALIZATION PROMPT.");
		expect(sentBodies[1]).not.toContain("OUTER WHOLE REQUEST");
		expect(asked).toEqual([1]);
		expect(outer.requests.map((r) => r.requestedOutputTokens)).toEqual([
			1_500,
		]);
	});

	it("does not size a request made outside the guard", async () => {
		openai({ "org:acc_A": () => answered("ok") });
		const outer = makeLedger({ attemptKind: "FINALIZATION" });
		const { sizer, asked } = sizeEverything();
		const model = await planModel();

		await runWithDispatchGuard(turnGuard(outer.budget), () =>
			runWithDispatchRequestSizer(sizer, () =>
				runOutsideDispatchGuard(() =>
					generateText({
						model,
						prompt: "UNGUARDED QUESTION",
						maxRetries: 0,
					}),
				),
			),
		);

		expect(asked).toEqual([]);
		expect(outer.requests).toEqual([]);
		expect(sentBodies[0]).toContain("UNGUARDED QUESTION");
	});

	it("does not size a request its own guard's ledger counts as auxiliary", async () => {
		openai({ "org:acc_A": () => answered("ok") });
		const aux = makeLedger({ attemptKind: "AUXILIARY" });
		const { sizer, asked } = sizeEverything();
		const model = await planModel();

		await runWithDispatchGuard(turnGuard(aux.budget), () =>
			runWithDispatchRequestSizer(sizer, () =>
				generateText({
					model,
					prompt: "AUXILIARY QUESTION",
					maxOutputTokens: 3_000,
					maxRetries: 0,
				}),
			),
		);

		expect(asked).toEqual([]);
		expect(aux.requests.map((r) => r.requestedOutputTokens)).toEqual([
			3_000,
		]);
		expect(sentBodies[0]).toContain("AUXILIARY QUESTION");
	});
});

describe("a plan call with no ledger", () => {
	it("is unchanged outside a chat turn", async () => {
		const sends = openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("From B"),
		});
		const model = await planModel();
		await expect(
			generateText({ model, prompt: "Hi" }),
		).resolves.toMatchObject({ text: "From B" });
		expect(sends).toHaveLength(2);
	});
});

describe("a 401 refresh-and-resend inside a ledgered chat turn", () => {
	const unauthorized = () =>
		new Response(JSON.stringify({ error: { code: "invalid_token" } }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});

	/** acc_A answers 401 to its first send and `then` to every later one. */
	function refusesFirstSend(then: () => Response) {
		let calls = 0;
		return openai({
			"org:acc_A": () => {
				calls += 1;
				return calls === 1 ? unauthorized() : then();
			},
		});
	}

	class TurnStopped extends Error {}

	/**
	 * A turn guard that records each dispatch check and latches a stop
	 * when `stop()` is called, the way the Advisor's turn guard does.
	 */
	function stoppableGuard(budget: DispatchBudget, events: string[]) {
		let stop: TurnStopped | null = null;
		const throwIfStopped = () => {
			if (stop) {
				throw stop;
			}
		};
		const guard: DispatchGuard = {
			key: "turn-example-1",
			assertDispatchable: async () => {
				events.push("dispatch-check");
				throwIfStopped();
			},
			abortSignal: () => undefined,
			rethrowIfStopped: () => throwIfStopped(),
			throwIfStopped,
			budget,
		};
		return {
			guard,
			stop: () => {
				stop = new TurnStopped("the chat turn was stopped");
			},
		};
	}

	it("passes the turn's dispatch check again before the resend, under the one reservation, which settles", async () => {
		const sends = refusesFirstSend(() => answered("After refresh"));
		const { budget, events } = makeLedger();
		const { guard } = stoppableGuard(budget, events);
		state.onRefresh = () => events.push("refresh");
		state.accounts = [account("acc_A")];
		const model = await planModel();

		const result = await runWithDispatchGuard(guard, () =>
			generateText({ model, prompt: "Hi", maxRetries: 0 }),
		);

		expect(result.text).toBe("After refresh");
		expect(sends).toEqual([
			"org:acc_A:gpt-6.1-sol",
			"org:acc_A:gpt-6.1-sol",
		]);
		// One reservation for the one billed send (a 401 consumes nothing);
		// the resend is checked again after the refresh, before it goes out.
		expect(events).toEqual([
			"dispatch-check",
			"reserve:attempt-1",
			"refresh",
			"dispatch-check",
			"settle:attempt-1:10/5",
		]);
	});

	it("does not resend when the turn stops during the token refresh, and fails with the stop", async () => {
		const sends = refusesFirstSend(() => answered("must not run"));
		const { budget, events } = makeLedger();
		const { guard, stop } = stoppableGuard(budget, events);
		state.onRefresh = stop;
		state.accounts = [account("acc_A")];
		const model = await planModel();

		const outcome = await runWithDispatchGuard(guard, () =>
			generateText({ model, prompt: "Hi", maxRetries: 0 }),
		).then(
			() => "resolved",
			(error: unknown) => error,
		);

		expect(outcome).toBeInstanceOf(TurnStopped);
		expect(sends).toEqual(["org:acc_A:gpt-6.1-sol"]);
		// The resend's dispatch check refuses it. No second reservation; the
		// one attempt stays charged.
		expect(events).toEqual([
			"dispatch-check",
			"reserve:attempt-1",
			"dispatch-check",
			"unknown:attempt-1",
		]);
	});

	it("does not resend when the stop latches after the dispatch check passed, immediately before the send", async () => {
		const sends = refusesFirstSend(() => answered("must not run"));
		const { budget, events } = makeLedger();
		const { guard, stop } = stoppableGuard(budget, events);
		state.accounts = [account("acc_A")];
		// The resend's durable check passes; the stop latches in the
		// continuation right after it, before the send.
		let checks = 0;
		const check = guard.assertDispatchable;
		guard.assertDispatchable = async () => {
			await check();
			checks += 1;
			if (checks === 2) {
				queueMicrotask(stop);
			}
		};
		const model = await planModel();

		const outcome = await runWithDispatchGuard(guard, () =>
			generateText({ model, prompt: "Hi", maxRetries: 0 }),
		).then(
			() => "resolved",
			(error: unknown) => error,
		);

		expect(outcome).toBeInstanceOf(TurnStopped);
		expect(sends).toEqual(["org:acc_A:gpt-6.1-sol"]);
	});
});
