/**
 * The organization's shared ChatGPT plan accounts and its pooling policy
 * (Fizzy #2770).
 *
 * Every procedure acts on the session's active organization, resolved
 * server-side; nothing in the input names an organization. Organization
 * admins and owners manage the accounts and the policy; only an owner may
 * acknowledge the terms, and pooling cannot be turned on before that. Nobody
 * acting as another user may accept the terms, change the policy, or change
 * or disconnect an account. With
 * `CHATGPT_PLAN` or `CHATGPT_PLAN_POOLING` off for the organization every
 * procedure answers NOT_FOUND. Tokens never leave the server.
 */

import { ORPCError } from "@orpc/server";
import { disconnectChatGptPlanOrgAccount } from "@repo/ai/lib/chatgpt-plan/plan-credentials";
import { backfillChatGptPlanSubscriptions } from "@repo/ai/lib/chatgpt-plan/subscription-backfill";
import {
	acknowledgeChatGptPlanOrgTerms,
	type ChatGptPlanOrgAccountSummary,
	type ChatGptPlanOrgPolicyValues,
	getChatGptPlanCredentialStatus,
	getChatGptPlanOrgAccountWindows,
	getChatGptPlanOrgPolicy,
	getChatGptPlanSourceStates,
	getChatGptPlanWindowBudgets,
	getUsersByIds,
	isFeatureEnabled,
	listChatGptPlanOrgAccounts,
	updateChatGptPlanOrgAccount,
	updateChatGptPlanOrgPolicy,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	chatGptPlanUsageEstimateSchema,
	toChatGptPlanUsageEstimate,
} from "../../../../lib/chatgpt-plan-usage";
import { maskEmail } from "../../../../lib/mask-email";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

const EMPTY_WINDOW = {
	windowStart: null,
	resetsAt: null,
	requests: 0,
	inputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	lastRequestAt: null,
	topConsumers: [],
	inputTokensByUser: {},
};

const OWNER_ONLY_TERMS = "Only an organization owner can accept these terms.";

interface PoolCaller {
	organizationId: string;
	userId: string;
	role: string;
}

async function poolingAvailable(organizationId: string): Promise<boolean> {
	const [plan, pooling] = await Promise.all([
		isFeatureEnabled("CHATGPT_PLAN", organizationId),
		isFeatureEnabled("CHATGPT_PLAN_POOLING", organizationId),
	]);
	return plan && pooling;
}

/**
 * The session's organization, when pooling is available there and the
 * caller is one of its admins or owners.
 */
async function requirePoolAdmin(context: {
	user: { id: string };
	session: { activeOrganizationId?: string | null };
}): Promise<PoolCaller> {
	const organizationId = resolveOrganizationId(undefined, context.session);
	if (!organizationId || !(await poolingAvailable(organizationId))) {
		throw new ORPCError("NOT_FOUND", {
			message: "ChatGPT plan pooling is not available here",
		});
	}
	const membership = await requireOrgMembership(
		context.user.id,
		organizationId,
		["admin", "owner"],
	);
	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "You must be an admin or owner of this organization",
		});
	}
	return { organizationId, userId: context.user.id, role: membership.role };
}

/**
 * Accepting the terms, changing the policy and changing or unbinding an
 * account are the admin's own acts; someone acting as them may read the pool, never change
 * those.
 */
function refuseImpersonated(context: {
	session: { impersonatedBy?: string | null };
}): void {
	if (context.session.impersonatedBy) {
		throw new ORPCError("FORBIDDEN", {
			message: "This change cannot be made while acting as another user.",
		});
	}
}

const tierSchema = z.enum(["UNKNOWN", "PLUS", "PRO", "FREE", "TEAM"]);
const backgroundFallbackSchema = z.enum(["NEVER", "AUTO"]);

