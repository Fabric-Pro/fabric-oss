import { ORPCError } from "@orpc/server";
import {
	type GroupingRunResults,
	getLatestScanFindingGrouping,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * The most-recent security/accessibility finding-grouping run for a project
 * (spec `2026-07-01-security-finding-tickets`) — drives the "Group into
 * tickets" button's status + polling. Returns the latest grouping run (any
 * status) with its `results`, or `null` when the project has never run
 * grouping. Read-gated by project access.
 */
export const getGroupingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/scan/grouping/latest",
		tags: ["Projects", "Security"],
		summary: "Get the latest security/accessibility finding-grouping run",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId } = input;
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

		const grouping = await getLatestScanFindingGrouping(projectId);
		// `results` is a Prisma `Json?` column (inferred as JsonValue | null). Re-type
		// it to the typed results shape so the oRPC client — and the UI types
		// derived from this contract — get a real `GroupingRunResults | null`, not
		// an opaque JsonValue. Unlike `get-review.ts`'s `proposals` (an array that
		// defaults to `[]`), `results` being `null` is itself a meaningful state
		// (the run hasn't completed yet), so it is preserved rather than defaulted
		// to an empty object.
		return {
			grouping: grouping
				? {
						...grouping,
						results: (grouping.results ??
							null) as unknown as GroupingRunResults | null,
					}
				: null,
		};
	});
