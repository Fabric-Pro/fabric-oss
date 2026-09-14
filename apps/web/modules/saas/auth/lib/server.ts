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

/**
 * Whether the organization behind a slug is in its deletion corridor
 * (Fizzy #2462).
 *
 * Asked separately rather than read off the resolved organization, because the
 * auth library owns `getFullOrganization` and its payload is not a contract we
 * control — a soft-delete column it does not know about may or may not survive
 * the round trip. One indexed lookup on a field we do own is cheaper than a
 * guess, and `cache()` means the layout's check and the resolver's both cost a
 * single query per request.
 *
 * Returns null for a slug that does not exist at all: the caller's next step
 * is the same either way, and this is not the place to tell a stranger which
 * organizations exist.
 *
 * DELIBERATELY UNWRAPPED, unlike every other helper in this file. They catch
 * and return a safe default; here there is no such thing. The only default
 * available is "not deleted", and a caught error would hand the organization
 * back exactly when the check could not be made — turning the one query that
 * gates reachability into the one that fails open. Letting it throw costs an
 * error page on a database blip and never costs access. Do not add a catch to
 * make this match its neighbours.
 */
export const getOrganizationDeletedAt = cache(
	async (slug: string): Promise<Date | null> => {
		const organization = await db.organization.findUnique({
			where: { slug },
			select: { deletedAt: true },
		});

		return organization?.deletedAt ?? null;
	},
);

type ActiveOrganization = Awaited<
	ReturnType<typeof auth.api.getFullOrganization>
>;

export const getActiveOrganization = cache(
	async (slug: string): Promise<ActiveOrganization | null> => {
		// A DELETED ORGANIZATION RESOLVES TO NOTHING, for members and guests
		// alike (Fizzy #2462). The schema states the contract this restores:
		// a deactivated organization keeps every row it owns and "is made
		// unreachable by REFUSING it at tenant resolution instead" — which is
		// why none of its ~168 related tables carries a liveness predicate.
		//
		// This was the one resolution path that did not refuse. The oRPC tenant
		// middleware did, so every data read failed, but the shell above them
		// resolved perfectly well and rendered: sidebar, organization name,
		// logo and theme colour, over panels that each failed on their own. The
		// result was a workspace that looked alive and did nothing, with the
		// one fact that explained it — that it had been deleted — stated
		// nowhere.
		//
		// Checked FIRST so it covers the guest fallback below too. That path
		// queries by slug with no liveness predicate of its own, so a
		// project-scoped guest would otherwise still reach the shell of a
		// deleted organization after its members had stopped being able to.
		if (await getOrganizationDeletedAt(slug)) {
			return null;
		}

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

/**
 * The viewer's LIVE organizations.
 *
 * Deleted ones are filtered out here, at the source, and that is load-bearing
 * for more than tidiness (Fizzy #2462). This list is what `/app` routes on —
 * `lastActiveOrganizationId ?? activeOrganizationId ?? organizations.at(0)` —
 * so leaving a deactivated organization in it means a post-login hop drops the
 * person straight back into the workspace they just deleted, where every read
 * is refused at tenant resolution.
 *
 * It is also what makes the slug layout's redirect safe. That layout sends a
 * deleted organization to `/app`; if this list still carried it, `/app` would
 * pick it again and the two would bounce forever. Filtering here is what turns
 * that redirect into a terminating one: with no live organization left, the
 * `requireOrganization` gate falls through to `/new-organization`, which
 * carries the restore banner — the one screen that both explains what happened
 * and offers the way back.
 *
 * The auth library owns `listOrganizations` and knows nothing about the
 * retention window, so the liveness check is a second query rather than a
 * predicate — the same reason `OrganizationSelect` partitions its own list.
 */
export const getOrganizationList = cache(async (): Promise<Organization[]> => {
	try {
		const organizationList = await auth.api.listOrganizations({
			headers: await headers(),
		});
		const organizations = (organizationList ?? []) as Organization[];

		if (organizations.length === 0) {
			return [];
		}

		const deleted = await db.organization.findMany({
			where: {
				id: {
					in: organizations.map((organization) => organization.id),
				},
				deletedAt: { not: null },
			},
			select: { id: true },
		});

		if (deleted.length === 0) {
			return organizations;
		}

		const deletedIds = new Set(
			deleted.map((organization) => organization.id),
		);

		return organizations.filter(
			(organization) => !deletedIds.has(organization.id),
		);
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
