import { listWizardTempContextsBySession } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const listTempContextsProcedure = tenantProtectedProcedure
	// Evaluated against the organization named in the input, not the
	// session's: wizard temp contexts are stamped with it, and processing one
	// runs extraction and embeddings on that organization's AI provider.
	// `requireOrganization`: temp contexts exist only to become a project's
	// in an organization (ADR-018). Without it a null organization resolves
	// nothing and the role check is skipped — an organization viewer could
	// upload and process files the session role used to refuse them.
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
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
		const { sessionId } = input;
		const user = context.user;
		// The organization the gate authorized (it resolves the same way), so
		// an omitted one is the session's here too, never the null arm.
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

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
