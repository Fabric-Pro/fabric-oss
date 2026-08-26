import { ORPCError } from "@orpc/client";
import {
	clearProjectDocumentDecisionPrecheck,
	getDocumentById,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	extractDecisionPrecheck,
	recordDecisionOverridesAccepted,
} from "../lib/decision-override-audit";

/**
 * "Keep anyway" for a generated document that contradicts a logged architecture
 * decision. Server-authoritative override + accept: record one immutable
 * `decision.override_accepted` row per conflicting decision, then clear the
 * document's `decisionPrecheck` so the editor stops warning.
 *
 * Discard / regenerate / revert is the not-logged "cancel" equivalent and does
 * not reach this procedure (it goes through the version-history / regenerate
 * controls). The override write is flag-gated + best-effort; the clear is
 * unconditional so a flag-off caller still resolves the (already-null) column.
 */
export const acknowledgeDecisionPrecheckProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/:documentId/acknowledge-decision-precheck",
		tags: ["Projects", "Documents"],
		summary: "Acknowledge a document decision pre-check",
		description:
			"Log the override for a document that contradicts a logged decision, then clear the finding.",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Bind the document to the authorized project (the permission gate above
		// only authorizes `input.projectId`; the document is loaded by id).
		const document = await getDocumentById(input.documentId);
		if (!document || document.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", { message: "Document not found" });
		}

		recordDecisionOverridesAccepted(context, {
			projectId: input.projectId,
			organizationId,
			surface: "document",
			artifactType: "project_document",
			artifactId: document.id,
			precheck: extractDecisionPrecheck(document.decisionPrecheck),
			resolveSnapshot: () => document.content ?? "",
		});

		await clearProjectDocumentDecisionPrecheck(document.id);

		return { acknowledged: true };
	});
