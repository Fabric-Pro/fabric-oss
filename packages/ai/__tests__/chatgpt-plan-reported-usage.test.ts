/**
 * The plan's own usage report (Fizzy #2770): the `x-codex-*` rate-limit
 * headers Codex reads from the ChatGPT plan backend are parsed by Codex's
 * rules, stored per source bound to the sign-in that made the call, compared
 * with Fabric's estimate on shared accounts, and ignored when absent.
 */
import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));

const db = vi.hoisted(() => ({
	reportedWrites: [] as Array<Record<string, unknown>>,
	accuracyWrites: [] as Array<Record<string, unknown>>,
	stored: true,
	window: {
		windowStart: new Date("2026-10-12T08:00:00Z") as Date | null,
		weightedInputTokens: 500_000,
	},
	budget: 2_000_000,
	settled: [] as unknown[],
}));

vi.mock("@repo/logs", () => ({ logger }));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		sortChatGptPlanReportedLimits: actual.sortChatGptPlanReportedLimits,
		chatGptPlanWindowPercentUncapped:
			actual.chatGptPlanWindowPercentUncapped,
		chatGptPlanReportedUsage: () => null,
		getChatGptPlanSourceStates: async () => [],
		recordChatGptPlanSourceExhausted: async () => true,
		markChatGptPlanSourceAnswered: async () => true,
		getChatGptPlanOrgAccountWindows: async (params: {
			accountIds: string[];
		}) => new Map(params.accountIds.map((id) => [id, db.window])),
		getChatGptPlanWindowCalibrations: async (_k: string, ids: string[]) =>
			new Map(
				ids.map((id) => [id, { budget: db.budget, calibrated: false }]),
			),
		recordChatGptPlanReportedUsage: async (
			input: Record<string, unknown>,
		) => {
			db.reportedWrites.push(input);
			return db.stored;
		},
		recordChatGptPlanReportedAccuracy: async (
			input: Record<string, unknown> & {
				estimatePercent: number;
				reportedPercent: number;
			},
		) => {
			db.accuracyWrites.push(input);
			return Math.abs(input.estimatePercent - input.reportedPercent);
		},
		settleChatGptPlanAccountWindows: async () => db.settled,
		getUserModelPreference: vi.fn(),
		getModelForTask: vi.fn(),
	};
});

vi.mock("../lib/chatgpt-plan/plan-credentials", () => ({
	getChatGptPlanAccessToken: async () => ({
		accessToken: "access-1",
		expiresAt: new Date(Date.now() + 3_600_000),
		credentialFingerprint: "fp-own",
	}),
	refreshChatGptPlanAfterUnauthorized: vi.fn(),
}));

import { CHATGPT_PLAN_HEAVY_MODEL } from "../lib/chatgpt-plan/models";
import { createChatGptPlanModel } from "../lib/chatgpt-plan/provider";
import {
	__resetChatGptPlanReportedUsage,
	noteChatGptPlanReportedUsage,
	parseChatGptPlanRateLimitHeaders,
	settleChatGptPlanWindowsInBackground,
} from "../lib/chatgpt-plan/reported-usage";
import { __resetChatGptPlanWindowCache } from "../lib/chatgpt-plan/window-cache";

const NOW = Date.parse("2026-10-12T10:00:00Z");
const RESET_SECONDS = Math.floor(NOW / 1000) + 3 * 3600;

const account = {
	kind: "org" as const,
	organizationId: "org_a",
	accountId: "acc_1",
};

function codexHeaders(primary: number, extra: Record<string, string> = {}) {
	return new Headers({
		"x-codex-primary-used-percent": String(primary),
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-at": String(RESET_SECONDS),
		"x-codex-secondary-used-percent": "22",
		"x-codex-secondary-window-minutes": "10080",
		...extra,
	});
}

const reply = (headers: Headers, status = 200) => ({
	status,
	headers,
	credentialFingerprint: "fp-1",
});

beforeEach(() => {
	vi.clearAllMocks();
	__resetChatGptPlanReportedUsage();
	__resetChatGptPlanWindowCache();
	db.reportedWrites = [];
	db.accuracyWrites = [];
	db.stored = true;
	db.window = {
		windowStart: new Date("2026-10-12T08:00:00Z"),
		weightedInputTokens: 500_000,
	};
	db.budget = 2_000_000;
	db.settled = [];
});

