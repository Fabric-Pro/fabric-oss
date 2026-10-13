/**
 * How long background work should wait for a ChatGPT plan window to reset
 * before its one retry (Fizzy #2770). Read by `withChatGptPlanWait` in the
 * workflows that may run on a shared plan; every flag, policy and state read
 * lives here, never in workflow code.
 */

import { aiApiFallbackApproved } from "@repo/ai/lib/job-context";
import {
	getChatGptPlanOrgPolicy,
	getChatGptPlanSourceStates,
	isFeatureEnabled,
	listChatGptPlanOrgAccounts,
} from "@repo/database";
import { sharedPlansSpentError } from "./lib/chatgpt-plan-shared-spent";

// With no reset time known for any plan, wait this long: a third of a Plus
// window, so the retry has a fair chance without stalling the run for hours.
const UNKNOWN_RESET_WAIT_MS = 30 * 60_000;
// Spread the retries of runs that ran out together, so they do not all land
// on the same reset at once.
const MAX_JITTER_MS = 5 * 60_000;

export interface EstimatePlanPoolResetInput {
	organizationId?: string | null;
	/** The member whose own plan may have served the work. */
	userId?: string | null;
}

export interface EstimatePlanPoolResetResult {
	waitMs: number;
	jitterMs: number;
	/**
	 * False when no plan said when it resets and `waitMs` is a guess: a run
	 * that pauses instead of waiting then sleeps longer, so its pause cap is
	 * not spent on guesses shorter than a plan window.
	 */
	resetKnown?: boolean;
}

/**
 * The time until the earliest known reset among the plans that could serve
 * the work: the organization's shared accounts serving background jobs, and
 * the member's own plan. Zero when the organization lets background work run
 * on its provider once every plan is spent — the retry then resolves that.
 */
export async function estimatePlanPoolResetActivity(
	input: EstimatePlanPoolResetInput,
): Promise<EstimatePlanPoolResetResult> {
	// A run a person let bill the organization's provider retries at once.
	if (aiApiFallbackApproved()) {
		return { waitMs: 0, jitterMs: 0, resetKnown: true };
	}
	const now = Date.now();
	const jitterMs = Math.floor(Math.random() * MAX_JITTER_MS);
	const resets: Date[] = [];

	const { organizationId, userId } = input;
	if (organizationId) {
		if (await isFeatureEnabled("CHATGPT_PLAN", organizationId)) {
			const policy = await getChatGptPlanOrgPolicy(organizationId);
			if (
				policy.termsAcknowledgedAt !== null &&
				policy.apiFallbackBackground === "AUTO"
			) {
				return { waitMs: 0, jitterMs: 0, resetKnown: true };
			}
			const accounts = (
				await listChatGptPlanOrgAccounts(organizationId)
			).filter(
				(account) =>
					account.enabled &&
					account.status === "ACTIVE" &&
					account.serveBackground,
			);
			const states = await getChatGptPlanSourceStates(
				"ORG",
				accounts.map((account) => account.id),
			);
			resets.push(
				...states
					.map((state) => state.openUntil)
					.filter((until): until is Date => until !== null),
			);
		}
	}
	if (userId) {
		const [own] = await getChatGptPlanSourceStates("USER", [userId]);
		if (own?.openUntil) {
			resets.push(own.openUntil);
		}
	}

	const earliest = resets
		.map((reset) => reset.getTime())
		.filter((time) => time > now)
		.sort((a, b) => a - b)[0];
	return {
		waitMs: earliest === undefined ? UNKNOWN_RESET_WAIT_MS : earliest - now,
		resetKnown: earliest !== undefined,
		jitterMs,
	};
}

/**
 * Fails with the plan's own error when every shared ChatGPT plan the run's
 * job may use is spent (Fizzy #2770). Asked by a workflow after a step that
 * failed without saying why — an agent run on another queue — so its plan
 * wait can fire; a plan left, or an AUTO policy, answers quietly.
 */
export async function assertSharedPlansNotSpentActivity(input: {
	userId: string;
	organizationId?: string | null;
}): Promise<void> {
	const spent = await sharedPlansSpentError(input);
	if (spent) {
		throw spent;
	}
}
