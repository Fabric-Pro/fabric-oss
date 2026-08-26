import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Pure-ish DB op: flip the flag on a tenant-scoped linked meeting. */
export async function applyInclusion(params: {
	projectId: string;
	linkedMeetingId: string;
	included: boolean;
}): Promise<{ success: true; includedInDigest: boolean }> {
	const res = await db.projectLinkedMeeting.updateMany({
		where: { id: params.linkedMeetingId, projectId: params.projectId },
		data: { includedInDigest: params.included },
	});
	if (res.count === 0) {
		throw new ORPCError("NOT_FOUND", {
			message: "Linked meeting not found",
		});
	}
	return { success: true, includedInDigest: params.included };
}

export const setIncludedProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/meeting-digest/{linkedMeetingId}/included",
		tags: ["Projects", "Meeting Digest"],
		summary: "Include/exclude a meeting from the Meeting Digest (admin)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkedMeetingId: z.string(),
			included: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const result = await applyInclusion({
			projectId: input.projectId,
			linkedMeetingId: input.linkedMeetingId,
			included: input.included,
		});

		recordAuditFromRequest(context, {
			action: "project.meeting_digest.inclusion_changed",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "linked_meeting", id: input.linkedMeetingId },
			metadata: { included: input.included },
		});

		return result;
	});
