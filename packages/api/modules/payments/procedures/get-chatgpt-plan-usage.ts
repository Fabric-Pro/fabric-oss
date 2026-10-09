/**
 * The organization's ChatGPT plan usage per subscription over a range
 * (Fizzy #2972 FR4/AC5): one row per shared account and, for members' own
 * plans, one row per member — requests, uncached input, cached and output
 * tokens, what it would have cost on API billing, and its share of the plan
 * usage. Successful calls only.
 *
 * The organization is the session's, never the input's; owners and admins
 * only, like the rest of the usage page. Empty while `CHATGPT_PLAN` is off.
 */

import { ORPCError } from "@orpc/client";
import {
	type ChatGptPlanUsageGroup,
	db,
	getChatGptPlanUsageBySource,
	isFeatureEnabled,
	listChatGptPlanOrgAccounts,
} from "@repo/database";
import { z } from "zod";
import { estimateChatGptPlanApiCost } from "../../../lib/chatgpt-plan-cost";
import { maskEmail } from "../../../lib/mask-email";
import {
	requireOrganizationAdmin,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * How members' own plans are shown: a row per member, or one row for all of
 * them. Pending a product decision; switching is this one line.
 */
const OWN_PLAN_USAGE_ROWS: "per-member" | "combined" = "per-member";

const DEFAULT_PERIOD_DAYS = 30;
const MAX_RANGE_DAYS = 365;

const rowSchema = z.object({
	key: z.string(),
	kind: z.enum(["shared", "member", "members"]),
	/** The account's label, the member's name, or null for the combined row. */
	label: z.string().nullable(),
	/** The shared account's masked address. */
	detail: z.string().nullable(),
	requests: z.number(),
	uncachedInputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	apiEquivalentCostMicroUsd: z.number(),
	/** Share of the plan usage, by uncached input tokens — what a plan window counts. */
	sharePercent: z.number(),
});

type ChatGptPlanUsageRow = z.infer<typeof rowSchema>;

/**
 * The range the usage page shows: an explicit `from`/`to` (swapped when
 * reversed), `to` alone reaching back as far as the page allows, otherwise
 * the preset; never longer than {@link MAX_RANGE_DAYS}.
 */
function resolveRange(input: {
	periodDays?: number;
	periodHours?: number;
	from?: Date;
	to?: Date;
}): { from: Date; to: Date } {
	let to = input.to ?? new Date();
	let from: Date;
	if (input.from) {
		from = input.from;
	} else if (input.to && !input.periodDays && !input.periodHours) {
		from = new Date(to.getTime() - MAX_RANGE_DAYS * 86_400_000);
	} else {
		const hours =
			input.periodHours ?? (input.periodDays ?? DEFAULT_PERIOD_DAYS) * 24;
		from = new Date(to.getTime() - hours * 3_600_000);
	}
	if (from > to) {
		[from, to] = [to, from];
	}
	const earliest = new Date(to.getTime() - MAX_RANGE_DAYS * 86_400_000);
	return { from: from < earliest ? earliest : from, to };
}

interface RowDraft {
	key: string;
	kind: ChatGptPlanUsageRow["kind"];
	label: string | null;
	detail: string | null;
	groups: ChatGptPlanUsageGroup[];
}

async function toRow(draft: RowDraft, totalUncached: number) {
	const sum = (pick: (group: ChatGptPlanUsageGroup) => number) =>
		draft.groups.reduce((total, group) => total + pick(group), 0);
	const uncachedInputTokens = sum((group) =>
		Math.max(0, group.inputTokens - group.cachedInputTokens),
	);
	const estimate = await estimateChatGptPlanApiCost(
		draft.groups.map((group) => ({
			providerModelId: group.providerModelId,
			inputTokens: group.inputTokens,
			outputTokens: group.outputTokens,
			cachedInputTokens: group.cachedInputTokens,
		})),
	);
	return {
		key: draft.key,
		kind: draft.kind,
		label: draft.label,
		detail: draft.detail,
		requests: sum((group) => group.requests),
		uncachedInputTokens,
		cachedInputTokens: sum((group) => group.cachedInputTokens),
		outputTokens: sum((group) => group.outputTokens),
		apiEquivalentCostMicroUsd: estimate.estimatedApiCostMicroUsd,
		sharePercent:
			totalUncached > 0
				? Math.round((uncachedInputTokens / totalUncached) * 1000) / 10
				: 0,
	};
}

export const getChatGptPlanUsage = tenantProtectedProcedure
	// Visibility only; owners and admins, checked below.
	.route({
		method: "GET",
		path: "/payments/chatgpt-plan-usage",
		tags: ["Payments"],
		summary: "ChatGPT plan usage per subscription",
		description:
			"The active organization's ChatGPT plan usage per shared account and per member's own plan over a range",
	})
	.input(
		z.object({
			periodDays: z.number().int().min(1).max(MAX_RANGE_DAYS).optional(),
			periodHours: z
				.number()
				.int()
				.min(1)
				.max(24 * MAX_RANGE_DAYS)
				.optional(),
			from: z.coerce.date().optional(),
			to: z.coerce.date().optional(),
		}),
	)
	.output(z.object({ rows: z.array(rowSchema) }))
	.handler(async ({ input, context: { user, session } }) => {
		const organizationId = resolveOrganizationId(undefined, session);
		if (!organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message: "ChatGPT plan usage is shown for an organization",
			});
		}
		await requireOrganizationAdmin(organizationId, user.id).catch(() => {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization owners or admins can view organization AI activity",
			});
		});
		if (!(await isFeatureEnabled("CHATGPT_PLAN", organizationId))) {
			return { rows: [] };
		}

		const { from, to } = resolveRange(input);
		const groups = await getChatGptPlanUsageBySource({
			organizationId,
			from,
			to,
		});
		if (groups.length === 0) {
			return { rows: [] };
		}

		const accounts = new Map(
			(await listChatGptPlanOrgAccounts(organizationId)).map(
				(account) => [account.id, account],
			),
		);
		const memberIds = [
			...new Set(
				groups
					.filter((group) => group.accountId === null && group.userId)
					.map((group) => group.userId as string),
			),
		];
		const members = new Map(
			(OWN_PLAN_USAGE_ROWS === "per-member" && memberIds.length > 0
				? await db.user.findMany({
						where: { id: { in: memberIds } },
						select: { id: true, name: true, email: true },
					})
				: []
			).map((member) => [member.id, member.name || member.email]),
		);

		const drafts = new Map<string, RowDraft>();
		for (const group of groups) {
			const account = group.accountId
				? accounts.get(group.accountId)
				: undefined;
			const draft: Omit<RowDraft, "groups"> = group.accountId
				? {
						key: `account:${group.accountId}`,
						kind: "shared",
						label: account?.label ?? "Removed shared account",
						detail: maskEmail(account?.email ?? null),
					}
				: OWN_PLAN_USAGE_ROWS === "per-member"
					? {
							key: `member:${group.userId ?? "unknown"}`,
							kind: "member",
							label:
								(group.userId && members.get(group.userId)) ||
								null,
							detail: null,
						}
					: {
							key: "members",
							kind: "members",
							label: null,
							detail: null,
						};
			const existing = drafts.get(draft.key);
			if (existing) {
				existing.groups.push(group);
			} else {
				drafts.set(draft.key, { ...draft, groups: [group] });
			}
		}

		const totalUncached = groups.reduce(
			(total, group) =>
				total +
				Math.max(0, group.inputTokens - group.cachedInputTokens),
			0,
		);
		const rows = await Promise.all(
			[...drafts.values()].map((draft) => toRow(draft, totalUncached)),
		);
		rows.sort(
			(a, b) =>
				Number(b.kind === "shared") - Number(a.kind === "shared") ||
				b.uncachedInputTokens - a.uncachedInputTokens,
		);
		return { rows };
	});
