import type { ChatGptPlanTier } from "@repo/database";
import { logger } from "@repo/logs";
import { type PlanSourceRef, planSourceLogFields } from "./sources";

/**
 * What a ChatGPT sign-in's ID token says about the subscription (Fizzy #2770
 * G7). The token came from OpenAI over Fabric's own OAuth exchange, and its
 * signature was checked at connect, so the payload is only decoded here —
 * defensively: a missing or malformed claim never fails a sign-in or a
 * refresh.
 */

const AUTH_CLAIM = "https://api.openai.com/auth";

const TIER_BY_PLAN_TYPE: Record<string, ChatGptPlanTier> = {
	free: "FREE",
	plus: "PLUS",
	pro: "PRO",
	team: "TEAM",
	business: "TEAM",
	enterprise: "TEAM",
	edu: "TEAM",
};

/**
 * Only what the token actually says: a field is absent when the claim is
 * missing or unreadable, so storing it never overwrites a known tier (an
 * admin's included) or date with "unknown".
 */
export interface ChatGptPlanSubscription {
	tier?: ChatGptPlanTier;
	/** When the paid subscription runs out. */
	subscriptionActiveUntil?: Date;
}

function decodePayload(idToken: string): Record<string, unknown> | null {
	const payload = idToken.split(".")[1];
	if (!payload) {
		return null;
	}
	try {
		const decoded: unknown = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		);
		return typeof decoded === "object" && decoded !== null
			? (decoded as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** An ISO string or epoch seconds/milliseconds; null otherwise. */
function toDate(value: unknown): Date | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Date(value < 1e12 ? value * 1000 : value);
	}
	if (typeof value === "string" && value.length > 0) {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : new Date(parsed);
	}
	return null;
}

/**
 * The subscription an ID token describes: only the claims it carries and
 * this code understands. Empty when it says nothing usable.
 */
export function readChatGptPlanSubscription(
	idToken: string | null | undefined,
): ChatGptPlanSubscription {
	const claims = idToken ? decodePayload(idToken)?.[AUTH_CLAIM] : undefined;
	if (typeof claims !== "object" || claims === null) {
		return {};
	}
	const auth = claims as Record<string, unknown>;
	const planType =
		typeof auth.chatgpt_plan_type === "string"
			? auth.chatgpt_plan_type.toLowerCase()
			: "";
	const tier = TIER_BY_PLAN_TYPE[planType];
	const until = toDate(auth.chatgpt_subscription_active_until);
	return {
		...(tier && { tier }),
		...(until && { subscriptionActiveUntil: until }),
	};
}

/**
 * What an ID token carries, safe to log: presence flags and the plain plan
 * name ("plus"), never a token or a claim that identifies a person.
 */
export interface ChatGptPlanIdTokenShape {
	idTokenPresent: boolean;
	/** The token names an email: the duplicate guard matches accounts by it. */
	emailPresent: boolean;
	authClaimPresent: boolean;
	/** The auth claim's key names only, never their values. */
	authClaimKeys: string[];
	planTypeValue: string | null;
	untilPresent: boolean;
}

const PLAN_TYPE_LOGGABLE = /^[a-z0-9_-]{1,32}$/i;
const CLAIM_KEY_LOGGABLE = /^[a-z0-9_]{1,64}$/i;
const MAX_LOGGED_CLAIM_KEYS = 20;

export function describeChatGptPlanIdToken(
	idToken: string | null | undefined,
): ChatGptPlanIdTokenShape {
	const payload = idToken ? decodePayload(idToken) : null;
	const claims = payload?.[AUTH_CLAIM];
	const auth =
		typeof claims === "object" && claims !== null
			? (claims as Record<string, unknown>)
			: null;
	const planType = auth?.chatgpt_plan_type;
	return {
		idTokenPresent: Boolean(idToken),
		emailPresent:
			typeof payload?.email === "string" && payload.email.length > 0,
		authClaimPresent: auth !== null,
		authClaimKeys: auth
			? Object.keys(auth)
					.filter((key) => CLAIM_KEY_LOGGABLE.test(key))
					.slice(0, MAX_LOGGED_CLAIM_KEYS)
			: [],
		planTypeValue:
			typeof planType === "string" && PLAN_TYPE_LOGGABLE.test(planType)
				? planType
				: null,
		untilPresent: toDate(auth?.chatgpt_subscription_active_until) !== null,
	};
}

/**
 * One line per sign-in, refresh or backfill saying what the ID token held,
 * so a tier stuck on UNKNOWN can be told apart from a token without claims.
 */
export function logChatGptPlanIdTokenShape(
	event: "connect" | "refresh" | "backfill",
	ref: PlanSourceRef,
	idToken: string | null | undefined,
): void {
	logger.info("[chatgpt-plan] ID token subscription claims", {
		event,
		sourceKind: ref.kind,
		...planSourceLogFields(ref),
		...describeChatGptPlanIdToken(idToken),
	});
}
