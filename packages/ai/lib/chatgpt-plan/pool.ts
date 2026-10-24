import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	type AiProviderConfig,
	type ChatGptPlanOrgPolicyValues,
	getActiveChatGptPlanOrgUse,
	getCachedChatGptPlanOrgPolicy,
	getChatGptPlanServedModels,
	getChatGptPlanWindowCalibrations,
	getPlanSpentPersonalProviderConfig,
	hasDeclinedChatGptPlanInOrganization,
	isFeatureEnabled,
	listChatGptPlanModels,
	listChatGptPlanOrgAccounts,
	organizationHasLlmApiProvider,
	recordAudit,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { AiJobKey } from "../job-keys";
import {
	chatGptPlanAccountUsage,
	chatGptPlanFairShare,
	type FairShare,
} from "./account-usage";
import {
	chatGptPlanExhaustedMessage,
	chatGptPlanSourceExhaustedError,
	chatGptPlanSourceReportedUsage,
} from "./exhaustion-breaker";
import { isAiImpersonatedRequest } from "./interactive-context";
import { resolveChatGptPlanModel } from "./models";
import {
	type ChatGptPlanRoutingContext,
	resolveOwnChatGptPlan,
} from "./routing";
import { refreshStaleChatGptPlanServedModels } from "./served-models";
import {
	type PlanSourceRef,
	planSourceKey,
	planSourceStateKey,
} from "./sources";
import { getCachedChatGptPlanOrgAccountWindows } from "./window-cache";

/**
 * The background jobs an organization's shared ChatGPT plan accounts may
 * serve (Fizzy #2770). Default-deny: a job type joins only by being listed
 * here, the review point for what may spend a shared plan unattended. Meeting
 * sync and channel monitoring are the organization's own capture work, so the
 * accounts it shares may run them; they stay off members' own plans
 * (`OWN_PLAN_BACKGROUND_DENYLIST`). Every text job that can run on a plan
 * joins (product decision, 2026-10-09); the organization's provider stays
 * the fallback through its spend policy. The bulk runs a person clicks
 * ({@link BULK_PERSON_JOB_TYPES}) join as background work, so the pool's
 * headroom keeps a share of every window for people. Off the list on
 * purpose: the non-text jobs, which a plan cannot serve.
 */
export const PLAN_POOL_BACKGROUND_JOB_TYPES: readonly AiJobKey[] = [
	"daily-brief",
	"workflow-builder",
	"meeting-transcript-sync",
	"slack-channel-monitor",
	"teams-channel-monitor",
	"scheduled-report",
	"publishing-suggestion",
	"publishing-suggestion-manual",
	"newsletter-curation",
	"living-document-refresh",
	"context-summarization",
	"context-enrichment",
	"pr-review",
	"parlume-meeting-notes",
	"fabric-mention",
	"parlume-live-turn",
	"weave-reader",
	"external-agent",
	"public-api",
	"security-scan",
	"recurring-error-scan",
	"batch-document-generation",
	"project-setup",
	"atlas-analysis",
];

/**
 * Bulk runs a person starts with one click — scans, batch document
 * generation, project setup, Atlas analysis. One run can spend a whole
 * window, so they never run on the clicker's own plan (they are on
 * `OWN_PLAN_BACKGROUND_DENYLIST`) and run on the organization's shared
 * accounts as background work instead (product decision, 2026-10-09).
 */
export const BULK_PERSON_JOB_TYPES: readonly AiJobKey[] = [
	"security-scan",
	"batch-document-generation",
	"project-setup",
	"atlas-analysis",
];

/** Why a bulk run found no provider, for a member who has a plan of their own. */
export const BULK_RUNS_NEED_SHARED_PLAN_MESSAGE =
	"Scans, project setup, Atlas and batch generation run on your organization's shared ChatGPT plans. Ask an admin to connect a shared account, or share your own plan: Settings → AI Providers → Personal → Share organization-wide.";

/**
 * A member whose own plan's window is spent has their interactive work served
 * by the organization's shared accounts that serve interactive work, with a
 * warning, until it resets; with no such account usable the call fails as
 * before. The single switch for that decision (Fizzy #2770).
 */
export const OWN_PLAN_SPENT_FALLS_THROUGH_TO_POOL = true;

