import {
	type CreateInstructionPublishedNotificationsArgs,
	createInstructionPublishedNotifications,
} from "@repo/database";
import { logger } from "@repo/logs";
import { invalidateUnreadCount } from "../../../../lib/notification-cache";
import { dispatchExternalDelivery } from "../../../../lib/notification-delivery";

/**
 * Tells the project's members a new Coding Instructions version is published,
 * from the oRPC publish paths (manual publish, proposal approval). The writer
 * in `@repo/database` is the one the Temporal publish activity uses too; this
 * wrapper adds what only the API can do for the rows it wrote: clear the
 * cached unread count and start email/webhook delivery where the member opted
 * in. Call it after the publish committed, through `runInBackground`. Never
 * throws.
 */
export async function notifyInstructionsPublished(
	args: CreateInstructionPublishedNotificationsArgs,
): Promise<void> {
	const rows = await createInstructionPublishedNotifications(args);
	await Promise.all(
		rows.map(async (row) => {
			await invalidateUnreadCount(row.userId, args.organizationId);
			await dispatchExternalDelivery(row).catch((error: unknown) => {
				logger.warn(
					{ err: error, notificationId: row.id },
					"[instructions] publish notification delivery failed",
				);
			});
		}),
	);
}
