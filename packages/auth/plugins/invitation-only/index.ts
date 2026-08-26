import { config } from "@repo/config";
import {
	getPendingInvitationByEmail,
	getPendingProjectInvitationByEmail,
	getUserByEmail,
} from "@repo/database";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

const PROTECTED_PATHS = new Set([
	"/sign-up/email",
	"/sign-up/username",
	"/sign-in/magic-link",
]);

// /sign-in/magic-link serves both sign-in (existing user) and signup
// (new user). Only the new-user case should be gated by an invitation.
const EXISTING_USER_BYPASS_PATHS = new Set(["/sign-in/magic-link"]);

function matchesProtectedPath(path: string | undefined): boolean {
	if (!path) {
		return false;
	}
	if (PROTECTED_PATHS.has(path)) {
		return true;
	}
	if (path.startsWith("/callback/")) {
		return true;
	}
	if (path.startsWith("/oauth2/callback/")) {
		return true;
	}
	return false;
}

function normalizeEmail(rawEmail: string | undefined): string | null {
	if (!rawEmail) {
		return null;
	}
	const normalized = rawEmail.trim().toLowerCase();
	return normalized.length > 0 ? normalized : null;
}

export async function lookupInvitation(rawEmail: string | undefined) {
	const normalized = normalizeEmail(rawEmail);
	if (!normalized) {
		return null;
	}
	// Accept EITHER an org-level invitation OR a project invitation: a user
	// invited only to a project (no org invite) must still be able to create
	// an account when global signup is disabled. Without the project fallback
	// the gate throws INVALID_INVITATION and the external guest can never sign
	// up despite holding a valid project invite.
	const orgInvitation = await getPendingInvitationByEmail(normalized);
	if (orgInvitation) {
		return orgInvitation;
	}
	const projectInvitation =
		await getPendingProjectInvitationByEmail(normalized);
	return projectInvitation ?? null;
}

async function userExistsByEmail(
	rawEmail: string | undefined,
): Promise<boolean> {
	const normalized = normalizeEmail(rawEmail);
	if (!normalized) {
		return false;
	}
	const user = await getUserByEmail(normalized);
	return user !== null;
}

export const invitationOnlyPlugin = () =>
	({
		id: "invitationOnlyPlugin",
		hooks: {
			before: [
				{
					matcher: (context) => matchesProtectedPath(context.path),
					handler: createAuthMiddleware(async (ctx) => {
						if (config.auth.enableSignup) {
							return;
						}

						const email = (
							ctx.body as { email?: string } | undefined
						)?.email;

						// Existing users on dual-purpose endpoints (e.g. magic
						// link) are signing in, not signing up — they don't
						// need a pending invitation.
						if (
							ctx.path &&
							EXISTING_USER_BYPASS_PATHS.has(ctx.path) &&
							(await userExistsByEmail(email))
						) {
							return;
						}

						const hasInvitation = await lookupInvitation(email);

						if (!hasInvitation) {
							throw new APIError("BAD_REQUEST", {
								code: "INVALID_INVITATION",
								message: "No invitation found for this email",
							});
						}
					}),
				},
			],
		},
		// better-auth 1.6.x changed $ERROR_CODES values from plain strings
		// to { code, message } RawError objects.
		$ERROR_CODES: {
			INVALID_INVITATION: {
				code: "INVALID_INVITATION" as const,
				message: "No invitation found for this email",
			},
		},
	}) satisfies BetterAuthPlugin;
