import { listWizardTempContextsBySession } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const listTempContextsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/wizard/temp-contexts",
		tags: ["Wizard", "Temp Contexts"],
		summary: "List temp contexts",
		description: "List all temp contexts for a wizard session",
	})
	.input(
		z.object({
			sessionId: z.string().min(1, "Session ID is required"),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { sessionId, organizationId } = input;
		const user = context.user;

		const contexts = await listWizardTempContextsBySession(
			sessionId,
			user.id,
			organizationId ?? undefined,
		);

		return {
			contexts: contexts.map((ctx) => {
				const metadata = ctx.metadata as Record<string, unknown> | null;
				return {
					id: ctx.id,
					sessionId: ctx.sessionId,
					type: ctx.type,
					originalFilename: ctx.originalFilename,
					mimeType: ctx.mimeType,
					fileSize: ctx.fileSize,
					extractionStatus: ctx.extractionStatus,
					extractionError: ctx.extractionError,
					content: ctx.content,
					createdAt: ctx.createdAt,
					expiresAt: ctx.expiresAt,
					documentTag: (metadata?.documentTag as string) || null,
				};
			}),
		};
	});
