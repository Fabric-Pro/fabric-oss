/**
 * The one-shot completion / failure notification for a document generation
 * (Fizzy #2199).
 *
 * A generation that had to queue can finish an hour after the person who asked
 * for it closed the tab, so the bell is the only place they will ever learn how
 * it went. Exactly one row per document, on whichever terminal path the run
 * actually took.
 *
 * Lives in `@repo/database` rather than beside `fanOut.*` in
 * `packages/api/lib/notification-service.ts` because the caller is a Temporal
 * activity, and `@repo/api` depends on `@repo/temporal` — reaching back for the
 * API-side helper would close a cycle in the workspace graph. Same remedy, for
 * the same reason, as `document-refresh-notifications.ts` (whose header states
 * it in full), `repo-integration-notifications.ts`, `pm-conflict-notifications.ts`
 * and `agent-reply-notifications.ts`.
 *
 * The mechanism follows `report-execution-notification.ts`, which solves the
 * identical problem for a report run:
 *
 *  - **Exactly-once.** The per-document claim (`generationNotificationEmittedAt`)
 *    and the notification insert run in a SINGLE `db.$transaction`, so a
 *    retried activity, an ambiguous commit, or two terminal paths racing cannot
 *    notify the requester twice. The claim predicate also requires the
 *    PERSISTED status to be one the announced outcome can actually produce, so
 *    the bell can never get ahead of the write it is describing.
 *  - **A repeat run coalesces instead of failing.** The insert is
 *    `createMany({ skipDuplicates })`, because a regenerated document collides
 *    with its own unread notification on the live-unread partial unique index —
 *    and a throw there would abort the transaction and take the claim with it.
 *    See the comment at the write.
 *  - **Tenant and link without a slug lookup.** `organizationId` is copied off
 *    the document; the link is stored context-relative and the inbox re-bases it
 *    from that column (`resolveNotificationLink`).
 *
 * The one deliberate divergence from the report writer is the source pointers.
 * This row carries `projectId` and `documentId`, as
 * `document-refresh-notifications.ts` does and the report row has no need to:
 * `filterByCurrentAccess` in `@repo/api` can only drop a notification at read
 * time when it can see which project the row belongs to. Without `projectId` a
 * member removed from the project would keep receiving bell entries about that
 * project's documents indefinitely. Both columns are also the cascade-cleanup
 * pointers, so a deleted project or document takes its notifications with it.
 */
import {
	db,
	NotificationCategory,
	NotificationType,
	type ProjectDocumentStatus,
} from "../../client";
import { buildDocumentLink } from "./documents";

/** Which of the generation workflow's two terminal paths is reporting. */
export type DocumentGenerationOutcome = "COMPLETED" | "FAILED";

/**
 * The persisted document statuses each outcome is allowed to claim.
 *
 * The success list is three long because a finished generation is not always
 * `COMPLETE`: `saveProjectDocument` promotes only a DRAFT or GENERATING row and
 * deliberately preserves IN_PROGRESS / REVIEW when a person has already moved
 * the document along. All three mean the content landed.
 *
 * The failure list includes the two in-flight states on purpose. The child
 * marks the row FAILED before it throws, but the parent has terminal paths the
 * child never reaches — a dependency that will not arrive, a requester who lost
 * access while they waited — and those throw while the row still reads QUEUED.
 * That requester is precisely the one owed an explanation, so the claim is not
 * narrowed to FAILED.
 *
 * The two lists are disjoint, which is the property that matters: a document
 * that completed can never be claimed by a failure, and one still waiting can
 * never be claimed by a success.
 */
const CLAIMABLE_STATUSES: Record<
	DocumentGenerationOutcome,
	ProjectDocumentStatus[]
> = {
	COMPLETED: ["COMPLETE", "IN_PROGRESS", "REVIEW"],
	FAILED: ["FAILED", "QUEUED", "GENERATING"],
};

export interface EmitDocumentGenerationNotificationInput {
	documentId: string;
	/**
	 * The person who asked for this document, and the row's only recipient.
	 *
	 * Taken from the workflow input rather than from `ProjectDocument.userId`:
	 * that column is the tenant-isolation copy of the project's owner, which in
	 * an organization is usually somebody else entirely.
	 */
	userId: string;
	outcome: DocumentGenerationOutcome;
	/**
	 * Which attempt is reporting, as the `generationStartedAt` the queue write
	 * stamped for it.
	 *
	 * The claim is released when a new attempt is accepted, so without this the
	 * claim is document-scoped and the WRONG run can take it: an older workflow
	 * that terminalizes after a newer dispatch consumes the newer attempt's
	 * claim, the bell shows the stale run's outcome, and the outcome the person
	 * is actually waiting on is suppressed as already-notified. Scoping the
	 * claim to the attempt makes a superseded run's notification a silent skip,
	 * which is what it should have been.
	 *
	 * Optional because a caller with no identity to prove (an old dispatcher's
	 * run) still gets the document-scoped behaviour rather than no notification.
	 */
	generationStartedAt?: Date | string | null;
}

/**
 * Tell the requester their document is ready, or that it is not coming.
 *
 * Throws only if the transaction itself fails, so a caller with a retry budget
 * can re-run it cleanly; every other refusal (no document, no recipient,
 * already notified, status does not match) is a silent, idempotent skip.
 */
