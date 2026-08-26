import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export interface ConfigRow {
	linkedMeetingId: string;
	subject: string | null;
	includedInDigest: boolean;
	lastMeetingDate: Date | null;
}

/** Pure mapper — unit-tested in isolation, no DB. */
export function toConfigRows(
	linked: Array<{
		id: string;
		subject: string | null;
		includedInDigest: boolean;
	}>,
	lastMeetingByLinkedId: Map<string, Date>,
): ConfigRow[] {
	return linked.map((l) => ({
		linkedMeetingId: l.id,
		subject: l.subject,
		includedInDigest: l.includedInDigest,
		lastMeetingDate: lastMeetingByLinkedId.get(l.id) ?? null,
	}));
}

export const listConfigurableMeetingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-digest/configurable",
		tags: ["Projects", "Meeting Digest"],
		summary: "List configurable meetings (one row per meeting series)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const access = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!access) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project",
			});
		}

		const rows = await db.projectLinkedMeeting.findMany({
			where: { projectId: input.projectId },
			select: { id: true, subject: true, includedInDigest: true },
			orderBy: { subject: "asc" },
		});

		// Latest transcript date per series (deliberately not date-filtered) so
		// the panel can show when a series last produced a meeting.
		const latest = rows.length
			? await db.projectMeetingTranscript.groupBy({
					by: ["linkedMeetingId"],
					where: { projectId: input.projectId },
					_max: { meetingDate: true },
				})
			: [];
		const lastMeetingByLinkedId = new Map<string, Date>();
		for (const g of latest) {
			if (g._max.meetingDate) {
				lastMeetingByLinkedId.set(
					g.linkedMeetingId,
					g._max.meetingDate,
				);
			}
		}

		return { meetings: toConfigRows(rows, lastMeetingByLinkedId) };
	});