export type PickChatGptPlanSourceContext = ChatGptPlanRoutingContext;

export type ChatGptPlanAudience = "interactive" | "background";

/** A source was chosen. `ownPlanSpent` is set when it stands in for the member's own spent plan. */
export interface ChatGptPlanSourcePick {
	source: PlanSourceRef;
	ownPlanSpent?: SubscriptionPlanExhaustedError;
}

/**
 * Plans would serve this call, but every one is spent or excluded. Each kind
 * of work follows its own policy: it stops with the reset time (interactive
 * ASK, background NEVER), or runs on the organization's provider (AUTO).
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
 * past it serves background work only when every account is. Use is the
 * share OpenAI reported while that report is fresh, else Fabric's estimate.
 * A member's interactive work skips an account whose fair share they have
 * used up (Fizzy #2770 D6) — only when a fresh report or a refusal-calibrated
 * budget says so; on the estimate alone the account just goes last. With
 * every account skipped so, it is spent for them until the earliest of those
 * windows resets.
 */
async function pickFromPool(params: {
	organizationId: string;
	userId: string;
	audience: ChatGptPlanAudience;
	exclude: ReadonlySet<string>;
}): Promise<PoolOutcome> {
	const { organizationId, audience, exclude } = params;
	if (!(await isFeatureEnabled("CHATGPT_PLAN", organizationId))) {
		return NO_POOL;
	}
	const policy = await getCachedChatGptPlanOrgPolicy(organizationId);
	if (policy.termsAcknowledgedAt === null) {
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
	const refOf = (accountId: string): PlanSourceRef => ({
		kind: "org",
		organizationId,
		accountId,
	});
	const states = await Promise.all(
		serving.map((account) =>
			chatGptPlanSourceExhaustedError(refOf(account.id)),
		),
	);
	const unspent = serving.filter(
		(account, index) =>
			!states[index] && !exclude.has(planSourceKey(refOf(account.id))),
	);
	const resetAt = earliest(states.map((state) => state?.resetAt ?? null));
	if (unspent.length === 0) {
		return { pick: null, exhausted: true, resetAt, policy };
	}
	// Each account's open window (an account whose window has reset counts
	// as unused), as a share of its own budget — or as OpenAI reported it,
	// while that report is fresh.
	const accountIds = unspent.map((account) => account.id);
	const [windows, calibrations, reports] = await Promise.all([
		getCachedChatGptPlanOrgAccountWindows(organizationId, accountIds),
		getChatGptPlanWindowCalibrations("ORG", accountIds),
		Promise.all(
			accountIds.map((id) => chatGptPlanSourceReportedUsage(refOf(id))),
		),
	]);
	const reportOf = new Map(
		accountIds.map((id, index) => [id, reports[index]]),
	);
	const usage = (accountId: string) =>
		chatGptPlanAccountUsage({
			window: windows.get(accountId),
			calibration: calibrations.get(accountId),
			reported: reportOf.get(accountId) ?? null,
			userId: params.userId,
		});
	const share = (accountId: string) => usage(accountId).share;
	const fairShare = (account: (typeof unspent)[number]): FairShare =>
		audience === "interactive" && account.maxMemberSharePct
			? chatGptPlanFairShare(usage(account.id), account.maxMemberSharePct)
			: "within";
	// Only a fair share the plan's real limits back up blocks a member;
	// one Fabric's estimate alone says is used up only orders the pick.
	const open = unspent.filter((account) => fairShare(account) !== "blocked");
	if (open.length === 0) {
		return {
			pick: null,
			exhausted: true,
			resetAt: earliest(
				unspent.map((account) => usage(account.id).resetsAt),
			),
			policy,
		};
	}
	const overLast = (account: (typeof open)[number]) =>
		fairShare(account) === "over" ? 1 : 0;
	const byUse = [...open].sort(
		(a, b) => overLast(a) - overLast(b) || share(a.id) - share(b.id),
	);
	const ceiling = (100 - policy.headroomPct) / 100;
	const withinHeadroom =
		audience === "background"
			? byUse.filter((account) => share(account.id) <= ceiling)
			: byUse;
	const pick = (withinHeadroom.length > 0 ? withinHeadroom : byUse)[0];
	return {
		pick: pick ? refOf(pick.id) : null,
		exhausted: false,
		resetAt,
		policy,
	};
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
			: await pickFromPool({
					organizationId,
					userId: context.userId,
					audience,
					exclude,
				});
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

/** The audit action for a member's own work billed to the organization's provider. */
export const CHATGPT_PLAN_INTERACTIVE_API_FALLBACK_AUDIT_ACTION =
	"org.chatgpt_plan.interactive_api_fallback_used";

// One audit row per organization and job type (or member) per window, per
// process: a run or a chat turn makes many model calls, and the fact worth
// recording is that the organization's provider took over, not each call.
const API_FALLBACK_AUDIT_WINDOW_MS = 10 * 60_000;
const lastApiFallbackAudit = new Map<string, number>();

function auditApiFallback(
	organizationId: string,
	by: { jobType: AiJobKey | undefined } | { userId: string },
	now = Date.now(),
): void {
	const member = "userId" in by ? by.userId : null;
	const key = member
		? `${organizationId}:user:${member}`
		: `${organizationId}:${"jobType" in by ? (by.jobType ?? "") : ""}`;
	const last = lastApiFallbackAudit.get(key);
	if (last !== undefined && now - last < API_FALLBACK_AUDIT_WINDOW_MS) {
		return;
	}
	lastApiFallbackAudit.set(key, now);
	recordAudit({
		action: member
			? CHATGPT_PLAN_INTERACTIVE_API_FALLBACK_AUDIT_ACTION
			: CHATGPT_PLAN_API_FALLBACK_AUDIT_ACTION,
		category: "org",
		severity: "warning",
		actor: member ? { type: "user", userId: member } : { type: "system" },
		organizationId,
		resource: {
			type: "chatgpt_plan_org_policy",
			id: organizationId,
			name: null,
		},
		metadata: "jobType" in by ? { jobType: by.jobType ?? null } : {},
	});
}

/**
 * Whether a member's own work that found every plan spent runs on the
 * organization's provider instead (Fizzy #3048): its interactive policy is
 * "Use API billing" and it has an LLM provider of its own to bill — never a
 * member's personal key or the platform's. Without one the work stops with
 * the reset time, as under ASK. A fault reads as no.
 */
export async function chatGptPlanInteractiveApiFallback(
	plan: ChatGptPlanSourcesExhausted,
	organizationId: string | null | undefined,
): Promise<boolean> {
	if (
		!organizationId ||
		plan.audience !== "interactive" ||
		plan.policy?.apiFallbackInteractive !== "AUTO"
	) {
		return false;
	}
	try {
		return await organizationHasLlmApiProvider(organizationId);
	} catch {
		return false;
	}
}

/**
 * The member's own key serving their own work while every plan it may use is
 * spent (Fizzy #3085), and when the plans reset.
 */
export interface ChatGptPlanPersonalKeyPick {
	personalKey: AiProviderConfig;
	resetAt: Date | null;
}

/**
 * Whether a member's own work that found every plan spent may run on a
 * personal key they opted in ("Use when the ChatGPT plan is spent"), and
 * which (Fizzy #3085). It applies only where the organization would
 * otherwise stop that work: its people policy is "Stop and show the reset
 * time", or it has no LLM provider of its own to bill. Never background
 * work, which would bill the individual for work they never asked for;
 * never an impersonated request; never another member's key.
 *
 * Null when it does not apply. Otherwise `config` is the key, or null when
 * the member has none opted in, which the stop message turns into a
 * "Configure a fallback" link. A fault reads as "does not apply".
 */
export async function chatGptPlanPersonalKeyFallback(
	plan: ChatGptPlanSourcesExhausted,
	context: {
		userId: string;
		organizationId?: string | null;
		jobType?: AiJobKey;
	},
): Promise<{ config: AiProviderConfig | null } | null> {
	if (
		!context.organizationId ||
		plan.audience !== "interactive" ||
		isAiImpersonatedRequest() ||
		(context.jobType !== undefined &&
			PLAN_POOL_BACKGROUND_JOB_TYPES.includes(context.jobType))
	) {
		return null;
	}
	try {
		if (
			await chatGptPlanInteractiveApiFallback(
				plan,
				context.organizationId,
			)
		) {
			return null;
		}
		return {
			config: await getPlanSpentPersonalProviderConfig({
				userId: context.userId,
			}),
		};
	} catch {
		return null;
	}
}

// Like the audit above: once per member per window, not per model call.
const lastPersonalKeyLog = new Map<string, number>();

function logPersonalKeyFallback(
	organizationId: string,
	userId: string,
	provider: string | null,
	now = Date.now(),
): void {
	const key = `${organizationId}:${userId}`;
	const last = lastPersonalKeyLog.get(key);
	if (last !== undefined && now - last < API_FALLBACK_AUDIT_WINDOW_MS) {
		return;
	}
	lastPersonalKeyLog.set(key, now);
	logger.info(
		"[chatgpt-plan] Plans spent; serving the member's own work on their personal key",
		{ organizationId, userId, provider },
	);
}

export function __resetChatGptPlanApiFallbackAudit(): void {
	lastApiFallbackAudit.clear();
	lastPersonalKeyLog.clear();
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
 * throws `SubscriptionPlanExhaustedError` — interactive work under ASK,
 * background work waiting for a reset — except under an AUTO policy for that
 * kind of work, which runs on the organization's provider and is audited
 * (for a member's own work, only when the organization has a provider of its
 * own; that covers a spent own plan too). Where the organization would
 * stop a member's own work, a personal key they opted in serves it instead
 * (see {@link chatGptPlanPersonalKeyFallback}). Otherwise a spent own plan
 * that nothing could stand in for is still returned, so the call fails
 * exactly as it did before shared plans existed.
 */
export async function chatGptPlanSourceForCall(
	context: PickChatGptPlanSourceContext,
	options: { exclude?: Iterable<string> } = {},
): Promise<ChatGptPlanSourcePick | ChatGptPlanPersonalKeyPick | null> {
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
		(plan.policy?.apiFallbackBackground === "AUTO" ||
			context.apiFallbackApproved === true) &&
		context.organizationId
	) {
		auditApiFallback(context.organizationId, { jobType: context.jobType });
		return null;
	}
	if (
		context.organizationId &&
		(await chatGptPlanInteractiveApiFallback(plan, context.organizationId))
	) {
		auditApiFallback(context.organizationId, { userId: context.userId });
		return null;
	}
	const personal = await chatGptPlanPersonalKeyFallback(plan, context);
	if (personal?.config && context.organizationId) {
		logPersonalKeyFallback(
			context.organizationId,
			context.userId,
			personal.config.provider,
		);
		return { personalKey: personal.config, resetAt: plan.resetAt };
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
		{ personalKeyOption: personal !== null },
	);
}

/**
 * Whether the organization's shared ChatGPT plan accounts would serve its
 * allowlisted background jobs right now — plans on, the sharing terms
 * accepted, and an enabled, signed-in account that serves background
 * work (Fizzy #2770 F3). Said when someone links a channel or a meeting
 * series, whose first history import can take a large share of a window.
 * A fault reads as false: the heads-up is advisory.
 */
export async function sharedPlansServeBackgroundWork(
	organizationId: string,
): Promise<boolean> {
	try {
		if (!(await isFeatureEnabled("CHATGPT_PLAN", organizationId))) {
			return false;
		}
		const policy = await getCachedChatGptPlanOrgPolicy(organizationId);
		if (policy.termsAcknowledgedAt === null) {
			return false;
		}
		const accounts = await listChatGptPlanOrgAccounts(organizationId);
		return accounts.some(
			(account) =>
				account.enabled &&
				account.status === "ACTIVE" &&
				account.serveBackground,
		);
	} catch {
		return false;
	}
}

/**
 * Why a member's own work found no provider, when the organization does
 * share ChatGPT plans but none of them serves members — "No AI provider
 * configured" reads as wrong there. Null otherwise; a fault reads as null.
 */
export async function sharedPlansSkipMembersMessage(
	organizationId: string,
): Promise<string | null> {
	try {
		if (!(await isFeatureEnabled("CHATGPT_PLAN", organizationId))) {
			return null;
		}
		const policy = await getCachedChatGptPlanOrgPolicy(organizationId);
		if (policy.termsAcknowledgedAt === null) {
			return null;
		}
		const working = (
			await listChatGptPlanOrgAccounts(organizationId)
		).filter((account) => account.enabled && account.status === "ACTIVE");
		if (
			working.length === 0 ||
			working.some((account) => account.serveInteractive)
		) {
			return null;
		}
		return "None of your organization's shared ChatGPT plans serves members' own work, and there is no AI provider to fall back on. An admin can set a shared plan to Serves: Everything in Settings → AI Providers.";
	} catch {
		return null;
	}
}

/**
 * Why a bulk run ({@link BULK_PERSON_JOB_TYPES}) found neither a shared plan
 * nor a provider, when the member who started it has a ChatGPT plan of their
 * own here: "No AI provider configured" reads as wrong to someone whose plan
 * runs their chats. Null otherwise — for any other job, for a member with no
 * plan, or on a fault.
 */
export async function bulkRunsNeedSharedPlanMessage(params: {
	userId: string;
	organizationId: string;
	jobType: AiJobKey | undefined;
}): Promise<string | null> {
	if (
		params.jobType === undefined ||
		!BULK_PERSON_JOB_TYPES.includes(params.jobType)
	) {
		return null;
	}
	try {
		if (!(await isFeatureEnabled("CHATGPT_PLAN", params.organizationId))) {
			return null;
		}
		const use = await getActiveChatGptPlanOrgUse({
			userId: params.userId,
			organizationId: params.organizationId,
		});
		return use ? BULK_RUNS_NEED_SHARED_PLAN_MESSAGE : null;
	} catch {
		return null;
	}
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

/** A model a chat may run on, from the plan that serves the member. */
export interface InteractivePlanModelChoice {
	canonicalName: string;
	slug: string;
	displayName: string;
	/** The organization's model for this work. */
	isDefault: boolean;
	/** OpenAI lists it first: its newest or most capable model. */
	newest: boolean;
}

/**
 * The ChatGPT plan model that runs this member's own work of `taskType` here,
 * and whose plan it is — for a model picker that would otherwise be empty
 * because the work never reaches an API provider. Null when no plan serves
 * it, or when asking fails.
 *
 * `models` are the ones a chat may pick instead (Fizzy #2770 F13): those the
 * plan that serves the member lists, the only ones a chat's choice can run
 * on. Before that plan's list was ever read, only the organization's model.
 */
export async function interactivePlanModel(params: {
	userId: string;
	organizationId?: string;
	taskType: string;
}): Promise<{
	model: string;
	source: "own" | "shared";
	models: InteractivePlanModelChoice[];
	/** Every plan serving the member is spent: no model runs until this. */
	spent?: { until: Date | null };
} | null> {
	try {
		const pick = await pickChatGptPlanSource({
			userId: params.userId,
			organizationId: params.organizationId,
			planEligible: true,
		});
		if (!pick) {
			return null;
		}
		if (!("source" in pick)) {
			// Under "Use API billing" the organization's provider runs it;
			// otherwise a personal key the member opted in may (Fizzy #3085).
			if (
				(await chatGptPlanInteractiveApiFallback(
					pick,
					params.organizationId,
				)) ||
				(await chatGptPlanPersonalKeyFallback(pick, params))?.config
			) {
				return null;
			}
			return {
				model: "",
				source: pick.ownPlanOnly ? "own" : "shared",
				models: [],
				spent: { until: pick.resetAt },
			};
		}
		const [{ model }, rows, catalog] = await Promise.all([
			resolveChatGptPlanModel({
				userId: params.userId,
				organizationId: params.organizationId,
				taskType: params.taskType,
				source: pick.source,
			}),
			getChatGptPlanServedModels([planSourceStateKey(pick.source)]),
			listChatGptPlanModels(),
		]);
		refreshStaleChatGptPlanServedModels([pick.source], rows);
		const served = new Set(rows.map((row) => row.slug));
		const newest = rows
			.filter((row) => row.priority !== null)
			.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0]?.slug;
		const models = catalog
			.filter((entry) =>
				served.size > 0 ? served.has(entry.slug) : entry.slug === model,
			)
			.map((entry) => ({
				canonicalName: entry.canonicalName,
				slug: entry.slug,
				displayName: entry.displayName,
				isDefault: entry.slug === model,
				newest: entry.slug === newest,
			}));
		return {
			model,
			source: pick.source.kind === "org" ? "shared" : "own",
			models,
		};
	} catch {
		return null;
	}
}
