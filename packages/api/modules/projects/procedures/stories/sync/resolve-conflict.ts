import { ORPCError } from "@orpc/client";
import {
	clearPmSyncConflictFlag,
	getPmSyncItemState,
	isProjectReadOnly,
	writePmSyncItemContent,
} from "@repo/database";
import { READ_ONLY_MODE_ERROR_CODE, READ_ONLY_MODE_MESSAGE } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { enqueuePmSync } from "../../../lib/enqueue-pm-sync";

type ResolveConflictItemType = "epic" | "feature" | "story" | "bug";

/**
 * Why a resolution could not be synced to the PM tool. Kept in sync with
 * `PmSyncErrorKind` in packages/temporal/.../preview-pm-sync-conflict.ts and
 * the `checkPmSyncConflicts` procedure output enum.
 */
type PmSyncErrorKind =
	| "MISSING"
	| "EXPIRED"
	| "INVALID"
	| "DISABLED"
	| "NO_ACCESS"
	| "TRANSIENT"
	| "NOT_CONFIGURED";

/**
 * Map an `enqueuePmSync` failure reason to a UI-facing error kind. In the
 * per-user model `no-pm-config` means the caller hasn't connected their own PM
 * account (the resolved config was null or disabled).
 */
function enqueueReasonToPmError(
	reason: string | undefined,
): { kind: PmSyncErrorKind } | undefined {
	switch (reason) {
		case "no-pm-config":
			return { kind: "MISSING" };
		case "temporal-error":
		case "db-error":
			return { kind: "TRANSIENT" };
		default:
			// item-not-found / no-external-id / project-not-found are data
			// issues, not credential problems; surface them as transient so the
			// user can retry rather than seeing a false success.
			return reason ? { kind: "TRANSIENT" } : undefined;
	}
}

/**
 * Pure handler — separated from the oRPC procedure binding so tests can
 * call it directly without constructing a full procedure context.
 *
 * Generalizes over any hierarchy item type (`epic | feature | story | bug`);
 * `story`/`bug` coalesce to `db.userStory` via the `@repo/database` dispatch
 * helpers. Per `backend/queries.md` there is no inline Prisma here.
 *
 * Resolution semantics:
 *  - REMOTE: use the PM tool's version (re-import overwrites Fabric fields).
 *    The caller may inject a custom `importFromPm` for testing; defaults to a
 *    no-op acknowledgement so the status clear still happens (the user
 *    should manually re-pull to apply PM content).
 *  - LOCAL: push the Fabric version unconditionally, skipping the hash-drift
 *    check (`forceHashOverride: true`). Enqueues a Temporal push workflow.
 *    When `overrideTitle` / `overrideDescription` are supplied (AI-merge
 *    accept), they are written onto the entity FIRST so the force-push carries
 *    the merged content. The same handler thus covers both "Use Fabric" and
 *    "accept merge"; the only difference is whether an override is present.
 *
 * In both cases `lastPmSyncStatus` is reset from CONFLICT to SUCCESS so
 * auto-push can resume on the next status move.
 */
