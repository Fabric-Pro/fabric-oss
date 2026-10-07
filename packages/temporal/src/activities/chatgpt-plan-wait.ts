/**
 * How long background work should wait for a ChatGPT plan window to reset
 * before its one retry (Fizzy #2770). Read by `withChatGptPlanWait` in the
 * workflows that may run on a shared plan; every flag, policy and state read
 * lives here, never in workflow code.
 */

import {
	getChatGptPlanOrgPolicy,
	getChatGptPlanSourceStates,
	isFeatureEnabled,
	listChatGptPlanOrgAccounts,
} from "@repo/database";

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
	const now = Date.now();
	const jitterMs = Math.floor(Math.random() * MAX_JITTER_MS);
	const resets: Date[] = [];

	const { organizationId, userId } = input;
	if (organizationId) {
		const [plan, pooling] = await Promise.all([
			isFeatureEnabled("CHATGPT_PLAN", organizationId),
			isFeatureEnabled("CHATGPT_PLAN_POOLING", organizationId),
		]);
		if (plan && pooling) {
			const policy = await getChatGptPlanOrgPolicy(organizationId);
			if (
				policy.poolingEnabled &&
				policy.apiFallbackBackground === "AUTO"
			) {
				return { waitMs: 0, jitterMs: 0 };
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
		jitterMs,
	};
}
