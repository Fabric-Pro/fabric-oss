"use server";

import { auth } from "@repo/auth";
import {
	acceptProjectInvitation,
	db,
	declineProjectInvitation,
	getProjectInvitationWithEmail,
} from "@repo/database";
import { headers } from "next/headers";

type InvitationActionResult =
	| { success: true }
	| {
			success: false;
			code: "INVITATION_NOT_FOUND" | "UNAUTHENTICATED" | "UNKNOWN_ERROR";
	  };

type SignUpActionResult =
	| { success: true; email: string; requiresVerification: true }
	| {
			success: false;
			code:
				| "INVITATION_NOT_FOUND"
				| "INVITATION_EXPIRED"
				| "USER_EXISTS"
				| "INVALID_INPUT"
				| "PASSWORD_TOO_WEAK"
				| "CAPTCHA_FAILED"
				| "UNKNOWN_ERROR";
			message?: string;
			suggestions?: string[];
	  };

async function getAuthedUser(): Promise<{ id: string; email: string } | null> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user?.id || !session.user.email) {
		return null;
	}
	return { id: session.user.id, email: session.user.email };
}

export async function acceptProjectInvitationAction(
	invitationId: string,
): Promise<InvitationActionResult> {
	try {
		const user = await getAuthedUser();
		if (!user) {
			return { success: false, code: "UNAUTHENTICATED" };
		}
		await acceptProjectInvitation(invitationId, user.id, user.email);
		return { success: true };
	} catch (e) {
		const message =
			e && typeof e === "object" && "message" in e
				? String((e as { message: unknown }).message)
				: "";
		if (message.toLowerCase().includes("not found")) {
			return { success: false, code: "INVITATION_NOT_FOUND" };
		}
		return { success: false, code: "UNKNOWN_ERROR" };
	}
}

/**
 * Server-side signup for a user invited to a project.
 *
 * Verify-first flow: the account is created unverified, exactly like the
 * standard signup form. Better Auth sends the verification email
 * (`emailVerification.sendOnSignUp` in packages/auth/auth.ts), and the
 * `callbackURL` in the signup body makes that email's link return the
 * user to this invitation page after verifying.
 *
 * Clicking the link runs the `afterEmailVerification` hook, which sends
 * the welcome email and hands off to invite reconciliation
 * (`runInviteReconciliationForUser`) — the pending project invitation is
 * accepted automatically for the now-verified email. With
 * `autoSignInAfterVerification` the same click also signs the user in,
 * so they land back on the invitation page as a project member and see
 * the accepted state.
 *
 * This action never creates a session and never marks the email
 * verified; on success the caller renders a "check your email" state
 * (`requiresVerification: true`).
 */
export async function signUpForProjectInvitationAction(input: {
	invitationId: string;
	name: string;
	password: string;
	captchaToken?: string;
}): Promise<SignUpActionResult> {
	const name = input.name.trim();
	const password = input.password;
	if (name.length < 1) {
		return { success: false, code: "INVALID_INPUT" };
	}
	if (password.length < 12) {
		return {
			success: false,
			code: "PASSWORD_TOO_WEAK",
			message: "Password must be at least 12 characters.",
			suggestions: ["Use a passphrase of multiple words."],
		};
	}

	try {
		const invitation = await getProjectInvitationWithEmail(
			input.invitationId,
		);
		if (!invitation) {
			return { success: false, code: "INVITATION_NOT_FOUND" };
		}
		if (
			invitation.status !== "PENDING" ||
			new Date(invitation.expiresAt) < new Date()
		) {
			return { success: false, code: "INVITATION_EXPIRED" };
		}

		const email = invitation.email.toLowerCase();

		const existing = await db.user.findUnique({
			where: { email },
			select: { id: true },
		});
		if (existing) {
			// Any existing user — verified or not — goes down the sign-in
			// path. Do NOT delete an unverified user row: User deletes
			// cascade into 20+ tables (projects, documents, memberships,
			// etc.), and "unverified" does not mean "no data attached".
			// The caller has to reset their password or reach out to
			// support if the account is stuck. The accept flow resumes
			// via `signInAndAcceptProjectInvitation` after login.
			return { success: false, code: "USER_EXISTS" };
		}

		// captchaToken is consumed by the Better Auth `before` hook in
		// packages/auth/auth.ts; not part of the typed body, hence the cast.
		// callbackURL is embedded in the verification email link so the
		// user returns to this invitation page after verifying.
		const result = await auth.api.signUpEmail({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			body: {
				email,
				name,
				password,
				captchaToken: input.captchaToken,
				callbackURL: `/project-invitation/${input.invitationId}`,
			} as any,
		});
		if (!result?.user?.id) {
			return { success: false, code: "UNKNOWN_ERROR" };
		}

		// Mark onboarding complete at create time: the guest's destination
		// is the invited project, not the new-user onboarding wizard. The
		// email stays UNVERIFIED — verification (and the invitation grant
		// via reconciliation) happens when the user clicks the link.
		await db.user.update({
			where: { id: result.user.id },
			data: { onboardingComplete: true },
		});

		return { success: true, email, requiresVerification: true };
	} catch (e) {
		// Inspect `body.code` first (Better Auth wraps domain codes there),
		// then fall back to `code`. Surface PASSWORD_TOO_WEAK / CAPTCHA_FAILED
		// so the client can render actionable feedback; collapse everything
		// else to UNKNOWN_ERROR so this endpoint cannot leak details about
		// invitation existence, account collisions, or backend state.
		const bodyShape = (e as { body?: { code?: string } })?.body;
		const bodyCode = bodyShape?.code;
		const rawCode = (e as { code?: string })?.code;
		const errorCode = bodyCode ?? rawCode;

		if (errorCode === "PASSWORD_TOO_WEAK") {
			const body = bodyShape as
				| { message?: string; suggestions?: string[] }
				| undefined;
			return {
				success: false,
				code: "PASSWORD_TOO_WEAK",
				message: body?.message ?? "Password is too weak.",
				suggestions: body?.suggestions ?? [],
			};
		}
		if (errorCode === "CAPTCHA_FAILED") {
			return { success: false, code: "CAPTCHA_FAILED" };
		}

		return { success: false, code: "UNKNOWN_ERROR" };
	}
}

export async function declineProjectInvitationAction(
	invitationId: string,
): Promise<InvitationActionResult> {
	try {
		const user = await getAuthedUser();
		if (!user) {
			return { success: false, code: "UNAUTHENTICATED" };
		}
		await declineProjectInvitation(invitationId, user.email);
		return { success: true };
	} catch (e) {
		const message =
			e && typeof e === "object" && "message" in e
				? String((e as { message: unknown }).message)
				: "";
		if (message.toLowerCase().includes("not found")) {
			return { success: false, code: "INVITATION_NOT_FOUND" };
		}
		return { success: false, code: "UNKNOWN_ERROR" };
	}
}
