import { config } from "@repo/config";
import { db, hasAnyPersonalProject } from "@repo/database";
import { logger } from "@repo/logs";
import { getOrganizationList, getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { resolveGuestLandingRedirect } from "@saas/start/lib/guest-landing-redirect";
import { resolveLastActiveWorkspace } from "@saas/start/lib/last-active-workspace";
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

	// Sorted because two fallbacks below land the user on the *first* membership
	// when nothing else names one, and Better Auth's `listOrganizations` issues a
	// `findMany` on `member` with no sort at all — so "first" was whatever order
	// Postgres happened to return, which drifts with the query plan. A user with
	// several organizations could be dropped somewhere different on two
	// consecutive sign-ins with no data change between them. Ascending id is the
	// same tiebreak `resolveUserOrganization` already applies for the same
	// reason. Copied first: `getOrganizationList` is `cache()`d, and sorting in
	// place would reorder the array every other consumer of this request sees.
	const organizations = [...(await getOrganizationList())].sort((a, b) =>
		a.id.localeCompare(b.id),
	);

	if (config.organizations.enable) {
		// Resume an organization ONLY on a one-time post-login entry.
		// `session.activeOrganizationId` is a single value shared by every browser
		// tab (last-write-wins), so reading it on an ordinary /app load is exactly
		// what let a refreshed personal tab get hijacked into whatever org another
		// tab last activated. config.auth.redirectAfterSignIn marks the genuine
		// post-login hop with `?postLogin=1`; that hop is transient (it immediately
		// lands on /app/{slug} and never rests on /app), so it can't contaminate
		// other tabs. A bare /app resolves no organization from either source — org
		// context is reached via slug URLs, which are already per-tab and
		// refresh-safe (#1477).
		const fromSignIn = (await searchParams)?.postLogin === "1";

		if (fromSignIn) {
			// The order of these two sources is the whole point. Both claim to
			// answer "where was I working?", but only one of them is honest about
			// it. `user.lastActiveOrganizationId` is a durable, per-user record
			// written when the person actually moved into an organization.
			// `session.activeOrganizationId` is one last-write-wins value hanging
			// off a session that may outlive several switches — and every tab on
			// that session shares it. A user with more than one organization was
			// therefore being dropped into whichever one the session happened to
			// still be carrying, which is rarely where they left off. So we ask
			// the durable record first and keep the session value as the fallback
			// for the sessions that have no durable record yet: a first sign-in, a
			// fresh device, an account that has never switched.
			const lastActiveOrganization = await resolveLastActiveWorkspace({
				userId: session.user.id,
				organizations,
				getLastActiveOrganizationId: async (userId) => {
					const user = await db.user.findUnique({
						where: { id: userId },
						select: { lastActiveOrganizationId: true },
					});
					return user?.lastActiveOrganizationId ?? null;
				},
			});

			// A null resolution means either "no durable record" or "the record
			// names an org this user has since left" — both fall through to the
			// session value, then to the first membership so a post-login hop that
			// resolves nothing still lands somewhere while requireOrganization is
			// off.
			const targetOrganization =
				lastActiveOrganization ??
				organizations.find(
					(org) => org.id === session.session.activeOrganizationId,
				) ??
				organizations.at(0);

			if (targetOrganization) {
				// Align the session with the URL *before* handing over. Every oRPC
				// call builds its tenant context from `session.activeOrganizationId`
				// (packages/api/orpc/middleware/tenant-context-middleware.ts), so
				// landing on /app/{slug} for a different organization would leave
				// the page and the API reading two different tenants — a worse
				// failure than the one this ordering fixes. Best-effort by design:
				// a sign-in must not become an error page over a default, so the
				// write is skipped when the session already agrees and swallowed
				// when it fails.
				if (
					session.session.id &&
					session.session.activeOrganizationId !==
						targetOrganization.id
				) {
					try {
						await db.session.update({
							where: { id: session.session.id },
							data: {
								activeOrganizationId: targetOrganization.id,
							},
						});
					} catch (error) {
						logger.error(
							"[AppStart] Failed to align the session's organization with the post-login redirect",
							{
								userId: session.user.id,
								organizationId: targetOrganization.id,
								error: String(error),
							},
						);
					}
				}

				// Deliberately outside the try above: redirect() reports itself by
				// throwing, and a catch would swallow the navigation.
				redirect(`/app/${targetOrganization.slug}`);
			}
			// Nothing to resume — the user belongs nowhere yet. Fall through to
			// the guest / new-organization logic below.
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
