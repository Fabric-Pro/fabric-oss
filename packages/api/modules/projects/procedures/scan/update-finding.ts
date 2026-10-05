import { ORPCError } from "@orpc/server";
import {
	getScanFinding,
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
import { resolveProjectOrganizationId } from "../../lib/project-organization";
import { describeFindingChange } from "./lib/describe-finding-change";

/**
 * Update a finding's triage fields — status (resolve / dismiss / reopen),
 * category, and/or severity. Any subset may be sent; the AI's category and
 * severity are user-overridable so a mis-triaged finding can be corrected.
 */
export const updateFindingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/findings/:findingId",
		tags: ["Projects", "Security"],
		summary: "Update a scan finding (status / category / severity)",
	})
	.input(
		z
			.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				findingId: z.string(),
				status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).optional(),
				category: z.enum(["SECURITY", "ACCESSIBILITY"]).optional(),
				severity: z
					.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"])
					.optional(),
			})
			.refine(
				(v) =>
					v.status !== undefined ||
					v.category !== undefined ||
					v.severity !== undefined,
				{
					message:
						"Provide at least one of status, category, or severity.",
				},
			),
	)
	.handler(async ({ input, context }) => {
		const { projectId, findingId, status, category, severity } = input;
		// The project's own organization — the tenant the permission check
		// authorized — resolved before anything is written. A different
		// `input.organizationId` is refused here (BAD_REQUEST), never stamped on
		// a row or handed to a scanner, provider or workflow.
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			projectId,
		);
		const hasAccess = await hasProjectAccess(
			projectId,
			context.user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		// Read the current values first — needed both to 404 cleanly and to
		// describe what changed for the page-history entry.
		const finding = await getScanFinding(findingId, projectId);
		if (!finding) {
			throw new ORPCError("NOT_FOUND", { message: "Finding not found" });
		}

		const patch = { status, category, severity };
		const updated = await updateScanFinding(findingId, projectId, patch);
		if (!updated) {
			throw new ORPCError("NOT_FOUND", { message: "Finding not found" });
		}

		// Record the change in the page history (best-effort). A no-op patch
		// (values unchanged) yields null and records nothing.
		const activity = describeFindingChange(finding, patch);
		if (activity) {
			await recordScanActivity({
				projectId,
				type: activity.type,
				userId: context.user.id,
				organizationId,
				findingId,
				summary: activity.summary,
			}).catch(() => {});
		}

		return { success: true };
	});
