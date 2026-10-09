/**
 * The one-off header capture (Fizzy #2770): with CHATGPT_PLAN_HEADER_DEBUG=1
 * each plan reply's headers are logged with every identifying value
 * redacted; without it nothing is logged.
 */
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));

vi.mock("@repo/logs", () => ({ logger }));

vi.mock("@repo/database", () => ({
	getChatGptPlanSourceStates: async () => [],
	recordChatGptPlanSourceExhausted: async () => {},
	clearChatGptPlanSourceState: async () => {},
	getChatGptPlanOrgAccountWindows: async () => new Map(),
	getUserModelPreference: vi.fn(),
	getModelForTask: vi.fn(),
}));

vi.mock("../lib/chatgpt-plan/plan-credentials", () => ({
	getChatGptPlanAccessToken: async () => ({
		accessToken: "access-1",
		expiresAt: new Date(Date.now() + 3_600_000),
	}),
	refreshChatGptPlanAfterUnauthorized: vi.fn(),
}));

import { CHATGPT_PLAN_HEAVY_MODEL } from "../lib/chatgpt-plan/models";
import { createChatGptPlanModel } from "../lib/chatgpt-plan/provider";

const refusal = () =>
	new Response(
		JSON.stringify({ error: { code: "invalid_request", message: "no" } }),
		{
			status: 400,
			headers: {
				"content-type": "application/json",
				"openai-organization": "org-123",
				"x-request-id": "req_1",
			},
		},
	);

async function callOnce() {
	await generateText({
		model: createChatGptPlanModel({
			userId: "user-1",
			modelId: CHATGPT_PLAN_HEAVY_MODEL,
			fetchImpl: vi.fn<typeof fetch>(async () => refusal()),
		}),
		prompt: "x",
		maxRetries: 0,
	}).catch(() => {});
}

const headerLogs = () =>
	logger.info.mock.calls.filter(
		([message]) => message === "[chatgpt-plan] Response headers",
	);

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("CHATGPT_PLAN_HEADER_DEBUG", () => {
	it("logs each reply's headers, redacted, when set to 1", async () => {
		vi.stubEnv("CHATGPT_PLAN_HEADER_DEBUG", "1");
		await callOnce();
		expect(headerLogs()).toHaveLength(1);
		expect(headerLogs()[0]?.[1]).toMatchObject({
			status: 400,
			headers: {
				"openai-organization": "[redacted]",
				"x-request-id": "req_1",
			},
		});
	});

	it("logs nothing when unset", async () => {
		vi.stubEnv("CHATGPT_PLAN_HEADER_DEBUG", "");
		await callOnce();
		expect(headerLogs()).toHaveLength(0);
	});
});
