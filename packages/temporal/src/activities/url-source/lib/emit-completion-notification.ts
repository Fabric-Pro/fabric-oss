/**
 * Emit the persistent `CONTEXT_INDEXING_COMPLETED` notification from
 * `updateParentStatusActivity` when a URL-source crawl reaches a terminal
 * status. The temporal package can't reach across into `@repo/api`'s
 * `createNotification` (would cycle the dep graph), so this file is a
 * compact, purpose-built mirror of the shape `notification-service.ts`
 * persists — including the partial-unique-index dedupe coalesce on P2002.
 *
 * Three rules this encodes:
 *   - Notification shape: title and snippet both vary by status, and
 *     dedupeKey is `context-indexing-completed:`.
 *   - `CANCELLED` is silent — no notification at all.
 *   - Dedupe runs on the partial unique index over (userId, dedupeKey)
 *     WHERE readAt IS NULL AND archivedAt IS NULL AND dedupeKey IS NOT NULL.
 */
import type { ExtractionStatus } from "@repo/database";
import { db } from "@repo/database/prisma/client";
// Import enums from the generated client module directly to keep this file
// independent of `@repo/database`'s index — that module pulls in queries
// (e.g., ai-credits.ts) that need a live `Prisma` runtime import, which
// would force every test of this helper to stub Prisma. The generated
// enums file has no Prisma runtime dependency.
import {
	NotificationCategory,
	NotificationType,
} from "@repo/database/prisma/generated/enums";
import { activityLogger } from "../../lib/activity-logger";

/**
 * Inlined mirror of `apps/web` `displayUrl()` and
 * `packages/api/.../estimate-copy.ts` `displayUrl()` — the helper is pure
 * and tiny; copying it avoids dragging `@repo/api` into the temporal
 * package's compile graph. Behaviour is pinned by the API-side test at
 * `packages/api/modules/projects/procedures/contexts/lib/__tests__/estimate-copy.test.ts`
 * and mirrored by the temporal-side test at
 * `packages/temporal/__tests__/url-source/emit-completion-notification.test.ts`.
 */
const MAX_PATH_LENGTH = 40;

function displayUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	const host = parsed.host;
	const rawPath = parsed.pathname.replace(/\/+$/, "");
	if (rawPath === "" || rawPath === "/") {
		return host;
	}
	const path =
		rawPath.length > MAX_PATH_LENGTH
			? `${rawPath.slice(0, MAX_PATH_LENGTH)}…`
			: rawPath;
	return `${host}${path}`;
}

function contextTabHref(
	projectId: string,
	organizationSlug: string | null,
): string {
	return organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}/context`
		: `/app/projects/${projectId}/context`;
}

export interface EmitCompletionNotificationInput {
	contextId: string;
	projectId: string;
	userId: string | null;
	organizationId: string | null;
	sourceUrl: string;
	extractionStatus: ExtractionStatus;
	pagesIndexed?: number;
	extractionError?: string | null;
}

/**
 * Insert a `CONTEXT_INDEXING_COMPLETED` notification row keyed on the
 * contextId. Silently returns when:
 *   - status is `CANCELLED` (user-initiated cancels are
 *     intentionally silent).
 *   - status is anything other than `COMPLETED` / `FAILED` (defensive — the
 *     activity only ever invokes this with a terminal status, but the guard
 *     keeps a future caller from emitting a notification for `EXTRACTING`).
 *   - userId is null (no recipient — happens when the workflow was kicked
 *     off without a user context, e.g., reconciliation).
 *
 * Dedupes via the partial unique index on (userId, dedupeKey) live rows.
 * P2002 coalesces into the existing unread/live row — matches the
 * notification-service.ts pattern.
 */
export async function emitCompletionNotification(
	input: EmitCompletionNotificationInput,
): Promise<void> {
	const {
		contextId,
		projectId,
		userId,
		organizationId,
		sourceUrl,
		extractionStatus,
		pagesIndexed = 0,
		extractionError = null,
	} = input;

	// Silent-on-CANCELLED (user-initiated cancels are
	// intentionally not surfaced in the bell — the in-app cancel toast and
	// the row's status pill in the project's Context tab carry the message).
	if (extractionStatus === "CANCELLED") {
		activityLogger.debug("Skipping completion notification on CANCELLED", {
			contextId,
		});
		return;
	}

	// Defensive — only terminal statuses emit completion rows.
	if (extractionStatus !== "COMPLETED" && extractionStatus !== "FAILED") {
		activityLogger.debug(
			"Skipping completion notification — non-terminal status",
			{ contextId, extractionStatus },
		);
		return;
	}

	if (!userId) {
		activityLogger.debug(
			"Skipping completion notification — no userId on workflow input",
			{ contextId },
		);
		return;
	}

	// Org slug lookup (best-effort). When the workflow is org-scoped we
	// build the `/app/${slug}/...` link; when it's personal, slug is null.
	let organizationSlug: string | null = null;
	if (organizationId) {
		try {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { slug: true },
			});
			organizationSlug = org?.slug ?? null;
		} catch (error) {
			activityLogger.warn(
				"Failed to resolve org slug for completion notification",
				{
					contextId,
					organizationId,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}
	}

	const displayedUrl = displayUrl(sourceUrl);
	const isSuccess = extractionStatus === "COMPLETED";

	const title = isSuccess
		? `Indexed ${displayedUrl}`
		: `Failed to index ${displayedUrl}`;
	const snippet = isSuccess
		? `${pagesIndexed} pages ready for AI`
		: (extractionError ?? "Crawl failed");

	// dedupeKey convention: `context-indexing-completed:${contextId}` —
	// distinct prefix from the started-row (`context-indexing-started:`)
	// so the two rows can co-exist for the same crawl. The partial unique
	// index at schema.prisma:8901-8903 coalesces duplicate inserts on the
	// SAME key within the 60s live window.
	const dedupeKey = `context-indexing-completed:${contextId}`;

	const payload = {
		contextId,
		sourceUrl,
		status: extractionStatus,
		pagesIndexed,
		extractionError,
	};

	try {
		await db.notification.create({
			data: {
				userId,
				organizationId,
				type: NotificationType.CONTEXT_INDEXING_COMPLETED,
				category: NotificationCategory.CONTEXT_INDEXING_COMPLETED,
				title,
				snippet,
				link: contextTabHref(projectId, organizationSlug),
				projectId,
				payload,
				dedupeKey,
			},
		});
		activityLogger.info("Emitted CONTEXT_INDEXING_COMPLETED notification", {
			contextId,
			status: extractionStatus,
		});
	} catch (error) {
		// Coalesce dedupe collisions silently — a P2002 here means the
		// partial unique index found an existing unread row for the same
		// (userId, dedupeKey) pair (e.g., a retry-cancel-retry sequence
		// finalized twice). Update the live row with the latest title /
		// snippet / payload so the bell shows current state.
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
				.catch((updateError) => {
					activityLogger.warn(
						"Coalesce-update of completion notification failed",
						{
							contextId,
							updateError:
								updateError instanceof Error
									? updateError.message
									: String(updateError),
						},
					);
				});
			return;
		}
		// Any other error is logged-and-swallowed — the notification dispatch
		// must never abort the finalize activity. The row already has the
		// terminal extractionStatus written by the activity's own update.
		activityLogger.warn(
			"Failed to emit CONTEXT_INDEXING_COMPLETED notification",
			{
				contextId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}
