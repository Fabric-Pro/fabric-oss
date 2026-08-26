import { getDeliveryPreferences } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Read the current user's notification delivery-channel preferences.
 *
 * Delivery preferences are account-global (per-user, not per-org) — keyed on
 * the caller's id only, so the same channels apply in every workspace (AC-9).
 * A missing row means in-app only: every external channel off (AC-1).
 *
 * In-app is the always-on default and is NOT represented in the payload; the UI
 * renders it as a fixed, disabled row (AC-8). The webhook signing secret is
 * never returned — only `hasWebhookSecret` signals whether one is configured.
 * The webhook URL is config, not a secret, so it is decrypted and returned so
 * the user can review/edit it.
 */
export const getDeliveryPreferencesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "GET",
		path: "/notifications/delivery-preferences",
		tags: ["Notifications"],
		summary:
			"Get the current user's notification delivery-channel preferences",
		description:
			"Account-global per-user channels controlling WHERE notifications are delivered (in-app is always on). Missing preferences default to in-app only.",
	})
	.output(
		z.object({
			emailEnabled: z.boolean(),
			webhookEnabled: z.boolean(),
			webhookUrl: z.string().nullable(),
			hasWebhookSecret: z.boolean(),
		}),
	)
	.handler(async ({ context }) => {
		const row = await getDeliveryPreferences(context.user.id);

		return {
			emailEnabled: row.emailEnabled,
			webhookEnabled: row.webhookEnabled,
			webhookUrl: row.encryptedWebhookUrl
				? decryptApiKey(row.encryptedWebhookUrl)
				: null,
			hasWebhookSecret: row.encryptedWebhookSecret !== null,
		};
	});
