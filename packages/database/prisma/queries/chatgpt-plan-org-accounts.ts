/**
 * ChatGPT plan accounts an organization connected for its shared work, and
 * its pooling policy (Fizzy #2770).
 *
 * Both tables belong to the organization, so every function here takes the
 * `organizationId` the caller resolved from the session or the job, and every
 * read and write filters on it — a write by account id alone could reach
 * another tenant's row. Tokens arrive and leave already encrypted; the
 * encryption and the refresh live in `@repo/ai`'s `lib/chatgpt-plan`.
 */

import { db } from "../client";
import {
	type ChatGptPlanApiFallbackBackground,
	type ChatGptPlanApiFallbackInteractive,
	type ChatGptPlanOrgAccount,
	type ChatGptPlanOrgPolicy,
	type ChatGptPlanTier,
	Prisma,
} from "../generated/client";
import { isFeatureEnabled } from "./feature-flags";

export type {
	ChatGptPlanApiFallbackBackground,
	ChatGptPlanApiFallbackInteractive,
	ChatGptPlanOrgAccount,
	ChatGptPlanOrgPolicy,
	ChatGptPlanTier,
};

/**
 * The ChatGPT account is already connected to another organization. One
 * account serves at most one organization (`subject` is unique), and the
 * caller must not learn which one.
 */
export class ChatGptPlanSubjectBoundElsewhereError extends Error {
	constructor() {
		super(
			"This ChatGPT account is already connected to another organization",
		);
		this.name = "ChatGptPlanSubjectBoundElsewhereError";
	}
}

/** The fields the settings surfaces may show; never a token. */
export const CHATGPT_PLAN_ORG_ACCOUNT_PUBLIC_SELECT = {
	id: true,
	label: true,
	email: true,
	status: true,
	tier: true,
	enabled: true,
	serveInteractive: true,
	serveBackground: true,
	connectedByUserId: true,
	lastUsedAt: true,
	createdAt: true,
	updatedAt: true,
} as const;

export type ChatGptPlanOrgAccountSummary =
	Prisma.ChatGptPlanOrgAccountGetPayload<{
		select: typeof CHATGPT_PLAN_ORG_ACCOUNT_PUBLIC_SELECT;
	}>;

export function listChatGptPlanOrgAccounts(
	organizationId: string,
): Promise<ChatGptPlanOrgAccountSummary[]> {
	return db.chatGptPlanOrgAccount.findMany({
		where: { organizationId },
		select: CHATGPT_PLAN_ORG_ACCOUNT_PUBLIC_SELECT,
		orderBy: { createdAt: "asc" },
	});
}

/** The full row, tokens included, for the server's own refresh and calls. */
export function getChatGptPlanOrgAccount(params: {
	organizationId: string;
	accountId: string;
}): Promise<ChatGptPlanOrgAccount | null> {
	return db.chatGptPlanOrgAccount.findFirst({
		where: { id: params.accountId, organizationId: params.organizationId },
	});
}

/**
 * Whether this ChatGPT account is already one of any organization's shared
 * accounts. Says nothing about which: a person connecting it as their own
 * plan is refused without learning the organization.
 */
export async function isChatGptPlanOrgAccountSubject(
	subject: string,
): Promise<boolean> {
	const found = await db.chatGptPlanOrgAccount.findUnique({
		where: { subject },
		select: { id: true },
	});
	return found !== null;
}

export interface ChatGptPlanOrgAccountWrite {
	organizationId: string;
	connectedByUserId: string;
	label: string;
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

/**
 * Stores a fresh sign-in for the organization. Reconnecting an account the
 * organization already has replaces its tokens and clears NEEDS_RECONNECT,
 * keeping its label and serving toggles.
 *
 * @throws ChatGptPlanSubjectBoundElsewhereError when the ChatGPT account is
 *   connected to another organization, including when two organizations
 *   race to connect it.
 */
export async function upsertChatGptPlanOrgAccount(
	input: ChatGptPlanOrgAccountWrite,
): Promise<{ id: string; created: boolean }> {
	const { organizationId, label, subject, ...tokens } = input;
	const existing = await db.chatGptPlanOrgAccount.findUnique({
		where: { subject },
		select: { id: true, organizationId: true },
	});
	if (existing && existing.organizationId !== organizationId) {
		throw new ChatGptPlanSubjectBoundElsewhereError();
	}
	try {
		if (existing) {
			await db.chatGptPlanOrgAccount.updateMany({
				where: { id: existing.id, organizationId },
				data: { ...tokens, status: "ACTIVE" },
			});
			return { id: existing.id, created: false };
		}
		const created = await db.chatGptPlanOrgAccount.create({
			data: {
				organizationId,
				label,
				subject,
				...tokens,
				status: "ACTIVE",
			},
			select: { id: true },
		});
		return { id: created.id, created: true };
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002"
		) {
			throw new ChatGptPlanSubjectBoundElsewhereError();
		}
		throw error;
	}
}

