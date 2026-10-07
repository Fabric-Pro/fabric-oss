import {
	type ChatGptPlanOrganization,
	ChatGptPlanSubjectBoundElsewhereError,
	findChatGptPlanPoolAdminOrganization,
	isChatGptPlanOrgAccountSubject,
	isChatGptPlanPersonalSubject,
	listChatGptPlanOrgAccounts,
	listChatGptPlanOrganizations,
	recordAudit,
	setChatGptPlanOrgUse,
} from "@repo/database";
import { z } from "zod";
import { CHATGPT_PLAN_SCOPE, verifyChatGptIdToken } from "./oauth";
import {
	storeChatGptPlanCredential,
	storeChatGptPlanOrgAccount,
} from "./plan-credentials";

export const CHATGPT_PLAN_NOT_ENABLED =
	"ChatGPT plan isn't enabled for any of your organizations. Ask your Fabric admin to enable it.";

/** What `fabric connect chatgpt` uploads after the sign-in on the member's machine. */
export const chatGptPlanUploadSchema = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1),
	idToken: z.string().min(1),
	tokenType: z.string().min(1).default("Bearer"),
	expiresIn: z.number().int().positive(),
	scopes: z.array(z.string().min(1)).min(1),
	clientId: z.string().min(1),
	hostId: z.string().min(1),
	earliestRefreshAt: z.union([z.number(), z.string()]).optional(),
});

export type ChatGptPlanUpload = z.infer<typeof chatGptPlanUploadSchema>;

export type ConnectChatGptPlanResult =
	| {
			ok: true;
			email: string | null;
			organizations: Array<
				Pick<ChatGptPlanOrganization, "slug" | "name" | "enabled">
			>;
	  }
	| { ok: false; status: 400 | 403 | 409; error: string };

type IdTokenClaims = Awaited<ReturnType<typeof verifyChatGptIdToken>>;

async function verifyUpload(
	upload: ChatGptPlanUpload,
): Promise<
	| { ok: true; claims: IdTokenClaims }
	| { ok: false; status: 400; error: string }
> {
	if (!upload.scopes.includes(CHATGPT_PLAN_SCOPE)) {
		return {
			ok: false,
			status: 400,
			error: "ChatGPT plan usage was not granted at sign-in; sign in again and allow it",
		};
	}
	try {
		return {
			ok: true,
			claims: await verifyChatGptIdToken(upload.idToken, {
				clientId: upload.clientId,
			}),
		};
	} catch {
		return {
			ok: false,
			status: 400,
			error: "The ChatGPT ID token is not valid",
		};
	}
}

/**
 * Stores a verified ChatGPT plan sign-in for `userId` and turns use on in the
 * organizations the person chose — only those that also have `CHATGPT_PLAN`
 * on and that the person still belongs to. How the caller proved who
 * `userId` is (an upload ticket today) is the caller's business, never this
 * function's: it trusts `userId` and `organizationIds` as given.
 *
 * Background-job use is never turned on here; only an explicit choice in
 * settings does that. A ChatGPT account an organization already shares is
 * refused (Fizzy #2770).
 */
export async function connectChatGptPlan(params: {
	userId: string;
	organizationIds: string[];
	upload: ChatGptPlanUpload;
}): Promise<ConnectChatGptPlanResult> {
	const { userId, upload } = params;
	const verified = await verifyUpload(upload);
	if (!verified.ok) {
		return verified;
	}
	const { claims } = verified;
	// One ChatGPT account, one usage window: as an organization's shared
	// account and someone's own plan at once it would be counted twice.
	if (await isChatGptPlanOrgAccountSubject(claims.sub)) {
		return {
			ok: false,
			status: 409,
			error: "This ChatGPT account is already shared by an organization. Sign in with your own ChatGPT account.",
		};
	}

	const chosen = new Set(params.organizationIds);
	const organizations = await listChatGptPlanOrganizations({ userId });
	const enabledHere = organizations.filter((org) => chosen.has(org.id));
	// The ticket's organizations may have lost the flag since it was minted;
	// a plan no organization may use is not stored.
	if (enabledHere.length === 0) {
		return { ok: false, status: 403, error: CHATGPT_PLAN_NOT_ENABLED };
	}

	await storeChatGptPlanCredential({
		userId,
		email: claims.email ?? null,
		subject: claims.sub,
		clientId: upload.clientId,
		hostId: upload.hostId,
		tokens: {
			access_token: upload.accessToken,
			refresh_token: upload.refreshToken,
			id_token: upload.idToken,
			token_type: upload.tokenType,
			expires_in: upload.expiresIn,
			earliest_refresh_at: upload.earliestRefreshAt,
		},
		scopes: upload.scopes,
	});

	await Promise.all(
		enabledHere.map((org) =>
			setChatGptPlanOrgUse({
				userId,
				organizationId: org.id,
				enabled: true,
			}),
		),
	);

	// Only the email's domain: the account address and every token stay out
	// of the audit trail.
	const actor = { type: "user" as const, userId };
	const resource = { type: "chatgpt_plan", id: userId, name: null };
	recordAudit({
		action: "account.chatgpt_plan.connected",
		category: "account",
		actor,
		organizationId: null,
		resource,
		metadata: { emailDomain: claims.email?.split("@")[1] ?? null },
	});
	for (const org of enabledHere) {
		recordAudit({
			action: "account.chatgpt_plan.organization_use_changed",
			category: "account",
			actor,
			organizationId: org.id,
			resource,
			metadata: {
				enabled: true,
				includeBackgroundJobs: org.includeBackgroundJobs,
			},
		});
	}

	return {
		ok: true,
		email: claims.email ?? null,
		organizations: organizations.map((org) => ({
			slug: org.slug,
			name: org.name,
			enabled: org.enabled || chosen.has(org.id),
		})),
	};
}

