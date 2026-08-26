import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * AUTHORIZATION: `requireInputOrgPermission` + `requireProjectPermission`, both
 * at PROJECT_UPDATE — the caller must be a member of the organization they
 * named AND an owner/editor of the project.
 *
 * Flips the opt-in `actionItemRoutingEnabled` flag: whether action items
 * extracted from ingested meetings and monitored chat threads are evaluated
 * against the project's existing tickets and may be proposed as enrichments
 * rather than always as new tickets.
 *
 * FLAG-ONLY — starts no workflow and changes nothing already proposed. The flag
 * is read at ingestion time by each analyze activity, so turning it off affects
 * the next transcript or thread analyzed, and proposals already in the review
 * inbox keep the routing they were written with. Nothing was committed without
 * an approval either way, so switching it off is a complete rollback.
 */
export const setActionItemRoutingProcedure = tenantProtectedProcedure
	// Verifies membership of the organization the CALLER supplied.
	// `requireProjectPermission` authorizes the project and never looks at the
	// org, and `resolveOrganizationId` returns the client's string verbatim —
	// so without this a caller could pair their own project with someone else's
	// organization id.
	.use(requireInputOrgPermission(Permissions.PROJECT_UPDATE))
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/set-action-item-routing",
		tags: ["Projects"],
		summary: "Set Create-vs-Enrich routing for extracted action items",
		description:
			"Enables or disables evaluating extracted action items against the project's existing tickets so a match can be proposed as an enrichment instead of a duplicate new ticket.",
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

		// Same tenant scope as the sibling monitor-flag procedures: an org
		// project is org-owned (editable by any member with PROJECT_UPDATE), a
		// personal project is user-owned.
		const tenantFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId: user.id };

		const project = await db.project.findFirst({
			where: { id: input.projectId, ...tenantFilter },
			select: { id: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		await db.project.update({
			where: { id: input.projectId, ...tenantFilter },
			data: { actionItemRoutingEnabled: input.enabled },
		});

		return { status: "ok", actionItemRoutingEnabled: input.enabled };
	});
