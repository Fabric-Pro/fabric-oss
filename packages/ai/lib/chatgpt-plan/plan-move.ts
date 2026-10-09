import {
	type ChatGptPlanSourceKind,
	chatGptPlanAccountIdentityWhere,
} from "@repo/database";
import { Prisma } from "@repo/database/prisma/client";
import { withRefreshLock } from "@repo/database/prisma/queries/lib/refresh-lock";
import { chatGptPlanSourceLockKey } from "./sources";

/**
 * Moves one ChatGPT account between a member's own plan and an
 * organization's shared accounts without signing in again (Fizzy #2770 I1).
 * The sign-in, its tier and its per-source state go with it: the breaker,
 * the served models and the budget calibration describe the same ChatGPT
 * account, so a window spent before the move stays spent after it. The usage
 * ledger is not rewritten; the new source's window estimate starts from what
 * it records from now on.
 *
 * Each move runs under the old source's refresh lock, inside that lock's
 * transaction: a refresh token is single-use, and a refresh racing the move
 * would otherwise store its rotated token on a row the move just deleted.
 */

export type ChatGptPlanMoveFailure =
	/** Nothing to move: no own plan, or no such account in the organization. */
	| "not_found"
	/** Only the member who connected an account may take it back. */
	| "not_connector"
	/** The member already has an own plan; one per person. */
	| "personal_exists"
	/** The ChatGPT account is already one of an organization's shared accounts. */
	| "already_shared";

export class ChatGptPlanMoveError extends Error {
	constructor(readonly reason: ChatGptPlanMoveFailure) {
		super(reason);
		this.name = "ChatGptPlanMoveError";
	}
}

type Tx = Parameters<Parameters<typeof withRefreshLock>[1]>[0];

type SourceKey = { sourceKind: ChatGptPlanSourceKind; sourceId: string };

/** Re-keys the per-source rows, first clearing anything left under the new key. */
async function moveSourceRows(
	tx: Tx,
	from: SourceKey,
	to: SourceKey,
): Promise<void> {
	await tx.chatGptPlanSourceState.deleteMany({ where: to });
	await tx.chatGptPlanServedModel.deleteMany({ where: to });
	await tx.chatGptPlanBudgetObservation.deleteMany({ where: to });
	await tx.chatGptPlanSourceState.updateMany({ where: from, data: to });
	await tx.chatGptPlanServedModel.updateMany({ where: from, data: to });
	await tx.chatGptPlanBudgetObservation.updateMany({ where: from, data: to });
}

function isUniqueViolation(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === "P2002"
	);
}

/**
 * Turns the member's own plan into a shared account of `organizationId`,
 * connected by them. Their own plan is gone afterwards; their per-organization
 * choices about using one are kept, as a disconnect keeps them.
 *
 * @throws ChatGptPlanMoveError `not_found` without an own plan (including one
 *   disconnected during the move), `already_shared` when an organization
 *   already shares the account.
 */
