import { ORPCError } from "@orpc/server";
import {
	db,
	isFeatureEnabled,
	resolveWorkflowIntegrationForProvider,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { parlumeReadinessRefusal } from "../../lib/parlume-auto-join";
import {
	getParlumeReadiness,
	isParlumeReady,
} from "../../lib/parlume-readiness";
import { requireParlumeProject } from "../parlume/sessions";

/** Why auto-join cannot be turned on without the caller's Microsoft account. */
export const PARLUME_AUTO_JOIN_MICROSOFT_REQUIRED =
	"Connect your Microsoft account in Settings → Integrations first. Parlume reads your Teams calendar to know when this series meets.";

/** Why auto-join cannot be turned on for a series whose syncing is stopped. */
export const PARLUME_AUTO_JOIN_SYNC_STOPPED =
	"Syncing is stopped for this series, so Parlume cannot join it automatically. Resume syncing in the project's Settings → Meeting Transcript Sync first.";

/**
 * Turn Parlume's automatic joining of one linked series on or off, or change
 * the mode and chat suggestions its joins use.
 *
 * The same permission as inviting Parlume by hand, because every join it
 * makes is one: it runs as the caller, who becomes the series' enabler.
 * Their Teams calendar is read to find each occurrence, through the
 * Microsoft connection the scheduler will use. The organization is the
 * loaded project's, never the caller's input, and their project permissions
 * are checked again at every join.
 */
export const setParlumeAutoJoinProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/meeting-digest/{linkedMeetingId}/parlume-auto-join",
		tags: ["Projects", "Meeting Digest", "Parlume"],
		summary:
			"Turn Parlume's automatic joining of a linked series on or off",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkedMeetingId: z.string(),
			enabled: z.boolean(),
			toolsReadOnly: z.boolean().default(true),
			suggestionsEnabled: z.boolean().default(true),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId } = await requireParlumeProject(input.projectId);
		if (!(await isFeatureEnabled("MEETING_AGENDA", organizationId))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Meeting agendas are not enabled.",
			});
		}
		const series = await db.projectLinkedMeeting.findFirst({
			where: { id: input.linkedMeetingId, projectId: input.projectId },
			select: { id: true, subject: true, deactivatedAt: true },
		});
		if (!series) {
			throw new ORPCError("NOT_FOUND", {
				message: "Linked meeting not found",
			});
		}

		if (input.enabled) {
			if (series.deactivatedAt) {
				throw new ORPCError("CONFLICT", {
					message: PARLUME_AUTO_JOIN_SYNC_STOPPED,
				});
			}
			const connection = await resolveWorkflowIntegrationForProvider(
				"MICROSOFT_GRAPH",
				context.user.id,
				organizationId,
			);
			if (!connection?.credentials) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message: PARLUME_AUTO_JOIN_MICROSOFT_REQUIRED,
				});
			}
			const readiness = await getParlumeReadiness({
				userId: context.user.id,
				organizationId,
			});
			if (!isParlumeReady(readiness)) {
				throw new ORPCError("CONFLICT", {
					message:
						parlumeReadinessRefusal(readiness) ??
						"Parlume is not ready to join meetings yet.",
				});
			}
		}

		const updated = await db.projectLinkedMeeting.update({
			where: { id: series.id },
			data: input.enabled
				? {
						parlumeAutoJoin: true,
						parlumeAutoJoinUserId: context.user.id,
						parlumeAutoJoinToolsReadOnly: input.toolsReadOnly,
						parlumeAutoJoinSuggestions: input.suggestionsEnabled,
						parlumeAutoJoinError: null,
						parlumeAutoJoinErrorAt: null,
					}
				: {
						parlumeAutoJoin: false,
						parlumeAutoJoinUserId: null,
						parlumeAutoJoinError: null,
						parlumeAutoJoinErrorAt: null,
					},
			select: {
				parlumeAutoJoin: true,
				parlumeAutoJoinToolsReadOnly: true,
				parlumeAutoJoinSuggestions: true,
			},
		});

		recordAuditFromRequest(context, {
			action: "project.parlume.auto_join_changed",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "linked_meeting",
				id: series.id,
				...(series.subject ? { name: series.subject } : {}),
			},
			metadata: {
				enabled: updated.parlumeAutoJoin,
				toolsReadOnly: updated.parlumeAutoJoinToolsReadOnly,
				suggestionsEnabled: updated.parlumeAutoJoinSuggestions,
			},
		});

		return {
			linkedMeetingId: series.id,
			enabled: updated.parlumeAutoJoin,
			toolsReadOnly: updated.parlumeAutoJoinToolsReadOnly,
			suggestionsEnabled: updated.parlumeAutoJoinSuggestions,
		};
	});