describe("parseChatGptPlanRateLimitHeaders", () => {
	it("reads both limits as Codex does, reset-at in epoch seconds", () => {
		expect(
			parseChatGptPlanRateLimitHeaders(codexHeaders(12.5), NOW),
		).toEqual({
			primary: {
				usedPercent: 12.5,
				windowMinutes: 300,
				resetsAt: new Date(RESET_SECONDS * 1000),
			},
			secondary: {
				usedPercent: 22,
				windowMinutes: 10080,
				resetsAt: null,
			},
		});
	});

	it("accepts a relative reset when no absolute one is sent", () => {
		const parsed = parseChatGptPlanRateLimitHeaders(
			new Headers({
				"x-codex-primary-used-percent": "40",
				"x-codex-primary-reset-after-seconds": "600",
			}),
			NOW,
		);
		expect(parsed?.primary?.resetsAt).toEqual(new Date(NOW + 600_000));
	});

	it("reports nothing when the headers are absent, unparseable or empty of data", () => {
		expect(parseChatGptPlanRateLimitHeaders(new Headers(), NOW)).toBeNull();
		expect(
			parseChatGptPlanRateLimitHeaders(
				new Headers({ "x-codex-primary-used-percent": "lots" }),
				NOW,
			),
		).toBeNull();
		// Codex's rule: 0% with no window and no reset says nothing.
		expect(
			parseChatGptPlanRateLimitHeaders(
				new Headers({ "x-codex-primary-used-percent": "0" }),
				NOW,
			),
		).toBeNull();
	});
});

describe("noteChatGptPlanReportedUsage", () => {
	it("stores the report bound to the sign-in that made the call", async () => {
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(40)),
			NOW,
		);
		expect(db.reportedWrites).toEqual([
			expect.objectContaining({
				sourceKind: "ORG",
				sourceId: "acc_1",
				credentialFingerprint: "fp-1",
				observedAt: new Date(NOW),
				limits: expect.objectContaining({
					primary: expect.objectContaining({ usedPercent: 40 }),
				}),
			}),
		]);
	});

	it("stores nothing for a reply without the headers, or from an unknown sign-in", async () => {
		await noteChatGptPlanReportedUsage(account, reply(new Headers()), NOW);
		await noteChatGptPlanReportedUsage(
			account,
			{ ...reply(codexHeaders(40)), credentialFingerprint: undefined },
			NOW,
		);
		expect(db.reportedWrites).toEqual([]);
	});

	it("writes at most once a minute per source, unless the usage moved or OpenAI refused", async () => {
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(40)),
			NOW,
		);
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(41)),
			NOW + 1_000,
		);
		expect(db.reportedWrites).toHaveLength(1);
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(48)),
			NOW + 2_000,
		);
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(48), 429),
			NOW + 3_000,
		);
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(48)),
			NOW + 64_000,
		);
		expect(db.reportedWrites).toHaveLength(4);
	});

	it("records the estimate beside the report on a shared account, and warns on a wide gap", async () => {
		// Estimate 25% (500k of 2M); ChatGPT says 60%.
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(60)),
			NOW,
		);
		expect(db.accuracyWrites).toEqual([
			expect.objectContaining({
				sourceKind: "ORG",
				sourceId: "acc_1",
				windowStart: new Date("2026-10-12T08:00:00Z"),
				estimatePercent: 25,
				reportedPercent: 60,
			}),
		]);
		expect(logger.warn).toHaveBeenCalledWith(
			"[chatgpt-plan] Window estimate drifts from the usage OpenAI reported",
			expect.objectContaining({ driftPoints: 35 }),
		);
	});

	it("does not call a member's own plan's gap the estimate's error", async () => {
		await noteChatGptPlanReportedUsage(
			{ kind: "user", userId: "user-1" },
			reply(codexHeaders(60)),
			NOW,
		);
		expect(db.reportedWrites).toHaveLength(1);
		expect(db.accuracyWrites).toEqual([]);
	});

	it("records no gap when the write was fenced off", async () => {
		db.stored = false;
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(60)),
			NOW,
		);
		expect(db.accuracyWrites).toEqual([]);
	});
});

