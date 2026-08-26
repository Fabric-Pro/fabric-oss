import {
	upsertNotificationDisplayPreference,
	upsertNotificationPreferences,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Update the current user's notification category preferences.
 *
 * Own-user only (keyed on `context.user.id`) so one user's toggles never
 * affect another's (PR-1/PR-3/AC-11). Account-global — written to the user's
 * single "" preference row. Only the provided flags are changed; omitted flags
 * keep their current value.
 */
export const updateNotificationPreferencesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/notifications/preferences",
		tags: ["Notifications"],
		summary: "Update the current user's notification category preferences",
		description:
			"Toggle individual notification categories on/off. Takes effect immediately for newly created notifications; existing notifications are unaffected.",
	})
	.input(
		z.object({
			mentions: z.boolean().optional(),
			replies: z.boolean().optional(),
			assignments: z.boolean().optional(),
			status: z.boolean().optional(),
			syncProject: z.boolean().optional(),
			aiAgent: z.boolean().optional(),
			reportEmails: z.boolean().optional(),
			reviewEmails: z.boolean().optional(),
			publishingSuggestions: z.boolean().optional(),
			publishingEmails: z.boolean().optional(),
			// Display-only (#2117) — changes how delivered notifications are
			// drawn, never whether they are delivered.
			stackedCardStyle: z.boolean().optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
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
			stackedCardStyle: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { stackedCardStyle, ...deliveryFlags } = input;

		// Two writes to the same row, but deliberately two calls: the delivery
		// flags and the display preference are separate types precisely so a
		// style toggle can never be mistaken for a delivery gate. Sequential
		// rather than parallel — both upsert the same unique key, and
		// concurrent upserts on one row race for it.
		const flags = await upsertNotificationPreferences(
			context.user.id,
			deliveryFlags,
		);
		const display = await upsertNotificationDisplayPreference(
			context.user.id,
			stackedCardStyle === undefined ? {} : { stackedCardStyle },
		);

		return { success: true, ...flags, ...display };
	});
