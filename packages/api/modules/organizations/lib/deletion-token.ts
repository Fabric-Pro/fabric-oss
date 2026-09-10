/**
 * The single-use token that stands between "I want to delete this" and the
 * organization actually going dark (Fizzy #2462).
 *
 * WHY A TOKEN AT ALL. Typing the organization's name proves the person knows
 * WHICH organization they are destroying. It does not prove WHO they are — an
 * unlocked laptop satisfies it. The screen has promised a password field for as
 * long as it has existed and never rendered one, and it cannot: magic-link and
 * social sign-in accounts have no password, so a password gate would lock those
 * owners out of deleting their own organization.
 *
 * WHY EMAIL AND NOT A STRONGER FACTOR. An authenticator or passkey challenge is
 * a better proof, and the repository already has a step-up grant mechanism that
 * could carry one. Both were rejected on COVERAGE: an authenticator challenge
 * refuses every owner who never enrolled one, and passkeys are opt-in. Every
 * account here has a verified email address, so this is the only factor that
 * reaches everyone. It is also what the auth library itself falls back to for
 * deleting a password-less account.
 *
 * Storage is the auth library's own generic `verification` table, under a
 * namespaced identifier — the same shape its account-deletion flow uses. That
 * buys expiry and single-use consumption without inventing a table.
 */
import { randomBytes } from "node:crypto";
import { db } from "@repo/database";

/**
 * One hour. Long enough to walk to another device and back, short enough that a
 * link sitting in a mailbox is not a standing authorisation to destroy a tenant.
 */
const TOKEN_TTL_MS = 60 * 60 * 1000;

const IDENTIFIER_PREFIX = "delete-org";

type DeletionTokenPayload = {
	organizationId: string;
	userId: string;
};

function identifierFor(token: string) {
	return `${IDENTIFIER_PREFIX}-${token}`;
}

/**
 * Mint a token for one specific (organization, requester) pair.
 *
 * The pair is stored in the row rather than being re-derived at redemption
 * time. A token is therefore not a general "delete something" capability: it
 * only ever names the organization it was minted for, so a leaked link cannot
 * be pointed at a different tenant.
 */
export async function createOrganizationDeletionToken(
	payload: DeletionTokenPayload,
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString("hex");
	const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

	await db.verification.create({
		data: {
			identifier: identifierFor(token),
			value: JSON.stringify(payload),
			expiresAt,
		},
	});

	return { token, expiresAt };
}

/**
 * Redeem a token, exactly once.
 *
 * Deletes the row before returning the payload, so two concurrent redemptions
 * cannot both succeed — `deleteMany` reports how many rows it removed, and only
 * the caller that removed one is holding a real token. An expired row is
 * removed and refused rather than left to accumulate.
 *
 * Returns `null` for every failure — unknown, expired, malformed. The caller
 * must not distinguish them to the user: telling someone WHICH way their token
 * was invalid tells an attacker the same thing.
 */
export async function consumeOrganizationDeletionToken(
	token: string,
): Promise<DeletionTokenPayload | null> {
	const identifier = identifierFor(token);

	const row = await db.verification.findFirst({
		where: { identifier },
		select: { id: true, value: true, expiresAt: true },
	});

	if (!row) {
		return null;
	}

	const { count } = await db.verification.deleteMany({
		where: { id: row.id },
	});

	// Someone else redeemed it between the read and the delete.
	if (count === 0) {
		return null;
	}

	if (row.expiresAt.getTime() <= Date.now()) {
		return null;
	}

	try {
		const parsed = JSON.parse(row.value) as DeletionTokenPayload;

		if (!parsed?.organizationId || !parsed?.userId) {
			return null;
		}

		return parsed;
	} catch {
		return null;
	}
}

/**
 * Drop any outstanding tokens for an organization.
 *
 * Called when a deletion is confirmed or the organization is restored: a token
 * minted before a restore must not still be spendable afterwards, or a stale
 * link in a mailbox could re-delete something a person deliberately brought
 * back.
 *
 * Scans by payload rather than by identifier because the identifier carries the
 * random token, not the organization. The table is small and this runs on
 * deliberate, rare actions.
 */
export async function revokeOrganizationDeletionTokens(organizationId: string) {
	const rows = await db.verification.findMany({
		where: { identifier: { startsWith: `${IDENTIFIER_PREFIX}-` } },
		select: { id: true, value: true },
	});

	const doomed = rows
		.filter((row) => {
			try {
				return (
					(JSON.parse(row.value) as DeletionTokenPayload)
						?.organizationId === organizationId
				);
			} catch {
				return false;
			}
		})
		.map((row) => row.id);

	if (doomed.length === 0) {
		return { revoked: 0 };
	}

	const { count } = await db.verification.deleteMany({
		where: { id: { in: doomed } },
	});

	return { revoked: count };
}