export async function shareOwnChatGptPlan(params: {
	userId: string;
	organizationId: string;
	label: string;
}): Promise<{ accountId: string }> {
	const { userId, organizationId, label } = params;
	try {
		return await withRefreshLock(
			chatGptPlanSourceLockKey({ kind: "user", userId }),
			async (tx) => {
				const own = await tx.chatGptPlanCredential.findUnique({
					where: { userId },
				});
				if (!own) {
					throw new ChatGptPlanMoveError("not_found");
				}
				const shared = await tx.chatGptPlanOrgAccount.findFirst({
					where: chatGptPlanAccountIdentityWhere({
						subject: own.subject,
						email: own.email,
					}),
					select: { id: true },
				});
				if (shared) {
					throw new ChatGptPlanMoveError("already_shared");
				}
				const account = await tx.chatGptPlanOrgAccount.create({
					data: {
						organizationId,
						label,
						connectedByUserId: userId,
						email: own.email,
						subject: own.subject,
						clientId: own.clientId,
						hostId: own.hostId,
						encryptedAccessToken: own.encryptedAccessToken,
						encryptedRefreshToken: own.encryptedRefreshToken,
						encryptedIdToken: own.encryptedIdToken,
						accessTokenExpiresAt: own.accessTokenExpiresAt,
						earliestRefreshAt: own.earliestRefreshAt,
						scopes: own.scopes,
						status: own.status,
						tier: own.tier,
						subscriptionActiveUntil: own.subscriptionActiveUntil,
						lastUsedAt: own.lastUsedAt,
					},
					select: { id: true },
				});
				await moveSourceRows(
					tx,
					{ sourceKind: "USER", sourceId: userId },
					{ sourceKind: "ORG", sourceId: account.id },
				);
				// The member's per-organization choices stay, as on a disconnect:
				// without an own plan they serve nothing, and a later own plan
				// finds them again.
				const removed = await tx.chatGptPlanCredential.deleteMany({
					where: { userId },
				});
				if (removed.count !== 1) {
					// Disconnected meanwhile; the transaction rolls back.
					throw new ChatGptPlanMoveError("not_found");
				}
				return { accountId: account.id };
			},
		);
	} catch (error) {
		// Another organization took the same `subject` in the meantime.
		if (isUniqueViolation(error)) {
			throw new ChatGptPlanMoveError("already_shared");
		}
		throw error;
	}
}

/**
 * Turns a shared account back into the own plan of the member who connected
 * it, used in the organization it was shared with unless they already chose
 * otherwise there. Nobody else may, admins
 * included: they can disconnect it, not make it theirs.
 *
 * @throws ChatGptPlanMoveError `not_found`, `not_connector` or
 *   `personal_exists`.
 */
export async function takeBackSharedChatGptPlan(params: {
	userId: string;
	organizationId: string;
	accountId: string;
}): Promise<void> {
	const { userId, organizationId, accountId } = params;
	try {
		await withRefreshLock(
			chatGptPlanSourceLockKey({
				kind: "org",
				organizationId,
				accountId,
			}),
			async (tx) => {
				const account = await tx.chatGptPlanOrgAccount.findFirst({
					where: { id: accountId, organizationId },
				});
				if (!account) {
					throw new ChatGptPlanMoveError("not_found");
				}
				if (account.connectedByUserId !== userId) {
					throw new ChatGptPlanMoveError("not_connector");
				}
				const own = await tx.chatGptPlanCredential.findUnique({
					where: { userId },
					select: { id: true },
				});
				if (own) {
					throw new ChatGptPlanMoveError("personal_exists");
				}
				await tx.chatGptPlanCredential.create({
					data: {
						userId,
						email: account.email,
						subject: account.subject,
						clientId: account.clientId,
						hostId: account.hostId,
						encryptedAccessToken: account.encryptedAccessToken,
						encryptedRefreshToken: account.encryptedRefreshToken,
						encryptedIdToken: account.encryptedIdToken,
						accessTokenExpiresAt: account.accessTokenExpiresAt,
						earliestRefreshAt: account.earliestRefreshAt,
						scopes: account.scopes,
						status: account.status,
						tier: account.tier,
						subscriptionActiveUntil:
							account.subscriptionActiveUntil,
						lastUsedAt: account.lastUsedAt,
					},
				});
				await moveSourceRows(
					tx,
					{ sourceKind: "ORG", sourceId: accountId },
					{ sourceKind: "USER", sourceId: userId },
				);
				// It served this organization's work until now: keep serving the
				// member's own work there, unless they already chose for this
				// organization — that choice, background jobs included, stands.
				await tx.chatGptPlanOrgUse.upsert({
					where: {
						userId_organizationId: { userId, organizationId },
					},
					create: {
						userId,
						organizationId,
						enabled: true,
						includeBackgroundJobs: false,
					},
					update: {},
				});
				await tx.chatGptPlanOrgAccount.deleteMany({
					where: { id: accountId, organizationId },
				});
			},
		);
	} catch (error) {
		// Two take-backs racing to the member's one own plan.
		if (isUniqueViolation(error)) {
			throw new ChatGptPlanMoveError("personal_exists");
		}
		throw error;
	}
}
