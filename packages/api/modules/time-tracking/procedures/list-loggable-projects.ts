import { ORPCError } from "@orpc/server";
import { listTimeAccessRows } from "@repo/database";
import { resolveEffectiveTimePolicy } from "@repo/utils/time-tracking";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { projectsWithPermission } from "../lib/project-access";
import { resolveProfileTimeZone } from "../lib/time-settings";

export const listLoggableProjectsInputSchema = z.object({
	organizationId: z.string().min(1).max(INPUT_BOUNDS.name),
});

/**
 * The organization's ACTIVE projects the caller can log time on right now,
 * with the policy a new entry on each would be saved under, and the time zone
 * on the caller's profile (null when none or not a real zone) that a new
 * entry starts in.
 *
 * Gated on organization membership only: an organization viewer can still
 * hold TIME_LOG on a project through an Editor membership, so TIME_LOG is
 * decided per project below, with the precedence `createEntry` applies. A
 * project the caller neither created nor is a member of is never offered.
 */
export const listLoggableProjectsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/time-tracking/projects",
		tags: ["Time tracking"],
		summary: "List projects the caller can log time on",
		description:
			"Active projects of the organization where the caller currently holds the time:log permission, each with its billing model and the effective start/stop and billable defaults, plus the IANA time zone on the caller's profile (null when none is set).",
	})
	.input(listLoggableProjectsInputSchema)
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

		const [rows, profileTimeZone] = await Promise.all([
			listTimeAccessRows({
				organizationId,
				userId: context.user.id,
				projects: "loggable",
			}),
			resolveProfileTimeZone(context.user.id),
		]);
		if (!rows.organization) {
			return { projects: [], profileTimeZone };
		}
		const organization = rows.organization;

		const projects = projectsWithPermission(
			rows,
			Permissions.TIME_LOG,
			new Date(),
		).map((project) => ({
			id: project.id,
			name: project.name,
			billingModel: project.billingModel,
			...resolveEffectiveTimePolicy({ org: organization, project }),
		}));

		return { projects, profileTimeZone };
	});
