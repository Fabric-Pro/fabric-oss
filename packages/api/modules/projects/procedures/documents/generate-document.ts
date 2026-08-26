/**
 * Generate Document Procedure
 * Triggers Temporal workflow for document generation with RAG
 */

import { ORPCError } from "@orpc/server";
import { getDocumentById } from "@repo/database/prisma/queries/projects/documents";
import { logger } from "@repo/logs";
import { hasPermission } from "@repo/permissions";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import {
	Permissions,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	dispatchDocumentGeneration,
	MAX_RUN_INSTRUCTIONS_CHARS,
} from "../../lib/dispatch-document-generation";

/**
 * Generation is authorized against the project, not the caller's org role.
 *
 * This procedure takes a document id, so `requireProjectPermission` — which
 * reads `projectId` off the input — cannot gate it. It previously used the
 * org-level `requirePermission`, which is skipped outright in personal tenant
 * context, plus a bare `hasProjectAccess` membership test that never looked at
 * the member's role. A read-only project guest therefore passed and could
 * overwrite a document by regenerating it.
 *
 * The gate now runs in the handler against the project, using the same shared
 * resolver and the same A → C → B precedence `requireProjectPermission` uses:
 * personal-project owner, then an active ProjectMember row (authoritative on
 * its own), then the caller's org role on the host org. That also fixes the
 * inverse error the old org-level check made — an org `viewer` who is an
 * `EDITOR` on one project was refused, though the project-authoritative model
 * grants them the permission.
 */
export const generateDocumentProcedure = tenantProtectedProcedure
	.route({
		method: "POST",
		path: "/projects/documents/:id/generate",
		tags: ["Projects", "Documents"],
		summary: "Generate document content using AI with RAG",
	})
	.input(
		z.object({
			id: z.string(),
			prompt: z
				.string()
				.max(MAX_RUN_INSTRUCTIONS_CHARS)
				.optional()
				.default("")
				.describe(
					"Optional custom instructions. If empty, uses document-type-specific default prompt.",
				),
			promptId: z
				.string()
				.optional()
				.describe("Optional custom prompt ID from Prompt Library"),
			promptVersionId: z
				.string()
				.optional()
				.describe(
					"Specific prompt version ID for attribution tracking",
				),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// Get document with content for regeneration
		const document = await getDocumentById(input.id);

		if (!document) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found",
			});
		}

		// Store current content for regeneration context
		// This ensures the AI knows what exists and generates fresh content
		const currentDocument = document.content || undefined;

		// Authorize against the project, role-aware. `null` means the project
		// row is gone; treat that as not-found rather than leaking its absence
		// as a permission error.
		const access = await resolveEffectiveProjectPermissions(
			document.projectId,
			user.id,
		);

		if (!access) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// A personal-project owner is authorized for any project permission,
		// matching `requireProjectPermission`'s owner path exactly.
		if (
			access.source !== "owner" &&
			!hasPermission(access.permissions, Permissions.DOCUMENT_UPDATE)
		) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project",
			});
		}

		try {
			// The dispatch itself — token issuance, the
			// mark-GENERATING-before-start ordering, and the tri-state
			// recovery when `workflow.start` throws ambiguously — lives in
			// one shared helper, because the Documents-tab create flow now
			// dispatches generation too and a second copy of those rules
			// would drift silently.
			return await dispatchDocumentGeneration({
				documentId: document.id,
				projectId: document.projectId,
				documentType: document.type,
				userId: user.id,
				organizationId: document.project?.organizationId || undefined,
				prompt: input.prompt,
				promptId: input.promptId,
				promptVersionId: input.promptVersionId,
				currentDocument,
			});
		} catch (error) {
			// Everything in this try is infrastructure (Temporal client,
			// token issuance, workflow start), so the raw error can carry
			// internal details — connection strings, addresses, provider
			// messages — that must not reach the editor's error toast. Log
			// the real failure for operators and hand the client a generic
			// message instead.
			logger.error(
				`[GenerateDocument] Failed to start document generation for document ${document.id}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start document generation",
			});
		}
	});
