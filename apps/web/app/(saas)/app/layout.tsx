import { config } from "@repo/config";
import { getAllFlags, getUserDefaultFunctionTags } from "@repo/database";
import { createPurchasesHelper } from "@repo/payments/lib/helper";
import { getOrganizationList, getSession } from "@saas/auth/lib/server";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { RoleTagSnapshotProvider } from "@saas/shared/components/RoleTagSnapshotProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { attemptAsync } from "es-toolkit";
import { redirect } from "next/navigation";
import type { PropsWithChildren } from "react";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Layout({ children }: PropsWithChildren) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	// Forced password rotation (SOC 2 CC6.1). The middleware (proxy.ts) also
	// redirects here, but it reads the flag from the UNSIGNED `session_data`
	// cookie, which a user can edit to bypass the gate. This server-side check
	// uses the DB-backed session (getSession → `disableCookieCache: true`), so a
	// tampered cookie has no effect. `/change-password` lives outside the `/app`
	// segment (it is not wrapped by this layout), so this cannot loop.
	if (session.user.mustChangePassword) {
		redirect("/change-password");
	}

	if (config.users.enableOnboarding && !session.user.onboardingComplete) {
		redirect("/onboarding");
	}

	const organizations = await getOrganizationList();

	if (
		config.organizations.enable &&
		config.organizations.requireOrganization
	) {
		const organization =
			organizations.find(
				(org) => org.id === session?.session.activeOrganizationId,
			) || organizations[0];

		if (!organization) {
			redirect("/new-organization");
		}
	}

	const hasFreePlan = Object.values(config.payments.plans).some(
		(plan) => "isFree" in plan,
	);

	if (
		((config.organizations.enable && config.organizations.enableBilling) ||
			config.users.enableBilling) &&
		!hasFreePlan
	) {
		// This parent layout wraps both /app (personal) and /app/{slug} (org), so
		// it cannot see the deeper segment's slug — it falls back to the shared
		// session.activeOrganizationId (or the first org). That value is shared
		// across tabs, so in a multi-tab + org-scoped-billing setup the gate may
		// check the wrong org's plan. It does NOT bite the default config
		// (organizations.enableBilling is false → user-scoped billing), and the
		// org-scoped plan is re-checked per-slug in [organizationSlug]/layout.tsx.
		// Leaving the fail-closed logic untouched; per-tab org-billing gating
		// belongs in the slug-scoped layout, not this context-ambiguous parent.
		const organizationId = config.organizations.enable
			? session?.session.activeOrganizationId || organizations?.at(0)?.id
			: undefined;

		const [error, data] = await attemptAsync(() =>
			orpcClient.payments.listPurchases({
				organizationId,
			}),
		);

		if (error) {
			// listPurchases requires ORG_BILLING_READ (admin/owner only).
			// Members hit FORBIDDEN here — they can't pick or upgrade a
			// plan for the org anyway, so the /choose-plan redirect is wrong
			// for them too. Skip the gate ONLY for that case. Other errors
			// (DB down, timeout, regression) must fail closed so paid-only
			// configs don't silently bypass the entitlement gate when the
			// gate cannot determine subscription state.
			const code = (error as { code?: unknown })?.code;
			const status = (error as { status?: unknown })?.status;
			const isPermissionDenied = code === "FORBIDDEN" || status === 403;
			if (!isPermissionDenied) {
				throw new Error("Failed to fetch purchases");
			}
			console.warn(
				"[AppLayout] Member without billing read; skipping plan gate",
			);
		} else {
			const purchases = data?.purchases ?? [];

			const { activePlan } = createPurchasesHelper(purchases);

			if (!activePlan) {
				redirect("/choose-plan");
			}
		}
	}

	// Resolved server-side (DB-backed, see @repo/database) and handed to
	// FeatureFlagProvider below so client components can read flag values
	// from the RSC payload with no fetch and no loading branch.
	const featureFlags = await getAllFlags();

	// Whether this user has any default function tags, for the blocking
	// role-tag gate (Fizzy #2264). Read here rather than in the client so the
	// gate is correct on first paint and cannot be skipped by a failed client
	// fetch. Gated on the flag: this layout is `force-dynamic` with
	// `revalidate = 0` and wraps every authenticated page, so an unconditional
	// read here would cost every user a DB round-trip per navigation for a
	// feature nobody has turned on. While the flag is off the snapshot stays
	// `null` — indistinguishable downstream from a real `false`, since
	// `shouldEnforce` (the gate) returns `false` on the flag alone before it
	// ever looks at the snapshot, so "no gate" is correct either way.
	//
	// `null` means "unknown" once the flag IS on: a read failure leaves the
	// gate shut rather than trapping every user during a database incident,
	// and the gate's own query re-decides once any read succeeds. That failure
	// case is logged below — it is the only thing that tells an operator this
	// particular `null` is a failure and not just the flag being off.
	let hasDefaultFunctionTags: boolean | null = null;
	if (featureFlags.ROLE_TAG_ENFORCEMENT) {
		try {
			const defaultTags = await getUserDefaultFunctionTags(
				session.user.id,
			);
			hasDefaultFunctionTags = defaultTags.length > 0;
		} catch (error) {
			hasDefaultFunctionTags = null;
			console.warn(
				"[AppLayout] Failed to read default function tags; role-tag gate staying shut",
				error,
			);
		}
	}

	// The active-incident surface lived here in earlier shapes (full-width
	// banner, then a fixed top-right chip in `AppWrapper`). It now renders in
	// two purpose-built spots instead: an inline `IncidentChip` in the
	// dashboard hero (left of the range picker) and an always-visible
	// `IncidentRailIndicator` triangle in the sidebar footer next to the
	// notification bell. See `incident-summary.tsx` for the shared role gate.

	return (
		<FeatureFlagProvider value={featureFlags}>
			<RoleTagSnapshotProvider value={hasDefaultFunctionTags}>
				{children}
			</RoleTagSnapshotProvider>
		</FeatureFlagProvider>
	);
}
