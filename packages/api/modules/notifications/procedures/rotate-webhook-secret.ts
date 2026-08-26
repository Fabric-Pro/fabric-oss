import { ORPCError } from "@orpc/server";
import {
	getDeliveryPreferences,
	upsertDeliveryPreferences,
} from "@repo/database";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { generateWebhookSecret } from "../lib/delivery-preferences";

/**
 * Rotate the current user's webhook signing secret.
 *
 * Generates a new secret, persists only its encrypted form, and returns the
 * plaintext ONCE (never retrievable afterwards). Requires a configured webhook
 * URL — rotating a secret for a channel that was never set up is a no-op the
 * UI shouldn't offer, so it's rejected here too.
 */
export const rotateWebhookSecretProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/notifications/delivery-preferences/rotate-webhook-secret",
		tags: ["Notifications"],
		summary: "Rotate the current user's webhook signing secret",
		description:
			"Generates a new HMAC signing secret for webhook delivery and returns it once. The previous secret stops working immediately.",
	})
	.output(
		z.object({
			success: z.boolean(),
			webhookSecret: z.string(),
		}),
	)
	.handler(async ({ context }) => {
		const userId = context.user.id;
		const current = await getDeliveryPreferences(userId);

		if (!current.encryptedWebhookUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Configure a webhook URL before rotating the signing secret.",
			});
		}

		const webhookSecret = generateWebhookSecret();
		await upsertDeliveryPreferences(userId, {
			encryptedWebhookSecret: encryptApiKey(webhookSecret),
		});

		return { success: true, webhookSecret };
	});
