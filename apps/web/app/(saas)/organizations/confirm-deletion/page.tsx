import { ORGANIZATION_RETENTION_DAYS } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { ConfirmOrganizationDeletion } from "@saas/organizations/components/ConfirmOrganizationDeletion";
import { AuthWrapper } from "@saas/shared/components/AuthWrapper";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Landing page for the emailed deletion-confirmation link (Fizzy #2462).
 *
 * Deliberately renders a page with a button rather than redeeming the token on
 * load — see the component for why a GET redemption would let a link-following
 * mail scanner delete an organization.
 */
export default async function ConfirmOrganizationDeletionPage({
	searchParams,
}: {
	searchParams: Promise<{ token?: string }>;
}) {
	const { token } = await searchParams;
	const session = await getSession();

	// Signing in is part of the proof: the token names who requested the
	// deletion, and the procedure refuses if the session is anyone else.
	if (!session?.user) {
		redirect(
			`/auth/login?redirectTo=${encodeURIComponent(
				`/organizations/confirm-deletion?token=${token ?? ""}`,
			)}`,
		);
	}

	if (!token) {
		redirect("/app");
	}

	return (
		<AuthWrapper>
			<ConfirmOrganizationDeletion
				token={token}
				retentionDays={ORGANIZATION_RETENTION_DAYS}
			/>
		</AuthWrapper>
	);
}
