/**
 * Emit the persistent `SECURITY_SCAN_COMPLETED` notification when a scan
 * reaches a terminal state. The temporal package can't reach `@repo/api`'s
 * `createNotification` (dep cycle), so this mirrors the shape
 * notification-service.ts persists — including the partial-unique-index dedupe
 * coalesce on P2002. Patterned on url-source/lib/emit-completion-notification.
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

export interface EmitScanNotificationInput {
	scanId: string;
	projectId: string;
	userId: string | null;
	organizationId: string | null;
	securityFindingCount: number;
	accessibilityFindingCount: number;
	failed?: boolean;
	errorMessage?: string | null;
}

function scanPageHref(
	projectId: string,
	organizationSlug: string | null,
): string {
	return organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}/security`
		: `/app/projects/${projectId}/security`;
}

/**
 * Insert a `SECURITY_SCAN_COMPLETED` notification keyed on scanId. Silently
 * returns when there is no recipient (userId null). Dedupe collisions coalesce
 * into the existing live row. A failed dispatch never aborts the caller — the
 * scan row already carries the authoritative status.
 */
export async function emitScanNotification(
	input: EmitScanNotificationInput,
): Promise<void> {
	const {
		scanId,
		projectId,
		userId,
		organizationId,
		securityFindingCount,
		accessibilityFindingCount,
		failed = false,
		errorMessage = null,
	} = input;

	if (!userId) {
		return;
	}

	// Write-time preference filter (Notification Center Preferences, AC-4):
	// SECURITY_SCAN_COMPLETED is category PROJECT, gated by the Sync/Project
	// (`syncProject`) toggle. Skip when the recipient disabled it; default-on
	// when no preference row exists.
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
			logger.warn("[SecurityScan] Failed to resolve org slug", {
				scanId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const total = securityFindingCount + accessibilityFindingCount;
	const title = failed
		? "Security & accessibility scan failed"
		: total === 0
			? "Clean scan — no issues found"
			: `Scan found ${total} issue${total === 1 ? "" : "s"}`;
	const snippet = failed
		? (errorMessage ?? "The scan did not complete")
		: total === 0
			? "No security or accessibility issues detected"
			: `${securityFindingCount} security · ${accessibilityFindingCount} accessibility`;

	const dedupeKey = `security-scan-completed:${scanId}`;
	const payload = {
		scanId,
		securityFindingCount,
		accessibilityFindingCount,
		failed,
	};

	try {
		await db.notification.create({
			data: {
				userId,
				organizationId,
				type: NotificationType.SECURITY_SCAN_COMPLETED,
				category: NotificationCategory.PROJECT,
				title,
				snippet,
				link: scanPageHref(projectId, organizationSlug),
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
		logger.warn("[SecurityScan] Failed to emit completion notification", {
			scanId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
