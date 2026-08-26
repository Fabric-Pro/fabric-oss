import "server-only";
import { auth, type Organization, type Session } from "@repo/auth";
import { db, getInvitationById } from "@repo/database";
import { headers } from "next/headers";
import { cache } from "react";

export const getSession = cache(async (): Promise<Session | null> => {
	const session = await auth.api.getSession({
		headers: await headers(),
		query: {
			disableCookieCache: true,
		},
	});

	// better-auth 1.6.x's getSession return type lost plugin field
	// augmentations (admin's role, organization's activeOrganizationId,
	// custom user fields). The runtime payload still has them; cast to
	// our explicit Session type so consumers get the right shape.
	return session as Session | null;
});

type ActiveOrganization = Awaited<
	ReturnType<typeof auth.api.getFullOrganization>
>;

export const getActiveOrganization = cache(
	async (slug: string): Promise<ActiveOrganization | null> => {
		try {
			const activeOrganization = await auth.api.getFullOrganization({
				query: {
					organizationSlug: slug,
				},
				headers: await headers(),
			});

			if (activeOrganization) {
				return activeOrganization;
			}
		} catch {
			// fall through to guest fallback
		}

		// Guest fallback: Better Auth's getFullOrganization requires an
		// OrganizationMember row, which a project-scoped guest does not
		// have. Return the bare org record so the org-scoped layout can
		// render branding and guests can reach their invited projects.
		try {
			const session = await auth.api.getSession({
				headers: await headers(),
			});
			if (!session?.user?.id) {
				return null;
			}

			// Do NOT select `metadata` — it is free-form JSON and may
			// hold internal org flags that should not leak to guests.
			// The NavBar and guest landing experience only need the
			// identification fields.
			const org = await db.organization.findUnique({
				where: { slug },
				select: {
					id: true,
					slug: true,
					name: true,
					logo: true,
					createdAt: true,
				},
			});
			if (!org) {
				return null;
			}

			const isGuest = await isGuestInOrg(session.user.id, org.id);
			if (!isGuest) {
				return null;
			}

			return {
				...org,
				members: [],
				invitations: [],
			} as unknown as ActiveOrganization;
		} catch {
			return null;
		}
	},
);

export const getOrganizationList = cache(async (): Promise<Organization[]> => {
	try {
		const organizationList = await auth.api.listOrganizations({
			headers: await headers(),
		});
		return (organizationList ?? []) as Organization[];
	} catch {
		return [];
	}
});

export const getUserAccounts = cache(async () => {
	try {
		const userAccounts = await auth.api.listUserAccounts({
			headers: await headers(),
		});

		return userAccounts;
	} catch {
		return [];
	}
});

export const getUserPasskeys = cache(async () => {
	try {
		const userPasskeys = await auth.api.listPasskeys({
			headers: await headers(),
		});

		return userPasskeys;
	} catch {
		return [];
	}
});

export const getInvitation = cache(async (id: string) => {
	try {
		return await getInvitationById(id);
	} catch {
		return null;
	}
});

/**
 * True when the current user has guest-only access to an organization:
 * at least one accepted ProjectMember row on a project belonging to that org,
 * AND no OrganizationMember (Better Auth `member`) row in that org.
 *
 * Used by the app layout to hide org-level chrome (settings, billing,
 * integrations, members) from guests.
 */
export const isGuestInOrg = cache(
	async (userId: string, organizationId: string): Promise<boolean> => {
		try {
			const [orgMembership, projectMembership] = await Promise.all([
				db.member.findFirst({
					where: { organizationId, userId },
					select: { id: true },
				}),
				db.projectMember.findFirst({
					where: {
						userId,
						acceptedAt: { not: null },
						OR: [
							{ expiresAt: null },
							{ expiresAt: { gt: new Date() } },
						],
						project: { organizationId },
					},
					select: { id: true },
				}),
			]);
			return !orgMembership && !!projectMembership;
		} catch {
			return false;
		}
	},
);