export interface ChatGptPlanOrgAccountPatch {
	label?: string;
	enabled?: boolean;
	serveInteractive?: boolean;
	serveBackground?: boolean;
	tier?: ChatGptPlanTier;
}

/** The account before and after the change; null when it is not this organization's. */
export async function updateChatGptPlanOrgAccount(params: {
	organizationId: string;
	accountId: string;
	patch: ChatGptPlanOrgAccountPatch;
}): Promise<{
	before: ChatGptPlanOrgAccountSummary;
	after: ChatGptPlanOrgAccountSummary;
} | null> {
	const where = {
		id: params.accountId,
		organizationId: params.organizationId,
	};
	const before = await db.chatGptPlanOrgAccount.findFirst({
		where,
		select: CHATGPT_PLAN_ORG_ACCOUNT_PUBLIC_SELECT,
	});
	if (!before) {
		return null;
	}
	const { count } = await db.chatGptPlanOrgAccount.updateMany({
		where,
		data: params.patch,
	});
	const after =
		count > 0
			? await db.chatGptPlanOrgAccount.findFirst({
					where,
					select: CHATGPT_PLAN_ORG_ACCOUNT_PUBLIC_SELECT,
				})
			: null;
	return after ? { before, after } : null;
}

/**
 * Deletes the account and its breaker row, which has no foreign key to
 * cascade from. False when the account is not this organization's.
 */
export async function deleteChatGptPlanOrgAccount(params: {
	organizationId: string;
	accountId: string;
}): Promise<boolean> {
	return db.$transaction(async (tx) => {
		const { count } = await tx.chatGptPlanOrgAccount.deleteMany({
			where: {
				id: params.accountId,
				organizationId: params.organizationId,
			},
		});
		if (count > 0) {
			await tx.chatGptPlanSourceState.deleteMany({
				where: { sourceKind: "ORG", sourceId: params.accountId },
			});
		}
		return count > 0;
	});
}

export async function touchChatGptPlanOrgAccount(params: {
	organizationId: string;
	accountId: string;
}): Promise<void> {
	await db.chatGptPlanOrgAccount.updateMany({
		where: { id: params.accountId, organizationId: params.organizationId },
		data: { lastUsedAt: new Date() },
	});
}

export type ChatGptPlanOrgPolicyValues = Pick<
	ChatGptPlanOrgPolicy,
	| "poolingEnabled"
	| "apiFallbackInteractive"
	| "apiFallbackBackground"
	| "headroomPct"
	| "termsAcknowledgedById"
	| "termsAcknowledgedAt"
>;

/** What an organization with no policy row gets: pooling off, nothing acknowledged. */
export const DEFAULT_CHATGPT_PLAN_ORG_POLICY: ChatGptPlanOrgPolicyValues = {
	poolingEnabled: false,
	apiFallbackInteractive: "ASK",
	apiFallbackBackground: "NEVER",
	headroomPct: 40,
	termsAcknowledgedById: null,
	termsAcknowledgedAt: null,
};

const POLICY_SELECT = {
	poolingEnabled: true,
	apiFallbackInteractive: true,
	apiFallbackBackground: true,
	headroomPct: true,
	termsAcknowledgedById: true,
	termsAcknowledgedAt: true,
} as const;

export async function getChatGptPlanOrgPolicy(
	organizationId: string,
): Promise<ChatGptPlanOrgPolicyValues> {
	const row = await db.chatGptPlanOrgPolicy.findUnique({
		where: { organizationId },
		select: POLICY_SELECT,
	});
	return row ?? DEFAULT_CHATGPT_PLAN_ORG_POLICY;
}

export type ChatGptPlanOrgPolicyPatch = Partial<
	Pick<
		ChatGptPlanOrgPolicyValues,
		"poolingEnabled" | "apiFallbackBackground" | "headroomPct"
	>
>;

/**
 * Applies the change and returns the policy before and after. The
 * interactive fallback keeps its stored default (ASK) and is not changeable:
 * interactive work always fails with the plan's own refusal, which already
 * asks the member (Fizzy #2770). Whether the
 * change is allowed — pooling on only after the terms were acknowledged —
 * is the caller's rule, checked against `before`.
 */
