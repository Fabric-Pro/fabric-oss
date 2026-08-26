/**
 * Emit the persistent `SECURITY_TICKETS_GENERATED` notification when a
 * security-finding-grouping run creates or updates at least one ticket. The
 * temporal package can't reach `@repo/api`'s `createNotification` (dependency
 * cycle), so this mirrors the shape `emit-scan-notification.ts` persists —
 * including the partial-unique-index dedupe coalesce on P2002. Patterned on
 * `emit-scan-notification.ts` exactly.
 *
 * Not exported from `activities/security-scan/index.ts`'s barrel — like
 * `emitScanNotification`, this is a plain function imported directly by its
 * one caller (`grouping-activities.ts`'s `persistGroupingResultsActivity`),
 * not itself a Temporal-registered activity.
 */

import { db } from "@repo/database/prisma/client";
import {
	NotificationCategory,
	NotificationType,
} from "@repo/database/prisma/generated/enums";
import {
	getNotificationPreferences,
	isCategoryEnabled,
} from "@repo/database/prisma/queries/notification-preferences";
import { logger } from "@repo/logs";

export interface EmitGroupingNotificationInput {
	groupingId: string;
	projectId: string;
	projectName: string;
	userId: string | null;
	organizationId: string | null;
	createdCount: number;
	updatedCount: number;
	skippedCount: number;
}

function groupingResultsHref(
	projectId: string,
	organizationSlug: string | null,
): string {
	return organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}/security`
		: `/app/projects/${projectId}/security`;
}

/**
 * Insert a `SECURITY_TICKETS_GENERATED` notification keyed on `groupingId`.
 * Silently returns when there is no recipient (`userId` null). Dedupe
 * collisions coalesce into the existing live row. A failed dispatch never
 * aborts the caller — the grouping row already carries the authoritative
 * status/results.
 *
 * Only called by `persistGroupingResultsActivity` when
 * `createdCount + updatedCount > 0` — a fully-skipped or access-blocked run
 * never reaches this function (no notification spam on a no-op run).
 */
export async function emitGroupingNotification(
	input: EmitGroupingNotificationInput,
): Promise<void> {
	const {
		groupingId,
		projectId,
		projectName,
		userId,
		organizationId,
		createdCount,
		updatedCount,
		skippedCount,
	} = input;

	if (!userId) {
		return;
	}

	// Write-time preference filter, same category/gate as
	// SECURITY_SCAN_COMPLETED (category PROJECT); default-on when no
	// preference row exists.
	const flags = await getNotificationPreferences(userId);
	if (!isCategoryEnabled(flags, NotificationCategory.PROJECT)) {
		return;
	}

	let organizationSlug: string | null = null;
	if (organizationId) {
		try {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { slug: true },
			});
			organizationSlug = org?.slug ?? null;
		} catch (error) {
			logger.warn(
				"[SecurityFindingGrouping] Failed to resolve org slug",
				{
					groupingId,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}
	}

	const totalTickets = createdCount + updatedCount;
	const title = `Grouped findings into ${totalTickets} ticket${totalTickets === 1 ? "" : "s"} — ${projectName}`;
	const snippet = `${createdCount} new · ${updatedCount} updated · ${skippedCount} already covered`;

	const dedupeKey = `security-tickets-generated:${groupingId}`;
	const payload = {
		groupingId,
		projectId,
		projectName,
		createdCount,
		updatedCount,
		skippedCount,
	};

	try {
		await db.notification.create({
			data: {
				userId,
				organizationId,
				type: NotificationType.SECURITY_TICKETS_GENERATED,
				category: NotificationCategory.PROJECT,
				title,
				snippet,
				link: groupingResultsHref(projectId, organizationSlug),
				projectId,
				payload,
				dedupeKey,
			},
		});
	} catch (error) {
		const isUniqueViolation =
			typeof error === "object" &&
			error !== null &&
			(error as { code?: string }).code === "P2002";
		if (isUniqueViolation) {
			await db.notification
				.updateMany({
					where: {
						userId,
						dedupeKey,
						readAt: null,
						archivedAt: null,
					},
					data: { title, snippet, payload },
				})
				.catch(() => {
					/* best-effort coalesce */
				});
			return;
		}
		logger.warn(
			"[SecurityFindingGrouping] Failed to emit completion notification",
			{
				groupingId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}