describe("the chatgpt-plan.usage-headers diagnostic", () => {
	const diagnostics = () =>
		logger.info.mock.calls.filter(
			([message]) => message === "chatgpt-plan.usage-headers",
		);

	it("says which x-codex headers arrived, what they parsed to and that it was stored", async () => {
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(40)),
			NOW,
		);
		expect(diagnostics()).toEqual([
			[
				"chatgpt-plan.usage-headers",
				{
					sourceKind: "ORG",
					sourceId: "acc_1",
					status: 200,
					presentCodexHeaders: [
						"x-codex-primary-reset-at",
						"x-codex-primary-used-percent",
						"x-codex-primary-window-minutes",
						"x-codex-secondary-used-percent",
						"x-codex-secondary-window-minutes",
					],
					parsed: {
						primaryPct: 40,
						resetAt: new Date(RESET_SECONDS * 1000).toISOString(),
						windowMinutes: 300,
						secondaryPct: 22,
					},
					persisted: true,
				},
			],
		]);
	});

	it("says a reply carried no usage headers, naming no other header", async () => {
		await noteChatGptPlanReportedUsage(
			account,
			reply(
				new Headers({
					authorization: "Bearer secret-token",
					"openai-organization": "org-secret",
					"x-request-id": "req_1",
				}),
			),
			NOW,
		);
		expect(diagnostics()).toEqual([
			[
				"chatgpt-plan.usage-headers",
				{
					sourceKind: "ORG",
					sourceId: "acc_1",
					status: 200,
					presentCodexHeaders: [],
					parsed: null,
					persisted: false,
					skipReason: "no-usage-headers",
				},
			],
		]);
		expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(
			/secret|req_1/,
		);
	});

	it("says a report from a replaced sign-in was not stored", async () => {
		db.stored = false;
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(40)),
			NOW,
		);
		expect(diagnostics()[0]?.[1]).toMatchObject({
			persisted: false,
			skipReason: "sign-in-changed",
		});
	});

	it("logs once per source every ten minutes", async () => {
		const own = { kind: "user" as const, userId: "user-1" };
		await noteChatGptPlanReportedUsage(account, reply(new Headers()), NOW);
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(40)),
			NOW + 60_000,
		);
		await noteChatGptPlanReportedUsage(own, reply(new Headers()), NOW);
		expect(diagnostics()).toHaveLength(2);
		await noteChatGptPlanReportedUsage(
			account,
			reply(codexHeaders(40)),
			NOW + 10 * 60_000,
		);
		expect(diagnostics()).toHaveLength(3);
		expect(diagnostics()[1]?.[1]).toMatchObject({
			sourceKind: "USER",
			sourceId: "user-1",
		});
	});
});

describe("settleChatGptPlanWindowsInBackground", () => {
	it("warns about a window that reset unrefused far past its budget", async () => {
		db.settled = [
			{
				windowStart: new Date("2026-10-12T01:00:00Z"),
				peakEstimatePercent: 150,
				weightedInputTokens: 3_000_000,
				budget: 2_000_000,
				refused: false,
				lowerBound: true,
			},
		];
		settleChatGptPlanWindowsInBackground(account, NOW);
		await vi.waitFor(() =>
			expect(logger.warn).toHaveBeenCalledWith(
				"[chatgpt-plan] A window reset without a refusal far past its estimated budget",
				expect.objectContaining({
					peakEstimatePercent: 150,
					raisedBudgetTo: 3_000_000,
				}),
			),
		);
	});
});

describe("the plan provider", () => {
	it("hands every reply's usage headers to the store, a refusal included", async () => {
		const fetchImpl = vi.fn<typeof fetch>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							code: "subscription_sharing_usage_limit_exceeded",
							message: "spent",
						},
					}),
					{
						status: 429,
						headers: Object.fromEntries(codexHeaders(100)),
					},
				),
		);
		await generateText({
			model: createChatGptPlanModel({
				userId: "user-1",
				modelId: CHATGPT_PLAN_HEAVY_MODEL,
				fetchImpl,
			}),
			prompt: "x",
			maxRetries: 0,
		}).catch(() => {});
		await vi.waitFor(() =>
			expect(db.reportedWrites).toEqual([
				expect.objectContaining({
					sourceKind: "USER",
					sourceId: "user-1",
					credentialFingerprint: "fp-own",
					limits: expect.objectContaining({
						primary: expect.objectContaining({ usedPercent: 100 }),
					}),
				}),
			]),
		);
	});
});
