import { ORPCError } from "@orpc/server";
import { listTimeAccessRows, listTimeEntriesForAuthor } from "@repo/database";
import { hasPermission } from "@repo/permissions";
import {
	inclusiveDaySpan,
	isIsoDate,
	MAX_TIME_LIST_SPAN_DAYS,
} from "@repo/utils/time-tracking";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { workDateSchema } from "../lib/entry-input";
import { effectiveProjectPermissions } from "../lib/project-access";
import { serializeTimeEntry } from "../lib/save-entry";

export const listTimeEntriesInputSchema = z
	.object({
		organizationId: z.string().min(1).max(INPUT_BOUNDS.name),
		/** First work date, inclusive. */
		from: workDateSchema,
		/** Last work date, inclusive. */
		to: workDateSchema,
	})
	.refine(
		(input) => {
			// An unreadable date is already reported on its own field.
			if (!isIsoDate(input.from) || !isIsoDate(input.to)) {
				return true;
			}
			const span = inclusiveDaySpan(input.from, input.to);
			return span >= 1 && span <= MAX_TIME_LIST_SPAN_DAYS;
		},
		{
			message: `Choose a range of 1 to ${MAX_TIME_LIST_SPAN_DAYS} days, ending on or after its start`,
			path: ["to"],
		},
	);

/**
 * The caller's own entries over a work-date range, for the week view.
 *
 * An entry on a project the caller can no longer access (removed from it, or
 * the project was deleted) is left out: losing access to a project hides what
 * was logged there too. An archived or completed project's entries stay listed.
 */
export const listTimeEntriesProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/time-tracking/entries",
		tags: ["Time tracking"],
		summary: "List the caller's time entries",
		description:
			"The caller's own time entries with a work date from `from` to `to` (inclusive, at most 31 days), on projects they can still access, ordered by work date and then creation.",
	})
	.input(listTimeEntriesInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "organizationId is required",
			});
		}

		const entries = await listTimeEntriesForAuthor({
			organizationId,
			userId: context.user.id,
			from: input.from,
			to: input.to,
		});
		if (entries.length === 0) {
			return { entries: [], totalMinutes: 0 };
		}

		const access = await listTimeAccessRows({
			organizationId,
			userId: context.user.id,
			projects: {
				ids: [...new Set(entries.map((entry) => entry.projectId))],
			},
		});
		const now = new Date();
		const readable = new Set(
			access.projects
				.filter((project) =>
					hasPermission(
						effectiveProjectPermissions({
							organizationRole: access.organizationRole,
							member: project.member,
							ownedByCaller: project.ownedByCaller,
							now,
						}),
						Permissions.PROJECT_READ,
					),
				)
				.map((project) => project.id),
		);

		const visible = entries.filter((entry) =>
			readable.has(entry.projectId),
		);
		return {
			entries: visible.map(serializeTimeEntry),
			totalMinutes: visible.reduce(
				(sum, entry) => sum + entry.durationMinutes,
				0,
			),
		};
	});
