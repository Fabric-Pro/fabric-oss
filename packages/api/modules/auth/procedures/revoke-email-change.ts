import { ORPCError } from "@orpc/server";
import {
	blockEmailVerifyJWT,
	markEmailChangeRevoked,
} from "@repo/auth/lib/email-verify-blocklist";
import { verifyToken } from "@repo/auth/lib/signed-token";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { publicProcedure } from "../../../orpc/procedures";

interface RevokePayload {
	userId: string;
	oldEmail: string;
	newEmail: string;
	betterAuthToken: string;
	kind: "email-change-revoke";
}

export interface RevokeEmailChangeDeps {
	db: {
		session: {
			deleteMany: (args: {
				where: { userId: string };
			}) => Promise<{ count: number }>;
		};
		user: {
			findUnique: (args: {
				where: { id: string };
				select: { email: true };
			}) => Promise<{ email: string } | null>;
			update: (args: {
				where: { id: string };
				data: { email: string; emailVerified: boolean };
			}) => Promise<unknown>;
		};
	};
	blockEmailVerifyJWT: (jwt: string) => Promise<void>;
	markEmailChangeRevoked: (
		oldEmail: string,
		newEmail: string,
	) => Promise<void>;
}

export async function revokeEmailChangeHandler(
	token: string,
	deps: RevokeEmailChangeDeps,
): Promise<{ ok: true }> {
	const v = verifyToken<RevokePayload>(token);

	if (!v.ok || v.payload.kind !== "email-change-revoke") {
		throw new ORPCError("BAD_REQUEST", {
			message: "Invalid or expired link",
		});
	}

	// verifyToken returns a generic-cast payload — runtime shape isn't enforced
	// by TypeScript, so validate fields explicitly before using them.
	const { userId, oldEmail, newEmail, betterAuthToken } = v.payload;
	if (
		!userId ||
		typeof userId !== "string" ||
		typeof oldEmail !== "string" ||
		!oldEmail ||
		typeof newEmail !== "string" ||
		!newEmail
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Invalid or expired link",
		});
	}

	// Tuple-based revocation marker — primary control. Covers BOTH the JWT 1
	// confirmation (sent to OLD) and the JWT 2 verification (which Better
	// Auth mints server-side on JWT 1 click and we never see). The
	// /verify-email before-hook decodes incoming JWTs and rejects any with
	// a payload matching this {email, updateTo} tuple. Marked first and
	// fails closed: if the marker cannot be persisted we cannot honestly
	// report success, since JWT 2 would still be clickable.
	try {
		await deps.markEmailChangeRevoked(oldEmail, newEmail);
	} catch (error) {
		logger.error(
			{
				event: "email_change.revoke.tuple_mark_error",
				security: true,
				userId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Failed to persist email-change revocation marker",
		);
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Could not record the cancellation. Please try again.",
		});
	}

	// Delete sessions to terminate any active foothold the attacker may
	// have. auth.api.revokeSessions needs the caller's own session header,
	// which a public revoke procedure does not have, so we delete directly.
	try {
		await deps.db.session.deleteMany({ where: { userId } });
	} catch (error) {
		logger.error(
			{
				event: "email_change.revoke.session_delete_error",
				security: true,
				userId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Failed to delete sessions during email-change revocation",
		);
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Could not revoke sessions. Please try again.",
		});
	}

	// Defense-in-depth: also blocklist JWT 1 by exact-token hash. The tuple
	// marker above already covers JWT 1, so this is best-effort — failures
	// are logged but don't fail the revocation.
	if (typeof betterAuthToken === "string" && betterAuthToken.length > 0) {
		try {
			await deps.blockEmailVerifyJWT(betterAuthToken);
		} catch (error) {
			logger.warn(
				{
					event: "email_change.revoke.jwt_blocklist_error",
					userId,
					error:
						error instanceof Error ? error.message : String(error),
				},
				"Failed to blocklist JWT 1; tuple marker still in effect",
			);
		}
	}

	// Roll back the email field if JWT 2 has already been clicked (Better
	// Auth updates user.email synchronously then). The tuple marker
	// prevents future verify-email clicks, but if the attacker already
	// committed the change, only this rollback restores the account.
	// Lookup + update both fail closed: if we cannot verify or restore the
	// email, we must not claim the revocation succeeded.
	let current: { email: string } | null;
	try {
		current = await deps.db.user.findUnique({
			where: { id: userId },
			select: { email: true },
		});
	} catch (error) {
		logger.error(
			{
				event: "email_change.revoke.user_lookup_error",
				security: true,
				userId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Failed to read user during email-change revocation",
		);
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Could not verify email-change state. Please try again.",
		});
	}

	let rolledBack = false;
	if (current && current.email === newEmail) {
		try {
			await deps.db.user.update({
				where: { id: userId },
				data: { email: oldEmail, emailVerified: true },
			});
			rolledBack = true;
		} catch (error) {
			logger.error(
				{
					event: "email_change.revoke.rollback_error",
					security: true,
					userId,
					error:
						error instanceof Error ? error.message : String(error),
				},
				"Failed to roll back email field during revocation",
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"Could not roll back the email change. Please contact support.",
			});
		}
	}

	logger.info(
		{ event: "email_change.revoked", security: true, userId, rolledBack },
		"Email change revoked",
	);

	return { ok: true };
}

/**
 * Cancels a pending email-change by revoking sessions and blocklisting the
 * verification JWT. The HMAC-signed token (created in auth.ts
 * sendChangeEmailVerification) IS the authentication — no session is required
 * from the caller.
 */
export const revokeEmailChange = publicProcedure
	.route({
		method: "POST",
		path: "/auth/revoke-email-change",
		tags: ["Auth"],
		summary: "Cancel a pending email change and revoke all user sessions",
	})
	.input(z.object({ token: z.string().min(1) }))
	.handler(({ input }) =>
		revokeEmailChangeHandler(input.token, {
			db,
			blockEmailVerifyJWT,
			markEmailChangeRevoked,
		}),
	);
