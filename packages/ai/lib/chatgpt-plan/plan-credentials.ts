import {
	type ChatGptPlanCredential,
	deleteChatGptPlanCredential,
	deleteChatGptPlanOrgAccount,
	getChatGptPlanCredential,
	getChatGptPlanOrgAccount,
	notifyChatGptPlanOrgAccountNeedsReconnect,
	upsertChatGptPlanCredential,
	upsertChatGptPlanOrgAccount,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { withRefreshLock } from "@repo/database/prisma/queries/lib/refresh-lock";
import { logger } from "@repo/logs";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import {
	CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
	CHATGPT_PLAN_SCOPE,
	CHATGPT_TOKEN_REQUEST_TIMEOUT_MS,
	ChatGptPlanAuthError,
	type ChatGptPlanTokenResponse,
	parseEarliestRefreshAt,
	refreshChatGptPlanTokens,
	revokeChatGptPlanToken,
} from "./oauth";
import {
	chatGptPlanSourceLockKey,
	type PlanSourceRef,
	planSourceKey,
	planSourceLogFields,
} from "./sources";
import { missingSubscriptionFields } from "./subscription-backfill";
import {
	logChatGptPlanIdTokenShape,
	readChatGptPlanSubscription,
} from "./subscription-claims";

const REFRESH_MARGIN_MS = 5 * 60_000;
// Below this, earliest_refresh_at is ignored: a token with seconds left would
// expire mid-request.
const MUST_REFRESH_MS = 60_000;

type CredentialTiming = Pick<
	ChatGptPlanCredential,
	"accessTokenExpiresAt" | "earliestRefreshAt"
>;

/**
 * Refresh about five minutes before expiry, but not before the provider's
 * `earliest_refresh_at` unless the token is about to lapse.
 */
export function chatGptPlanNeedsRefresh(
	credential: CredentialTiming,
	now: number,
): boolean {
	const remaining = credential.accessTokenExpiresAt.getTime() - now;
	if (remaining <= MUST_REFRESH_MS) {
		return true;
	}
	if (remaining > REFRESH_MARGIN_MS) {
		return false;
	}
	const earliest = credential.earliestRefreshAt?.getTime() ?? null;
	return earliest === null || now >= earliest;
}

/**
 * The fields a member's own credential and an organization account share:
 * everything the refresh reads and writes.
 */
type PlanSignIn = Pick<
	ChatGptPlanCredential,
	| "clientId"
	| "encryptedAccessToken"
	| "encryptedRefreshToken"
	| "accessTokenExpiresAt"
	| "earliestRefreshAt"
	| "scopes"
	| "status"
	| "tier"
	| "subscriptionActiveUntil"
	| "encryptedIdToken"
>;

function assertUsable(
	credential: PlanSignIn | null,
): asserts credential is PlanSignIn {
	if (!credential) {
		throw new ChatGptPlanAuthError(
			"No ChatGPT plan is connected",
			"not_connected",
			true,
		);
	}
	if (credential.status === "NEEDS_RECONNECT") {
		throw new ChatGptPlanAuthError(
			CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
			"needs_reconnect",
			true,
		);
	}
	if (!credential.scopes.includes(CHATGPT_PLAN_SCOPE)) {
		throw new ChatGptPlanAuthError(
			"ChatGPT plan usage was not granted for this sign-in",
			"plan_scope_missing",
			true,
		);
	}
}

export interface ChatGptPlanAccessToken {
	accessToken: string;
	expiresAt: Date;
}

function toAccessToken(credential: PlanSignIn): ChatGptPlanAccessToken {
	return {
		accessToken: decryptApiKey(credential.encryptedAccessToken),
		expiresAt: credential.accessTokenExpiresAt,
	};
}

/**
 * A tier or paid-until date the row lacks, from the ID token stored at
 * sign-in: a refresh need not bring a new one, or one with the claims.
 */
function storedSubscriptionFields(current: PlanSignIn): Partial<PlanSignIn> {
	if (!current.encryptedIdToken) {
		return {};
	}
	try {
		return missingSubscriptionFields(
			current,
			readChatGptPlanSubscription(
				decryptApiKey(current.encryptedIdToken),
			),
		);
	} catch {
		return {};
	}
}

function rotatedFields(
	current: PlanSignIn,
	tokens: ChatGptPlanTokenResponse,
	now: number,
): Partial<PlanSignIn> {
	return {
		// A refresh may bring a new ID token; its subscription claims keep
		// the tier and paid-until date current (Fizzy #2770 G7), and the
		// stored one fills only what neither the new token nor the row says.
		...storedSubscriptionFields(current),
		...readChatGptPlanSubscription(tokens.id_token),
		encryptedAccessToken: encryptApiKey(tokens.access_token),
		...(tokens.refresh_token && {
			encryptedRefreshToken: encryptApiKey(tokens.refresh_token),
		}),
		...(tokens.id_token && {
			encryptedIdToken: encryptApiKey(tokens.id_token),
		}),
		accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
		earliestRefreshAt: parseEarliestRefreshAt(tokens.earliest_refresh_at),
		...(tokens.scope && {
			scopes: tokens.scope.split(" ").filter(Boolean),
		}),
	};
}

export interface ChatGptPlanCredentialDeps {
	fetchImpl?: typeof fetch;
	now?: () => number;
}

type LockTx = Parameters<Parameters<typeof withRefreshLock>[1]>[0];

function readSignIn(ref: PlanSourceRef): Promise<PlanSignIn | null> {
	return ref.kind === "user"
		? getChatGptPlanCredential(ref.userId)
		: getChatGptPlanOrgAccount({
				organizationId: ref.organizationId,
				accountId: ref.accountId,
			});
}

function readSignInUnderLock(
	tx: LockTx,
	ref: PlanSourceRef,
): Promise<PlanSignIn | null> {
	return ref.kind === "user"
		? tx.chatGptPlanCredential.findUnique({ where: { userId: ref.userId } })
		: tx.chatGptPlanOrgAccount.findFirst({
				where: {
					id: ref.accountId,
					organizationId: ref.organizationId,
				},
			});
}

async function storeRotatedUnderLock(
	tx: LockTx,
	ref: PlanSourceRef,
	data: Partial<PlanSignIn>,
): Promise<ChatGptPlanAccessToken> {
	if (ref.kind === "user") {
		return toAccessToken(
			await tx.chatGptPlanCredential.update({
				where: { userId: ref.userId },
				data,
			}),
		);
	}
	await tx.chatGptPlanOrgAccount.updateMany({
		where: { id: ref.accountId, organizationId: ref.organizationId },
		data,
	});
	const updated = await readSignInUnderLock(tx, ref);
	assertUsable(updated);
	return toAccessToken(updated);
}

/**
 * Flips an ACTIVE source to NEEDS_RECONNECT. Only that flip tells a shared
 * account's owners and admins (Fizzy #2770 D4): an account already waiting
 * for a reconnect is not announced again, and only a new sign-in makes it
 * ACTIVE.
 */
async function markNeedsReconnect(ref: PlanSourceRef): Promise<void> {
	const data = { status: "NEEDS_RECONNECT" as const };
	if (ref.kind === "user") {
		await db.chatGptPlanCredential.updateMany({
			where: { userId: ref.userId },
			data,
		});
		return;
	}
	const flipped = await db.chatGptPlanOrgAccount.updateMany({
		where: {
			id: ref.accountId,
			organizationId: ref.organizationId,
			status: "ACTIVE",
		},
		data,
	});
	if (flipped.count === 1) {
		await notifyChatGptPlanOrgAccountNeedsReconnect({
			organizationId: ref.organizationId,
			accountId: ref.accountId,
		});
	}
}

/**
 * Refreshes under the source's advisory lock. The row is re-read inside the
 * lock: a caller that queued behind another refresh must use the token that
 * refresh stored, because the refresh token it read before waiting is now
 * spent. `failedToken` forces a refresh unless someone already rotated it.
 */
async function refreshUnderLock(
	ref: PlanSourceRef,
	failedToken: string | undefined,
	{ fetchImpl = fetch, now = Date.now }: ChatGptPlanCredentialDeps,
): Promise<ChatGptPlanAccessToken> {
	try {
		return await withRefreshLock(
			chatGptPlanSourceLockKey(ref),
			async (tx, assertBudget) => {
				const current = await readSignInUnderLock(tx, ref);
				assertUsable(current);
				const currentToken = toAccessToken(current);
				const forced =
					failedToken !== undefined &&
					currentToken.accessToken === failedToken;
				if (!forced && !chatGptPlanNeedsRefresh(current, now())) {
					return currentToken;
				}
				assertBudget(CHATGPT_TOKEN_REQUEST_TIMEOUT_MS);
				let tokens: ChatGptPlanTokenResponse;
				try {
					tokens = await refreshChatGptPlanTokens(
						{
							clientId: current.clientId,
							refreshToken: decryptApiKey(
								current.encryptedRefreshToken,
							),
						},
						fetchImpl,
					);
				} catch (error) {
					// A transient failure (network, 5xx) does not cost the session:
					// keep using the current token while it is still valid.
					const terminal =
						error instanceof ChatGptPlanAuthError &&
						error.reauthRequired;
					if (
						!terminal &&
						!forced &&
						now() < current.accessTokenExpiresAt.getTime()
					) {
						return currentToken;
					}
					throw error;
				}
				logChatGptPlanIdTokenShape("refresh", ref, tokens.id_token);
				return storeRotatedUnderLock(
					tx,
					ref,
					rotatedFields(current, tokens, now()),
				);
			},
		);
	} catch (error) {
		// Recorded outside the lock's transaction, which the throw rolls back,
		// so later calls fail fast instead of replaying a dead refresh token.
		if (
			error instanceof ChatGptPlanAuthError &&
			error.reauthRequired &&
			error.code !== "not_connected"
		) {
			await markNeedsReconnect(ref).catch(() => {});
			logger.warn("[chatgpt-plan] Sign-in needs to be repeated", {
				...planSourceLogFields(ref),
				code: error.code,
			});
			// The provider's own wording ("invalid_grant") helps nobody who
			// reads it on a failed document; say what to do instead.
			throw new ChatGptPlanAuthError(
				CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
				error.code,
				true,
			);
		}
		throw error;
	}
}

// Single flight within this process; the advisory lock covers every other one.
const inflight = new Map<string, Promise<ChatGptPlanAccessToken>>();

function singleFlight(
	ref: PlanSourceRef,
	failedToken: string | undefined,
	deps: ChatGptPlanCredentialDeps,
): Promise<ChatGptPlanAccessToken> {
	const key = `${planSourceKey(ref)}:${failedToken ?? ""}`;
	let pending = inflight.get(key);
	if (!pending) {
		pending = refreshUnderLock(ref, failedToken, deps).finally(() => {
			inflight.delete(key);
		});
		inflight.set(key, pending);
	}
	return pending;
}

/**
 * A valid access token for this plan source, refreshed when close to expiry.
 * Never cached outside the request: callers ask again per call.
 *
 * @throws ChatGptPlanAuthError when there is no usable credential.
 */
export async function getChatGptPlanSourceAccessToken(
	ref: PlanSourceRef,
	deps: ChatGptPlanCredentialDeps = {},
): Promise<ChatGptPlanAccessToken> {
	const credential = await readSignIn(ref);
	assertUsable(credential);
	if (!chatGptPlanNeedsRefresh(credential, (deps.now ?? Date.now)())) {
		return toAccessToken(credential);
	}
	return singleFlight(ref, undefined, deps);
}

/** After a 401: refreshes unless another caller already rotated `failedToken`. */
export function refreshChatGptPlanSourceAfterUnauthorized(
	ref: PlanSourceRef,
	failedToken: string,
	deps: ChatGptPlanCredentialDeps = {},
): Promise<ChatGptPlanAccessToken> {
	return singleFlight(ref, failedToken, deps);
}

/** {@link getChatGptPlanSourceAccessToken} for this user's own plan. */
export function getChatGptPlanAccessToken(
	userId: string,
	deps: ChatGptPlanCredentialDeps = {},
): Promise<ChatGptPlanAccessToken> {
	return getChatGptPlanSourceAccessToken({ kind: "user", userId }, deps);
}

/** {@link refreshChatGptPlanSourceAfterUnauthorized} for this user's own plan. */
export function refreshChatGptPlanAfterUnauthorized(
	userId: string,
	failedToken: string,
	deps: ChatGptPlanCredentialDeps = {},
): Promise<ChatGptPlanAccessToken> {
	return refreshChatGptPlanSourceAfterUnauthorized(
		{ kind: "user", userId },
		failedToken,
		deps,
	);
}

export interface StoreChatGptPlanCredentialInput {
	userId: string;
	email: string | null;
	subject: string;
	clientId: string;
	hostId: string;
	tokens: ChatGptPlanTokenResponse & {
		refresh_token: string;
		id_token: string;
	};
	scopes: string[];
	now?: number;
}

export async function storeChatGptPlanCredential(
	input: StoreChatGptPlanCredentialInput,
): Promise<void> {
	const now = input.now ?? Date.now();
	await upsertChatGptPlanCredential({
		userId: input.userId,
		email: input.email,
		subject: input.subject,
		clientId: input.clientId,
		hostId: input.hostId,
		encryptedAccessToken: encryptApiKey(input.tokens.access_token),
		encryptedRefreshToken: encryptApiKey(input.tokens.refresh_token),
		encryptedIdToken: encryptApiKey(input.tokens.id_token),
		accessTokenExpiresAt: new Date(now + input.tokens.expires_in * 1000),
		earliestRefreshAt: parseEarliestRefreshAt(
			input.tokens.earliest_refresh_at,
		),
		scopes: input.scopes,
		...readChatGptPlanSubscription(input.tokens.id_token),
	});
	logChatGptPlanIdTokenShape(
		"connect",
		{ kind: "user", userId: input.userId },
		input.tokens.id_token,
	);
}

/**
 * Revokes the refresh token at OpenAI, then deletes the row. A failed revoke
 * is logged and does not keep the row: the person asked for the connection
 * to be gone from Fabric, and a row left behind would keep it usable here.
 */
export async function disconnectChatGptPlan(
	userId: string,
	deps: ChatGptPlanCredentialDeps = {},
): Promise<boolean> {
	const credential = await getChatGptPlanCredential(userId);
	if (!credential) {
		return false;
	}
	try {
		await revokeChatGptPlanToken(
			{
				clientId: credential.clientId,
				refreshToken: decryptApiKey(credential.encryptedRefreshToken),
			},
			deps.fetchImpl,
		);
	} catch (error) {
		logger.warn("[chatgpt-plan] Revoking the refresh token failed", {
			userId,
			code:
				error instanceof ChatGptPlanAuthError ? error.code : undefined,
		});
	}
	return deleteChatGptPlanCredential(userId);
}

export interface StoreChatGptPlanOrgAccountInput
	extends Omit<StoreChatGptPlanCredentialInput, "userId"> {
	organizationId: string;
	connectedByUserId: string;
	label: string;
}

/**
 * Stores a verified sign-in as one of the organization's shared accounts.
 *
 * @throws ChatGptPlanSubjectBoundElsewhereError when another organization
 *   already has this ChatGPT account.
 */
export async function storeChatGptPlanOrgAccount(
	input: StoreChatGptPlanOrgAccountInput,
): Promise<{ id: string; created: boolean }> {
	const now = input.now ?? Date.now();
	const stored = await upsertChatGptPlanOrgAccount({
		organizationId: input.organizationId,
		connectedByUserId: input.connectedByUserId,
		label: input.label,
		email: input.email,
		subject: input.subject,
		clientId: input.clientId,
		hostId: input.hostId,
		encryptedAccessToken: encryptApiKey(input.tokens.access_token),
		encryptedRefreshToken: encryptApiKey(input.tokens.refresh_token),
		encryptedIdToken: encryptApiKey(input.tokens.id_token),
		accessTokenExpiresAt: new Date(now + input.tokens.expires_in * 1000),
		earliestRefreshAt: parseEarliestRefreshAt(
			input.tokens.earliest_refresh_at,
		),
		scopes: input.scopes,
		...readChatGptPlanSubscription(input.tokens.id_token),
	});
	logChatGptPlanIdTokenShape(
		"connect",
		{
			kind: "org",
			organizationId: input.organizationId,
			accountId: stored.id,
		},
		input.tokens.id_token,
	);
	return stored;
}

/**
 * Revokes a shared account's refresh token at OpenAI, then deletes it, on the
 * same terms as {@link disconnectChatGptPlan}. False when the account is not
 * this organization's.
 */
export async function disconnectChatGptPlanOrgAccount(
	params: { organizationId: string; accountId: string },
	deps: ChatGptPlanCredentialDeps = {},
): Promise<boolean> {
	const account = await getChatGptPlanOrgAccount(params);
	if (!account) {
		return false;
	}
	try {
		await revokeChatGptPlanToken(
			{
				clientId: account.clientId,
				refreshToken: decryptApiKey(account.encryptedRefreshToken),
			},
			deps.fetchImpl,
		);
	} catch (error) {
		logger.warn("[chatgpt-plan] Revoking the refresh token failed", {
			organizationId: params.organizationId,
			planAccountId: params.accountId,
			code:
				error instanceof ChatGptPlanAuthError ? error.code : undefined,
		});
	}
	return deleteChatGptPlanOrgAccount(params);
}
