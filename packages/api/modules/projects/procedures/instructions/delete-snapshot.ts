import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	countInFlightDerivedSnapshots,
	deleteInstructionSnapshot,
	getInstructionSnapshot,
	getPublishedInstructionSnapshot,
	listInstructionFiles,
} from "@repo/database";
import {
	isKeyOwnedBySnapshot,
	snapshotOwnedPrefixes,
} from "@repo/instructions";
import {
	type DeleteObjectsResult,
	getStorageProvider,
	type StorageProviderInterface,
} from "@repo/storage";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	assertProjectPermission,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { assertNotMigrationSnapshot } from "./migration-freeze";

const BUCKET = config.storage.bucketNames.skills;

/**
 * Deleting a snapshot whose validation workflow is still running removes the
 * row its next activity reads, so `loadVerifiedSnapshot`
 * (`packages/temporal/src/activities/project-instructions.ts`) raises a
 * non-retryable tenant-mismatch failure for what was really an avoidable
 * click, and a promotion already in flight can keep writing immutable objects
 * after this handler has collected the keys it means to remove.
 *
 * The tab has always hidden the button for those statuses
 * (`InstructionsHistory.tsx`), but the UI is not an authorization boundary —
 * an authorized caller reaching this oRPC procedure directly was hidden from
 * nothing. This is the fast, friendly half of the guard; the DELETE's own
 * predicate in `deleteInstructionSnapshot` is the authority, exactly as with
 * the published pointer below.
 */
const DELETABLE_STATUSES = new Set(["READY", "REJECTED", "FAILED"]);

/**
 * An upload nobody finished: the browser began it and could not reach storage
 * (or the tab was closed), so `finalize` never ran and no workflow owns the
 * row, which stays RECEIVING for hours until the reaper closes it. The tab
 * hides Upload while it is there and used to offer no way out of it, so it may
 * be discarded.
 *
 * Only a plain upload or edit: a repository sync's snapshot is RECEIVING while
 * its run copies files in, and a proposal or a direct commit answers to its
 * pull request. Whether `finalize` has claimed the row since this was read is
 * what the DELETE's own predicate decides (`abandonedUpload` in
 * `deleteInstructionSnapshot`); this is the fast, friendly half.
 */
function isUnfinishedUpload(snapshot: {
	status: string;
	source?: string | null;
	proposalStatus?: string | null;
}): boolean {
	return (
		snapshot.status === "RECEIVING" &&
		snapshot.source === "UPLOAD" &&
		(snapshot.proposalStatus ?? null) === null
	);
}

/**
 * `deleteObjects` is best-effort: it NEVER throws on a delete failure and
 * reports per-key failures in `errors` (`packages/storage/types.ts`).
 * Discarding that result reported a delete as complete while the objects were
 * still in the bucket — for someone deleting a version precisely because of
 * what it held. The Temporal twin of this check lives in
 * `activities/project-instructions.ts`; there a throw means a retry, here it
 * means the caller is told the delete did not finish.
 *
 * The message carries the COUNT only: a key names a project, a snapshot and a
 * file id, and this string is returned to the client.
 */
function assertAllDeleted(result: DeleteObjectsResult): void {
	if (result.errors.length > 0) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: `Could not delete ${result.errors.length} stored object(s)`,
		});
	}
}

/**
 * Deletes every object under a prefix, paginated to completion. Keys that are
 * already gone are tolerated, so this is safe when the prefix is empty or the
 * delete is a retry; a key that genuinely could not be deleted throws.
 */
