import { listRestorableOrganizationsForUser } from "@repo/database";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { z } from "zod";
import { protectedProcedure } from "../../../../orpc/procedures";

/**
 * The organizations this person could bring back right now (Fizzy #2462).
 *
 * Feeds two surfaces, and it has to feed both or the feature has a dead end:
 *
 *  - the workspace switcher, for someone who still has another organization to
 *    be looking at;
 *  - the create-an-organization page, for someone who just deleted their LAST
 *    one and was redirected there. Without the second, deleting your only
 *    organization strands you on a page that says "create one" and never
 *    mentions the one you can still recover.
 *
 * `protectedProcedure` with no tenant middleware: by definition none of these
 * organizations can be the caller's active one. Safety comes from the query
 * being filtered by the caller's own membership rows, so it cannot name a
 * tenant they have nothing to do with.
 */
export const listRestorableOrganizationsProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/organizations/deletion/restorable",
		tags: ["Organizations"],
		summary: "List organizations the caller can still restore",
	})
	.input(z.object({}).optional())
	.handler(async ({ context }) => {
		const rows = await listRestorableOrganizationsForUser({
			userId: context.user.id,
		});

		return {
			organizations: rows
				// Only the people who could delete it can bring it back — the
				// same rule `restore` enforces. Listing an organization the
				// caller cannot act on would render a button that always fails.
				.filter((row) =>
					hasPermission(
						resolveOrgPermissions(row.role),
						Permissions.ORG_DELETE,
					),
				)
				.map((row) => ({
					id: row.id,
					name: row.name,
					slug: row.slug,
					logo: row.logo,
					deletedAt: row.deletedAt,
					scheduledPermanentDeleteAt: row.scheduledPermanentDeleteAt,
					// Sent as a count rather than a rendered string so the UI
					// owns the wording, and so a page cached for an hour cannot
					// display a stale "6 days left".
					daysRemaining: row.scheduledPermanentDeleteAt
						? Math.max(
								0,
								Math.ceil(
									(row.scheduledPermanentDeleteAt.getTime() -
										Date.now()) /
										(24 * 60 * 60 * 1000),
								),
							)
						: null,
				})),
		};
	});
