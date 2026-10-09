/**
 * The subscription a ChatGPT sign-in's ID token describes (Fizzy #2770 G7):
 * the tier from `chatgpt_plan_type` and when the subscription is paid until.
 * Decoded defensively — absent or malformed claims are "nothing to say",
 * never an error.
 */
import { describe, expect, it } from "vitest";
import {
	describeChatGptPlanIdToken,
	readChatGptPlanSubscription,
} from "../lib/chatgpt-plan/subscription-claims";

function idToken(payload: unknown): string {
	const part = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "RS256" })}.${part(payload)}.signature`;
}

const auth = (claims: Record<string, unknown>) =>
	idToken({ sub: "user-1", "https://api.openai.com/auth": claims });

describe("readChatGptPlanSubscription", () => {
	it("reads the tier and the paid-until date", () => {
		expect(
			readChatGptPlanSubscription(
				auth({
					chatgpt_plan_type: "plus",
					chatgpt_subscription_active_until:
						"2026-11-08T10:00:00+00:00",
					chatgpt_account_id: "acct-1",
				}),
			),
		).toEqual({
			tier: "PLUS",
			subscriptionActiveUntil: new Date("2026-11-08T10:00:00Z"),
		});
	});

	it.each([
		["free", "FREE"],
		["pro", "PRO"],
		["team", "TEAM"],
		["business", "TEAM"],
		["enterprise", "TEAM"],
		["Plus", "PLUS"],
	])("maps plan type %s to %s", (planType, tier) => {
		expect(
			readChatGptPlanSubscription(auth({ chatgpt_plan_type: planType }))
				?.tier,
		).toBe(tier);
	});

	it("reads an epoch timestamp, in seconds or milliseconds", () => {
		const seconds = Date.parse("2026-11-08T00:00:00Z") / 1000;
		expect(
			readChatGptPlanSubscription(
				auth({ chatgpt_subscription_active_until: seconds }),
			).subscriptionActiveUntil,
		).toEqual(new Date("2026-11-08T00:00:00Z"));
		expect(
			readChatGptPlanSubscription(
				auth({ chatgpt_subscription_active_until: seconds * 1000 }),
			).subscriptionActiveUntil,
		).toEqual(new Date("2026-11-08T00:00:00Z"));
	});

	it("says nothing when the token has no subscription claims", () => {
		expect(readChatGptPlanSubscription(idToken({ sub: "user-1" }))).toEqual(
			{},
		);
		expect(readChatGptPlanSubscription(undefined)).toEqual({});
		expect(readChatGptPlanSubscription("")).toEqual({});
	});

	// Never "unknown" over a known value: an admin-set tier, or a date the
	// last token gave, survives a token that does not say.
	it("leaves out a plan type it does not know, and a missing date", () => {
		expect(
			readChatGptPlanSubscription(
				auth({ chatgpt_plan_type: "something-new" }),
			),
		).toEqual({});
		expect(
			readChatGptPlanSubscription(auth({ chatgpt_plan_type: "pro" })),
		).toEqual({ tier: "PRO" });
	});

	it("never throws on a malformed token or claim", () => {
		expect(readChatGptPlanSubscription("not-a-jwt")).toEqual({});
		expect(readChatGptPlanSubscription("a.!!!.c")).toEqual({});
		expect(
			readChatGptPlanSubscription(
				idToken({ "https://api.openai.com/auth": "free" }),
			),
		).toEqual({});
		expect(
			readChatGptPlanSubscription(
				auth({
					chatgpt_plan_type: 42,
					chatgpt_subscription_active_until: "never",
				}),
			),
		).toEqual({});
	});
});

describe("describeChatGptPlanIdToken", () => {
	it("says what the token holds without any of its content beyond the plan name", () => {
		expect(
			describeChatGptPlanIdToken(
				auth({
					chatgpt_plan_type: "plus",
					chatgpt_subscription_active_until: 1_793_000_000,
					chatgpt_account_id: "acct-1",
				}),
			),
		).toEqual({
			idTokenPresent: true,
			emailPresent: false,
			authClaimPresent: true,
			authClaimKeys: [
				"chatgpt_plan_type",
				"chatgpt_subscription_active_until",
				"chatgpt_account_id",
			],
			planTypeValue: "plus",
			untilPresent: true,
		});
	});

	it.each([
		["no token", undefined],
		["an empty token", ""],
		["an unreadable token", "not-a-jwt"],
	])("reports %s as absent claims", (_label, token) => {
		expect(describeChatGptPlanIdToken(token)).toEqual({
			idTokenPresent: Boolean(token),
			emailPresent: false,
			authClaimPresent: false,
			authClaimKeys: [],
			planTypeValue: null,
			untilPresent: false,
		});
	});

	it("tells a token without the auth claim from one without a plan type", () => {
		expect(describeChatGptPlanIdToken(idToken({ sub: "user-1" }))).toEqual({
			idTokenPresent: true,
			emailPresent: false,
			authClaimPresent: false,
			authClaimKeys: [],
			planTypeValue: null,
			untilPresent: false,
		});
		expect(describeChatGptPlanIdToken(auth({}))).toMatchObject({
			authClaimPresent: true,
			authClaimKeys: [],
			planTypeValue: null,
		});
	});

	it("drops a plan type that is not a short plain name", () => {
		expect(
			describeChatGptPlanIdToken(
				auth({ chatgpt_plan_type: "owner@example.com" }),
			).planTypeValue,
		).toBeNull();
		expect(
			describeChatGptPlanIdToken(
				auth({ chatgpt_plan_type: "x".repeat(64) }),
			).planTypeValue,
		).toBeNull();
	});

	it("lists the auth claim's key names, never their values", () => {
		const shape = describeChatGptPlanIdToken(
			auth({
				chatgpt_account_id: "acct-secret-1",
				chatgpt_user_id: "user-secret-1",
				"bad key!": "x",
				...Object.fromEntries(
					Array.from({ length: 30 }, (_, i) => [
						`k${i}`,
						`value-${i}`,
					]),
				),
			}),
		);
		expect(shape.authClaimKeys.slice(0, 2)).toEqual([
			"chatgpt_account_id",
			"chatgpt_user_id",
		]);
		expect(shape.authClaimKeys).toHaveLength(20);
		expect(shape.authClaimKeys).not.toContain("bad key!");
		const logged = JSON.stringify(shape);
		for (const value of ["acct-secret-1", "user-secret-1", "value-"]) {
			expect(logged).not.toContain(value);
		}
	});

	it("says whether the token names an email, never the address", () => {
		const shape = describeChatGptPlanIdToken(
			idToken({ sub: "user-1", email: "person@example.com" }),
		);
		expect(shape.emailPresent).toBe(true);
		expect(JSON.stringify(shape)).not.toContain("person@example.com");
	});
});
