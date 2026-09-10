/**
 * Activities for the organization purge (Fizzy #2462).
 *
 * An organization is deactivated first and destroyed seven days later. These
 * activities are the destroying half: the reminder that goes out before the
 * window closes, the guarded hard delete, and the teardown of everything the
 * hard delete cannot reach.
 *
 * THE CASCADE IS NOT THE WHOLE JOB. Deleting the `organization` row cascades
 * across ~168 relations and takes the entire tenant's Postgres footprint with
 * it — and reaches nothing outside Postgres. Three things live outside it and
 * each has an activity here:
 *
 *   - vectors, in Qdrant, in per-organization collections;
 *   - objects, in S3/R2, under org-prefixed keys in three buckets;
 *   - the payment-provider subscription, which bills whether or not the tenant
 *     that bought it still exists.
 *
 * ORDER IS LOAD-BEARING AND IS THE DATABASE FIRST. `permanentDeleteOrganization`
 * carries a `deletedAt: { not: null }` guard, so a person who restores their
 * organization between the sweep reading its batch and the sweep reaching their
 * row makes the delete match zero rows and fail. That failure is the signal to
 * skip. Tearing anything down before the delete would destroy a restored
 * organization's vectors and files while its rows sat safely in Postgres —
 * which is the worst outcome available here, because it is silent.
 *
 * `@repo/*` barrels are imported STATICALLY. The worker bundles activities at
 * build time; a dynamic import resolves at runtime against a module graph the
 * bundler never walked.
 */

import { config } from "@repo/config";
import {
	db,
	getOrganizationsNeedingPurgeReminder,
	getOrganizationsReadyForPurge,
	getPurchasesByOrganizationId,
	markOrganizationPurgeReminderSent,
	ORGANIZATION_RETENTION_DAYS,
	permanentDeleteOrganization,
} from "@repo/database";
import { logger } from "@repo/logs";
import { sendEmail } from "@repo/mail";
import { cancelSubscription } from "@repo/payments";
import { deleteOrganizationCollections } from "@repo/rag/lib/collection-manager";
import { deleteObjects, listObjects } from "@repo/storage";
import { getBaseUrl } from "@repo/utils";
import { heartbeat } from "@temporalio/activity";

// ============================================================================
// Types
// ============================================================================

export interface GetExpiredOrganizationsInput {
	batchSize?: number;
}

export interface ExpiredOrganization {
	id: string;
	name: string;
}

export interface GetOrganizationsNeedingPurgeReminderInput {
	batchSize?: number;
}

/** An owner who should be warned before the purge. */
export interface OrganizationPurgeReminderRecipient {
	id: string;
	email: string | null;
}

export interface OrganizationNeedingPurgeReminder {
	id: string;
	name: string;
	/** Who asked for the deletion. Null if that user has since been removed. */
	deletedBy: string | null;
	/**
	 * Every owner, because restoring is gated by the same permission as
	 * deleting — so this is exactly the set of people who can act on the
	 * warning, and the only set for whom it is not merely informational.
	 */
	owners: OrganizationPurgeReminderRecipient[];
	/**
	 * ISO 8601, NOT a `Date`. Temporal's data converter is JSON, so a `Date`
	 * returned from an activity arrives at the workflow as a string wearing a
	 * `Date` type — and `toLocaleString` on a string quietly returns the string
	 * rather than throwing, so the mistake ships as an ISO timestamp in an
	 * email instead of an error. Typing it as what it actually is keeps the
	 * formatting decision at the one place that can make it correctly.
	 */
	scheduledPermanentDeleteAt: string;
}

export interface SendOrganizationDeletionReminderInput {
	organizationId: string;
	organizationName: string;
	owners: OrganizationPurgeReminderRecipient[];
	/** ISO 8601 — see the note on `OrganizationNeedingPurgeReminder`. */
	scheduledPermanentDeleteAt: string;
}

export interface SendOrganizationDeletionReminderOutput {
	sent: boolean;
	error?: string;
}

export interface PermanentDeleteOrganizationFromDbInput {
	organizationId: string;
}

