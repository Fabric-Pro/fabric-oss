import { getInvitation, getSession } from "@saas/auth/lib/server";
import type { InvitationState } from "@saas/organizations/components/OrganizationInvitationModal";
import { OrganizationInvitationModal } from "@saas/organizations/components/OrganizationInvitationModal";
import { redirect } from "next/navigation";

export default async function OrganizationInvitationPage({
	params,
}: {
	params: Promise<{ invitationId: string }>;
}) {
	const { invitationId } = await params;

	const invitation = await getInvitation(invitationId);

	if (!invitation) {
		redirect("/app");
	}

	const organizationName = invitation.organization.name;
	const organizationSlug = invitation.organization.slug || "";
	const logoUrl = invitation.organization.logo || undefined;

	// Determine invitation state for the client component
	let state: InvitationState;

	// Check terminal statuses first — a canceled/rejected invitation that also
	// happens to be past its expiry date should show the real reason, not "expired".
	if (invitation.status === "accepted") {
		state = { type: "accepted" };
	} else if (invitation.status === "rejected") {
		state = { type: "rejected" };
	} else if (invitation.status === "canceled") {
		state = { type: "canceled" };
	} else if (
		invitation.status !== "pending" ||
		new Date(invitation.expiresAt) < new Date()
	) {
		state = { type: "expired" };
	} else {
		// Invitation is pending — check authentication
		const session = await getSession();

		if (!session) {
			state = {
				type: "not_authenticated",
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
		<OrganizationInvitationModal
			organizationName={organizationName}
			organizationSlug={organizationSlug}
			logoUrl={logoUrl}
			invitationId={invitationId}
			state={state}
		/>
	);
}