export async function emitDocumentGenerationNotification(
	input: EmitDocumentGenerationNotificationInput,
): Promise<void> {
	const { documentId, userId, outcome } = input;
	const attemptStartedAt = input.generationStartedAt
		? new Date(input.generationStartedAt)
		: null;
	const attemptIdentity =
		attemptStartedAt && !Number.isNaN(attemptStartedAt.getTime())
			? attemptStartedAt
			: null;

	// Defensive — only the two terminal outcomes have anything to announce.
	if (outcome !== "COMPLETED" && outcome !== "FAILED") {
		return;
	}
	// No recipient — nothing a retry can fix; return rather than throw.
	if (!userId) {
		return;
	}

	const document = await db.projectDocument.findUnique({
		where: { id: documentId },
		select: {
			projectId: true,
			organizationId: true,
			title: true,
			generationNotificationEmittedAt: true,
		},
	});
	if (!document) {
		return;
	}
	// Fast-path idempotent skip — avoids opening a transaction for a document
	// that has already told its requester.
	if (document.generationNotificationEmittedAt) {
		return;
	}

	const isSuccess = outcome === "COMPLETED";
	// The title names the document, because a bell full of rows reading
	// "Document generation finished" is not something anyone can act on. The
	// fallback covers a row saved with a blank title, which the editor allows.
	const documentTitle = document.title?.trim() || "Your document";
	const title = isSuccess
		? `${documentTitle} is ready`
		: `${documentTitle} could not be generated`;

	// The failure snippet is GENERIC, deliberately. The run's error is whatever
	// a model call, an activity or a dependency refusal produced — stack
	// markers, provider payloads, internal ids — and the bell is the one surface
	// it must never reach. The real reason is rendered on the document page from
	// `generationError`, which is exactly where this link goes.
	const snippet = isSuccess
		? "Open it to review what was generated"
		: "Open the document to see what went wrong";

	// Context-relative: no leading slash and no organization segment. The inbox
	// prepends the notification's OWN workspace base, so the link resolves to
	// the document's workspace rather than to whichever one the recipient
	// happens to be looking at when they click.
	const link = buildDocumentLink({
		projectId: document.projectId,
		documentId,
	});

	// Identifiers only. The notifications list API hands payloads back to the
	// client verbatim, so nothing that is not already a pointer goes in here —
	// no error text, and no copy the row's own columns do not already carry.
	const payload = {
		documentId,
		projectId: document.projectId,
		status: outcome,
	};

	// Atomic claim + create. `count === 0` means either somebody already
	// claimed this document or the row is not in a state this outcome could
	// have produced — both are "skip", not "error". Anything that throws rolls
	// the whole transaction back, leaving the claim unset for a clean retry.
	await db.$transaction(async (tx) => {
		const { count } = await tx.projectDocument.updateMany({
			where: {
				id: documentId,
				status: { in: CLAIMABLE_STATUSES[outcome] },
				generationNotificationEmittedAt: null,
				// Only the attempt that is still the row's own may claim. A run
				// superseded while it waited would otherwise spend the claim the
				// newer run needs, and the person would be told about the wrong one.
				...(attemptIdentity
					? { generationStartedAt: attemptIdentity }
					: {}),
			},
			data: { generationNotificationEmittedAt: new Date() },
		});
		if (count === 0) {
			return;
		}
		// `createMany({ skipDuplicates })`, not `create()`, and the difference is
		// load-bearing rather than stylistic.
		//
		// `dedupeKey` sits under the live-unread partial unique index
		// `notification_userId_dedupeKey_live_uq`, so a person who REGENERATES a
		// document before opening the first notice collides with their own unread
		// row. A `create()` raises P2002 for that, INSIDE this transaction — and
		// Postgres marks a transaction aborted the moment a statement in it errors,
		// so the COMMIT degrades to a ROLLBACK and the claim written one statement
		// ago is lost along with the notification. Catching the P2002 here cannot
		// rescue that (the same reason `bindPromptVersion` retries in a FRESH
		// transaction); only not raising can. `skipDuplicates` compiles to
		// `INSERT ... ON CONFLICT DO NOTHING`, which covers the partial index
		// without a conflict target and returns a count instead of throwing, so the
		// claim commits either way.
		//
		// Coalescing is the RIGHT answer here, not merely the safe one: the
		// recipient already has an unread bell entry for this exact document, and a
		// second one beside it carries no new information — both links open the same
		// page, which shows the latest run's outcome. The claim still takes, so this
		// document is done announcing itself either way.
		await tx.notification.createMany({
			data: [
				{
					userId,
					organizationId: document.organizationId,
					type: isSuccess
						? NotificationType.DOCUMENT_GENERATION_COMPLETED
						: NotificationType.DOCUMENT_GENERATION_FAILED,
					// SYSTEM, the peer of REPORT_COMPLETED / REPORT_FAILED: a run
					// the user started themselves finishing is not noise to
					// suppress, so it is not routed through the category toggles.
					category: NotificationCategory.SYSTEM,
					title,
					snippet,
					link,
					// The read-time access re-check and the cascade cleanup both
					// read these. See this file's header.
					projectId: document.projectId,
					documentId,
					payload,
					// Per (document, recipient, attempt). The attempt segment is
					// what lets a genuine SECOND run reach the bell while the
					// first notice is still unread — without it the two collide
					// on the live-unread index and the newer outcome is dropped.
					dedupeKey: attemptIdentity
						? `document-generation:${documentId}:${userId}:${attemptIdentity.toISOString()}`
						: `document-generation:${documentId}:${userId}`,
				},
			],
			skipDuplicates: true,
		});
	});
}