export interface PermanentDeleteOrganizationFromDbOutput {
	success: boolean;
	/**
	 * True when the delete missed because the organization is live again. The
	 * caller must treat this as a SKIP, never as a failure — somebody exercised
	 * the recovery this whole corridor exists to provide.
	 */
	restored?: boolean;
	error?: string;
}

export interface DeleteOrganizationVectorsInput {
	organizationId: string;
}

export interface DeleteOrganizationVectorsOutput {
	success: boolean;
	error?: string;
}

export interface DeleteOrganizationObjectsFromStorageInput {
	organizationId: string;
}

export interface DeleteOrganizationObjectsFromStorageOutput {
	deleted: number;
	pages: number;
}

export interface CaptureOrganizationSubscriptionIdsInput {
	organizationId: string;
}

export interface CaptureOrganizationSubscriptionIdsOutput {
	subscriptionIds: string[];
}

export interface CancelOrganizationSubscriptionsInput {
	organizationId: string;
	subscriptionIds: string[];
}

export interface CancelOrganizationSubscriptionsOutput {
	cancelled: number;
	/** Subscription ids the provider refused. Empty on a clean run. */
	failed: string[];
}

// ============================================================================
// Reminder pass
// ============================================================================

/**
 * Where a person goes to bring a deactivated organization back.
 *
 * `/new-organization`, not a dedicated restore route, because that is where the
 * restore control actually lives: the page renders `RestorableOrganizations` as
 * a banner above the create form, and it is already where deleting your last
 * organization drops you. Sending the reminder somewhere else would mean two
 * surfaces for one action, and the mail would rot the moment one moved.
 *
 * A plain path, not a tokenised one: restoring is not destructive, the banner
 * lists only what `listRestorableOrganizationsForUser` says the signed-in caller
 * may restore, and a link carrying a capability would still be spendable by
 * anyone who saw the mail.
 */
const ORGANIZATION_RESTORE_PATH = "/new-organization";

/**
 * Organizations 24-48 hours from purge that have not been warned yet.
 *
 * The query has NO lower bound on the window, so an organization whose warning
 * failed is picked up again the next day rather than falling past a band and
 * never being warned. `deletionReminderSentAt` is what stops a SUCCESSFUL
 * warning going out twice.
 */
