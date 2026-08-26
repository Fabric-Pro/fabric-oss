import { getSession } from "@saas/auth/lib/server";
import {
	type ProjectInvitationState,
	ProjectInvitationModal,
} from "@saas/projects/components/ProjectInvitationModal";
import { db, getProjectInvitationWithEmail } from "@repo/database";
import { redirect } from "next/navigation";

export default async function ProjectInvitationPage({
	params,
}: {
	params: Promise<{ invitationId: string }>;
}) {
	const { invitationId } = await params;

	// `invitation.email` is used server-side to choose the auth branch. For the
	// unauthenticated branches (needs_login, needs_signup) and email_mismatch it
	// is forwarded to the client — gated by the high-entropy invitationId, which
	// matches the trust boundary of the invitation itself.
	const invitation = await getProjectInvitationWithEmail(invitationId);

	if (!invitation) {
		redirect("/app");
	}

	const projectName = invitation.project.name;
	const projectId = invitation.project.id;
	const organizationSlug = invitation.project.organization?.slug ?? null;

	let state: ProjectInvitationState;

	if (invitation.status === "ACCEPTED") {
		state = { type: "accepted" };
	} else if (invitation.status === "DECLINED") {
		state = { type: "declined" };
	} else if (
		invitation.status !== "PENDING" ||
		new Date(invitation.expiresAt) < new Date()
	) {
		state = { type: "expired" };
	} else {
		const session = await getSession();
		if (!session) {
			// Branch: do we need to sign up a brand-new user or sign in an
			// existing one? We leak whether the invited email has an account,
			// but only to a holder of the (high-entropy) invitation id — same
			// trust boundary as the invitation itself.
			const existingUser = await db.user.findUnique({
				where: { email: invitation.email.toLowerCase() },
				select: { id: true, emailVerified: true },
			});
			// Unverified existing users (e.g. signed up via this invitation
			// but never clicked the verification link) land on the signup
			// form; resubmitting returns USER_EXISTS, which points them to
			// the sign-in branch where the email-not-verified alert offers a
			// verification-email resend.
			state = existingUser?.emailVerified
				? {
						type: "needs_login",
						invitationId,
						email: invitation.email,
					}
				: {
						type: "needs_signup",
						invitationId,
						email: invitation.email,
					};
		} else if (
			session.user.email.toLowerCase() !== invitation.email.toLowerCase()
		) {
			state = {
				type: "email_mismatch",
				invitationEmail: invitation.email,
				currentEmail: session.user.email,
			};
		} else {
			state = { type: "pending" };
		}
	}

	return (
		<ProjectInvitationModal
			invitationId={invitationId}
			projectId={projectId}
			projectName={projectName}
			organizationSlug={organizationSlug}
			role={invitation.role}
			state={state}
		/>
	);
}
