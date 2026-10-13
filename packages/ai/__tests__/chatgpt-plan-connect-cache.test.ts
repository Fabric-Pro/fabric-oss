import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	states: vi.fn(),
	served: vi.fn(),
	store: vi.fn(),
	probe: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	findChatGptPlanSharedAccountConnector: async () => null,
	listChatGptPlanOrganizations: async () => [
		{
			id: "example-org",
			slug: "example-org",
			name: "Example",
			enabled: true,
		},
	],
	setChatGptPlanOrgUse: async () => {},
	recordAudit: vi.fn(),
	getChatGptPlanSourceStates: mocks.states,
	getChatGptPlanServedModels: mocks.served,
}));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../lib/chatgpt-plan/oauth", () => ({
	CHATGPT_PLAN_SCOPE: "plan",
	verifyChatGptIdToken: async () => ({
		sub: "new-subject",
		email: "new@example.com",
	}),
}));
vi.mock("../lib/chatgpt-plan/plan-credentials", () => ({
	storeChatGptPlanCredential: mocks.store,
}));
vi.mock("../lib/chatgpt-plan/served-models", async (importOriginal) => ({
	...(await importOriginal()),
	refreshChatGptPlanServedModelsInBackground: mocks.probe,
}));

import { connectChatGptPlan } from "../lib/chatgpt-plan/connect";
import {
	__resetChatGptPlanBreaker,
	chatGptPlanSourceExhaustedError,
} from "../lib/chatgpt-plan/exhaustion-breaker";
import { __resetChatGptPlanServedModelProbes } from "../lib/chatgpt-plan/served-models";
import { chatGptPlanServedSlugs } from "../lib/chatgpt-plan/served-slugs";

const source = { kind: "user", userId: "example-user" } as const;
const otherSource = { kind: "user", userId: "other-user" } as const;
const now = Date.parse("2026-10-09T12:00:00Z");
const stored = { credentialFingerprint: "0123456789abcdef" };
const spent = {
	openUntil: new Date(now + 60_000),
	resetAt: new Date(now + 60_000),
	consecutiveUnknownResets: 0,
};
const params = {
	userId: source.userId,
	organizationIds: ["example-org"],
	upload: {
		accessToken: "synthetic-access",
		refreshToken: "synthetic-refresh",
		idToken: "synthetic-id",
		tokenType: "Bearer",
		expiresIn: 3600,
		scopes: ["plan"],
		clientId: "example-client",
		hostId: "example-host",
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	__resetChatGptPlanBreaker();
	__resetChatGptPlanServedModelProbes();
	mocks.states.mockResolvedValue([spent]);
	mocks.served.mockResolvedValue([{ slug: "old-model" }]);
});

it.each(["exhaustion", "served models"])(
	"uses the replacement's clean %s immediately while preserving other users' caches",
	async (property) => {
		expect(
			await chatGptPlanSourceExhaustedError(source, now),
		).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(
			await chatGptPlanSourceExhaustedError(otherSource, now),
		).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(await chatGptPlanServedSlugs(source, now)).toEqual(
			new Set(["old-model"]),
		);
		expect(await chatGptPlanServedSlugs(otherSource, now)).toEqual(
			new Set(["old-model"]),
		);
		mocks.store.mockImplementationOnce(async () => {
			mocks.states.mockResolvedValue([]);
			mocks.served.mockResolvedValue([]);
			return stored;
		});
		expect(await connectChatGptPlan(params)).toMatchObject({ ok: true });
		if (property === "exhaustion") {
			expect(
				await chatGptPlanSourceExhaustedError(source, now + 1),
			).toBeNull();
		} else {
			expect(await chatGptPlanServedSlugs(source, now + 1)).toBeNull();
		}
		expect(
			await chatGptPlanSourceExhaustedError(otherSource, now + 1),
		).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(await chatGptPlanServedSlugs(otherSource, now + 1)).toEqual(
			new Set(["old-model"]),
		);
	},
);

it("still refuses an exhausted same-account reconnect after reloading its durable state", async () => {
	await chatGptPlanSourceExhaustedError(source, now);
	await chatGptPlanServedSlugs(source, now);
	mocks.store.mockResolvedValueOnce(stored);
	await connectChatGptPlan(params);
	expect(
		await chatGptPlanSourceExhaustedError(source, now + 1),
	).toBeInstanceOf(SubscriptionPlanExhaustedError);
	expect(await chatGptPlanServedSlugs(source, now + 1)).toEqual(
		new Set(["old-model"]),
	);
});

it("keeps the old caches when credential storage fails", async () => {
	await chatGptPlanSourceExhaustedError(source, now);
	await chatGptPlanServedSlugs(source, now);
	const error = new Error("synthetic storage failure");
	mocks.store.mockRejectedValueOnce(error);
	await expect(connectChatGptPlan(params)).rejects.toBe(error);
	mocks.states.mockResolvedValue([]);
	mocks.served.mockResolvedValue([]);
	expect(
		await chatGptPlanSourceExhaustedError(source, now + 1),
	).toBeInstanceOf(SubscriptionPlanExhaustedError);
	expect(await chatGptPlanServedSlugs(source, now + 1)).toEqual(
		new Set(["old-model"]),
	);
	expect(mocks.probe).not.toHaveBeenCalled();
});
