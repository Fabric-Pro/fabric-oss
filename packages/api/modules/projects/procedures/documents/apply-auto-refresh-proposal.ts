import { ORPCError } from "@orpc/client";
import {
	clearRefreshProposal,
	DocumentVersionConflictError,
	getAutoRefreshSettings,
	updateDocument,
} from "@repo/database";
import { normalizeQuoteArtifacts } from "@repo/utils/quote-artifacts";
import { z } from "zod";
import { applyDocumentUpdateSideEffects } from "../../../../lib/document-side-effects";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadDocumentForAutoRefresh } from "../../lib/auto-refresh-document-access";
import { assertLivingDocsRefreshEnabled } from "../../lib/living-docs-refresh-feature";

/**
 * Accept a pending auto-refresh proposal — the human half of the default
 * (propose, don't write) refresh mode.
 *
 * Two things about this handler are load-bearing:
 *
 * 1. THE AUTHOR IS THE ACCEPTING HUMAN. `lastEditedBy` is the caller, not the
 *    agent that drafted the content. A person read this and chose to commit it,
 *    so the version ledger names the person — the same reasoning that made
 *    `updateDocument` stop copying the incoming writer onto the snapshot row.
 *
 * 2. THE PROPOSAL IS ONLY VALID AGAINST THE VERSION IT WAS DRAFTED FROM. The
 *    model read version N, spent minutes generating, and the proposal then sat
 *    in the database until someone clicked Accept — which could be days. Anyone
 *    may have edited in that window. Applying blind would silently revert them,
 *    so the write is guarded by `expectedVersion: pendingBaselineVersion` and a
 *    lost race is reported as `stale` rather than thrown as a 500: nothing is
 *    written, the dead proposal is cleared, and the user is told to re-run.
 */
export const applyDocumentAutoRefreshProposalProcedure =
	tenantProtectedProcedure
		.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
		.route({
			method: "POST",
			path: "/projects/{projectId}/documents/{id}/auto-refresh/proposal/apply",
			tags: ["Projects", "Documents"],
			summary: "Apply the pending auto-refresh proposal",
			description:
				"Commit the AI-proposed refresh to the document as a new version authored by the accepting user. Reports `stale` without writing if the document has moved since the proposal was generated.",
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

			const user = context.user;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			await loadDocumentForAutoRefresh({
				documentId: input.id,
				projectId: input.projectId,
				userId: user.id,
				organizationId,
			});

			const settings = await getAutoRefreshSettings(input.id);
			const pendingContent = settings?.pendingContent;
			if (!settings || !pendingContent) {
				throw new ORPCError("NOT_FOUND", {
					message: "No proposal to apply for this document.",
				});
			}

			const baselineVersion = settings.pendingBaselineVersion;

			// A proposal with no baseline cannot be proven safe to apply — there is no
			// version to guard the write against, so we cannot tell an untouched
			// document from one that has been edited since. `storeRefreshProposal`
			// always records a baseline, so this is only reachable for a row that
			// predates the guard or was written by hand. Fail closed and make the user
			// re-run: the cost is one refresh, versus silently reverting a human edit.
			if (baselineVersion === null) {
				await clearRefreshProposal(input.id);
				return { applied: false as const, reason: "stale" as const };
			}

			let document: Awaited<ReturnType<typeof updateDocument>>;
			try {
				document = await updateDocument(input.id, {
					content: normalizeQuoteArtifacts(pendingContent),
					changeDescription: settings.pendingSummary ?? undefined,
					// The accepting human, NOT the agent that drafted this.
					lastEditedBy: user.id,
					userId: user.id,
					organizationId,
					expectedVersion: baselineVersion,
				});
			} catch (error) {
				if (error instanceof DocumentVersionConflictError) {
					// The document moved under the proposal. Nothing was written.
					// Clear it so the stale draft cannot be accepted later, and let the
					// next scheduled refresh regenerate against current content.
					await clearRefreshProposal(input.id);
					return {
						applied: false as const,
						reason: "stale" as const,
					};
				}
				throw error;
			}

			await clearRefreshProposal(input.id);

			// Same side effects as any other document save. Skipping these would leave
			// Qdrant serving the PRE-refresh body — search would answer from content
			// that is no longer in the document.
			await applyDocumentUpdateSideEffects({
				projectId: input.projectId,
				document,
				user,
				organizationId,
				logScope: "ApplyAutoRefreshProposal",
			});

			return { applied: true as const, version: document.version };
		});