export async function getOrganizationsNeedingPurgeReminderActivity(
	input: GetOrganizationsNeedingPurgeReminderInput,
): Promise<OrganizationNeedingPurgeReminder[]> {
	const { batchSize = 100 } = input;

	try {
		const organizations = await getOrganizationsNeedingPurgeReminder({
			batchSize,
		});

		logger.info(
			`[OrgDeletion] Found ${organizations.length} organization(s) needing a purge reminder`,
		);

		return organizations.map((organization) => ({
			id: organization.id,
			name: organization.name,
			deletedBy: organization.deletedBy,
			owners: organization.owners.map((owner) => ({
				id: owner.id,
				email: owner.email,
			})),
			// The query's own WHERE clause guarantees this column is set; the
			// fallback exists only to satisfy the nullable column type.
			scheduledPermanentDeleteAt: (
				organization.scheduledPermanentDeleteAt ?? new Date()
			).toISOString(),
		}));
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[OrgDeletion] Failed to fetch organizations needing a reminder: ${errorMsg}`,
		);
		// Re-thrown so Temporal retries and a systemically broken reminder pass
		// is visible, rather than reporting "0 to warn" forever.
		throw error;
	}
}

/**
 * Warn every owner that the window is closing.
 *
 * ALL OWNERS, not just whoever pressed the button. Restoring is gated by the
 * same permission as deleting, so an owner is exactly the set of people who can
 * act on this warning — and a co-owner who finds out after the purge has no
 * recourse at all.
 *
 * The stamp is ALL-OR-NOTHING. `deletionReminderSentAt` is a single column: it
 * can record that the warning went out, not that four of five owners received
 * one. So the column is stamped only when every recipient was accepted, and a
 * partial failure deliberately leaves it null — the sweep then retries the whole
 * organization tomorrow, and the owners who already received one get a duplicate.
 * A duplicate warning is a nuisance; a missing one is the failure this feature
 * exists to prevent, so the trade goes that way.
 *
 * That retry only works because the query has no lower bound on the window (see
 * `getOrganizationsNeedingPurgeReminder`). Under the 24-48h band it originally
 * had, an organization that failed its send fell out of the band before the next
 * sweep and was never warned at all.
 *
 * The per-recipient idempotency key is what keeps the duplicate bounded to the
 * failed pass rather than every pass.
 */
export async function sendOrganizationDeletionReminderActivity(
	input: SendOrganizationDeletionReminderInput,
): Promise<SendOrganizationDeletionReminderOutput> {
	const {
		organizationId,
		organizationName,
		owners,
		scheduledPermanentDeleteAt,
	} = input;

	// Nobody to warn. Stamping here would record a warning that was never
	// composed, and the organization would go dark with no notice and no trace
	// of why — so leave the column null and say so loudly instead.
	if (owners.length === 0) {
		logger.warn(
			`[OrgDeletion] Organization ${organizationId} has no owners to warn`,
		);
		return { sent: false, error: "No reminder recipient" };
	}

	try {
		// Formatted HERE, on the way into the template, because this is the last
		// place that still holds a real `Date`. Full date AND time with a zone:
		// "in two days" is unactionable to someone reading it at the wrong end
		// of a weekend.
		const purgeDate = new Date(scheduledPermanentDeleteAt).toLocaleString(
			"en-US",
			{
				weekday: "long",
				year: "numeric",
				month: "long",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
				timeZoneName: "short",
			},
		);

		const restoreUrl = new URL(
			ORGANIZATION_RESTORE_PATH,
			getBaseUrl(),
		).toString();

		// Sent one at a time rather than as one message with many recipients:
		// putting every owner in a single `to` would show each of them the
		// others' addresses, and a single provider rejection would lose the
		// whole set rather than one of it.
		const results = await Promise.all(
			owners.map(async (owner) => {
				if (!owner.email) {
					return { ok: false as const, userId: owner.id };
				}

				const accepted = await sendEmail({
					to: owner.email,
					templateId: "organizationDeletionReminder",
					// Per organization AND per recipient, so a retried attempt
					// cannot send the same owner a second copy while still
					// letting the pass reach an owner it missed.
					idempotencyKey: `org-deletion-reminder-${organizationId}-${owner.id}`,
					context: {
						organizationName,
						restoreUrl,
						purgeDate,
						retentionDays: ORGANIZATION_RETENTION_DAYS,
					},
				});

				return { ok: accepted === true, userId: owner.id };
			}),
		);

		const failed = results.filter((result) => !result.ok);

		if (failed.length > 0) {
			logger.error(
				`[OrgDeletion] Reminder for organization ${organizationId} reached ${
					results.length - failed.length
				} of ${results.length} owners — not stamping, will retry`,
			);
			return {
				sent: false,
				error: `Mail provider rejected ${failed.length} of ${results.length} recipients`,
			};
		}

		await markOrganizationPurgeReminderSent(organizationId);

		logger.info(
			`[OrgDeletion] Sent purge reminder for organization ${organizationId} to ${results.length} owner(s)`,
		);

		return { sent: true };
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[OrgDeletion] Failed to send purge reminder for organization ${organizationId}: ${errorMsg}`,
		);

		// Returned, not thrown: one organization's unreachable mailbox must not
		// stop the sweep from warning the rest of the batch.
		return { sent: false, error: errorMsg };
	}
}

// ============================================================================
// Purge pass
// ============================================================================

/**
 * Organizations whose window has elapsed.
 *
 * Oldest first, so a backlog drains in the order it accumulated.
 */
