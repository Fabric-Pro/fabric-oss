/**
 * Scheduled cleanup for deactivated organizations (Fizzy #2462).
 *
 * Deleting an organization deactivates it and schedules its destruction seven
 * days out. This workflow is what makes that second half happen: it runs daily
 * and does two passes — warn the organizations whose window is about to close,
 * then destroy the ones whose window has closed.
 *
 * Modelled closely on `project-deletion.ts`, which has run this exact shape in
 * production since January, and it keeps that file's two hard-won properties:
 *
 *   1. EVERY ITEM IS INDEPENDENT. One organization that fails to purge must not
 *      strand the rest of the batch behind it, so each is wrapped in its own
 *      try/catch and a failure only records an id.
 *
 *   2. THE DATABASE DELETE COMES FIRST. It is the only step that carries the
 *      restore guard, so it is the only step that can discover a person brought
 *      their organization back after this run read its batch. Everything
 *      external happens strictly after a delete that actually removed the row.
 *
 * A restored organization is SKIPPED, not failed. `failedOrganizationIds` exists
 * to be alerted on; putting a successful user recovery in it would page somebody
 * every time the feature worked.
 *
 * NO `patched()` GATES. The project workflow carries several because steps were
 * added to a workflow that already had running histories in production. This one
 * is new — no history exists that could replay differently — and adding gates
 * pre-emptively would leave permanent dead branches nobody can ever remove.
 *
 * IMPORTS ARE TYPE-ONLY BEYOND `@temporalio/workflow`, deliberately. Workflow
 * code is bundled into the deterministic sandbox; pulling in `@repo/database`
 * for a constant would drag Prisma in with it. The retention window is owned by
 * the queries, so nothing here needs to know how long seven days is.
 */

import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const {
	getExpiredOrganizationsActivity,
	getOrganizationsNeedingPurgeReminderActivity,
	sendOrganizationDeletionReminderActivity,
	captureOrganizationSubscriptionIdsActivity,
	permanentDeleteOrganizationFromDbActivity,
	deleteOrganizationVectorsActivity,
	cancelOrganizationSubscriptionsActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "5m",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
		maximumInterval: "1m",
	},
});

// Object-storage teardown gets MORE retries than the default, for the same
// reason the project sweep does: the organization row is already gone, so there
// is no later run that would rediscover these objects. Durable transient
// recovery is worth more here than a fast failure.
const { deleteOrganizationObjectsFromStorageActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "10m",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 10,
		maximumInterval: "2m",
	},
});

// ============================================================================
// Types
// ============================================================================

export interface OrganizationDeleteCleanupWorkflowInput {
	/** Maximum number of organizations to process in one run, per pass. */
	batchSize?: number;
}

export interface OrganizationDeleteCleanupWorkflowOutput {
	/** False when at least one organization failed to purge. */
	success: boolean;
	/** Reminder emails the provider accepted. */
	remindersSent: number;
	/** Organizations destroyed by this run. */
	organizationsDeleted: number;
	/**
	 * Organizations that threw. Restored ones are NOT here — a restore is a
	 * skip, and this list is what alerting reads.
	 */
	failedOrganizationIds: string[];
	durationMs: number;
}

// ============================================================================
// Workflow
// ============================================================================

