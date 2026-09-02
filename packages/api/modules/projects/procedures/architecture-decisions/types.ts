import { ORPCError } from "@orpc/client";
import {
	archiveDecisionType,
	hasProjectAccess,
	listDecisionTypes,
	restoreDecisionType,
} from "@repo/database";
import { z } from "zod";
import { emitActivity } from "../../../../lib/realtime";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Per-project decision-type taxonomy, read side. Types are minted by the
 * save path when a suggested or hand-typed new label is applied — there is no
 * standalone create endpoint, so nothing ships without a consumer.
 */
export const listDecisionTypesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ARCHITECTURE_DECISION_READ))
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/decision-types",
		tags: ["Projects", "Architecture Decisions"],
		summary: "List the project's decision types",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
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

		const types = await listDecisionTypes({ projectId: input.projectId });
		return { types };
	});

/**
 * Retire a type from the taxonomy. Archiving rather than deleting is what keeps
 * the log honest: decisions already tagged with the type keep rendering it,
 * because decision and version reads resolve the relation without an archive
 * filter. Only the picker stops offering it.
 *
 * Takes the same permission as deleting a decision — this removes an option
 * every future decision would have seen, so it is not an UPDATE-level edit.
 */
export const archiveDecisionTypeProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ARCHITECTURE_DECISION_DELETE))
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/decision-types/{id}",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Archive a decision type",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const archived = await archiveDecisionType({
			id: input.id,
			projectId: input.projectId,
		});
		if (!archived) {
			throw new ORPCError("NOT_FOUND", {
				message: "Decision type not found",
			});
		}

		await emitActivity({
			projectId: input.projectId,
			userId: user.id,
			userName: user.name || user.email || "Anonymous",
			activityType: "decision_type_archived",
			resourceType: "decision_type",
			resourceId: archived.id,
			resourceName: archived.name,
			timestamp: new Date().toISOString(),
		});

		return { type: archived };
	});

/**
 * Undo an archive, so retiring the wrong type is recoverable from the toast
 * rather than only by re-applying the name to some future decision.
 */
export const restoreDecisionTypeProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ARCHITECTURE_DECISION_DELETE))
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_DELETE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/decision-types/{id}/restore",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Restore an archived decision type",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const restored = await restoreDecisionType({
			id: input.id,
			projectId: input.projectId,
		});
		if (!restored) {
			throw new ORPCError("NOT_FOUND", {
				message: "Archived decision type not found",
			});
		}

		await emitActivity({
			projectId: input.projectId,
			userId: user.id,
			userName: user.name || user.email || "Anonymous",
			activityType: "decision_type_restored",
			resourceType: "decision_type",
			resourceId: restored.id,
			resourceName: restored.name,
			timestamp: new Date().toISOString(),
		});

		return { type: restored };
	});
