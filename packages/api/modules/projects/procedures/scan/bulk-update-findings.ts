import { ORPCError } from "@orpc/server";
import {
	hasProjectAccess,
	recordScanActivity,
	updateScanFinding,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Bulk triage (G8) — the manual counterpart of the AI false-positive review.
 * Apply a single status and/or severity change to many findings at once
 * (multi-select → bulk bar). Each update is tenant-scoped via `updateScanFinding`
 * (matched on `projectId`), so a row outside the caller's project is silently
 * skipped rather than mutated. Records ONE `FINDINGS_REVIEWED` page-history entry
 * summarising the batch.
 *
 * Permission mirrors the single-finding `update` (PROJECT_UPDATE): triage edits
 * are an update, not a settings change.
 */
export const bulkUpdateFindingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/findings/bulk-update",
		tags: ["Projects", "Security"],
		summary: "Bulk-update scan findings (status / severity)",
	})
	.input(
		z
			.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				findingIds: z.array(z.string()).min(1).max(200),
				status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).optional(),
				severity: z
					.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"])
					.optional(),
			})
			.refine((v) => v.status !== undefined || v.severity !== undefined, {
				message: "Provide at least one of status or severity.",
			}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId, findingIds, status, severity } =
			input;
		const hasAccess = await hasProjectAccess(
			projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// De-dupe ids so a repeated selection doesn't inflate the count, then
		// apply the same patch to each. `updateScanFinding` is scoped by projectId,
		// so a stray id from another project simply doesn't update (count unmoved).
		const patch = { status, severity };
		const uniqueIds = Array.from(new Set(findingIds));
		let updated = 0;
		for (const findingId of uniqueIds) {
			const ok = await updateScanFinding(findingId, projectId, patch);
			if (ok) {
				updated += 1;
			}
		}

		// One page-history entry for the whole batch (best-effort). Describe what
		// moved so the History dialog reads honestly.
		if (updated > 0) {
			const parts: string[] = [];
			if (severity !== undefined) {
				parts.push(`severity → ${severity}`);
			}
			if (status !== undefined) {
				parts.push(`status → ${status}`);
			}
			await recordScanActivity({
				projectId,
				type: "FINDINGS_REVIEWED",
				userId: context.user.id,
				organizationId: organizationId ?? null,
				summary: `Updated ${updated} finding${
					updated === 1 ? "" : "s"
				} — ${parts.join(", ")}`,
			}).catch(() => {});
		}

		return { updated };
	});