export async function getExpiredOrganizationsActivity(
	input: GetExpiredOrganizationsInput,
): Promise<ExpiredOrganization[]> {
	const { batchSize = 100 } = input;

	try {
		const organizations = await getOrganizationsReadyForPurge({
			batchSize,
		});

		logger.info(
			`[OrgDeletion] Found ${organizations.length} organization(s) ready for purge`,
		);

		return organizations.map((organization) => ({
			id: organization.id,
			name: organization.name,
		}));
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[OrgDeletion] Failed to fetch expired organizations: ${errorMsg}`,
		);
		throw error;
	}
}

/**
 * Destroy the organization's Postgres footprint, or find out that it came back.
 *
 * THIS DELIBERATELY DIVERGES FROM `permanentDeleteProjectFromDbActivity`, which
 * maps Prisma's P2025 to `{ success: true }`. Under a guarded delete P2025 is
 * ambiguous — it fires both when the row is gone and when the guard rejected a
 * row that is still there — and collapsing the two to success is exactly why the
 * project's storage teardown had to grow a restore-race guard of its own to
 * avoid wiping a restored project's files. Here the two cases are separated at
 * the source by asking whether the row still exists:
 *
 *   - row present  -> the guard rejected it, somebody restored it. `success:
 *     false, restored: true`, and the caller SKIPS. Nothing external is touched.
 *   - row absent   -> already destroyed. `success: true`, because the goal is
 *     achieved and this is the shape a retried attempt takes after its first
 *     attempt succeeded but the response was lost. Reporting failure there would
 *     strand the external teardown, which no later run would ever retry.
 *
 * Transient failures throw so Temporal retries them.
 */
export async function permanentDeleteOrganizationFromDbActivity(
	input: PermanentDeleteOrganizationFromDbInput,
): Promise<PermanentDeleteOrganizationFromDbOutput> {
	const { organizationId } = input;

	try {
		await permanentDeleteOrganization(organizationId);

		logger.info(
			`[OrgDeletion] Permanently deleted organization ${organizationId} from the database`,
		);

		return { success: true };
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";

		const isNotFoundError =
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "P2025";

		if (!isNotFoundError) {
			logger.error(
				`[OrgDeletion] Transient failure deleting organization ${organizationId}: ${errorMsg}`,
			);
			throw error;
		}

		const stillExists = await db.organization.findUnique({
			where: { id: organizationId },
			select: { id: true },
		});

		if (stillExists) {
			logger.info(
				`[OrgDeletion] Organization ${organizationId} was restored — skipping purge`,
			);
			return {
				success: false,
				restored: true,
				error: "Organization was restored",
			};
		}

		logger.info(
			`[OrgDeletion] Organization ${organizationId} was already destroyed — continuing with teardown`,
		);
		return { success: true };
	}
}

/**
 * Drop the organization's vector collections.
 *
 * Nothing in the repository called `deleteOrganizationCollections` before this
 * activity existed, despite its doc-comment saying it is "called when an
 * organization is deleted" — so every organization deleted to date has left its
 * embeddings searchable in Qdrant. This is the caller it was written for.
 *
 * THE SUCCESS FLAG IS WEAKER THAN IT LOOKS, and the caller's alerting has to
 * know it: `deleteOrganizationCollections` wraps each collection in its own
 * try/catch, logs, and carries on, returning `void`. A single collection that
 * refuses to drop is invisible from out here. `success: false` therefore means
 * "the whole call threw" — a malformed id, or a Qdrant client that is down —
 * not "every collection is gone". Fixing that belongs in `packages/rag`, whose
 * existence check on this path is also the cached one its own doc-comment warns
 * against using for deletes.
 *
 * The restore-race guard is here for defence in depth rather than necessity: the
 * caller only reaches this after a delete that reported success, and an
 * organization whose row is gone cannot be restored. It costs one primary-key
 * lookup and it means a future caller that reorders the steps cannot silently
 * destroy a live tenant's embeddings.
 */
export async function deleteOrganizationVectorsActivity(
	input: DeleteOrganizationVectorsInput,
): Promise<DeleteOrganizationVectorsOutput> {
	const { organizationId } = input;

	const stillExists = await db.organization.findUnique({
		where: { id: organizationId },
		select: { id: true },
	});

	if (stillExists) {
		logger.info(
			`[OrgDeletion] Organization ${organizationId} still exists — skipping vector teardown`,
		);
		return { success: true };
	}

	try {
		await deleteOrganizationCollections(organizationId);

		logger.info(
			`[OrgDeletion] Deleted vector collections for organization ${organizationId}`,
		);

		return { success: true };
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[OrgDeletion] Failed to delete vector collections for organization ${organizationId}: ${errorMsg}`,
		);

		return { success: false, error: errorMsg };
	}
}

