import { config } from "@repo/config";
import { db, hasAnyPersonalProject } from "@repo/database";
import { getOrganizationList, getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { resolveGuestLandingRedirect } from "@saas/start/lib/guest-landing-redirect";
import { resolveLastActiveWorkspaceRedirect } from "@saas/start/lib/last-active-workspace-redirect";
import UserStart from "@saas/start/UserStart";
import { redirect } from "next/navigation";

/**
 * When the user has no organization memberships but *does* have accepted
 * ProjectMember rows, they're a guest in one or more orgs they don't belong
 * to. Route them directly to their first invited project so they don't get
 * pushed into the "create an organization" flow.
 */
async function findGuestLandingTarget(userId: string): Promise<string | null> {
	const guestProject = await db.projectMember.findFirst({
		where: {
			userId,
			acceptedAt: { not: null },
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			project: { organizationId: { not: null } },
		},
		select: {
			projectId: true,
			project: { select: { organization: { select: { slug: true } } } },
		},
		orderBy: { acceptedAt: "desc" },
	});
	if (!guestProject?.project.organization?.slug) {
		return null;
	}
	return `/app/${guestProject.project.organization.slug}/projects/${guestProject.projectId}`;
}

export default async function AppStartPage({
	searchParams,
}: {
	searchParams?: Promise<{ postLogin?: string }>;
} = {}) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const organizations = await getOrganizationList();

	if (config.organizations.enable) {
		// Resume the session's active org ONLY on a one-time post-login entry.
		// `session.activeOrganizationId` is a single value shared by every browser
		// tab (last-write-wins), so reading it on an ordinary /app load is exactly
		// what let a refreshed personal tab get hijacked into whatever org another
		// tab last activated. config.auth.redirectAfterSignIn marks the genuine
		// post-login hop with `?postLogin=1`; that hop is transient (it immediately
		// lands on /app/{slug} and never rests on /app), so it can't contaminate
		// other tabs. A bare /app is the stable personal hub — org context is
		// reached via slug URLs, which are already per-tab and refresh-safe.
		const fromSignIn = (await searchParams)?.postLogin === "1";

		if (fromSignIn && session.session.activeOrganizationId) {
			const activeOrganization = organizations.find(
				(org) => org.id === session.session.activeOrganizationId,
			);

			if (activeOrganization) {
				redirect(`/app/${activeOrganization.slug}`);
			}

			// Active org ID is set but doesn't match any membership —
			// fall back to first org if available.
			if (organizations.length > 0) {
				redirect(`/app/${organizations[0].slug}`);
			}
		} else if (fromSignIn) {
			// Post-login hop with no session activeOrganizationId — check the
			// user's persisted last-active workspace and redirect if valid.
			// Not run on bare /app loads (multi-tab refresh safety: #1477).
			const lastActiveRedirect = await resolveLastActiveWorkspaceRedirect(
				{
					userId: session.user.id,
					organizations,
					getLastActiveOrganizationId: async (userId) => {
						const user = await db.user.findUnique({
							where: { id: userId },
							select: { lastActiveOrganizationId: true },
						});
						return user?.lastActiveOrganizationId ?? null;
					},
				},
			);
			if (lastActiveRedirect) {
				redirect(lastActiveRedirect);
			}
			// null → user was last in personal workspace, fall through to existing logic
		}

		if (
			config.organizations.requireOrganization &&
			organizations.length === 0
		) {
			// Before pushing the user into "create a new org", check if they
			// have guest access to any project — if yes, land them on it.
			const guestTarget = await findGuestLandingTarget(session.user.id);
			if (guestTarget) {
				redirect(guestTarget);
			}
			redirect("/new-organization");
		}

		if (
			config.organizations.requireOrganization &&
			organizations.length > 0
		) {
			redirect(`/app/${organizations[0].slug}`);
		}

		// Only reachable when requireOrganization is false (the branches
		// above redirect otherwise). A user with zero org memberships and
		// zero personal projects whose only access is a guest project
		// membership would land on an empty personal dashboard — route
		// them to their invited project instead.
		const guestRedirectTarget = await resolveGuestLandingRedirect({
			organizationCount: organizations.length,
			userId: session.user.id,
			// When the widget flag is ON, only auto-redirect on the post-login hop so a
			// guest can reach home (where the widget shows). When OFF, keep the old
			// always-redirect (an empty guest home has nothing to show) — rollback-safe.
			isPostLogin:
				fromSignIn || !config.dashboard.inviteWelcomeWidget.enabled,
			hasAnyPersonalProject,
			findGuestLandingTarget,
		});
		if (guestRedirectTarget) {
			redirect(guestRedirectTarget);
		}
	}

	return (
		<>
			<TopRightControls />
			<PageBreadcrumbs
				items={[{ label: "Dashboard" }]}
				className="mb-4 pt-6"
			/>
			<UserStart />
		</>
	);
}
