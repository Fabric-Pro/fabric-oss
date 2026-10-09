/**
 * Rotation between ChatGPT plans inside one model call (Fizzy #2770), with
 * the real selector, plan model and plan fetch; only OpenAI is simulated, by
 * the 429 `subscription_sharing_usage_limit_exceeded` a spent plan answers.
 *
 * - A spent shared account hands the call to the next one, silently; the
 *   usage row names the account that answered and the spent one stays
 *   closed for every process.
 * - A member's own plan spent mid-call hands it to a shared account that
 *   serves people.
 * - A sign-in rejected mid-call never rotates.
 * - A plan spent after output started ends the stream with
 *   `PlanSourceRotatedError` while another plan remains, and with
 *   `SubscriptionPlanExhaustedError` when none does.
 */

import {
	PlanSourceRotatedError,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
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
	ownUse: null as null | {
		includeBackgroundJobs: boolean;
		credentialStatus: "ACTIVE" | "NEEDS_RECONNECT";
	},
	accounts: [] as Account[],
	usage: new Map<string, number>(),
	rows: new Map<string, { openUntil: Date | null; resetAt: Date | null }>(),
	logUsage: vi.fn(),
	limits: vi.fn(),
	authFailure: null as Error | null,
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
	getActiveChatGptPlanOrgUse: async () => state.ownUse,
	hasDeclinedChatGptPlanInOrganization: async () => false,
	getChatGptPlanOrgPolicy: async () => ({
		poolingEnabled: true,
		apiFallbackInteractive: "ASK",
		apiFallbackBackground: "NEVER",
		headroomPct: 40,
		termsAcknowledgedById: "owner_1",
		termsAcknowledgedAt: new Date("2026-10-01T00:00:00Z"),
	}),
	getCachedChatGptPlanOrgPolicy: async () => ({
		poolingEnabled: true,
		apiFallbackInteractive: "ASK",
		apiFallbackBackground: "NEVER",
		headroomPct: 40,
		termsAcknowledgedById: "owner_1",
		termsAcknowledgedAt: new Date("2026-10-01T00:00:00Z"),
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
						outputTokens: 0,
						resetsAt: null,
					},
				]),
		),
	getChatGptPlanWindowBudget: async () => 750_000,
	getChatGptPlanWindowBudgets: async (_kind: string, ids: string[]) =>
		new Map(ids.map((id) => [id, 750_000])),
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
		state.rows.set(`${input.sourceKind}:${input.sourceId}`, {
			openUntil: input.openUntil,
			resetAt: input.resetAt,
		});
	},
	clearChatGptPlanSourceState: async () => {},
	getUserModelPreference: async () => null,
	getModelForTask: async () => null,
	touchChatGptPlanCredential: async () => {},
	touchChatGptPlanOrgAccount: async () => {},
	logAiUsageAsync: state.logUsage,
	recordAudit: vi.fn(),
}));