/**
 * Record the organization's subscription ids BEFORE the cascade eats them.
 *
 * `Purchase.organizationId` is `onDelete: Cascade`, so the moment the
 * organization row goes, every purchase row that names its subscription goes
 * with it. Reading them after the delete returns an empty list and cancels
 * nothing — which looks exactly like an organization that never had a
 * subscription, and would bill a destroyed tenant forever with no trace.
 *
 * Same shape as `captureProjectDocumentIdsActivity`, and for the same reason:
 * the identifiers an external system needs have to be lifted out of Postgres
 * while the rows still exist.
 *
 * Runs before the delete for EVERY candidate, including ones that turn out to
 * have been restored. That is harmless — the ids are only spent by
 * `cancelOrganizationSubscriptionsActivity`, which the caller reaches only after
 * a delete that actually removed the row.
 */
export async function captureOrganizationSubscriptionIdsActivity(
	input: CaptureOrganizationSubscriptionIdsInput,
): Promise<CaptureOrganizationSubscriptionIdsOutput> {
	const purchases = await getPurchasesByOrganizationId(input.organizationId);

	const subscriptionIds = purchases
		.filter(
			(purchase) =>
				purchase.type === "SUBSCRIPTION" &&
				purchase.subscriptionId !== null,
		)
		.map((purchase) => purchase.subscriptionId as string);

	return { subscriptionIds };
}

/**
 * Cancel the organization's subscriptions with the payment provider.
 *
 * AT PURGE, NOT AT DEACTIVATION, and that is the whole point of putting it here.
 * The corridor promises an organization comes back exactly as it was; a
 * subscription cancelled on day zero cannot be un-cancelled on day six, so
 * someone who changed their mind would be restored into a tenant with no
 * billing. The trade is explicit: the organization keeps paying for the days it
 * is recoverable, and stops paying the moment it stops being recoverable.
 *
 * This used to happen in `packages/auth`'s `before` hook on
 * `/organization/delete`. That route no longer deletes organizations — the oRPC
 * flow does — so without this activity a purged tenant's subscription would bill
 * forever against a customer that no longer exists.
 *
 * Failures are collected rather than thrown. The organization is already gone;
 * an unreachable payment provider must not fail the batch, and the returned list
 * is what makes the leftover subscriptions actionable.
 */
export async function cancelOrganizationSubscriptionsActivity(
	input: CancelOrganizationSubscriptionsInput,
): Promise<CancelOrganizationSubscriptionsOutput> {
	const { organizationId, subscriptionIds } = input;

	const failed: string[] = [];
	let cancelled = 0;

	for (const subscriptionId of subscriptionIds) {
		try {
			await cancelSubscription(subscriptionId);
			cancelled += 1;
		} catch (error) {
			const errorMsg =
				error instanceof Error ? error.message : "Unknown error";
			logger.error(
				`[OrgDeletion] Failed to cancel subscription for organization ${organizationId}: ${errorMsg}`,
			);
			failed.push(subscriptionId);
		}
	}

	if (cancelled > 0 || failed.length > 0) {
		logger.info(
			`[OrgDeletion] Cancelled ${cancelled} subscription(s) for organization ${organizationId} (${failed.length} failed)`,
		);
	}

	return { cancelled, failed };
}

// ============================================================================
// Object storage teardown
// ============================================================================

/**
 * Infinite-loop guard only — NOT a silent partial cap. Exceeding it throws, so a
 * pathological prefix surfaces as a failure Temporal retries rather than as a
 * quietly incomplete cleanup.
 */
const STORAGE_PAGE_SANITY_LIMIT = 10_000;

/** Heartbeat that is a no-op outside an activity context (unit tests). */
function safeStorageHeartbeat(): void {
	try {
		heartbeat();
	} catch {
		// not running inside a Temporal activity
	}
}

