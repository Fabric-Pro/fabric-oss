import { ORPCError } from "@orpc/client";
import {
	hasProjectAccess,
	listDecisionLogThreads,
	type MaturationTenantFilter,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { DecisionLogThreadSchema } from "./schemas";
import { serializeDecisionLogThread } from "./serializers";

/**
 * `maturation.listDecisionLog` (§12, AC-3.1/AC-3.2) — read the threaded Decision
 * Log for a feature: reverse-chronological roots (newest first), replies grouped
 * chronologically, each carrying its resolved-marker state (`status`) and a
 * one-sentence `summary`. Soft-deleted rows are excluded by the query helper.
 *
 * Read-only — no PM sync (§7.7). Returns a Zod-validated DTO.
 */
export const listDecisionLogProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/maturation/decision-log",
		tags: ["Projects", "Features", "Maturation"],
		summary: "List threaded Decision Log entries",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ threads: z.array(DecisionLogThreadSchema) }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const tenantFilter: MaturationTenantFilter = {
			organizationId: organizationId ?? null,
			userId: context.user.id,
		};

		const threads = await listDecisionLogThreads({
			tenantFilter,
			userStoryId: input.storyId,
		});

		return { threads: threads.map((t) => serializeDecisionLogThread(t)) };
	});