// Each source's access token names it, so the simulated OpenAI can tell
// which plan a request is billed to.
vi.mock("../lib/chatgpt-plan/plan-credentials", () => {
	const token = (name: string) => {
		if (state.authFailure) {
			throw state.authFailure;
		}
		return {
			accessToken: name,
			expiresAt: new Date(Date.now() + 3_600_000),
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

const SPENT = {
	code: "subscription_sharing_usage_limit_exceeded",
	message: "Usage limit reached",
};

const refusedSpent = () =>
	new Response(JSON.stringify({ error: SPENT }), {
		status: 429,
		headers: { "content-type": "application/json" },
	});

const spentMidReply = () =>
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
			delta: "Half an",
		},
		{
			type: "response.failed",
			response: { ...response([], "failed"), error: SPENT },
		},
	]);

/** OpenAI, simulated per plan: `replies[token]` answers that plan's calls. */
function openai(replies: Record<string, () => Response>) {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: unknown, init?: RequestInit) => {
			const token =
				new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
			calls.push(token);
			const reply = replies[token];
			if (!reply) {
				throw new Error(`unexpected plan ${token}`);
			}
			return reply();
		}),
	);
	return calls;
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
	state.ownUse = null;
	state.accounts = [account("acc_A"), account("acc_B")];
	state.usage = new Map([
		["acc_A", 10],
		["acc_B", 20],
	]);
	state.rows = new Map();
	state.authFailure = null;
	state.limits.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("rotation before any output", () => {
	it("moves a spent shared account's call to the next one, logging the account that answered", async () => {
		const calls = openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("From B"),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const result = await generateText({
			model: resolved.model,
			prompt: "Hi",
		});

		expect(result.text).toBe("From B");
		expect(calls).toEqual(["org:acc_A", "org:acc_B"]);
		// A rotation before any output writes exactly one row (Fizzy #2972 AC3).
		expect(state.logUsage).toHaveBeenCalledTimes(1);
		expect(state.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "OPENAI_CHATGPT_PLAN",
				providerConfigId: "acc_B",
			}),
		);
		// Closed for every process, through the shared state.
		expect(state.rows.get("ORG:acc_A")?.openUntil).toBeInstanceOf(Date);
		expect(state.limits).toHaveBeenCalledWith(
			expect.objectContaining({ providerConfigId: "acc_A" }),
		);
	});

	it("sends the next call straight to the open account, from the shared state, after a cache clear", async () => {
		openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("From B"),
		});
		const first = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await generateText({ model: first.model, prompt: "Hi" });

		__resetChatGptPlanBreaker();
		const calls = openai({ "org:acc_B": () => answered("Again B") });
		const next = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await expect(
			generateText({ model: next.model, prompt: "Hi" }),
		).resolves.toMatchObject({ text: "Again B" });
		expect(calls).toEqual(["org:acc_B"]);
	});

	it("moves a member's own plan, spent mid-call, to a shared account that serves people", async () => {
		state.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		const calls = openai({
			"user:user_1": refusedSpent,
			"org:acc_A": () => answered("From the shared plan"),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const result = await generateText({
			model: resolved.model,
			prompt: "Hi",
		});

		expect(result.text).toBe("From the shared plan");
		expect(calls).toEqual(["user:user_1", "org:acc_A"]);
		// The status the shell's warning reads now sees the own plan spent.
		expect(state.rows.get("USER:user_1")?.openUntil).toBeInstanceOf(Date);
		expect(state.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({ providerConfigId: "acc_A" }),
		);
	});

	it("fails with SubscriptionPlanExhaustedError once every plan is spent", async () => {
		openai({ "org:acc_A": refusedSpent, "org:acc_B": refusedSpent });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SubscriptionPlanExhaustedError);
		// Only the failed attempt is recorded; nothing was served.
		expect(state.logUsage).not.toHaveBeenCalledWith(
			expect.objectContaining({ success: true }),
		);
	});

	it("stops, without going round, when the member's own plan and every shared account are spent", async () => {
		state.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		const calls = openai({
			"user:user_1": refusedSpent,
			"org:acc_A": refusedSpent,
			"org:acc_B": refusedSpent,
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(calls).toEqual(["user:user_1", "org:acc_A", "org:acc_B"]);
	});

	it("checks the usage limits of the account it moves to, and stops there when one is reached", async () => {
		const calls = openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("must not run"),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const limitReached = new Error("token limit reached for this account");
		state.limits.mockImplementation(
			async (input: { providerConfigId: string | null }) => {
				if (input.providerConfigId === "acc_B") {
					throw limitReached;
				}
			},
		);
		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
		}).catch((caught: unknown) => caught);
		expect(error).toBe(limitReached);
		expect(calls).toEqual(["org:acc_A"]);
		expect(state.limits).toHaveBeenLastCalledWith(
			expect.objectContaining({ providerConfigId: "acc_B" }),
		);
	});

	it("never rotates away from a sign-in rejected mid-call", async () => {
		state.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		const calls = openai({ "org:acc_A": () => answered("must not run") });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		state.authFailure = new ChatGptPlanAuthError(
			"Reconnect",
			"needs_reconnect",
			true,
		);
		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ChatGptPlanAuthError);
		expect(calls).toEqual([]);
	});
});

describe("a plan spent after output started", () => {
	async function streamErrors() {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const errors: unknown[] = [];
		const result = streamText({
			model: resolved.model,
			prompt: "Hi",
			onError: ({ error }) => {
				errors.push(error);
			},
		});
		await result.consumeStream();
		return errors;
	}

	it("ends the stream with PlanSourceRotatedError while another plan remains", async () => {
		openai({ "org:acc_A": spentMidReply });
		const errors = await streamErrors();
		const rotated = errors.find(
			(error) => error instanceof PlanSourceRotatedError,
		);
		expect(rotated).toBeInstanceOf(PlanSourceRotatedError);
		expect((rotated as Error).message).toBe(
			"The ChatGPT plan ran out mid-reply. Send your message again to continue on another plan.",
		);
		expect(state.rows.get("ORG:acc_A")?.openUntil).toBeInstanceOf(Date);

		// The retry lands on the next plan.
		const calls = openai({ "org:acc_B": () => answered("From B") });
		const retry = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await expect(
			generateText({ model: retry.model, prompt: "Hi" }),
		).resolves.toMatchObject({ text: "From B" });
		expect(calls).toEqual(["org:acc_B"]);

		// Fizzy #2972 AC3: the cut-off attempt is a failed row and the retry a
		// successful one; usage totals count the success only.
		const rows = state.logUsage.mock.calls.map(
			(call: unknown[]) =>
				call[0] as { success?: boolean; providerConfigId?: string },
		);
		expect(rows.filter((row) => row.success !== false)).toEqual([
			expect.objectContaining({ providerConfigId: "acc_B" }),
		]);
		expect(rows.filter((row) => row.success === false)).toEqual([
			expect.objectContaining({ providerConfigId: "acc_A" }),
		]);
	});

	it("ends it with SubscriptionPlanExhaustedError when no plan remains", async () => {
		state.accounts = [account("acc_A")];
		openai({ "org:acc_A": spentMidReply });
		const errors = await streamErrors();
		expect(
			errors.some(
				(error) => error instanceof SubscriptionPlanExhaustedError,
			),
		).toBe(true);
	});
});
