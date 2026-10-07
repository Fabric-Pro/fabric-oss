/**
 * ChatGPT plan credentials and per-organization use (Fizzy #2939).
 *
 * `ChatGptPlanCredential` is one person's sign-in and has no organizationId,
 * so every function here takes the owner's `userId` and filters on it; none
 * reads by organization. Tokens arrive and leave already encrypted — the
 * encryption and the refresh live in `@repo/ai`'s `lib/chatgpt-plan`.
 *
 * `ChatGptPlanOrgUse` is per user within an organization, so its readers and
 * writers always filter on BOTH ids.
 */

import { db } from "../client";
import type {
	ChatGptPlanCredential,
	ChatGptPlanCredentialStatus,
} from "../generated/client";
import { isFeatureEnabled } from "./feature-flags";

export type { ChatGptPlanCredential, ChatGptPlanCredentialStatus };

export interface ChatGptPlanCredentialWrite {
	userId: string;
	email: string | null;
	subject: string;
	clientId: string;
	hostId: string;
	encryptedAccessToken: string;
	encryptedRefreshToken: string;
	encryptedIdToken: string | null;
	accessTokenExpiresAt: Date;
	earliestRefreshAt: Date | null;
	scopes: string[];
}

/** The fields the status surfaces may show; never a token. */
export const CHATGPT_PLAN_CREDENTIAL_PUBLIC_SELECT = {
	email: true,
	status: true,
	createdAt: true,
	updatedAt: true,
	lastUsedAt: true,
} as const;

export function getChatGptPlanCredential(
	userId: string,
): Promise<ChatGptPlanCredential | null> {
	return db.chatGptPlanCredential.findUnique({ where: { userId } });
}

export function getChatGptPlanCredentialStatus(userId: string) {
	return db.chatGptPlanCredential.findUnique({
		where: { userId },
		select: CHATGPT_PLAN_CREDENTIAL_PUBLIC_SELECT,
	});
}

/**
 * Stores a fresh sign-in. A new sign-in always clears NEEDS_RECONNECT, and
 * replaces every token, so a reconnect as a different ChatGPT account never
 * keeps the old account's refresh token.
 */
export async function upsertChatGptPlanCredential(
	input: ChatGptPlanCredentialWrite,
): Promise<void> {
	const { userId, ...fields } = input;
	await db.chatGptPlanCredential.upsert({
		where: { userId },
		create: { userId, ...fields, status: "ACTIVE" },
		update: { ...fields, status: "ACTIVE" },
	});
}

/**
 * Whether anyone has this ChatGPT account connected as their own plan.
 * Says nothing about who: an admin connecting it as an organization's shared
 * account is refused without learning whose plan it is (Fizzy #2770).
 */
export async function isChatGptPlanPersonalSubject(
	subject: string,
): Promise<boolean> {
	const found = await db.chatGptPlanCredential.findFirst({
		where: { subject },
		select: { id: true },
	});
	return found !== null;
}

/** Deletes the sign-in and its breaker row, which has no foreign key to cascade from. */
export async function deleteChatGptPlanCredential(
	userId: string,
): Promise<boolean> {
	const [{ count }] = await db.$transaction([
		db.chatGptPlanCredential.deleteMany({ where: { userId } }),
		db.chatGptPlanSourceState.deleteMany({
			where: { sourceKind: "USER", sourceId: userId },
		}),
	]);
	return count > 0;
}

export async function touchChatGptPlanCredential(
	userId: string,
): Promise<void> {
	await db.chatGptPlanCredential.updateMany({
		where: { userId },
		data: { lastUsedAt: new Date() },
	});
}

/**
 * This person's choice for this organization, when they turned the plan on
 * here and have a credential (in any state); null otherwise. The routing
 * gate's one database read beyond the flag.
 */
export async function getActiveChatGptPlanOrgUse(params: {
	userId: string;
	organizationId: string;
}): Promise<{
	includeBackgroundJobs: boolean;
	credentialStatus: ChatGptPlanCredentialStatus;
} | null> {
	const row = await db.chatGptPlanOrgUse.findUnique({
		where: {
			userId_organizationId: {
				userId: params.userId,
				organizationId: params.organizationId,
			},
		},
		select: {
			enabled: true,
			includeBackgroundJobs: true,
			user: {
				select: { chatGptPlanCredential: { select: { status: true } } },
			},
		},
	});
	const credentialStatus = row?.user.chatGptPlanCredential?.status;
	if (row?.enabled !== true || !credentialStatus) {
		return null;
	}
	return {
		includeBackgroundJobs: row.includeBackgroundJobs,
		credentialStatus,
	};
}

