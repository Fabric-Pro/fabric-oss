import {
	db,
	getNotificationDisplayPreference,
	getNotificationPreferences,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Read the current user's notification category preferences.
 *
 * Preferences are account-global (per-user, not per-org) — keyed on the
 * caller's id only, so the same toggles apply in every workspace (AC-3/AC-11).
 * Missing preferences default to all-enabled (opt-out model).
 *
 * `syncIntegrationAvailable` powers AC-7: when the user has no PM-tool
 * integration on any project they can access, the UI greys out the
 * Sync/Project toggle and shows an explanatory tooltip.
 */
export const getNotificationPreferencesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "GET",
		path: "/notifications/preferences",
		tags: ["Notifications"],
		summary: "Get the current user's notification category preferences",
		description:
			"Account-global per-user toggles controlling which in-app notification categories are delivered. Missing preferences default to all-enabled.",
	})
	.output(
		z.object({
			mentions: z.boolean(),
			replies: z.boolean(),
			assignments: z.boolean(),
			status: z.boolean(),
			syncProject: z.boolean(),
			aiAgent: z.boolean(),
			reportEmails: z.boolean(),
			reviewEmails: z.boolean(),
			publishingSuggestions: z.boolean(),
			publishingEmails: z.boolean(),
			// Display-only (#2117). A distinct field, not a delivery flag —
			// see NotificationDisplayPreference in @repo/database.
			stackedCardStyle: z.boolean(),
			syncIntegrationAvailable: z.boolean(),
		}),
	)
	.handler(async ({ context }) => {
		const userId = context.user.id;
		const now = new Date();

		const [flags, display, integration] = await Promise.all([
			getNotificationPreferences(userId),
			getNotificationDisplayPreference(userId),
			// AC-7: does the caller have ANY project with a PM-tool integration
			// (personal-owned, active project member, or org member)? `findFirst`
			// short-circuits at the first match. Access shape mirrors
			// `notifications/lib/access-filter.ts` — including the membership
			// not-expired clause so a lapsed member doesn't see the toggle as live.
			db.project.findFirst({
				where: {
					projectManagementMcpServerId: { not: null },
					OR: [
						{ userId, organizationId: null },
						{
							members: {
								some: {
									userId,
									acceptedAt: { not: null },
									OR: [
										{ expiresAt: null },
										{ expiresAt: { gt: now } },
									],
								},
							},
						},
						{ organization: { members: { some: { userId } } } },
					],
				},
				select: { id: true },
			}),
		]);

		return {
			...flags,
			...display,
			syncIntegrationAvailable: integration !== null,
		};
	});