/**
 * Delete every object the organization owns.
 *
 * WHY `${organizationId}/` IS A SAFE PREFIX. `buildTenantStoragePath` keys every
 * tenant-scoped object under its owner — the organization id in an organization,
 * the user id otherwise — and `isTenantOwnedKey` treats that prefix as the
 * isolation boundary the whole scheme rests on. Organization ids and user ids are
 * drawn from the same cuid space and never collide, so a key under this prefix
 * belongs to this organization and to nothing else.
 *
 * Two prefixes and one exact key, which is every org-scoped path that exists:
 *   - chat-documents: `{orgId}/workspace-files/...`
 *   - qa-run-evidence: `{orgId}/qa-runs/...`
 *   - avatars: `{orgId}.png`, the organization logo — a single object, not a
 *     prefix, because that is how the logo upload URL is minted.
 *
 * Project-scoped objects are NOT swept here. They are keyed by project id, not
 * by tenant, and are the project purge's job.
 *
 * Paging has no deletion cap: the organization row is already gone, so a capped
 * sweep would strand objects with nothing left to rediscover them. Residual
 * delete errors throw so Temporal retries the whole activity; the workflow
 * swallows the final post-retry failure and logs it, because the organization is
 * destroyed either way. Idempotent — re-running deletes whatever remains.
 */
export async function deleteOrganizationObjectsFromStorageActivity(
	input: DeleteOrganizationObjectsFromStorageInput,
): Promise<DeleteOrganizationObjectsFromStorageOutput> {
	const { organizationId } = input;

	// Restore-race guard, mirroring the project attachment sweep: deleting a
	// live organization's files is unrecoverable in a way the row delete is not.
	const stillExists = await db.organization.findUnique({
		where: { id: organizationId },
		select: { id: true },
	});

	if (stillExists) {
		logger.info(
			`[OrgDeletion] Organization ${organizationId} still exists (restored) — skipping storage cleanup`,
		);
		return { deleted: 0, pages: 0 };
	}

	const sweeps: { bucket: string; prefix: string }[] = [
		{
			bucket: config.storage.bucketNames.chatDocuments,
			prefix: `${organizationId}/`,
		},
		{
			bucket: config.storage.bucketNames.qaRunEvidence,
			prefix: `${organizationId}/`,
		},
	];

	let deleted = 0;
	let pages = 0;
	const errors: { key: string; message: string }[] = [];

	for (const sweep of sweeps) {
		let continuationToken: string | undefined;

		while (true) {
			if (pages >= STORAGE_PAGE_SANITY_LIMIT) {
				throw new Error(
					`[OrgDeletion] storage cleanup exceeded ${STORAGE_PAGE_SANITY_LIMIT} pages for organization ${organizationId}`,
				);
			}

			const page = await listObjects({
				bucket: sweep.bucket,
				prefix: sweep.prefix,
				continuationToken,
				maxKeys: 1000,
			});
			pages += 1;

			const keys = page.objects.map((object) => object.key);
			if (keys.length > 0) {
				const result = await deleteObjects(keys, {
					bucket: sweep.bucket,
				});
				deleted += result.deleted;
				errors.push(...result.errors);
			}

			safeStorageHeartbeat();

			if (!page.nextContinuationToken) {
				break;
			}
			continuationToken = page.nextContinuationToken;
		}
	}

	// The logo is one object at a known key rather than a prefix, so it is
	// deleted by name. A key that was never uploaded deletes cleanly.
	const logoResult = await deleteObjects([`${organizationId}.png`], {
		bucket: config.storage.bucketNames.avatars,
	});
	deleted += logoResult.deleted;
	errors.push(...logoResult.errors);

	if (errors.length > 0) {
		logger.error(
			`[OrgDeletion] storage cleanup left ${errors.length} object(s) for organization ${organizationId}; sample: ${errors
				.slice(0, 5)
				.map((e) => `${e.key}: ${e.message}`)
				.join("; ")}`,
		);
		throw new Error(
			`[OrgDeletion] storage cleanup failed for ${errors.length} object(s) (organization ${organizationId})`,
		);
	}

	logger.info(
		`[OrgDeletion] Deleted ${deleted} object(s) for organization ${organizationId} across ${pages} page(s)`,
	);

	return { deleted, pages };
}