export async function organizationDeleteCleanupWorkflow(
	input: OrganizationDeleteCleanupWorkflowInput = {},
): Promise<OrganizationDeleteCleanupWorkflowOutput> {
	const startTime = Date.now();
	const { batchSize = 100 } = input;

	log.info("Starting organization delete cleanup workflow", { batchSize });

	let remindersSent = 0;
	let organizationsDeleted = 0;
	const failedOrganizationIds: string[] = [];

	try {
		// --------------------------------------------------------------
		// Pass 1: warn the organizations whose window closes in 24-48h
		// --------------------------------------------------------------
		log.info("Step 1: Processing purge reminders");

		const organizationsNeedingReminder =
			await getOrganizationsNeedingPurgeReminderActivity({ batchSize });

		log.info(
			`Found ${organizationsNeedingReminder.length} organization(s) needing a purge reminder`,
		);

		for (const organization of organizationsNeedingReminder) {
			try {
				const result = await sendOrganizationDeletionReminderActivity({
					organizationId: organization.id,
					organizationName: organization.name,
					owners: organization.owners,
					scheduledPermanentDeleteAt:
						organization.scheduledPermanentDeleteAt,
				});

				if (result.sent) {
					remindersSent++;
					log.info(
						`Sent purge reminder for organization ${organization.id}`,
					);
				} else {
					// Not a batch failure. The activity records nothing when it
					// cannot send, so this organization stays eligible and the
					// next daily run tries again — until its window closes.
					log.warn(
						`Failed to send purge reminder for organization ${organization.id}`,
						{ error: result.error },
					);
				}
			} catch (error) {
				log.error(
					`Error sending purge reminder for organization ${organization.id}`,
					{
						error:
							error instanceof Error
								? error.message
								: "Unknown error",
					},
				);
			}
		}

		// --------------------------------------------------------------
		// Pass 2: destroy the organizations whose window has closed
		// --------------------------------------------------------------
		log.info("Step 2: Processing expired organizations");

		const expiredOrganizations = await getExpiredOrganizationsActivity({
			batchSize,
		});

		log.info(
			`Found ${expiredOrganizations.length} expired organization(s) to purge`,
		);

		for (const organization of expiredOrganizations) {
			try {
				// Lifted out BEFORE the cascade removes the purchase rows that
				// carry them. `Purchase.organizationId` is `onDelete: Cascade`,
				// so after the delete there is nothing left to read and the
				// subscription would bill a destroyed tenant forever.
				const { subscriptionIds } =
					await captureOrganizationSubscriptionIdsActivity({
						organizationId: organization.id,
					});

				// The database FIRST — it carries the restore guard, so this is
				// where a mid-sweep restore is discovered.
				const dbResult =
					await permanentDeleteOrganizationFromDbActivity({
						organizationId: organization.id,
					});

				if (!dbResult.success) {
					// Somebody brought it back between the batch read and now.
					// Skip every teardown step: its vectors, files and billing
					// all still belong to a live organization. NOT counted as a
					// failure — this is the recovery path working.
					log.info(
						`Purge skipped for organization ${organization.id} (restored)`,
						{ error: dbResult.error },
					);
					continue;
				}

				// Vectors. Escalated to error on failure: the rows are gone, so
				// nothing will rediscover these collections and a person's
				// embeddings stay searchable with no automatic recovery.
				const vectorResult = await deleteOrganizationVectorsActivity({
					organizationId: organization.id,
				});

				if (!vectorResult.success) {
					log.error(
						`Vector teardown failed for organization ${organization.id} — vectors ORPHANED, manual cleanup required`,
						{
							event: "organization.deletion.qdrant_orphaned",
							organizationId: organization.id,
							error: vectorResult.error,
						},
					);
				}

				// Objects. The activity exhausts its own retries first; a
				// failure that reaches here is logged, never fatal — the
				// organization is destroyed either way.
				try {
					await deleteOrganizationObjectsFromStorageActivity({
						organizationId: organization.id,
					});
				} catch (err) {
					log.error(
						`Storage teardown failed after retries for organization ${organization.id} (objects orphaned)`,
						{
							event: "organization.deletion.objects_orphaned",
							organizationId: organization.id,
							error:
								err instanceof Error
									? err.message
									: String(err),
						},
					);
				}

				// Billing, last, and only for an organization that really went.
				// Cancelling is irreversible in a way the other two steps are
				// not: a restored organization must come back still paying.
				if (subscriptionIds.length > 0) {
					try {
						const billingResult =
							await cancelOrganizationSubscriptionsActivity({
								organizationId: organization.id,
								subscriptionIds,
							});

						if (billingResult.failed.length > 0) {
							log.error(
								`Subscription cancellation failed for organization ${organization.id} — the tenant is gone but is STILL BILLING`,
								{
									event: "organization.deletion.subscription_orphaned",
									organizationId: organization.id,
									failedCount: billingResult.failed.length,
								},
							);
						}
					} catch (err) {
						log.error(
							`Subscription cancellation threw for organization ${organization.id} — the tenant is gone but may STILL BE BILLING`,
							{
								event: "organization.deletion.subscription_orphaned",
								organizationId: organization.id,
								error:
									err instanceof Error
										? err.message
										: String(err),
							},
						);
					}
				}

				organizationsDeleted++;
				log.info(
					`Permanently deleted organization ${organization.id} (${organization.name})`,
				);
			} catch (error) {
				failedOrganizationIds.push(organization.id);
				log.error(`Error purging organization ${organization.id}`, {
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				});
			}
		}

		const durationMs = Date.now() - startTime;
		const success = failedOrganizationIds.length === 0;

		if (success) {
			log.info("Organization delete cleanup completed successfully", {
				remindersSent,
				organizationsDeleted,
				durationMs,
			});
		} else {
			log.warn(
				"Organization delete cleanup completed with some failures",
				{
					remindersSent,
					organizationsDeleted,
					failedCount: failedOrganizationIds.length,
					failedOrganizationIds,
					durationMs,
				},
			);
		}

		return {
			success,
			remindersSent,
			organizationsDeleted,
			failedOrganizationIds,
			durationMs,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const durationMs = Date.now() - startTime;
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Organization delete cleanup workflow failed", {
			error: errorMsg,
			remindersSent,
			organizationsDeleted,
			durationMs,
		});

		throw ApplicationFailure.nonRetryable(
			errorMsg,
			"ORGANIZATION_DELETION_FAILED",
		);
	}
}
