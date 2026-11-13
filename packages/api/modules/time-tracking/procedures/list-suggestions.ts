import { ORPCError } from "@orpc/server";
import { listPendingTimeSuggestions, listTimeAccessRows } from "@repo/database";
import {
	type EffectiveTimePolicy,
	resolveEffectiveTimePolicy,
} from "@repo/utils/time-tracking";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { projectsWithPermission } from "../lib/project-access";
import { serializeTimeSuggestion } from "../lib/suggestions";

export const listTimeSuggestionsInputSchema = z.object({
	organizationId: z.string().min(1).max(INPUT_BOUNDS.name),
});

/**
 * The caller's own suggestions waiting for confirmation, newest work date
 * first.
 *
 * Only suggestions that have not expired, on ACTIVE projects the caller can
 * still discover and holds TIME_LOG on: a suggestion is for time the caller
 * could confirm now, so one on a project they lost access to, or one that
 * was archived, is left out.
 */
export const listTimeSuggestionsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/time-tracking/suggestions",
		tags: ["Time tracking"],
		summary: "List the caller's time suggestions",
		description:
			"The caller's own pending, unexpired time suggestions on projects they can log time on now, each with the project's current start/stop and billable defaults and a count of its evidence per kind.",
	})
	.input(listTimeSuggestionsInputSchema)
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
		const now = new Date();

		const suggestions = await listPendingTimeSuggestions({
			organizationId,
			userId: context.user.id,
			now,
		});
		if (suggestions.length === 0) {
			return { suggestions: [] };
		}

		const rows = await listTimeAccessRows({
			organizationId,
			userId: context.user.id,
			projects: "loggable",
		});
		const organization = rows.organization;
		if (!organization) {
			return { suggestions: [] };
		}
		const policies = new Map<string, EffectiveTimePolicy>(
			projectsWithPermission(rows, Permissions.TIME_LOG, now).map(
				(project) => [
					project.id,
					resolveEffectiveTimePolicy({ org: organization, project }),
				],
			),
		);

		return {
			suggestions: suggestions.flatMap((suggestion) => {
				const policy = policies.get(suggestion.projectId);
				return policy
					? [serializeTimeSuggestion(suggestion, policy)]
					: [];
			}),
		};
	});
