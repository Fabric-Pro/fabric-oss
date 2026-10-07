import { getActiveChatGptPlanOrgUse, isFeatureEnabled } from "@repo/database";
import { logger } from "@repo/logs";
import type { AiJobKey } from "../job-keys";
import { isAiImpersonatedRequest } from "./interactive-context";
import {
	CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
	ChatGptPlanAuthError,
} from "./oauth";

export interface ChatGptPlanRoutingContext {
	userId: string;
	organizationId?: string;
	/** Set only by entry points that run the member's own interactive work. */
	planEligible?: boolean;
	/** The background pipeline making the call, when one is. */
	jobType?: AiJobKey;
}

/**
 * Bulk background work that never runs on a member's own plan, even when
 * they included background jobs (Fizzy #2770): meeting sync, newsletters,
 * sweeps and scans, and the non-text jobs. Their volume would spend the
 * member's window on work nobody asked them for. A call with no `jobType`
 * keeps the phase-1 rule. Scheduled reports, daily briefs and publishing
 * suggestions stay allowed: the setting's own warning names them as what it
 * covers.
 */
export const OWN_PLAN_BACKGROUND_DENYLIST: readonly AiJobKey[] = [
	"meeting-transcript-sync",
	"parlume-meeting-notes",
	"newsletter-curation",
	"security-scan",
	"slack-channel-monitor",
	"image-generation",
	"transcription",
];

/**
 * Where the member's own plan stands for this call:
 * - `off` — no plan may serve anything here: no organization, an
 *   impersonated request, `CHATGPT_PLAN` off, or the check failed;
 * - `none` — the member has no plan turned on here;
 * - `ownDisabled` — their plan is on here but does not cover this call (a
 *   background job they did not include, or bulk work on
 *   {@link OWN_PLAN_BACKGROUND_DENYLIST});
 * - `own` — their plan serves this call.
 */
export type OwnChatGptPlanState = "off" | "none" | "ownDisabled" | "own";

/**
 * @throws ChatGptPlanAuthError when the plan would serve this call but its
 *   sign-in needs reconnecting. Falling back — to the organization's API
 *   billing or to its shared plans — would spend what the member never
 *   approved, so the call is refused.
 */
export async function resolveOwnChatGptPlan(
	context: ChatGptPlanRoutingContext,
): Promise<OwnChatGptPlanState> {
	// An admin acting as the member: their work is never the member's own,
	// whatever the caller marked it.
	if (!context.organizationId || isAiImpersonatedRequest()) {
		return "off";
	}
	try {
		if (!(await isFeatureEnabled("CHATGPT_PLAN", context.organizationId))) {
			return "off";
		}
		const use = await getActiveChatGptPlanOrgUse({
			userId: context.userId,
			organizationId: context.organizationId,
		});
		if (use === null) {
			return "none";
		}
		if (
			context.planEligible !== true &&
			(!use.includeBackgroundJobs ||
				(context.jobType !== undefined &&
					OWN_PLAN_BACKGROUND_DENYLIST.includes(context.jobType)))
		) {
			return "ownDisabled";
		}
		if (use.credentialStatus !== "ACTIVE") {
			throw new ChatGptPlanAuthError(
				CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
				"needs_reconnect",
				true,
			);
		}
		return "own";
	} catch (error) {
		if (error instanceof ChatGptPlanAuthError) {
			throw error;
		}
		logger.warn(
			"[chatgpt-plan] Routing check failed; using the organization provider",
			{
				userId: context.userId,
				organizationId: context.organizationId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return "off";
	}
}

/**
 * Whether this call runs on the member's own ChatGPT plan. It runs in an
 * organization with `CHATGPT_PLAN` on, the member has an ACTIVE plan they
 * turned on there, and either the caller marked the call plan-eligible (the
 * member's own interactive work) or the member chose to include background
 * jobs, the work done on their behalf without them. A database fault answers
 * no: the organization's provider is the default, never the plan. So does an
 * impersonated request, even for a call marked plan-eligible.
 *
 * @throws ChatGptPlanAuthError when the plan would serve this call but its
 *   sign-in needs reconnecting.
 */
export async function shouldUseChatGptPlan(
	context: ChatGptPlanRoutingContext,
): Promise<boolean> {
	return (await resolveOwnChatGptPlan(context)) === "own";
}
