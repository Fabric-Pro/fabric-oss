/**
 * The signed-in person's own ChatGPT plan connection (Fizzy #2939).
 *
 * Every procedure acts on the session's user only. The organization a choice
 * applies to is the session's active organization, resolved server-side and
 * checked against the organizations where the person is a member and the
 * `CHATGPT_PLAN` flag is on. Tokens never leave the server.
 */

import { ORPCError } from "@orpc/server";
import { chatGptPlanSourceExhaustedError } from "@repo/ai/lib/chatgpt-plan/exhaustion-breaker";
import { disconnectChatGptPlan } from "@repo/ai/lib/chatgpt-plan/plan-credentials";
import {
	sharedPlanServesMember,
	sharedPlansServeBackgroundWork,
} from "@repo/ai/lib/chatgpt-plan/pool";
import { backfillChatGptPlanSubscription } from "@repo/ai/lib/chatgpt-plan/subscription-backfill";
import {
	getChatGptPlanCredentialStatus,
	getChatGptPlanUserWindow,
	getChatGptPlanWindowBudget,
	listChatGptPlanOrganizations,
	setChatGptPlanOrgUse,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	chatGptPlanUsageEstimateSchema,
	toChatGptPlanUsageEstimate,
} from "../../../../lib/chatgpt-plan-usage";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { chatGptPlanSharedHereSchema, chatGptPlanShareState } from "./share";

/**
 * When the member's own plan window is spent in this organization: when it
 * resets, and whether the organization's shared plan serves their work
 * meanwhile (Fizzy #2770), so the shell can say so. Null whenever anything
 * needed to tell is missing or fails — the notice is advisory.
 */
async function ownPlanSpentHere(params: {
	userId: string;
	organizationId: string;
}): Promise<{ resetAt: Date | null; servedBySharedPlan: boolean } | null> {
	try {
		const spent = await chatGptPlanSourceExhaustedError({
			kind: "user",
			userId: params.userId,
		});
		if (!spent) {
			return null;
		}
		return {
			resetAt: spent.resetAt,
			servedBySharedPlan: await sharedPlanServesMember(params),
		};
	} catch {
		return null;
	}
}

const organizationSchema = z.object({
	slug: z.string().nullable(),
	name: z.string(),
	enabled: z.boolean(),
});

export const getChatGptPlanStatusProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "GET",
		path: "/users/chatgpt-plan/status",
		tags: ["Users"],
		summary: "Get ChatGPT plan connection",
		description:
			"The signed-in user's ChatGPT plan connection, the organizations that allow it, and an estimate of recent use",
	})
	.output(
		z.object({
			connected: z.boolean(),
			email: z.string().nullable(),
			status: z.enum(["ACTIVE", "NEEDS_RECONNECT"]).nullable(),
			// From the sign-in's subscription claims (Fizzy #2770 G7).
			tier: z.enum(["UNKNOWN", "PLUS", "PRO", "FREE", "TEAM"]).nullable(),
			subscriptionActiveUntil: z.date().nullable(),
			/** The session's organization, when it allows plan use. */
			currentOrganization: organizationSchema
				.extend({
					answered: z.boolean(),
					includeBackgroundJobs: z.boolean(),
				})
				.nullable(),
			organizations: z.array(organizationSchema),
			/**
			 * An advisory estimate of the plan's current window from Fabric's
			 * own calls; ChatGPT Settings → Usage is the real figure.
			 */
			usageEstimate: chatGptPlanUsageEstimateSchema.nullable(),
			/**
			 * One of the organization's shared accounts serves this member's
			 * own work here right now — they have no plan of their own here, or
			 * theirs is spent (Fizzy #2770).
			 */
			sharedPlanServesOwnWork: z.boolean(),
			/**
			 * The organization's shared accounts serve its background jobs here,
			 * so a channel or meeting series linked now has its first history
			 * import run on them (Fizzy #2770 F3).
			 */
			sharedPlansServeBackground: z.boolean(),
			/** The own plan's window is spent here; see `ownPlanSpentHere`. */
			ownPlanSpent: z
				.object({
					resetAt: z.date().nullable(),
					servedBySharedPlan: z.boolean(),
				})
				.nullable(),
			/** The own plan may become one of this organization's shared accounts (Fizzy #2770 I1). */
			canShare: z.boolean(),
			/** Shared accounts here this member connected; only they may take one back. */
			sharedHere: z.array(chatGptPlanSharedHereSchema),
		}),
	)
	.handler(async ({ context: { user, session } }) => {
		const organizationId = resolveOrganizationId(undefined, session);
		const [stored, organizations] = await Promise.all([
			getChatGptPlanCredentialStatus(user.id),
			listChatGptPlanOrganizations({ userId: user.id }),
		]);
		const credential =
			stored &&
			(await backfillChatGptPlanSubscription(
				{ kind: "user", userId: user.id },
				stored,
			));
		const current =
			organizations.find((org) => org.id === organizationId) ?? null;
		const usageEstimate = credential
			? toChatGptPlanUsageEstimate(
					await getChatGptPlanUserWindow({ userId: user.id }),
					await getChatGptPlanWindowBudget({
						kind: "user",
						userId: user.id,
					}),
				)
			: null;
		const ownPlanSpent =
			credential?.status === "ACTIVE" &&
			current?.enabled &&
			organizationId
				? await ownPlanSpentHere({ userId: user.id, organizationId })
				: null;
		const sharedPlanServesOwnWork =
			current && organizationId
				? await sharedPlanServesMember({
						userId: user.id,
						organizationId,
					}).catch(() => false)
				: false;
		const sharedPlansServeBackground = organizationId
			? await sharedPlansServeBackgroundWork(organizationId)
			: false;
		const shareState = await chatGptPlanShareState({
			userId: user.id,
			organizationId,
			hasOwnPlan: credential !== null,
			impersonated: Boolean(session.impersonatedBy),
		});
		return {
			connected: credential !== null,
			email: credential?.email ?? null,
			tier: credential?.tier ?? null,
			subscriptionActiveUntil:
				credential?.subscriptionActiveUntil ?? null,
			status: credential?.status ?? null,
			currentOrganization: current
				? {
						slug: current.slug,
						name: current.name,
						enabled: current.enabled,
						answered: current.answered,
						includeBackgroundJobs: current.includeBackgroundJobs,
					}
				: null,
			organizations: organizations.map(({ slug, name, enabled }) => ({
				slug,
				name,
				enabled,
			})),
			usageEstimate,
			sharedPlanServesOwnWork,
			sharedPlansServeBackground,
			ownPlanSpent,
			...shareState,
		};
	});

export const setChatGptPlanOrganizationUseProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/users/chatgpt-plan/organization-use",
		tags: ["Users"],
		summary: "Use the ChatGPT plan in this organization",
		description:
			"Turn use of the signed-in user's ChatGPT plan on or off in their active organization, and whether it also serves their background jobs and agents; off also answers the one-time prompt",
	})
	.input(
		z.object({
			enabled: z.boolean(),
			/** Only an explicit choice sets this; omitted keeps the stored value. */
			includeBackgroundJobs: z.boolean().optional(),
		}),
	)
	.output(
		z.object({ enabled: z.boolean(), includeBackgroundJobs: z.boolean() }),
	)
	.handler(async ({ context, input }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(undefined, session);
		const allowed = organizationId
			? (
					await listChatGptPlanOrganizations({
						userId: user.id,
						organizationId,
					})
				)[0]
			: undefined;
		if (!allowed) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"This organization does not allow using a ChatGPT plan",
			});
		}
		await setChatGptPlanOrgUse({
			userId: user.id,
			organizationId: allowed.id,
			enabled: input.enabled,
			includeBackgroundJobs: input.includeBackgroundJobs,
		});
		const result = {
			enabled: input.enabled,
			includeBackgroundJobs: input.enabled
				? (input.includeBackgroundJobs ?? allowed.includeBackgroundJobs)
				: false,
		};
		recordAuditFromRequest(context, {
			action: "account.chatgpt_plan.organization_use_changed",
			category: "account",
			outcome: "success",
			severity: result.includeBackgroundJobs ? "warning" : "info",
			organizationId: allowed.id,
			resource: { type: "chatgpt_plan", id: user.id, name: null },
			metadata: result,
		});
		return result;
	});

export const disconnectChatGptPlanProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/users/chatgpt-plan/disconnect",
		tags: ["Users"],
		summary: "Disconnect the ChatGPT plan",
		description:
			"Revoke the signed-in user's ChatGPT plan sign-in at OpenAI and delete it from Fabric",
	})
	.output(z.object({ disconnected: z.boolean() }))
	.handler(async ({ context }) => {
		const disconnected = await disconnectChatGptPlan(context.user.id);
		if (disconnected) {
			recordAuditFromRequest(context, {
				action: "account.chatgpt_plan.disconnected",
				category: "account",
				outcome: "success",
				severity: "info",
				organizationId: null,
				resource: {
					type: "chatgpt_plan",
					id: context.user.id,
					name: null,
				},
			});
		}
		return { disconnected };
	});
