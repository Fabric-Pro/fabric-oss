/**
 * List Chat Artifacts
 *
 * Returns paginated artifacts for the current tenant, with optional
 * filtering by project, conversation, and type.
 */

import { listChatArtifacts } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const listProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			projectId: z.string().optional(),
			conversationId: z.string().optional(),
			type: z
				.enum([
					"RESEARCH_REPORT",
					"CODE",
					"DOCUMENT",
					"DATA",
					"CHART",
					"FILE",
					"SUMMARY",
				])
				.optional(),
			limit: z.number().min(1).max(100).default(50),
			offset: z.number().min(0).default(0),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const result = await listChatArtifacts({
			userId: context.user.id,
			organizationId,
			projectId: input.projectId,
			conversationId: input.conversationId,
			type: input.type,
			limit: input.limit,
			offset: input.offset,
		});

		return result;
	});
