import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	type ChatGptPlanOrgPolicyValues,
	getChatGptPlanOrgPolicy,
	getChatGptPlanPoolUsageSince,
	hasDeclinedChatGptPlanInOrganization,
	isFeatureEnabled,
	listChatGptPlanOrgAccounts,
	recordAudit,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { AiJobKey } from "../job-keys";
import {
	chatGptPlanExhaustedMessage,
	chatGptPlanSourceExhaustedError,
} from "./exhaustion-breaker";
import { isAiImpersonatedRequest } from "./interactive-context";
import {
	type ChatGptPlanRoutingContext,
	resolveOwnChatGptPlan,
} from "./routing";
import { type PlanSourceRef, planSourceKey } from "./sources";

/**
 * The background jobs an organization's shared ChatGPT plan accounts may
 * serve (Fizzy #2770). Default-deny: a job type joins only by being listed
 * here, the review point for what may spend a shared plan unattended. Bulk
 * work — indexing, ingestion, sweeps, digests, meeting sync — never does.
 */
export const PLAN_POOL_BACKGROUND_JOB_TYPES: readonly AiJobKey[] = [
	"daily-brief",
	"workflow-builder",
];

/**
 * A member whose own plan's window is spent has their interactive work served
 * by the organization's shared accounts that serve interactive work, with a
 * warning, until it resets; with no such account usable the call fails as
 * before. The single switch for that decision (Fizzy #2770).
 */
export const OWN_PLAN_SPENT_FALLS_THROUGH_TO_POOL = true;

// Rough Fabric-only allowance of one Plus five-hour window, in input tokens.
const PLAN_WINDOW_MS = 5 * 60 * 60_000;
const ESTIMATED_WINDOW_INPUT_TOKENS = 750_000;

export type PickChatGptPlanSourceContext = ChatGptPlanRoutingContext;

export type ChatGptPlanAudience = "interactive" | "background";

/** A source was chosen. `ownPlanSpent` is set when it stands in for the member's own spent plan. */
export interface ChatGptPlanSourcePick {
	source: PlanSourceRef;
	ownPlanSpent?: SubscriptionPlanExhaustedError;
}

/**
 * Plans would serve this call, but every one is spent or excluded. Interactive
 * work keeps today's ASK; background work waits, or — under an AUTO policy —
 * runs on the organization's provider.
 */
export interface ChatGptPlanSourcesExhausted {
	exhausted: true;
	audience: ChatGptPlanAudience;
	policy: ChatGptPlanOrgPolicyValues | null;
	/** The earliest known reset among the spent sources. */
	resetAt: Date | null;
	/** The member's own spent plan, when it was the one in play. */
	ownPlanSpent?: SubscriptionPlanExhaustedError;
	/** No shared account would have served the call; only the own plan was in play. */
	ownPlanOnly?: boolean;
}

interface PoolOutcome {
	pick: PlanSourceRef | null;
	/** Accounts would serve this call, but all are spent or excluded. */
	exhausted: boolean;
	resetAt: Date | null;
	policy: ChatGptPlanOrgPolicyValues | null;
}

const NO_POOL: PoolOutcome = {
	pick: null,
	exhausted: false,
	resetAt: null,
	policy: null,
};

function earliest(dates: Array<Date | null>): Date | null {
	const known = dates.filter((date): date is Date => date !== null);
	return known.length === 0
		? null
		: new Date(Math.min(...known.map((date) => date.getTime())));
}

/**
 * The organization's least-used shared account for this audience. Background
 * work leaves the policy's headroom on every account for people; an account
 * past it serves background work only when every account is.
 */
async function pickFromPool(params: {
	organizationId: string;
	audience: ChatGptPlanAudience;
	exclude: ReadonlySet<string>;
}): Promise<PoolOutcome> {
	const { organizationId, audience, exclude } = params;
	if (!(await isFeatureEnabled("CHATGPT_PLAN_POOLING", organizationId))) {
		return NO_POOL;
	}
	const policy = await getChatGptPlanOrgPolicy(organizationId);
	if (!policy.poolingEnabled || policy.termsAcknowledgedAt === null) {
		return NO_POOL;
	}
	const serving = (await listChatGptPlanOrgAccounts(organizationId)).filter(
		(account) =>
			account.enabled &&
			account.status === "ACTIVE" &&
			(audience === "interactive"
				? account.serveInteractive
				: account.serveBackground),
	);
	if (serving.length === 0) {
		return { ...NO_POOL, policy };
	}
	const refs = serving.map(
		(account): PlanSourceRef => ({
			kind: "org",
			organizationId,
			accountId: account.id,
		}),
	);
	const states = await Promise.all(
		refs.map((ref) => chatGptPlanSourceExhaustedError(ref)),
	);
	const open = refs.filter(
		(ref, index) => !states[index] && !exclude.has(planSourceKey(ref)),
	);
	const resetAt = earliest(states.map((state) => state?.resetAt ?? null));
	if (open.length === 0) {
		return { pick: null, exhausted: true, resetAt, policy };
	}
	const usage = await getChatGptPlanPoolUsageSince({
		organizationId,
		accountIds: open.map((ref) =>
			ref.kind === "org" ? ref.accountId : "",
		),
		since: new Date(Date.now() - PLAN_WINDOW_MS),
	});
	const used = (ref: PlanSourceRef) =>
		ref.kind === "org" ? (usage.get(ref.accountId)?.inputTokens ?? 0) : 0;
	const byUse = [...open].sort((a, b) => used(a) - used(b));
	const ceiling =
		(ESTIMATED_WINDOW_INPUT_TOKENS * (100 - policy.headroomPct)) / 100;
	const withinHeadroom =
		audience === "background"
			? byUse.filter((ref) => used(ref) <= ceiling)
			: byUse;
	const pick =
		(withinHeadroom.length > 0 ? withinHeadroom : byUse)[0] ?? null;
	return { pick, exhausted: false, resetAt, policy };
}