const accountSchema = z.object({
	id: z.string(),
	label: z.string(),
	maskedEmail: z.string().nullable(),
	status: z.enum(["ACTIVE", "NEEDS_RECONNECT"]),
	tier: tierSchema,
	/** When the paid subscription runs out, per the sign-in (Fizzy #2770 G7). */
	subscriptionActiveUntil: z.date().nullable(),
	enabled: z.boolean(),
	serveInteractive: z.boolean(),
	serveBackground: z.boolean(),
	/** Fair share: the most of the window one member may use, in percent; null = no cap. */
	maxMemberSharePct: z.number().int().nullable(),
	lastUsedAt: z.date().nullable(),
	createdAt: z.date(),
	/** Set while the account's window is known to be spent. */
	coolingUntil: z.date().nullable(),
	/** Who connected it; only they may take it back as their own plan (Fizzy #2770 I1). */
	connectedByName: z.string().nullable(),
	viewerIsConnector: z.boolean(),
	// An estimate of the account's current window from Fabric's own calls;
	// labelled as one, since anything else spending the account is unseen.
	usageEstimate: chatGptPlanUsageEstimateSchema,
});

const policySchema = z.object({
	poolingEnabled: z.boolean(),
	apiFallbackBackground: backgroundFallbackSchema,
	headroomPct: z.number(),
	termsAcknowledged: z.boolean(),
	termsAcknowledgedAt: z.date().nullable(),
});

function toPolicyOutput(
	policy: ChatGptPlanOrgPolicyValues,
): z.infer<typeof policySchema> {
	return {
		poolingEnabled: policy.poolingEnabled,
		apiFallbackBackground: policy.apiFallbackBackground,
		headroomPct: policy.headroomPct,
		termsAcknowledged: policy.termsAcknowledgedAt !== null,
		termsAcknowledgedAt: policy.termsAcknowledgedAt,
	};
}

function accountResource(
	account: Pick<ChatGptPlanOrgAccountSummary, "id" | "label">,
) {
	return {
		type: "chatgpt_plan_org_account",
		id: account.id,
		name: account.label,
	};
}

export const getChatGptPlanPoolProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/organizations/chatgpt-plan-pool",
		tags: ["Organizations"],
		summary: "Get the organization's shared ChatGPT plan accounts",
		description:
			"The active organization's shared ChatGPT plan accounts with an estimate of each one's recent use, its pooling policy, and whether the caller may accept the pooling terms",
	})
	.output(
		z.object({
			accounts: z.array(accountSchema),
			policy: policySchema,
			viewer: z.object({
				isOwner: z.boolean(),
				/** A connector with an own plan must disconnect it before taking an account back. */
				hasOwnPlan: z.boolean(),
			}),
		}),
	)
	.handler(async ({ context }) => {
		const caller = await requirePoolAdmin(context);
		const { organizationId } = caller;
		const accounts = await backfillChatGptPlanSubscriptions(
			await listChatGptPlanOrgAccounts(organizationId),
			(account) => ({
				kind: "org",
				organizationId,
				accountId: account.id,
			}),
		);
		const ids = accounts.map((account) => account.id);
		const now = Date.now();
		const [policy, windows, budgets, states, connectors, ownPlan] =
			await Promise.all([
				getChatGptPlanOrgPolicy(organizationId),
				getChatGptPlanOrgAccountWindows({
					organizationId,
					accountIds: ids,
					now: new Date(now),
				}),
				getChatGptPlanWindowBudgets("ORG", ids),
				getChatGptPlanSourceStates("ORG", ids),
				getUsersByIds([
					...new Set(
						accounts.map((account) => account.connectedByUserId),
					),
				]),
				getChatGptPlanCredentialStatus(context.user.id),
			]);
		const openUntil = new Map(
			states.map((state) => [state.sourceId, state.openUntil]),
		);
		return {
			accounts: accounts.map((account) => {
				const window = windows.get(account.id);
				const cooling = openUntil.get(account.id) ?? null;
				return {
					id: account.id,
					label: account.label,
					maskedEmail: maskEmail(account.email),
					status: account.status,
					tier: account.tier,
					subscriptionActiveUntil: account.subscriptionActiveUntil,
					enabled: account.enabled,
					serveInteractive: account.serveInteractive,
					serveBackground: account.serveBackground,
					maxMemberSharePct: account.maxMemberSharePct,
					lastUsedAt: account.lastUsedAt,
					createdAt: account.createdAt,
					coolingUntil:
						cooling && cooling.getTime() > now ? cooling : null,
					connectedByName:
						connectors.get(account.connectedByUserId)?.name ?? null,
					viewerIsConnector:
						account.connectedByUserId === context.user.id,
					usageEstimate: toChatGptPlanUsageEstimate(
						window ?? EMPTY_WINDOW,
						budgets.get(account.id) ?? 0,
					),
				};
			}),
			policy: toPolicyOutput(policy),
			viewer: {
				isOwner: caller.role === "owner",
				hasOwnPlan: ownPlan !== null,
			},
		};
	});

