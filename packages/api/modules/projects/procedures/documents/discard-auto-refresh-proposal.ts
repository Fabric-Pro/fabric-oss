import { clearRefreshProposal, getAutoRefreshSettings } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadDocumentForAutoRefresh } from "../../lib/auto-refresh-document-access";
import { assertLivingDocsRefreshEnabled } from "../../lib/living-docs-refresh-feature";

/**
 * Reject a pending auto-refresh proposal. The document is never touched — the
 * proposal only ever lived on the settings row, so rejecting it is a delete of
 * the draft and nothing else.
 *
 * Deliberately idempotent: discarding when there is nothing pending is a no-op
 * success, not a NOT_FOUND. Two people clicking Discard on the same proposal, or
 * one person double-clicking, must not produce an error — the state they asked
 * for (no pending proposal) is the state they get. `apply` is the opposite: it
 * 404s on an empty proposal, because "commit this content" cannot be satisfied
 * when there is no content.
 */
export const discardDocumentAutoRefreshProposalProcedure =
	tenantProtectedProcedure
		.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
		.route({
			method: "POST",
			path: "/projects/{projectId}/documents/{id}/auto-refresh/proposal/discard",
			tags: ["Projects", "Documents"],
			summary: "Discard the pending auto-refresh proposal",
			description:
				"Reject the AI-proposed refresh. The document is left untouched.",
		})
		.input(
			z.object({
				projectId: z.string(),
				id: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			await assertLivingDocsRefreshEnabled();

			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			await loadDocumentForAutoRefresh({
				documentId: input.id,
				projectId: input.projectId,
				userId: context.user.id,
				organizationId,
			});

			// `clearRefreshProposal` is an UPDATE on `documentId` — it would throw
			// P2025 for a document that never had a settings row at all. Check first
			// so "nothing to discard" stays a quiet success.
			const settings = await getAutoRefreshSettings(input.id);
			if (!settings) {
				return { discarded: false as const };
			}

			await clearRefreshProposal(input.id);

			return { discarded: true as const };
		});
