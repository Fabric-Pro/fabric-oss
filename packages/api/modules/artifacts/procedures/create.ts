/**
 * Create Chat Artifact
 *
 * Persists a text-based artifact generated from agent output or research.
 */

import { ORPCError } from "@orpc/server";
import { createChatArtifact, hasProjectAccess } from "@repo/database";
import { logDataEvent } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const createProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_CREATE))
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			conversationId: z.string().optional(),
			instanceId: z.string().optional(),
			projectId: z.string().optional(),
			type: z.enum([
				"RESEARCH_REPORT",
				"CODE",
				"DOCUMENT",
				"DATA",
				"CHART",
				"FILE",
				"SUMMARY",
			]),
			title: z.string().min(1).max(240),
			description: z.string().optional(),
			content: z.string().optional(),
			mimeType: z.string().optional(),
			metadata: z.record(z.string(), z.any()).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (input.projectId) {
			const hasAccess = await hasProjectAccess(
				input.projectId,
				context.user.id,
				organizationId,
			);
			if (!hasAccess) {
				throw new ORPCError("FORBIDDEN", {
					message: "You don't have access to this project",
				});
			}
		}

		const artifact = await createChatArtifact({
			userId: context.user.id,
			organizationId,
			conversationId: input.conversationId,
			instanceId: input.instanceId,
			projectId: input.projectId,
			type: input.type,
			title: input.title,
			description: input.description,
			content: input.content,
			mimeType: input.mimeType,
			metadata: input.metadata,
		});

		// AUDIT-LOG-V1 SCOPE: This event stays on the stdout/webhook path
		// (@repo/logs/audit-logger.ts) for v1. Per D5 of
		// docs/audit-log/README.md, AI/MCP/
		// workflow events are deferred to Phase 2. Do NOT migrate to recordAudit
		// without coordination — dual-writing is acceptable but a unilateral migration
		// loses the stdout/webhook delivery the operator currently relies on.
		await logDataEvent(
			"CREATE",
			"chat_artifact",
			artifact.id,
			context.user.id,
			{
				organizationId,
				projectId: input.projectId,
				conversationId: input.conversationId,
				artifactType: input.type,
				artifactKind: input.metadata?.kind,
				source: input.metadata?.source ?? "artifacts_create",
			},
		).catch((error) => {
			console.warn("[AuditLog] Failed to log artifact creation:", error);
		});

		return { artifact };
	});