/**
 * Which ChatGPT plan serves this call (Fizzy #2770), in order: the member's
 * own plan; then, while pooling is on and its terms acknowledged, the
 * organization's least-used shared account that serves this kind of work —
 * interactive work only for a member with no plan of their own here — never
 * one who turned theirs off here, which chooses the organization's billing —
 * or whose own plan is spent (see {@link OWN_PLAN_SPENT_FALLS_THROUGH_TO_POOL}),
 * background work only for a
 * job type in {@link PLAN_POOL_BACKGROUND_JOB_TYPES}.
 *
 * Returns null when no plan would serve the call at all — the organization's
 * provider runs it, as before — and an exhausted result when plans would but
 * none is usable. An impersonated request never runs on any plan. A fault
 * while consulting the pool reads as "no pool".
 *
 * @throws ChatGptPlanAuthError when the member's own plan would serve the call
 *   but needs reconnecting — never substituted, not even by a shared account.
 */
export async function pickChatGptPlanSource(
	context: PickChatGptPlanSourceContext,
	options: { exclude?: Iterable<string> } = {},
): Promise<ChatGptPlanSourcePick | ChatGptPlanSourcesExhausted | null> {
	const { organizationId } = context;
	if (!organizationId || isAiImpersonatedRequest()) {
		return null;
	}
	const own = await resolveOwnChatGptPlan(context);
	if (own === "off") {
		return null;
	}
	const exclude = new Set(options.exclude ?? []);
	const audience: ChatGptPlanAudience =
		context.planEligible === true ? "interactive" : "background";

	let ownPlanSpent: SubscriptionPlanExhaustedError | undefined;
	if (own === "own") {
		const ownRef: PlanSourceRef = { kind: "user", userId: context.userId };
		const spent = await chatGptPlanSourceExhaustedError(ownRef);
		const excluded = exclude.has(planSourceKey(ownRef));
		if (!spent && !excluded) {
			return { source: ownRef };
		}
		// Excluded means it just refused this call; it is spent either way.
		ownPlanSpent =
			spent ??
			new SubscriptionPlanExhaustedError(
				chatGptPlanExhaustedMessage(null),
				null,
			);
		if (
			audience === "interactive" &&
			!OWN_PLAN_SPENT_FALLS_THROUGH_TO_POOL
		) {
			return ownSpentOutcome(ownPlanSpent, audience, null);
		}
	}

	if (
		audience === "background" &&
		(context.jobType === undefined ||
			!PLAN_POOL_BACKGROUND_JOB_TYPES.includes(context.jobType))
	) {
		return ownPlanSpent
			? ownSpentOutcome(ownPlanSpent, audience, null)
			: null;
	}

	let pool: PoolOutcome;
	try {
		// A member who turned their own plan off here chose the organization's
		// billing for their work; the shared plans are for members with no plan
		// of their own, or who never answered.
		const declined =
			audience === "interactive" &&
			own === "none" &&
			(await hasDeclinedChatGptPlanInOrganization({
				userId: context.userId,
				organizationId,
			}));
		pool = declined
			? NO_POOL
			: await pickFromPool({ organizationId, audience, exclude });
	} catch (error) {
		logger.warn(
			"[chatgpt-plan] Shared plan lookup failed; not using shared plans",
			{
				organizationId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		pool = NO_POOL;
	}
	if (pool.pick) {
		return { source: pool.pick, ...(ownPlanSpent && { ownPlanSpent }) };
	}
	if (pool.exhausted) {
		return {
			exhausted: true,
			audience,
			policy: pool.policy,
			resetAt: earliest([pool.resetAt, ownPlanSpent?.resetAt ?? null]),
			...(ownPlanSpent && { ownPlanSpent }),
		};
	}
	return ownPlanSpent
		? ownSpentOutcome(ownPlanSpent, audience, pool.policy)
		: null;
}

/** The member's own plan was the only one in play, and it is spent. */
function ownSpentOutcome(
	ownPlanSpent: SubscriptionPlanExhaustedError,
	audience: ChatGptPlanAudience,
	policy: ChatGptPlanOrgPolicyValues | null,
): ChatGptPlanSourcesExhausted {
	return {
		exhausted: true,
		audience,
		policy,
		resetAt: ownPlanSpent.resetAt,
		ownPlanSpent,
		ownPlanOnly: true,
	};
}

/** The audit action for a background call billed to the organization's provider. */
export const CHATGPT_PLAN_API_FALLBACK_AUDIT_ACTION =
	"org.chatgpt_plan.api_fallback_used";

// One audit row per organization and job type per window, per process: a
// background run makes many model calls, and the fact worth recording is
// that the organization's provider took over, not each call.
const API_FALLBACK_AUDIT_WINDOW_MS = 10 * 60_000;
const lastApiFallbackAudit = new Map<string, number>();

function auditApiFallback(
	organizationId: string,
	jobType: AiJobKey | undefined,
	now = Date.now(),
): void {
	const key = `${organizationId}:${jobType ?? ""}`;
	const last = lastApiFallbackAudit.get(key);
	if (last !== undefined && now - last < API_FALLBACK_AUDIT_WINDOW_MS) {
		return;
	}
	lastApiFallbackAudit.set(key, now);
	recordAudit({
		action: CHATGPT_PLAN_API_FALLBACK_AUDIT_ACTION,
		category: "org",
		severity: "warning",
		actor: { type: "system" },
		organizationId,
		resource: {
			type: "chatgpt_plan_org_policy",
			id: organizationId,
			name: null,
		},
		metadata: { jobType: jobType ?? null },
	});
}

export function __resetChatGptPlanApiFallbackAudit(): void {
	lastApiFallbackAudit.clear();
}

/** The sentence shown when every plan a call may use is spent. */
export function chatGptPlanPoolExhaustedMessage(resetAt: Date | null): string {
	if (!resetAt) {
		return "Every ChatGPT plan this work may use has no usage left in this window. Wait for one to reset, then try again.";
	}
	const at = resetAt.toISOString().slice(0, 16).replace("T", " ");
	return `Every ChatGPT plan this work may use has no usage left in this window. The first resets at ${at} UTC.`;
}

/**
 * The plan source for one model call, or null for the organization's
 * provider. When shared plans would serve the call but all are spent it
 * throws `SubscriptionPlanExhaustedError` — interactive work keeps today's
 * ASK, background work waits for a reset — except background work under an
 * AUTO policy, which runs on the organization's provider and is audited. A
 * spent own plan that nothing could stand in for is still returned, so the
 * call fails exactly as it did before shared plans existed.
 */
export async function chatGptPlanSourceForCall(
	context: PickChatGptPlanSourceContext,
	options: { exclude?: Iterable<string> } = {},
): Promise<ChatGptPlanSourcePick | null> {
	const plan = await pickChatGptPlanSource(context, options);
	if (plan === null || "source" in plan) {
		if (plan?.ownPlanSpent) {
			logger.info(
				"[chatgpt-plan] Own plan spent; serving on a shared account",
				{
					userId: context.userId,
					organizationId: context.organizationId,
				},
			);
		}
		return plan;
	}
	if (
		plan.audience === "background" &&
		plan.policy?.apiFallbackBackground === "AUTO" &&
		context.organizationId
	) {
		auditApiFallback(context.organizationId, context.jobType);
		return null;
	}
	// The member's own plan was in play: it still serves the call, and its
	// spent window fails the call itself, as it always has — the agent
	// exchange answers 429, a call fails with the plan's own message.
	if (plan.ownPlanSpent && context.organizationId) {
		return { source: { kind: "user", userId: context.userId } };
	}
	throw new SubscriptionPlanExhaustedError(
		chatGptPlanPoolExhaustedMessage(plan.resetAt),
		plan.resetAt,
	);
}

/**
 * Whether one of the organization's shared accounts would serve this
 * member's own interactive work right now — what the shell's warning says
 * once their own plan is spent. Asks only; marks no work.
 */
export async function sharedPlanServesMember(params: {
	userId: string;
	organizationId: string;
}): Promise<boolean> {
	const pick = await pickChatGptPlanSource({ ...params, planEligible: true });
	return pick !== null && "source" in pick && pick.source.kind === "org";
}

/**
 * Whether a ChatGPT plan — the member's own, or one the organization shares
 * with members who have none — would serve this member's own interactive
 * work, even if every such plan is spent right now (the call then fails with
 * the plan's refusal rather than moving to the organization's provider).
 * For an entry point that decides once per request, such as CopilotKit.
 *
 * @throws ChatGptPlanAuthError when the member's own plan needs reconnecting.
 */
export async function planServesInteractiveWork(params: {
	userId: string;
	organizationId?: string;
}): Promise<boolean> {
	return (
		(await pickChatGptPlanSource({ ...params, planEligible: true })) !==
		null
	);
}