/**
 * Whether this person deliberately keeps their own work here on the
 * organization's billing: they have a ChatGPT plan connected and turned it
 * off for this organization (or declined the prompt), as opposed to never
 * having connected one or never having answered. Such a member stays on the
 * organization's provider rather than its shared plans (Fizzy #2770).
 */
export async function hasDeclinedChatGptPlanInOrganization(params: {
	userId: string;
	organizationId: string;
}): Promise<boolean> {
	const row = await db.chatGptPlanOrgUse.findUnique({
		where: {
			userId_organizationId: {
				userId: params.userId,
				organizationId: params.organizationId,
			},
		},
		select: {
			enabled: true,
			user: {
				select: { chatGptPlanCredential: { select: { id: true } } },
			},
		},
	});
	return row?.enabled === false && row.user.chatGptPlanCredential !== null;
}

/**
 * Records the person's choice for one organization. `includeBackgroundJobs`
 * is left as it is when omitted, and is always cleared when the plan is
 * turned off here, so turning it back on never silently resumes background use.
 */
export async function setChatGptPlanOrgUse(params: {
	userId: string;
	organizationId: string;
	enabled: boolean;
	includeBackgroundJobs?: boolean;
}): Promise<void> {
	const { userId, organizationId, enabled } = params;
	const includeBackgroundJobs = enabled
		? params.includeBackgroundJobs
		: false;
	await db.chatGptPlanOrgUse.upsert({
		where: { userId_organizationId: { userId, organizationId } },
		create: {
			userId,
			organizationId,
			enabled,
			includeBackgroundJobs: includeBackgroundJobs ?? false,
		},
		update: {
			enabled,
			...(includeBackgroundJobs !== undefined && {
				includeBackgroundJobs,
			}),
		},
	});
}

export interface ChatGptPlanOrganization {
	id: string;
	slug: string | null;
	name: string;
	/** The person's own choice; false also when they never answered. */
	enabled: boolean;
	/** Whether they answered at all, so the prompt is offered only once. */
	answered: boolean;
	includeBackgroundJobs: boolean;
}

/**
 * The organizations this person belongs to where `CHATGPT_PLAN` is on, with
 * their own choice in each. `organizationId` narrows it to one organization,
 * for a credential bound to one.
 */
export async function listChatGptPlanOrganizations(params: {
	userId: string;
	organizationId?: string;
}): Promise<ChatGptPlanOrganization[]> {
	const memberships = await db.member.findMany({
		where: {
			userId: params.userId,
			...(params.organizationId && {
				organizationId: params.organizationId,
			}),
		},
		select: {
			organization: { select: { id: true, slug: true, name: true } },
		},
	});
	const flagged = (
		await Promise.all(
			memberships.map(async ({ organization }) =>
				(await isFeatureEnabled("CHATGPT_PLAN", organization.id))
					? organization
					: null,
			),
		)
	).filter((org) => org !== null);
	if (flagged.length === 0) {
		return [];
	}
	const uses = await db.chatGptPlanOrgUse.findMany({
		where: {
			userId: params.userId,
			organizationId: { in: flagged.map((org) => org.id) },
		},
		select: {
			organizationId: true,
			enabled: true,
			includeBackgroundJobs: true,
		},
	});
	const byOrg = new Map(uses.map((use) => [use.organizationId, use]));
	return flagged.map((org) => ({
		id: org.id,
		slug: org.slug,
		name: org.name,
		enabled: byOrg.get(org.id)?.enabled === true,
		answered: byOrg.has(org.id),
		includeBackgroundJobs:
			byOrg.get(org.id)?.includeBackgroundJobs === true,
	}));
}

/**
 * What this person's own plan calls used through Fabric since `since`, across
 * every organization — the plan's window is the person's, not a tenant's.
 * Their calls on an organization's shared account carry that account's id in
 * `providerConfigId` and spend its window, not theirs, so they are left out
 * (Fizzy #2770). Uses the (userId, createdAt) index.
 */
export async function getChatGptPlanUsageSince(params: {
	userId: string;
	since: Date;
}): Promise<{ requests: number; inputTokens: number; outputTokens: number }> {
	const totals = await db.aiUsageLog.aggregate({
		where: {
			userId: params.userId,
			createdAt: { gte: params.since },
			provider: "OPENAI_CHATGPT_PLAN",
			providerConfigId: null,
		},
		_count: { _all: true },
		_sum: { inputTokens: true, outputTokens: true },
	});
	return {
		requests: totals._count._all,
		inputTokens: totals._sum.inputTokens ?? 0,
		outputTokens: totals._sum.outputTokens ?? 0,
	};
}
