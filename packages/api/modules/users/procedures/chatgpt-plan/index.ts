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
import { sharedPlanServesMember } from "@repo/ai/lib/chatgpt-plan/pool";
import {
	getChatGptPlanCredentialStatus,
	getChatGptPlanUsageSince,
	listChatGptPlanOrganizations,
	setChatGptPlanOrgUse,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

// ChatGPT plans meter usage in rolling five-hour windows that OpenAI does not
// expose. The share below is an advisory estimate of how much of such a window
// Fabric alone used, against a rough allowance for a Plus plan; ChatGPT
// Settings → Usage is the real figure.
const PLAN_WINDOW_MS = 5 * 60 * 60_000;
const ESTIMATED_WINDOW_INPUT_TOKENS = 750_000;

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
			/** The session's organization, when it allows plan use. */
			currentOrganization: organizationSchema
				.extend({
					answered: z.boolean(),
					includeBackgroundJobs: z.boolean(),
				})
				.nullable(),
			organizations: z.array(organizationSchema),
			usageEstimate: z
				.object({
					windowHours: z.number(),
					requests: z.number(),
					inputTokens: z.number(),
					outputTokens: z.number(),
					estimatedPercent: z.number(),
				})
				.nullable(),
			/** The own plan's window is spent here; see `ownPlanSpentHere`. */
			ownPlanSpent: z
				.object({
					resetAt: z.date().nullable(),
					servedBySharedPlan: z.boolean(),
				})
				.nullable(),
		}),
	)
	.handler(async ({ context: { user, session } }) => {
		const organizationId = resolveOrganizationId(undefined, session);
		const [credential, organizations] = await Promise.all([
			getChatGptPlanCredentialStatus(user.id),
			listChatGptPlanOrganizations({ userId: user.id }),
		]);
		const current =
			organizations.find((org) => org.id === organizationId) ?? null;
		const usage = credential
			? await getChatGptPlanUsageSince({
					userId: user.id,
					since: new Date(Date.now() - PLAN_WINDOW_MS),
				})
			: null;
		const ownPlanSpent =
			credential?.status === "ACTIVE" &&
			current?.enabled &&
			organizationId
				? await ownPlanSpentHere({ userId: user.id, organizationId })
				: null;
		return {
			connected: credential !== null,
			email: credential?.email ?? null,
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
			usageEstimate: usage
				? {
						windowHours: PLAN_WINDOW_MS / 3_600_000,
						...usage,
						estimatedPercent: Math.min(
							100,
							Math.round(
								(usage.inputTokens /
									ESTIMATED_WINDOW_INPUT_TOKENS) *
									100,
							),
						),
					}
				: null,
			ownPlanSpent,
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