export const CHATGPT_PLAN_SHARED_NOT_ALLOWED =
	"You can connect a shared ChatGPT plan account only to an organization you administer, with ChatGPT plan pooling enabled.";

export type ConnectChatGptPlanOrgAccountResult =
	| {
			ok: true;
			email: string | null;
			organization: { slug: string | null; name: string };
			/** False when the organization already had this account. */
			created: boolean;
	  }
	| { ok: false; status: 400 | 403 | 409; error: string };

/**
 * Stores a verified ChatGPT plan sign-in as a shared account of
 * `organizationId` (Fizzy #2770), connected by `userId`. Like
 * {@link connectChatGptPlan}, it trusts both ids as given, and re-checks what
 * may have changed since the ticket was minted: that `userId` still
 * administers the organization and both flags are still on.
 *
 * A ChatGPT account serves at most one organization, and never both a
 * person's own work and an organization's: no one's own plan — the
 * connector's or anyone else's — can become a shared account.
 */
export async function connectChatGptPlanOrgAccount(params: {
	userId: string;
	organizationId: string;
	upload: ChatGptPlanUpload;
}): Promise<ConnectChatGptPlanOrgAccountResult> {
	const { userId, organizationId, upload } = params;
	const verified = await verifyUpload(upload);
	if (!verified.ok) {
		return verified;
	}
	const { claims } = verified;

	const organization = await findChatGptPlanPoolAdminOrganization({
		userId,
		organizationId,
	});
	if (!organization) {
		return {
			ok: false,
			status: 403,
			error: CHATGPT_PLAN_SHARED_NOT_ALLOWED,
		};
	}
	// Anyone's own plan, the connector's included: one ChatGPT account, one
	// usage window, never counted as a person's plan and a shared one at once.
	if (await isChatGptPlanPersonalSubject(claims.sub)) {
		return {
			ok: false,
			status: 409,
			error: "This ChatGPT account is already connected as someone's own plan. Sign in with the account the organization should share.",
		};
	}

	const existing = await listChatGptPlanOrgAccounts(organizationId);
	let stored: { id: string; created: boolean };
	try {
		stored = await storeChatGptPlanOrgAccount({
			organizationId,
			connectedByUserId: userId,
			label: `ChatGPT plan ${existing.length + 1}`,
			email: claims.email ?? null,
			subject: claims.sub,
			clientId: upload.clientId,
			hostId: upload.hostId,
			tokens: {
				access_token: upload.accessToken,
				refresh_token: upload.refreshToken,
				id_token: upload.idToken,
				token_type: upload.tokenType,
				expires_in: upload.expiresIn,
				earliest_refresh_at: upload.earliestRefreshAt,
			},
			scopes: upload.scopes,
		});
	} catch (error) {
		if (error instanceof ChatGptPlanSubjectBoundElsewhereError) {
			return { ok: false, status: 409, error: error.message };
		}
		throw error;
	}

	const label =
		existing.find((account) => account.id === stored.id)?.label ??
		`ChatGPT plan ${existing.length + 1}`;
	// Only the email's domain: the account address and every token stay out
	// of the audit trail.
	recordAudit({
		action: "org.chatgpt_plan.account_connected",
		category: "org",
		actor: { type: "user", userId },
		organizationId,
		resource: {
			type: "chatgpt_plan_org_account",
			id: stored.id,
			name: label,
		},
		metadata: {
			emailDomain: claims.email?.split("@")[1] ?? null,
			reconnected: !stored.created,
		},
	});

	return {
		ok: true,
		email: claims.email ?? null,
		organization: { slug: organization.slug, name: organization.name },
		created: stored.created,
	};
}