export async function updateChatGptPlanOrgPolicy(params: {
	organizationId: string;
	patch: ChatGptPlanOrgPolicyPatch;
}): Promise<{
	before: ChatGptPlanOrgPolicyValues;
	after: ChatGptPlanOrgPolicyValues;
}> {
	const { organizationId, patch } = params;
	const before = await getChatGptPlanOrgPolicy(organizationId);
	const after = await db.chatGptPlanOrgPolicy.upsert({
		where: { organizationId },
		create: { organizationId, ...patch },
		update: patch,
		select: POLICY_SELECT,
	});
	return { before, after };
}

/** Records which owner acknowledged the pooling terms, and when. */
export async function acknowledgeChatGptPlanOrgTerms(params: {
	organizationId: string;
	userId: string;
}): Promise<ChatGptPlanOrgPolicyValues> {
	const acknowledged = {
		termsAcknowledgedById: params.userId,
		termsAcknowledgedAt: new Date(),
	};
	return db.chatGptPlanOrgPolicy.upsert({
		where: { organizationId: params.organizationId },
		create: { organizationId: params.organizationId, ...acknowledged },
		update: acknowledged,
		select: POLICY_SELECT,
	});
}

export interface ChatGptPlanPoolUsage {
	requests: number;
	inputTokens: number;
	outputTokens: number;
}

/**
 * What each of the organization's accounts served through Fabric since
 * `since`, keyed by account id. An organization account's calls carry its id
 * in `providerConfigId`; accounts with no calls are absent. Only Fabric's
 * own use: anything else spending the same ChatGPT account is invisible here.
 */
export async function getChatGptPlanPoolUsageSince(params: {
	organizationId: string;
	accountIds: string[];
	since: Date;
}): Promise<Map<string, ChatGptPlanPoolUsage>> {
	if (params.accountIds.length === 0) {
		return new Map();
	}
	const groups = await db.aiUsageLog.groupBy({
		by: ["providerConfigId"],
		where: {
			organizationId: params.organizationId,
			createdAt: { gte: params.since },
			provider: "OPENAI_CHATGPT_PLAN",
			providerConfigId: { in: params.accountIds },
		},
		_count: { _all: true },
		_sum: { inputTokens: true, outputTokens: true },
	});
	return new Map(
		groups
			.filter((group) => group.providerConfigId !== null)
			.map((group) => [
				group.providerConfigId as string,
				{
					requests: group._count._all,
					inputTokens: group._sum.inputTokens ?? 0,
					outputTokens: group._sum.outputTokens ?? 0,
				},
			]),
	);
}

/**
 * When the account's oldest Fabric call since `since` ran, or null when none
 * did — the start of its usage window as far as Fabric can tell, so the window
 * resets no earlier than five hours later.
 */
export async function getChatGptPlanOrgAccountFirstUseSince(params: {
	organizationId: string;
	accountId: string;
	since: Date;
}): Promise<Date | null> {
	const first = await db.aiUsageLog.findFirst({
		where: {
			organizationId: params.organizationId,
			provider: "OPENAI_CHATGPT_PLAN",
			providerConfigId: params.accountId,
			createdAt: { gte: params.since },
		},
		orderBy: { createdAt: "asc" },
		select: { createdAt: true },
	});
	return first?.createdAt ?? null;
}

export interface ChatGptPlanPoolAdminOrganization {
	id: string;
	slug: string | null;
	name: string;
	role: string;
}

/**
 * The organization, when this person is one of its admins or owners and it
 * has both `CHATGPT_PLAN` and `CHATGPT_PLAN_POOLING` on; null otherwise. Looked
 * up only among the person's own memberships, so an organization they do not
 * belong to reads exactly like one that does not exist. Name it by id or by
 * slug, not both.
 */
export async function findChatGptPlanPoolAdminOrganization(
	params: { userId: string } & (
		| { organizationId: string; slug?: never }
		| { slug: string; organizationId?: never }
	),
): Promise<ChatGptPlanPoolAdminOrganization | null> {
	const membership = await db.member.findFirst({
		where: {
			userId: params.userId,
			role: { in: ["admin", "owner"] },
			...(params.organizationId !== undefined
				? { organizationId: params.organizationId }
				: { organization: { slug: params.slug } }),
		},
		select: {
			role: true,
			organization: { select: { id: true, slug: true, name: true } },
		},
	});
	if (!membership) {
		return null;
	}
	const { organization } = membership;
	const [plan, pooling] = await Promise.all([
		isFeatureEnabled("CHATGPT_PLAN", organization.id),
		isFeatureEnabled("CHATGPT_PLAN_POOLING", organization.id),
	]);
	return plan && pooling ? { ...organization, role: membership.role } : null;
}
