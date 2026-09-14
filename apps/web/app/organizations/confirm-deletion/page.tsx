import { fetchOrganizationNameForDeletionToken } from "@repo/api/modules/organizations/procedures/deletion/server-fetch";
import { ORGANIZATION_RETENTION_DAYS } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { ConfirmOrganizationDeletion } from "@saas/organizations/components/ConfirmOrganizationDeletion";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Landing page for the emailed deletion-confirmation link (Fizzy #2462).
 *
 * Deliberately renders a page with a button rather than redeeming the token on
 * load — see the component for why a GET redemption would let a link-following
 * mail scanner delete an organization.
 *
 * Lives OUTSIDE the `(saas)` route group, with `AuthWrapper` supplied by its own
 * layout. Inside the group, `(saas)/layout.tsx` redirects a session-less visitor
 * to a bare `/auth/login` before this page runs, discarding the token — see that
 * layout's note. The redirect below is what preserves it, and it can only run
 * out here.
 *
 * The organization's NAME is resolved here rather than in the client component,
 * because doing it server-side keeps the token-to-name lookup off the public API
 * — see `fetchOrganizationNameForDeletionToken`. It is read, never spent: this
 * page may be rendered by the same mail scanner the click requirement exists to
 * defend against, and a render that consumed the token would hand that crawler
 * the outcome the button is there to withhold.
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

	// Null for an expired, spent or someone-else's link. The page still renders
	// — with its unnamed copy — and the refusal comes from `confirm`, which
	// answers every invalid-token case with one message.
	const organizationName = await fetchOrganizationNameForDeletionToken({
		token,
		userId: session.user.id,
	});

	return (
		<ConfirmOrganizationDeletion
			token={token}
			retentionDays={ORGANIZATION_RETENTION_DAYS}
			organizationName={organizationName}
		/>
	);
}