const ACCOUNT_FIELDS = [
	"label",
	"enabled",
	"serveInteractive",
	"serveBackground",
	"tier",
	"maxMemberSharePct",
] as const;

export const updateChatGptPlanPoolAccountProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_UPDATE))
	.route({
		method: "POST",
		path: "/organizations/chatgpt-plan-pool/accounts/update",
		tags: ["Organizations"],
		summary: "Update a shared ChatGPT plan account",
		description:
			"Rename a shared ChatGPT plan account, or change whether it is enabled, which work it serves and the most of its window one member may use",
	})
	.input(
		z.object({
			accountId: z.string().min(1),
			label: z.string().trim().min(1).max(80).optional(),
			enabled: z.boolean().optional(),
			serveInteractive: z.boolean().optional(),
			serveBackground: z.boolean().optional(),
			// The plan type is the admin's to state (OpenAI's ID token for
			// Fabric's client does not carry it); UNKNOWN clears it to "Not set".
			tier: tierSchema.optional(),
			maxMemberSharePct: z
				.number()
				.int()
				.min(1)
				.max(100)
				.nullable()
				.optional(),
		}),
	)
	.output(z.object({ updated: z.literal(true) }))
	.handler(async ({ context, input }) => {
		refuseImpersonated(context);
		const { organizationId } = await requirePoolAdmin(context);
		const { accountId, ...patch } = input;
		const result = await updateChatGptPlanOrgAccount({
			organizationId,
			accountId,
			patch,
		});
		if (!result) {
			throw new ORPCError("NOT_FOUND", {
				message: "No such ChatGPT plan account in this organization",
			});
		}
		const changed = ACCOUNT_FIELDS.filter(
			(field) => result.before[field] !== result.after[field],
		);
		if (changed.length > 0) {
			recordAuditFromRequest(context, {
				action: "org.chatgpt_plan.account_updated",
				category: "org",
				outcome: "success",
				severity:
					result.after.serveInteractive &&
					!result.before.serveInteractive
						? "warning"
						: "info",
				organizationId,
				resource: accountResource(result.after),
				metadata: {
					before: Object.fromEntries(
						changed.map((field) => [field, result.before[field]]),
					),
					after: Object.fromEntries(
						changed.map((field) => [field, result.after[field]]),
					),
				},
			});
		}
		return { updated: true as const };
	});

export const disconnectChatGptPlanPoolAccountProcedure =
	tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_UPDATE))
		.route({
			method: "POST",
			path: "/organizations/chatgpt-plan-pool/accounts/disconnect",
			tags: ["Organizations"],
			summary: "Disconnect a shared ChatGPT plan account",
			description:
				"Revoke a shared ChatGPT plan account's sign-in at OpenAI and delete it from Fabric",
		})
		.input(z.object({ accountId: z.string().min(1) }))
		.output(z.object({ disconnected: z.literal(true) }))
		.handler(async ({ context, input }) => {
			refuseImpersonated(context);
			const { organizationId } = await requirePoolAdmin(context);
			const account = (
				await listChatGptPlanOrgAccounts(organizationId)
			).find((candidate) => candidate.id === input.accountId);
			const disconnected =
				account !== undefined &&
				(await disconnectChatGptPlanOrgAccount({
					organizationId,
					accountId: input.accountId,
				}));
			if (!account || !disconnected) {
				throw new ORPCError("NOT_FOUND", {
					message:
						"No such ChatGPT plan account in this organization",
				});
			}
			recordAuditFromRequest(context, {
				action: "org.chatgpt_plan.account_disconnected",
				category: "org",
				outcome: "success",
				severity: "warning",
				organizationId,
				resource: accountResource(account),
			});
			return { disconnected: true as const };
		});

