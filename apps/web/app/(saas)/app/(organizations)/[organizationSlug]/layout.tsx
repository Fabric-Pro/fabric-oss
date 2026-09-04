import { config } from "@repo/config";
import {
	getAllFlagsForOrganization,
	getOrganizationRequireTwoFactor,
} from "@repo/database";
import {
	getActiveOrganization,
	getSession,
	isGuestInOrg,
} from "@saas/auth/lib/server";
import { OrganizationThemeProvider } from "@saas/organizations/components/OrganizationThemeProvider";
import { activeOrganizationQueryKey } from "@saas/organizations/lib/api";
import { shouldEnforceOrgTwoFactor } from "@saas/organizations/lib/mfa-enforcement";
import { OrganizationGuestProvider } from "@saas/organizations/lib/organization-guest-context";
import { AppWrapper } from "@saas/shared/components/AppWrapper";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { MfaSetupBanner } from "@saas/shared/components/MfaSetupBanner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { getServerQueryClient } from "@shared/lib/server";
import { notFound, redirect } from "next/navigation";
import type { PropsWithChildren } from "react";

// Helper to safely parse organization metadata
function getOrganizationBrandColor(
	metadata: string | null | undefined,
): string | undefined {
	if (!metadata) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(metadata);
		return parsed.brandColor;
	} catch {
		return undefined;
	}
}

export default async function OrganizationLayout({
	children,
	params,
}: PropsWithChildren<{
	params: Promise<{
		organizationSlug: string;
	}>;
}>) {
	const { organizationSlug } = await params;

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		return notFound();
	}

	// Server-seeded guest knowledge: computed once per request (both
	// helpers are react `cache()`d) and threaded into the client tree via
	// `OrganizationGuestProvider`, so guest-aware hooks have the correct
	// value on FIRST render — no org-shell flash and no client-side
	// probe requests that 403 for project-scoped guests.
	const session = await getSession();
	const guest = session?.user
		? await isGuestInOrg(session.user.id, organization.id)
		: false;

	// SOC 2 CC6.1 — organization-wide MFA enforcement. When an organization
	// requires two-factor authentication and the signed-in member has not
	// enabled it, gate access by redirecting them to enroll (they are guided to
	// set it up, never hard-locked out). Query optimization: the org-flag lookup
	// is the only DB hit here, so it is skipped entirely for members who already
	// comply, aren't org members, or when 2FA is globally unavailable. The
	// decision itself lives in the unit-tested `shouldEnforceOrgTwoFactor`.
	const userHasTwoFactor = !!session?.user?.twoFactorEnabled;
	const orgRequiresTwoFactor =
		config.auth.enableTwoFactor &&
		!guest &&
		!!session?.user &&
		!userHasTwoFactor
			? await getOrganizationRequireTwoFactor(organization.id)
			: false;
	if (
		shouldEnforceOrgTwoFactor({
			twoFactorGloballyEnabled: config.auth.enableTwoFactor,
			isGuest: guest,
			userHasTwoFactor,
			orgRequiresTwoFactor,
		})
	) {
		// Inside the organization rather than out of it. This used to send
		// people to the personal settings tree, which was the only place
		// account security lived; the tree is gone and the page has an
		// organization-reachable home, so enforcement no longer has to push a
		// member out of the organization enforcing it.
		redirect(
			`/app/${organizationSlug}/settings/account/security?mfaRequired=1&from=${encodeURIComponent(
				organizationSlug,
			)}`,
		);
	}

	const queryClient = getServerQueryClient();

	// Parallelize independent prefetch queries for better performance
	// See: async-parallel rule from Vercel React Best Practices
	const prefetchPromises: Promise<void>[] = [
		queryClient.prefetchQuery({
			queryKey: activeOrganizationQueryKey(organizationSlug),
			queryFn: () => organization,
		}),
	];

	// Guests have no billing relationship with the host org — the
	// org-scoped purchases call would just 403 server-side and be dropped.
	if (config.users.enableBilling && !guest) {
		const purchasesQueryOptions = orpc.payments.listPurchases.queryOptions({
			input: {
				organizationId: organization.id,
			},
		});
		prefetchPromises.push(
			queryClient.prefetchQuery(purchasesQueryOptions).catch((error) => {
				// Don't fail the layout. Drop the failed query from the cache
				// so dehydrate() doesn't serialize it to the client (which
				// would surface as "dehydrated as pending ended up rejecting"
				// for any consumer that reads this query key, e.g. members
				// without ORG_BILLING_READ).
				console.warn("[OrgLayout] Skipping purchases prefetch:", error);
				queryClient.removeQueries({
					queryKey: purchasesQueryOptions.queryKey,
				});
			}),
		);
	}

	// Feature flags, resolved for THIS organization.
	//
	// The account-wide provider in `(saas)/app/layout.tsx` sits above the
	// `[organizationSlug]` segment and therefore cannot know which organization
	// the viewer is in — it resolves global override > env > default only. This
	// second provider re-resolves with the organization and, because
	// `useFeatureFlag` reads the NEAREST context, shadows it for everything
	// under `/app/{slug}` with no change at any call site.
	//
	// It is the same component, not a variant: "nested provider, org-resolved
	// values" is the entire behaviour, and a second component would be a second
	// context to keep in sync for no gain.
	//
	// Fetched alongside the prefetch queries above rather than after them —
	// same async-parallel rule, independent read, no reason to serialize it.
	const [featureFlags] = await Promise.all([
		getAllFlagsForOrganization(organization.id),
		Promise.all(prefetchPromises),
	]);

	const brandColor = getOrganizationBrandColor(organization.metadata);

	return (
		<FeatureFlagProvider value={featureFlags}>
			<OrganizationThemeProvider brandColor={brandColor}>
				<OrganizationGuestProvider
					organizationSlug={organizationSlug}
					isGuest={guest}
				>
					<AppWrapper>
						<MfaSetupBanner />
						{children}
					</AppWrapper>
				</OrganizationGuestProvider>
			</OrganizationThemeProvider>
		</FeatureFlagProvider>
	);
}
