/**
 * Plan health (Fizzy #2770 D6): every organization's shared ChatGPT plan
 * account in one read-only list for deployment admins — status, how much of
 * its window Fabric's calls have used, when it resets, when it was last
 * refused, and the budget its refusals have calibrated. No tokens, and the
 * account's address is masked as on the organization's own settings page.
 */

import { backfillChatGptPlanSubscriptions } from "@repo/ai/lib/chatgpt-plan/subscription-backfill";
import {
	getChatGptPlanLastObservations,
	getChatGptPlanOrgAccountWindows,
	getChatGptPlanSourceStates,
	getChatGptPlanWindowBudgets,
	listChatGptPlanOrgAccountsForAdmin,
} from "@repo/database";
import { z } from "zod";
import { maskEmail } from "../../../lib/mask-email";
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
	/** Share of the window budget Fabric's calls used, 0–100; 0 with no open window. */
	windowPercent: z.number(),
	resetsAt: z.date().nullable(),
	/** Calls fail fast until then: OpenAI refused the account's window. */
	coolingUntil: z.date().nullable(),
	lastExhaustedAt: z.date().nullable(),
	/** Uncached input tokens per window. */
	budget: z.number(),
	budgetCalibrated: z.boolean(),
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
		const [windowsPerOrg, budgets, states, observed] = await Promise.all([
			Promise.all(
				[...byOrganization].map(([organizationId, accountIds]) =>
					getChatGptPlanOrgAccountWindows({
						organizationId,
						accountIds,
						now,
					}),
				),
			),
			getChatGptPlanWindowBudgets("ORG", ids),
			getChatGptPlanSourceStates("ORG", ids),
			getChatGptPlanLastObservations("ORG", ids),
		]);
		const windows = new Map(windowsPerOrg.flatMap((perOrg) => [...perOrg]));
		const stateOf = new Map(states.map((state) => [state.sourceId, state]));
		return {
			accounts: accounts.map((account) => {
				const window = windows.get(account.id);
				const state = stateOf.get(account.id);
				const budget = budgets.get(account.id) ?? 0;
				const cooling =
					state?.openUntil && state.openUntil > now
						? state.openUntil
						: null;
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
					windowPercent:
						budget > 0 && window
							? Math.min(
									100,
									Math.round(
										(window.inputTokens / budget) * 100,
									),
								)
							: 0,
					resetsAt: cooling
						? (state?.resetAt ?? null)
						: (window?.resetsAt ?? null),
					coolingUntil: cooling,
					lastExhaustedAt: latest(
						state?.lastExhaustedAt,
						observed.get(account.id),
					),
					budget,
					budgetCalibrated: observed.has(account.id),
				};
			}),
		};
	});
