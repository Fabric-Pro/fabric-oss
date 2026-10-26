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

/** A series' Parlume auto-join switch, as the config panel shows it. */
export interface ParlumeAutoJoinState {
	enabled: boolean;
	toolsReadOnly: boolean;
	suggestionsEnabled: boolean;
	/** Who turned it on; null when off, or when their account is gone. */
	enabledBy: { id: string; name: string } | null;
	error: string | null;
	errorAt: Date | null;
	/** Syncing is stopped for the series, so the scheduler skips it. */
	syncStopped: boolean;
}

/** Pure mapper — unit-tested in isolation, no DB. */
export function toParlumeAutoJoinState(row: {
	deactivatedAt: Date | null;
	parlumeAutoJoin: boolean;
	parlumeAutoJoinToolsReadOnly: boolean;
	parlumeAutoJoinSuggestions: boolean;
	parlumeAutoJoinError: string | null;
	parlumeAutoJoinErrorAt: Date | null;
	parlumeAutoJoinUser: { id: string; name: string } | null;
}): ParlumeAutoJoinState {
	return {
		enabled: row.parlumeAutoJoin,
		toolsReadOnly: row.parlumeAutoJoinToolsReadOnly,
		suggestionsEnabled: row.parlumeAutoJoinSuggestions,
		enabledBy: row.parlumeAutoJoin ? row.parlumeAutoJoinUser : null,
		error: row.parlumeAutoJoinError,
		errorAt: row.parlumeAutoJoinErrorAt,
		syncStopped: row.deactivatedAt !== null,
	};
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
			select: {
				id: true,
				subject: true,
				includedInDigest: true,
				deactivatedAt: true,
				parlumeAutoJoin: true,
				parlumeAutoJoinToolsReadOnly: true,
				parlumeAutoJoinSuggestions: true,
				parlumeAutoJoinError: true,
				parlumeAutoJoinErrorAt: true,
				parlumeAutoJoinUser: { select: { id: true, name: true } },
			},
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

		const autoJoinById = new Map(
			rows.map((row) => [row.id, toParlumeAutoJoinState(row)]),
		);
		return {
			meetings: toConfigRows(rows, lastMeetingByLinkedId).map((row) => ({
				...row,
				parlumeAutoJoin: autoJoinById.get(row.linkedMeetingId) ?? null,
			})),
		};
	});
