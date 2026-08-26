import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() (via `requireProjectPermission`) — only
 * project owners/editors can change this setting.
 *
 * Flips the opt-in `meetingTranscriptAutoAnalyzeEnabled` flag. This is a
 * FLAG-ONLY procedure — it starts NO Temporal workflow. The flag is consulted
 * by the auto-analysis hook inside `fetchAndStoreMeetingTranscript`, which only
 * acts when BOTH `meetingTranscriptSyncEnabled` and this flag are true, so a
 * stored `true` is inert while transcript sync is off.
 */
export const setAutoAnalyzeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/set-auto-analyze",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Set meeting transcript auto-analyze",
		description:
			"Enables or disables auto-creating proposals from newly-synced meeting transcripts.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			enabled: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Authorization enforced by `requireProjectPermission` above. Tenant scope
		// matches the sibling `enable-meeting-transcript-sync` procedure: an org
		// project is org-owned (editable by any member with PROJECT_UPDATE, not
		// just its creator), so the org branch scopes by `{ organizationId }` only.
		// A personal project is user-owned ⇒ `{ organizationId: null, userId }`.
		const tenantFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId: user.id };

		const project = await db.project.findFirst({
			where: { id: input.projectId, ...tenantFilter },
			select: { id: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		await db.project.update({
			where: { id: input.projectId, ...tenantFilter },
			data: {
				meetingTranscriptAutoAnalyzeEnabled: input.enabled,
			},
		});

		return {
			status: "ok",
			meetingTranscriptAutoAnalyzeEnabled: input.enabled,
		};
	});
