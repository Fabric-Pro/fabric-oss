/**
 * Binds a write of a ChatGPT plan source's state to the sign-in the work
 * behind it used (Fizzy #3037).
 *
 * A member's own plan keeps its row id when a different ChatGPT account
 * replaces it, and its per-source rows (breaker, served models, calibration)
 * are keyed by the member, not by the account. Work started with the previous
 * account's token can finish after the replacement and would otherwise write
 * that account's state under the same key. The fence names the sign-in by its
 * row id and the account's `subject`: a different account changes the
 * subject, a disconnect removes the row, and a reconnect after it creates a
 * new id. The same account signing in through another client registration
 * also gets a new subject, so its in-flight writes are dropped too; the next
 * call made with the new sign-in records its own outcome.
 */

import { createHash } from "node:crypto";
import type { ChatGptPlanSourceKind } from "../../generated/client";
import {
	chatGptPlanLockKey,
	chatGptPlanOrgAccountLockKey,
	withRefreshLock,
} from "./refresh-lock";

type FenceTx = Parameters<Parameters<typeof withRefreshLock>[1]>[0];

interface FencedSource {
	sourceKind: ChatGptPlanSourceKind;
	sourceId: string;
}

/**
 * An opaque, short name for one sign-in: a hash of its row id and subject,
 * so the subject itself never leaves the server.
 */
export function chatGptPlanCredentialFingerprint(signIn: {
	id: string;
	subject: string;
}): string {
	return createHash("sha256")
		.update(`${signIn.id}\u0000${signIn.subject}`)
		.digest("hex")
		.slice(0, 16);
}

/**
 * Runs `write` when the source's current sign-in is still the one
 * `credentialFingerprint` names, and reports whether it ran. `null` accepts
 * whatever sign-in the source has now, for a reporter too old to say which it
 * used; a source with no sign-in is refused either way.
 *
 * The check and the write share one transaction under the source's refresh
 * lock. The code that clears or re-keys these rows takes the same lock first:
 * `upsertChatGptPlanCredential`, the `delete…UnderLock` helpers and their
 * callers, and `plan-move.ts` in `@repo/ai`. So a write either commits before
 * that cleanup starts, which then removes it, or runs after it and sees the
 * new sign-in (`chatgpt-plan-lifecycle.test.ts` interleaves both). This holds
 * the lock for these statements only; it may wait behind a token refresh or
 * revoke that holds it.
 */
export function withChatGptPlanCredentialFence(
	source: FencedSource,
	credentialFingerprint: string | null,
	write: (tx: FenceTx) => Promise<unknown>,
): Promise<boolean> {
	const lockKey =
		source.sourceKind === "USER"
			? chatGptPlanLockKey(source.sourceId)
			: chatGptPlanOrgAccountLockKey(source.sourceId);
	return withRefreshLock(lockKey, async (tx) => {
		const current =
			source.sourceKind === "USER"
				? await tx.chatGptPlanCredential.findUnique({
						where: { userId: source.sourceId },
						select: { id: true, subject: true },
					})
				: await tx.chatGptPlanOrgAccount.findUnique({
						where: { id: source.sourceId },
						select: { id: true, subject: true },
					});
		if (
			!current ||
			(credentialFingerprint !== null &&
				chatGptPlanCredentialFingerprint(current) !==
					credentialFingerprint)
		) {
			return false;
		}
		await write(tx);
		return true;
	});
}