async function deleteObjectsUnderPrefix(
	storage: StorageProviderInterface,
	prefix: string,
): Promise<void> {
	let continuationToken: string | undefined;
	do {
		const page = await storage.listObjects({
			bucket: BUCKET,
			prefix,
			continuationToken,
		});
		const keys = page.objects.map((o) => o.key);
		if (keys.length > 0) {
			assertAllDeleted(
				await storage.deleteObjects(keys, { bucket: BUCKET }),
			);
		}
		continuationToken = page.nextContinuationToken;
	} while (continuationToken);
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE), and INSTRUCTION_DELETE
 * asserted in the handler for everything except the creator discarding their
 * own unfinished upload (see `isUnfinishedUpload`). The middleware is the
 * weaker permission because it is the one a creator holds; a version that is
 * finished, or another member's, still needs the delete permission.
 *
 * Deletes one coding-instructions snapshot: its database rows first, then its
 * files' storage objects. Tenant-scoped via `getInstructionSnapshot(id,
 * projectId, organizationId)` first (R11).
 *
 * The published snapshot can never be deleted out from under a project, and
 * the DATABASE is what guarantees that: the pointer's foreign key is
 * `onDelete: Restrict`, so the row delete raises P2003 and
 * `deleteInstructionSnapshot` reports `reason: "published"`. The
 * `getPublishedInstructionSnapshot` comparison above it is the fast path that
 * gives the same answer without a wasted transaction — it is a read-then-
 * delete check and a concurrent publish can win it, which is precisely why it
 * is no longer the only guard. Only the pointer's `id` is read from that
 * unscoped query, so nothing beyond that id crosses a tenant boundary.
 */
export const deleteSnapshotProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/instructions/snapshots/:snapshotId",
		tags: ["Projects", "Instructions"],
		summary: "Delete a coding-instructions snapshot",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			snapshotId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const snapshot = await getInstructionSnapshot(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		if (!snapshot) {
			throw new ORPCError("NOT_FOUND", { message: "Snapshot not found" });
		}
		const unfinished = isUnfinishedUpload(snapshot);
		// Anyone who may create passed the middleware; deleting what is not
		// their own unfinished upload takes the delete permission.
		if (!(unfinished && snapshot.userId === context.user.id)) {
			await assertProjectPermission(
				input.projectId,
				context.user.id,
				Permissions.INSTRUCTION_DELETE,
			);
		}
		// The proposal of a move into the repository is the pull request's own
		// rows (Fizzy #2878 §9): it goes with the move, not before it.
		await assertNotMigrationSnapshot({
			projectId: input.projectId,
			organizationId,
			snapshotId: snapshot.id,
		});
		// Same read-then-delete caveat as the published check below: a run
		// that starts after this read still has to be refused, which is why
		// the DELETE carries the predicate too.
		if (!DELETABLE_STATUSES.has(snapshot.status) && !unfinished) {
			throw new ORPCError("CONFLICT", {
				message:
					"This upload is still being checked and cannot be deleted yet",
			});
		}
		// An unfinished edit of this version inherits its unchanged files by
		// POINTING at this snapshot's promoted objects, so deleting it now
		// takes the bytes that validation is about to read. "Unfinished"
		// includes a FAILED edit, which is retryable and reads the very same
		// keys on its next attempt; deleting that edit is how the user gives
		// up on it and releases this version.
		// The fast, friendly half — the refusal in `deleteInstructionSnapshot`'s
		// own DELETE predicate is the authority, for the same reason the
		// published-pointer check below is only the fast path.
		const deriving = await countInFlightDerivedSnapshots(
			snapshot.id,
			input.projectId,
			organizationId,
		);
		if (deriving > 0) {
			throw new ORPCError("CONFLICT", {
				message:
					"An edit of this version is unfinished, so it cannot be deleted yet. Delete that edit first if you are not going to retry it",
			});
		}
		// The fast, friendly path only. It is a read-then-delete check, so a
		// publish committing between it and the delete would slip past it —
		// the `onDelete: Restrict` foreign key below is what actually stops
		// that, and it returns the same error.
		const published = await getPublishedInstructionSnapshot(
			input.projectId,
		);
		if (published?.id === snapshot.id) {
			throw new ORPCError("CONFLICT", {
				message: "The published snapshot cannot be deleted",
			});
		}

		// Storage keys are read BEFORE the rows go, because the rows are the
		// only record of where a snapshot's objects live.
		//
		// FILTERED to this snapshot's own objects. A derived snapshot's
		// inherited rows carry the BASE's immutable promoted keys until its
		// own promotion rewrites them, so deleting a rejected or failed edit
		// by row key would delete the bytes of the version it was edited FROM
		// — in the ordinary case the project's published coding instructions.
		// Leaving an unreferenced object for the bucket lifecycle rule is
		// recoverable; this is not.
		const files = await listInstructionFiles(snapshot.id, organizationId);
		const keys = files
			.map((f) => f.storageKey)
			.filter((key) =>
				isKeyOwnedBySnapshot(key, input.projectId, snapshot.id),
			);

		// Rows FIRST. The old order deleted the objects and only then the
		// rows, so a publish that won the race against the check above left
		// the project pointing at a snapshot whose bytes were already gone.
		// With the rows removed first, a snapshot that became published in
		// the meantime fails the foreign key and nothing at all is deleted.
		const removal = await deleteInstructionSnapshot(
			snapshot.id,
			input.projectId,
			organizationId,
			{ abandonedUpload: unfinished },
		);
		if (removal.reason === "published") {
			throw new ORPCError("CONFLICT", {
				message: "The published snapshot cannot be deleted",
			});
		}
		// The snapshot left a terminal status between the check above and the
		// DELETE — a "Try again" on a FAILED row is the realistic way. Nothing
		// was deleted, and nothing in storage has been touched yet.
		if (removal.reason === "active") {
			throw new ORPCError("CONFLICT", {
				message:
					"This upload is still being checked and cannot be deleted yet",
			});
		}
		// A derivation that started between the check above and the DELETE.
		// Nothing was deleted, and nothing in storage has been touched yet.
		if (removal.reason === "base_in_flight") {
			throw new ORPCError("CONFLICT", {
				message:
					"An edit of this version is unfinished, so it cannot be deleted yet. Delete that edit first if you are not going to retry it",
			});
		}
		// A proposal whose pull request may still be pushed, opened, closed or
		// settled (Fizzy #2563 spec §4.3). Refused before storage: falling
		// through would delete the bytes of a row the DELETE kept.
		if (removal.reason === "pull_request_unresolved") {
			throw new ORPCError("CONFLICT", {
				message:
					"This proposal's pull request is still open or being closed, so it cannot be deleted yet",
				data: { reason: "PULL_REQUEST_UNRESOLVED" },
			});
		}

		// No reason and nothing deleted: the row was already gone, so a
		// concurrent delete of the same version won. Another audit row and a
		// second storage sweep would describe work this request did not do.
		if (!removal.deleted) {
			throw new ORPCError("NOT_FOUND", {
				message: "This version was already deleted",
			});
		}

		recordAuditFromRequest(context, {
			action: "project.instructions.deleted",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_snapshot",
				id: snapshot.id,
				name: `v${snapshot.version}`,
			},
			metadata: { fileCount: files.length },
		});

		// Storage last, and after the audit: the rows are gone, so the
		// deletion has happened whatever storage does next. A failure here
		// throws (see `assertAllDeleted`) rather than reporting a clean
		// delete, and the objects it could not remove are unreferenced — the
		// bucket lifecycle rule is the backstop for those, tracked as a
		// follow-up.
		const storage = getStorageProvider();
		if (keys.length > 0) {
			assertAllDeleted(
				await storage.deleteObjects(keys, { bucket: BUCKET }),
			);
		}
		// Everything else under the snapshot's own prefixes, which the file
		// rows do not know about: the export zips built from it, and any
		// staged or promoted object no row names. Someone deleting a version
		// because it held something they did not want stored would otherwise
		// leave a full copy of its contents in the bucket for every Download
		// and every `fabric_get_project_instruction_bundle` call ever made
		// against it, or a staged copy of an upload that was replaced. Found
		// by prefix rather than by a recorded key, so pre-existing
		// wall-clock-stamped objects are collected too.
		for (const prefix of snapshotOwnedPrefixes(
			input.projectId,
			snapshot.id,
		)) {
			await deleteObjectsUnderPrefix(storage, prefix);
		}
		return { deleted: true as const };
	});
