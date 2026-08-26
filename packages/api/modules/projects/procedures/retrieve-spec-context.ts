/**
 * Retrieve Spec Context Procedure
 *
 * Multi-query RRF retrieval of stored project context (meeting transcripts,
 * uploaded docs, team messages) relevant to a spec. Wraps
 * `retrieveRelevantContextsForSpec` — the same spec-chunk fan-out + Reciprocal
 * Rank Fusion retrieval the "Update using context" flow uses — so callers get
 * higher-recall context than the single-query `documentContext` procedure.
 *
 * Used by the "Update Clean Spec" refresh to deterministically front-load
 * context into the AI Assistant message, preserving the retrieval quality of
 * the (now removed for V2) "Update using context" button.
 *
 * AUTHORIZATION: Uses hasProjectAccess() — verifies org membership + project
 * access, then tenant XOR isolation flows through the RAG store.
 */

import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { contextMetaHeader, retrieveRelevantContextsForSpec } from "@repo/rag";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const retrieveSpecContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/spec-context",
		tags: ["Projects", "Documents"],
		summary: "Retrieve spec-relevant RAG context",
		description:
			"Multi-query RRF retrieval of stored project context (transcripts, docs, chats) relevant to a spec. Higher recall than the single-query document-context endpoint.",
	})
	.input(
		z.object({
			projectId: z.string(),
			/** Spec markdown used as the retrieval query — chunked, embedded, fanned out. */
			specMarkdown: z.string(),
			organizationId: z.string().nullable().optional(),
			/**
			 * Only contexts created on/after this date are returned. Defaults to the
			 * epoch (all history) so a refresh can fold in any relevant context.
			 */
			baselineDate: z.string().datetime().optional(),
		}),
	)
	.output(z.object({ contexts: z.array(z.string()) }))
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
				message: "You do not have access to this project",
			});
		}

		try {
			const retrieved = await retrieveRelevantContextsForSpec({
				projectId: input.projectId,
				userId: user.id,
				organizationId: organizationId ?? undefined,
				specMarkdown: input.specMarkdown,
				baselineDate: input.baselineDate
					? new Date(input.baselineDate)
					: new Date(0),
			});

			// Each string carries the source's type label + AI guidance
			// header (#1888) when set, matching get-document-context; the
			// header is "" under the flag or for unannotated sources.
			const contexts = retrieved.map(
				(c) => `${contextMetaHeader(c)}${c.content}`,
			);

			logger.info(
				`[retrieveSpecContext] Retrieved ${contexts.length} contexts`,
				{
					projectId: input.projectId,
					contextCount: contexts.length,
				},
			);

			return { contexts };
		} catch (error) {
			// If the AI provider isn't configured, degrade gracefully — the refresh
			// can still proceed; the agent falls back to its own search tool.
			if (
				error instanceof Error &&
				error.message.includes("No AI provider configured")
			) {
				logger.warn(
					"[retrieveSpecContext] No AI provider configured, returning empty contexts",
				);
				return { contexts: [] };
			}

			logger.error(
				`[retrieveSpecContext] Failed to retrieve contexts: ${error}`,
			);
			return { contexts: [] };
		}
	});
