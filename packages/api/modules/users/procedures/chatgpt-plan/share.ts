/**
 * Moving the signed-in member's ChatGPT account between their own plan and
 * the organization's shared accounts (Fizzy #2770 I1). Both moves act on the
 * session's user and the session's organization only, and neither may be
 * made while an admin acts as the member.
 */

import { ORPCError } from "@orpc/server";
import {
	ChatGptPlanMoveError,
	shareOwnChatGptPlan,
	takeBackSharedChatGptPlan,
} from "@repo/ai/lib/chatgpt-plan/plan-move";
import {
	getChatGptPlanOrgPolicy,
	isFeatureEnabled,
	listChatGptPlanOrgAccounts,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { maskEmail } from "../../../../lib/mask-email";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../../organizations/lib/membership";

const MEMBER_ROLES = ["owner", "admin", "member"];

/** Whether the organization takes shared ChatGPT plans from its members now. */
async function sharingOpen(organizationId: string): Promise<boolean> {
	const [plan, pooling, policy] = await Promise.all([
		isFeatureEnabled("CHATGPT_PLAN", organizationId),
		isFeatureEnabled("CHATGPT_PLAN_POOLING", organizationId),
		getChatGptPlanOrgPolicy(organizationId),
	]);
	return plan && pooling && policy.termsAcknowledgedAt !== null;
}

export const chatGptPlanSharedHereSchema = z.object({
	accountId: z.string(),
	label: z.string(),
	maskedEmail: z.string().nullable(),
	status: z.enum(["ACTIVE", "NEEDS_RECONNECT"]),
	tier: z.enum(["UNKNOWN", "PLUS", "PRO", "FREE", "TEAM"]),
	enabled: z.boolean(),
});

/**
 * What the member's own plan card shows about sharing in the session's
 * organization: whether their own plan may be shared there, and the shared
 * accounts there they connected — which only they may take back. Advisory:
 * a fault reads as "nothing to offer".
 */
export async function chatGptPlanShareState(params: {
	userId: string;
	organizationId: string | null | undefined;
	hasOwnPlan: boolean;
	impersonated: boolean;
}): Promise<{
	canShare: boolean;
	sharedHere: Array<z.infer<typeof chatGptPlanSharedHereSchema>>;
}> {
	const { userId, organizationId } = params;
	if (!organizationId) {
		return { canShare: false, sharedHere: [] };
	}
	try {
		const [open, accounts] = await Promise.all([
			sharingOpen(organizationId),
			listChatGptPlanOrgAccounts(organizationId),
		]);
		return {
			canShare: params.hasOwnPlan && !params.impersonated && open,
			sharedHere: accounts
				.filter((account) => account.connectedByUserId === userId)
				.map((account) => ({
					accountId: account.id,
					label: account.label,
					maskedEmail: maskEmail(account.email),
					status: account.status,
					tier: account.tier,
					enabled: account.enabled,
				})),
		};
	} catch {
		return { canShare: false, sharedHere: [] };
	}
}

function refuseImpersonated(context: {
	session: { impersonatedBy?: string | null };
}): void {
	if (context.session.impersonatedBy) {
		throw new ORPCError("FORBIDDEN", {
			message: "This change cannot be made while acting as another user.",
		});
	}
}

async function requireMemberOrganization(context: {
	user: { id: string };
	session: { activeOrganizationId?: string | null };
}): Promise<string> {
	const organizationId = resolveOrganizationId(undefined, context.session);
	if (
		!organizationId ||
		!(await requireOrgMembership(
			context.user.id,
			organizationId,
			MEMBER_ROLES,
		))
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Open the organization to share or take back a plan in.",
		});
	}
	return organizationId;
}

const MOVE_MESSAGES: Record<
	ChatGptPlanMoveError["reason"],
	{ code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT"; message: string }
> = {
	not_found: {
		code: "NOT_FOUND",
		message: "There is no ChatGPT plan here to move.",
	},
	not_connector: {
		code: "FORBIDDEN",
		message:
			"Only the member who connected this account can take it back as their own plan. Admins can disconnect it instead.",
	},
	personal_exists: {
		code: "CONFLICT",
		message:
			"You already have a ChatGPT plan of your own. Disconnect it in Account settings → AI Providers, then take this account back.",
	},
	already_shared: {
		code: "CONFLICT",
		message:
			"This ChatGPT account is already shared by an organization. If you connected it there, take it back from that organization first.",
	},
};

function toOrpcError(error: unknown): unknown {
	if (!(error instanceof ChatGptPlanMoveError)) {
		return error;
	}
	const { code, message } = MOVE_MESSAGES[error.reason];
	return new ORPCError(code, { message });
}

export const shareChatGptPlanProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/users/chatgpt-plan/share",
		tags: ["Users"],
		summary: "Share your ChatGPT plan with this organization",
		description:
			"Turn the signed-in user's own ChatGPT plan into a shared account of their active organization, without signing in again; only they can take it back",
	})
	.output(z.object({ accountId: z.string() }))
	.handler(async ({ context }) => {
		refuseImpersonated(context);
		const organizationId = await requireMemberOrganization(context);
		if (!(await sharingOpen(organizationId))) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"This organization doesn't take shared ChatGPT plans yet: sharing must be on and an owner must accept its terms.",
			});
		}
		const existing = await listChatGptPlanOrgAccounts(organizationId);
		const name = context.user.name?.trim();
		const label = name
			? `${name}'s ChatGPT plan`
			: `ChatGPT plan ${existing.length + 1}`;
		let moved: { accountId: string };
		try {
			moved = await shareOwnChatGptPlan({
				userId: context.user.id,
				organizationId,
				label,
			});
		} catch (error) {
			throw toOrpcError(error);
		}
		recordAuditFromRequest(context, {
			action: "org.chatgpt_plan.account_shared_from_personal",
			category: "org",
			outcome: "success",
			severity: "info",
			organizationId,
			resource: {
				type: "chatgpt_plan_org_account",
				id: moved.accountId,
				name: label,
			},
			metadata: { fromUserId: context.user.id },
		});
		return moved;
	});

export const takeBackChatGptPlanProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/users/chatgpt-plan/take-back",
		tags: ["Users"],
		summary: "Take a shared ChatGPT plan back as your own",
		description:
			"Turn a shared ChatGPT plan account the signed-in user connected in their active organization back into their own plan, without signing in again",
	})
	.input(z.object({ accountId: z.string().min(1) }))
	.output(z.object({ ok: z.literal(true) }))
	.handler(async ({ context, input }) => {
		refuseImpersonated(context);
		const organizationId = await requireMemberOrganization(context);
		const account = (await listChatGptPlanOrgAccounts(organizationId)).find(
			(row) => row.id === input.accountId,
		);
		try {
			await takeBackSharedChatGptPlan({
				userId: context.user.id,
				organizationId,
				accountId: input.accountId,
			});
		} catch (error) {
			throw toOrpcError(error);
		}
		recordAuditFromRequest(context, {
			action: "org.chatgpt_plan.account_returned_to_personal",
			category: "org",
			outcome: "success",
			severity: "info",
			organizationId,
			resource: {
				type: "chatgpt_plan_org_account",
				id: input.accountId,
				name: account?.label ?? null,
			},
			metadata: { toUserId: context.user.id },
		});
		return { ok: true as const };
	});