export async function resolveConflictHandler(args: {
	itemId: string;
	itemType: ResolveConflictItemType;
	projectId: string;
	userId: string;
	/**
	 * Display name of the resolving user — stamped as `lastEditedByName` with
	 * source `CONFLICT_RESOLUTION` when the AI-merge override actually writes
	 * Fabric content (story/bug only). Null when unavailable. See spec IN-3.
	 */
	userName?: string | null;
	resolution: "REMOTE" | "LOCAL";
	/**
	 * When present on a LOCAL resolution, write the merged title and/or
	 * description onto the Fabric entity BEFORE the force-push so the existing
	 * `forceHashOverride` path pushes the merged content. Both `undefined` ⇒
	 * plain "Use Fabric" (push the current Fabric row).
	 */
	overrideTitle?: string;
	overrideDescription?: string;
	/**
	 * Optional override for the PM-import call — injected by tests.
	 * When omitted the REMOTE path only clears the conflict flag; the user
	 * should trigger a manual pull to apply PM content.
	 */
	importFromPm?: (args: { itemId: string }) => Promise<unknown>;
}): Promise<{ cleared: boolean; pmError?: { kind: PmSyncErrorKind } }> {
	const { itemId, itemType, projectId, userId } = args;

	if (args.resolution === "REMOTE") {
		if (args.importFromPm) {
			await args.importFromPm({ itemId });
		}
		// Clear conflict marker so the card no longer shows the badge.
		await clearPmSyncConflictFlag({ itemType, itemId });
	} else {
		// LOCAL: optionally apply the merged title/description first (AI-merge
		// accept), then push the Fabric version to PM, bypassing the hash-drift
		// guard.
		if (
			args.overrideTitle !== undefined ||
			args.overrideDescription !== undefined
		) {
			await writePmSyncItemContent({
				itemType,
				itemId,
				projectId,
				title: args.overrideTitle,
				description: args.overrideDescription,
				// AI-merge accept is a human-triggered content write → attribute it.
				lastEditedSource: "CONFLICT_RESOLUTION",
				lastEditedByName: args.userName ?? null,
			});
		}
		const enqueueResult = await enqueuePmSync({
			itemId,
			itemType,
			projectId,
			userId,
			forceHashOverride: true,
			triggerSource: "retry",
		});
		if (!enqueueResult.enqueued) {
			// Nothing was pushed to the PM tool — do NOT clear the conflict
			// flag (that would hide an unresolved conflict). Surface why so the
			// UI can prompt the user (e.g. connect their own PM account)
			// instead of showing a false success.
			return {
				cleared: false,
				pmError: enqueueReasonToPmError(enqueueResult.reason),
			};
		}
		await clearPmSyncConflictFlag({ itemType, itemId });
	}
	return { cleared: true };
}

/**
 * oRPC procedure — resolves a PM sync conflict by choosing REMOTE or LOCAL
 * state for any hierarchy item type.
 *
 * REMOTE: acknowledge that the PM version is authoritative; clears the
 *         conflict badge so the user can pull manually.
 * LOCAL:  push the Fabric version to PM unconditionally (bypasses hash
 *         drift check). Resumes auto-push on next status move. When
 *         `overrideTitle` / `overrideDescription` are supplied, the merged
 *         content is written to the entity before the push (AI-merge accept).
 */
export const resolveConflictProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/sync/resolve-conflict",
		tags: ["Projects", "Stories"],
		summary: "Resolve a PM sync conflict by choosing REMOTE or LOCAL state",
	})
	.input(
		z.object({
			projectId: z.string(),
			itemId: z.string(),
			itemType: z.enum(["epic", "feature", "story", "bug"]),
			resolution: z.enum(["REMOTE", "LOCAL"]),
			overrideTitle: z.string().max(2_000).optional(),
			overrideDescription: z.string().optional(),
		}),
	)
	.output(
		z.object({
			cleared: z.boolean(),
			pmError: z
				.object({
					kind: z.enum([
						"MISSING",
						"EXPIRED",
						"INVALID",
						"DISABLED",
						"NO_ACCESS",
						"TRANSIENT",
						"NOT_CONFIGURED",
					]),
				})
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const item = await getPmSyncItemState({
			itemType: input.itemType,
			itemId: input.itemId,
			projectId: input.projectId,
		});

		if (!item) {
			throw new ORPCError("NOT_FOUND", { message: "Item not found" });
		}

		if (item.lastPmSyncStatus !== "CONFLICT") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Item is not in CONFLICT state",
			});
		}

		// Read-only mode: LOCAL resolution pushes the Fabric
		// version to the PM tool — a direct, user-initiated external write.
		// Uses the shared query helper (no inline Prisma in this module).
		if (
			input.resolution === "LOCAL" &&
			(await isProjectReadOnly(input.projectId))
		) {
			throw new ORPCError("CONFLICT", {
				message: READ_ONLY_MODE_MESSAGE,
				data: { errorCode: READ_ONLY_MODE_ERROR_CODE },
			});
		}

		return resolveConflictHandler({
			itemId: input.itemId,
			itemType: input.itemType,
			projectId: input.projectId,
			userId: context.user.id,
			userName: context.user.name ?? null,
			resolution: input.resolution,
			overrideTitle: input.overrideTitle,
			overrideDescription: input.overrideDescription,
		});
	});
