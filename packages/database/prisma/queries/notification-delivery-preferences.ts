/**
 * Notification delivery-channel preference queries.
 *
 * Per-user, account-global preferences controlling WHERE a user receives
 * notifications — orthogonal to the category toggles in
 * `notification-preferences.ts`, which control WHICH notifications they get.
 *
 * In-app (the notification center) is the always-on default and is NOT stored
 * here. Only the opt-in external channels — email and webhook — are persisted.
 * There is exactly one row per user, keyed at the `organizationId = ""`
 * sentinel, mirroring `UserOrchestratorPreferences` / `notification-preferences`.
 *
 * Defaults are opt-IN (the inverse of the category model): a missing row means
 * every external channel is OFF, so existing users keep in-app-only delivery
 * with no backfill (AC-1).
 *
 * The webhook URL and signing secret are stored ENCRYPTED at rest (the columns
 * are named `encrypted*`). This layer treats them as opaque ciphertext strings;
 * encryption/decryption lives at the call sites that hold the plaintext
 * (the oRPC procedures and the Temporal webhook activity), never here.
 */

import { db } from "../client";

/** Raw row shape — channel flags plus encrypted webhook config (opaque here). */
export type NotificationDeliveryPreferenceRow = {
	emailEnabled: boolean;
	webhookEnabled: boolean;
	encryptedWebhookUrl: string | null;
	encryptedWebhookSecret: string | null;
};

/**
 * Opt-in default applied when no row exists: in-app only, every external
 * channel off. Mirrors the "missing row = sensible default" pattern from
 * `notification-preferences`, inverted because external channels are opt-in.
 */
export const DEFAULT_NOTIFICATION_DELIVERY_PREFERENCES: NotificationDeliveryPreferenceRow =
	{
		emailEnabled: false,
		webhookEnabled: false,
		encryptedWebhookUrl: null,
		encryptedWebhookSecret: null,
	};

// Prisma compound unique doesn't handle null cleanly; "" is the personal /
// account-global sentinel, matching UserOrchestratorPreferences.
function normalizeOrgId(organizationId?: string | null): string {
	return organizationId || "";
}

const ROW_SELECT = {
	emailEnabled: true,
	webhookEnabled: true,
	encryptedWebhookUrl: true,
	encryptedWebhookSecret: true,
} as const;

/**
 * Read a user's delivery preferences. Returns the in-app-only default when no
 * row exists (opt-in model — a missing row means no external channels).
 */
export async function getDeliveryPreferences(
	userId: string,
	organizationId?: string | null,
): Promise<NotificationDeliveryPreferenceRow> {
	const row = await db.notificationDeliveryPreference.findUnique({
		where: {
			userId_organizationId: {
				userId,
				organizationId: normalizeOrgId(organizationId),
			},
		},
		select: ROW_SELECT,
	});

	if (!row) {
		return { ...DEFAULT_NOTIFICATION_DELIVERY_PREFERENCES };
	}

	return {
		emailEnabled: row.emailEnabled,
		webhookEnabled: row.webhookEnabled,
		encryptedWebhookUrl: row.encryptedWebhookUrl,
		encryptedWebhookSecret: row.encryptedWebhookSecret,
	};
}

/**
 * Fields a caller may upsert. Each is optional; omitted fields keep their
 * current (or default) value. `encryptedWebhookUrl` / `encryptedWebhookSecret`
 * must already be ciphertext — this layer never sees plaintext. Pass `null`
 * explicitly to clear a stored value.
 */
export type UpsertDeliveryPreferencesInput = {
	emailEnabled?: boolean;
	webhookEnabled?: boolean;
	encryptedWebhookUrl?: string | null;
	encryptedWebhookSecret?: string | null;
};

/**
 * Create or update a user's delivery preferences. Only the provided fields are
 * changed; omitted fields keep their current value.
 */
export async function upsertDeliveryPreferences(
	userId: string,
	input: UpsertDeliveryPreferencesInput,
	organizationId?: string | null,
): Promise<NotificationDeliveryPreferenceRow> {
	const orgId = normalizeOrgId(organizationId);
	const row = await db.notificationDeliveryPreference.upsert({
		where: { userId_organizationId: { userId, organizationId: orgId } },
		create: {
			userId,
			organizationId: orgId,
			emailEnabled: input.emailEnabled ?? false,
			webhookEnabled: input.webhookEnabled ?? false,
			encryptedWebhookUrl: input.encryptedWebhookUrl ?? null,
			encryptedWebhookSecret: input.encryptedWebhookSecret ?? null,
		},
		update: {
			...(input.emailEnabled !== undefined && {
				emailEnabled: input.emailEnabled,
			}),
			...(input.webhookEnabled !== undefined && {
				webhookEnabled: input.webhookEnabled,
			}),
			...(input.encryptedWebhookUrl !== undefined && {
				encryptedWebhookUrl: input.encryptedWebhookUrl,
			}),
			...(input.encryptedWebhookSecret !== undefined && {
				encryptedWebhookSecret: input.encryptedWebhookSecret,
			}),
		},
		select: ROW_SELECT,
	});

	return {
		emailEnabled: row.emailEnabled,
		webhookEnabled: row.webhookEnabled,
		encryptedWebhookUrl: row.encryptedWebhookUrl,
		encryptedWebhookSecret: row.encryptedWebhookSecret,
	};
}