const POLICY_FIELDS = [
	"poolingEnabled",
	"apiFallbackBackground",
	"headroomPct",
] as const;

export const updateChatGptPlanPoolPolicyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_UPDATE))
	.route({
		method: "POST",
		path: "/organizations/chatgpt-plan-pool/policy",
		tags: ["Organizations"],
		summary: "Update the ChatGPT plan pooling policy",
		description:
			"Turn pooling of the organization's shared ChatGPT plan accounts on or off, and choose what happens when every plan is spent",
	})
	.input(
		z.object({
			poolingEnabled: z.boolean().optional(),
			apiFallbackBackground: backgroundFallbackSchema.optional(),
			headroomPct: z.number().int().min(0).max(90).optional(),
		}),
	)
	.output(policySchema)
	.handler(async ({ context, input }) => {
		refuseImpersonated(context);
		const { organizationId } = await requirePoolAdmin(context);
		if (input.poolingEnabled === true) {
			const current = await getChatGptPlanOrgPolicy(organizationId);
			if (current.termsAcknowledgedAt === null) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message:
						"An organization owner must accept the pooling terms before pooling can be turned on.",
				});
			}
		}
		const { before, after } = await updateChatGptPlanOrgPolicy({
			organizationId,
			patch: input,
		});
		const changed = POLICY_FIELDS.filter(
			(field) => before[field] !== after[field],
		);
		if (changed.length > 0) {
			recordAuditFromRequest(context, {
				action: "org.chatgpt_plan.policy_changed",
				category: "org",
				outcome: "success",
				// Background work billed to the organization's provider without
				// anyone asking is the setting an auditor looks for.
				severity:
					after.apiFallbackBackground === "AUTO" ||
					(after.poolingEnabled && !before.poolingEnabled)
						? "warning"
						: "info",
				organizationId,
				resource: {
					type: "chatgpt_plan_org_policy",
					id: organizationId,
					name: null,
				},
				metadata: {
					before: Object.fromEntries(
						changed.map((field) => [field, before[field]]),
					),
					after: Object.fromEntries(
						changed.map((field) => [field, after[field]]),
					),
				},
			});
		}
		return toPolicyOutput(after);
	});

export const acknowledgeChatGptPlanPoolTermsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_UPDATE))
	.route({
		method: "POST",
		path: "/organizations/chatgpt-plan-pool/acknowledge-terms",
		tags: ["Organizations"],
		summary: "Accept the ChatGPT plan pooling terms",
		description:
			"An organization owner accepts the terms for sharing ChatGPT plan accounts across the organization; pooling cannot be turned on before this",
	})
	.output(policySchema)
	.handler(async ({ context }) => {
		refuseImpersonated(context);
		const { organizationId, userId, role } =
			await requirePoolAdmin(context);
		if (role !== "owner") {
			throw new ORPCError("FORBIDDEN", { message: OWNER_ONLY_TERMS });
		}
		const current = await getChatGptPlanOrgPolicy(organizationId);
		// The first acceptance stands; a second click records nothing new.
		if (current.termsAcknowledgedAt !== null) {
			return toPolicyOutput(current);
		}
		const policy = await acknowledgeChatGptPlanOrgTerms({
			organizationId,
			userId,
		});
		recordAuditFromRequest(context, {
			action: "org.chatgpt_plan.terms_acknowledged",
			category: "org",
			outcome: "success",
			severity: "warning",
			organizationId,
			resource: {
				type: "chatgpt_plan_org_policy",
				id: organizationId,
				name: null,
			},
		});
		return toPolicyOutput(policy);
	});
