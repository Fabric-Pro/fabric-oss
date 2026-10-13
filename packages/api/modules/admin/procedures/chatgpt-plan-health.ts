/**
 * Plan health (Fizzy #2770 D6): every organization's shared ChatGPT plan
 * account in one read-only list for deployment admins — status, how much of
 * its window Fabric's calls have used, when it resets, when it was last
 * refused, and the budget its refusals have calibrated. No tokens, and the
 * account's address is masked as on the organization's own settings page.
 */

import { backfillChatGptPlanSubscriptions } from "@repo/ai/lib/chatgpt-plan/subscription-backfill";
import {
	type ChatGptPlanWindow,
	chatGptPlanReportedUsage,
	getChatGptPlanAccuracySummaries,
	getChatGptPlanLastObservations,
	getChatGptPlanOrgAccountWindows,
	getChatGptPlanSourceStates,
	getChatGptPlanWindowCalibrations,
	listChatGptPlanOrgAccountsForAdmin,
} from "@repo/database";
import { z } from "zod";
import {
	chatGptPlanUsageEstimateSchema,
	toChatGptPlanUsageEstimate,
} from "../../../lib/chatgpt-plan-usage";
import { maskEmail } from "../../../lib/mask-email";

const EMPTY_HEALTH_WINDOW: ChatGptPlanWindow = {
	windowStart: null,
	resetsAt: null,
	requests: 0,
	inputTokens: 0,
	weightedInputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	lastRequestAt: null,
	topConsumers: [],
	weightedInputTokensByUser: {},
};

import {
	adminProcedure,
	Permissions,
	requirePermission,
} from "../../../orpc/procedures";

const accountHealthSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	organizationName: z.string(),
	label: z.string(),
	maskedEmail: z.string().nullable(),
	status: z.enum(["ACTIVE", "NEEDS_RECONNECT"]),
	tier: z.enum(["UNKNOWN", "PLUS", "PRO", "FREE", "TEAM"]),
	subscriptionActiveUntil: z.date().nullable(),
	enabled: z.boolean(),
	/**
	 * Share of the window used, 0–100: OpenAI's own report while fresh, else
	 * Fabric's estimate (0 with no open window). `windowPercentSource` says which.
	 */
	windowPercent: z.number(),
	windowPercentSource: z.enum(["reported", "estimated"]),
	/** Fabric's estimate alone, 0–100. */
	estimatedPercent: z.number(),
	reported: chatGptPlanUsageEstimateSchema.shape.reported,
	resetsAt: z.date().nullable(),
	/** Calls fail fast until then: OpenAI refused the account's window. */
	coolingUntil: z.date().nullable(),
	lastExhaustedAt: z.date().nullable(),
	/** Sol-equivalent uncached input tokens per window. */
	budget: z.number(),
	/** A real refusal in the last month set the budget. */
	budgetCalibrated: z.boolean(),
	/** How well the estimate tracked OpenAI over the last month. */
	accuracy: z.object({
		/** The estimate at the latest refusals, newest first, uncapped. */
		refusalEstimatePercents: z.array(z.number()),
		windowsOverBudgetWithoutRefusal: z.number(),
		settledWindows: z.number(),
		latestReported: z
			.object({
				estimatePercent: z.number(),
				reportedPercent: z.number(),
				at: z.date(),
			})
			.nullable(),
		maxDriftPoints: z.number().nullable(),
	}),
});

function latest(...dates: Array<Date | null | undefined>): Date | null {
	const known = dates.filter((date): date is Date => date instanceof Date);
	return known.length === 0
		? null
		: new Date(Math.max(...known.map((date) => date.getTime())));
}

export const listChatGptPlanHealthProcedure = adminProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/admin/chatgpt-plan-health",
		tags: ["Administration"],
		summary: "List every organization's shared ChatGPT plan accounts",
	})
	.output(z.object({ accounts: z.array(accountHealthSchema) }))
	.handler(async () => {
		const accounts = await backfillChatGptPlanSubscriptions(
			await listChatGptPlanOrgAccountsForAdmin(),
			(account) => ({
				kind: "org",
				organizationId: account.organizationId,
				accountId: account.id,
			}),
		);
		const ids = accounts.map((account) => account.id);
		const now = new Date();
		const byOrganization = new Map<string, string[]>();
		for (const account of accounts) {
			byOrganization.set(account.organizationId, [
				...(byOrganization.get(account.organizationId) ?? []),
				account.id,
			]);
		}
		const [windowsPerOrg, calibrations, states, observed, accuracy] =
			await Promise.all([
				Promise.all(
					[...byOrganization].map(([organizationId, accountIds]) =>
						getChatGptPlanOrgAccountWindows({
							organizationId,
							accountIds,
							now,
						}),
					),
				),
				getChatGptPlanWindowCalibrations("ORG", ids),
				getChatGptPlanSourceStates("ORG", ids),
				getChatGptPlanLastObservations("ORG", ids),
				getChatGptPlanAccuracySummaries(ids, now),
			]);
		const windows = new Map(windowsPerOrg.flatMap((perOrg) => [...perOrg]));
		const stateOf = new Map(states.map((state) => [state.sourceId, state]));
		return {
			accounts: accounts.map((account) => {
				const window = windows.get(account.id);
				const state = stateOf.get(account.id);
				const calibration = calibrations.get(account.id);
				const budget = calibration?.budget ?? 0;
				const cooling =
					state?.openUntil && state.openUntil > now
						? state.openUntil
						: null;
				const usage = toChatGptPlanUsageEstimate(
					window ?? EMPTY_HEALTH_WINDOW,
					budget,
					chatGptPlanReportedUsage(state, now),
				);
				return {
					id: account.id,
					organizationId: account.organizationId,
					organizationName: account.organization.name,
					label: account.label,
					maskedEmail: maskEmail(account.email),
					status: account.status,
					tier: account.tier,
					subscriptionActiveUntil: account.subscriptionActiveUntil,
					enabled: account.enabled,
					windowPercent: usage.percent,
					windowPercentSource: usage.percentSource,
					estimatedPercent: usage.estimatedPercent,
					reported: usage.reported,
					resetsAt: cooling
						? (state?.resetAt ?? null)
						: usage.resetsAt,
					coolingUntil: cooling,
					lastExhaustedAt: latest(
						state?.lastExhaustedAt,
						observed.get(account.id),
					),
					budget,
					budgetCalibrated: calibration?.calibrated ?? false,
					accuracy: accuracy.get(account.id) ?? {
						refusalEstimatePercents: [],
						windowsOverBudgetWithoutRefusal: 0,
						settledWindows: 0,
						latestReported: null,
						maxDriftPoints: null,
					},
				};
			}),
		};
	});
