import { ORPCError } from "@orpc/server";
import {
	getDeliveryPreferences,
	type UpsertDeliveryPreferencesInput,
	upsertDeliveryPreferences,
} from "@repo/database";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	generateWebhookSecret,
	webhookUrlSchema,
} from "../lib/delivery-preferences";

/**
 * Update the current user's notification delivery-channel preferences.
 *
 * Own-user only (keyed on `context.user.id`). Account-global — written to the
 * user's single "" row. Only the provided fields are changed; omitted fields
 * keep their current value, so toggling email never disturbs webhook config and
 * vice-versa (AC-5/AC-7).
 *
 * Webhook URL + signing secret are encrypted at rest (`encryptApiKey`). A fresh
 * signing secret is generated the first time webhook is enabled without one and
 * is returned ONCE as `generatedWebhookSecret` — it is never retrievable
 * afterwards (only `hasWebhookSecret` is exposed). A malformed URL is rejected
 * by the input schema before the handler runs, so nothing is persisted (AC-4).
 */
export const updateDeliveryPreferencesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/notifications/delivery-preferences",
		tags: ["Notifications"],
		summary:
			"Update the current user's notification delivery-channel preferences",
		description:
			"Enable/disable email and webhook delivery and configure the webhook endpoint. In-app delivery is always on and cannot be disabled.",
	})
	.input(
		z.object({
			emailEnabled: z.boolean().optional(),
			webhookEnabled: z.boolean().optional(),
			// Empty string clears the stored URL; any other value must be a valid
			// http(s) URL without embedded credentials.
			webhookUrl: z.union([webhookUrlSchema, z.literal("")]).optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			emailEnabled: z.boolean(),
			webhookEnabled: z.boolean(),
			webhookUrl: z.string().nullable(),
			hasWebhookSecret: z.boolean(),
			/** Present only when a secret was freshly generated — shown once. */
			generatedWebhookSecret: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const current = await getDeliveryPreferences(userId);

		const upsertInput: UpsertDeliveryPreferencesInput = {};
		if (input.emailEnabled !== undefined) {
			upsertInput.emailEnabled = input.emailEnabled;
		}
		if (input.webhookEnabled !== undefined) {
			upsertInput.webhookEnabled = input.webhookEnabled;
		}

		// Resolve the effective webhook URL after this update for the
		// "enabled-needs-a-URL" guard below.
		let effectiveEncryptedUrl = current.encryptedWebhookUrl;
		if (input.webhookUrl !== undefined) {
			if (input.webhookUrl === "") {
				upsertInput.encryptedWebhookUrl = null;
				effectiveEncryptedUrl = null;
			} else {
				upsertInput.encryptedWebhookUrl = encryptApiKey(
					input.webhookUrl,
				);
				effectiveEncryptedUrl = upsertInput.encryptedWebhookUrl;
			}
		}

		const effectiveWebhookEnabled =
			input.webhookEnabled ?? current.webhookEnabled;

		// A webhook channel with no endpoint can't deliver — block the save with
		// a clear error rather than silently persisting an unusable state.
		if (effectiveWebhookEnabled && !effectiveEncryptedUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"A webhook URL is required to enable webhook delivery.",
			});
		}

		// Mint a signing secret the first time webhook is enabled without one.
		let generatedWebhookSecret: string | undefined;
		if (effectiveWebhookEnabled && !current.encryptedWebhookSecret) {
			generatedWebhookSecret = generateWebhookSecret();
			upsertInput.encryptedWebhookSecret = encryptApiKey(
				generatedWebhookSecret,
			);
		}

		const row = await upsertDeliveryPreferences(userId, upsertInput);

		return {
			success: true,
			emailEnabled: row.emailEnabled,
			webhookEnabled: row.webhookEnabled,
			webhookUrl: row.encryptedWebhookUrl
				? decryptApiKey(row.encryptedWebhookUrl)
				: null,
			hasWebhookSecret: row.encryptedWebhookSecret !== null,
			...(generatedWebhookSecret ? { generatedWebhookSecret } : {}),
		};
	});
