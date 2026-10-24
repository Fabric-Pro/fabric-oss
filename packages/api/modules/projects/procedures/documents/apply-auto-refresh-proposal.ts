import { ORPCError } from "@orpc/client";
import {
	clearRefreshProposal,
	DocumentGenerationInProgressError,
	DocumentVersionConflictError,
	getAutoRefreshSettings,
	updateDocument,
} from "@repo/database";
import { isRunGuardedDocumentType } from "@repo/utils/generation-run-guard";
import { preserveVisualSlots } from "@repo/utils/glossy/visual-slots";
import { preserveVisualMarkers } from "@repo/utils/proposal-artifact/visual-identity";
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
 * 2. THE PROPOSAL IS ONLY VALID AGAINST THE BODY IT WAS DRAFTED FROM. The
 *    model read version N, spent minutes generating, and the proposal then sat
 *    in the database until someone clicked Accept — which could be days. Anyone
 *    may have edited in that window. Applying blind would silently revert them,
 *    so the write is guarded by `expectedVersion: pendingBaselineVersion` and
 *    `expectedContentHash: pendingBaselineContentHash` — a Proposal run's
 *    final save writes its body at the old version, which the version alone
 *    cannot see (Fizzy #2946). A proposal missing either half is not applied.
 *    A lost race is reported as `stale` rather than thrown as a 500: nothing
 *    is written, the dead proposal is cleared, and the user is told to re-run.
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

			const current = await loadDocumentForAutoRefresh({
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
			// The body half of the baseline.
			const baselineContentHash = settings.pendingBaselineContentHash;

			// A proposal with no baseline cannot be proven safe to apply — there is no
			// version to guard the write against, so we cannot tell an untouched
			// document from one that has been edited since. `storeRefreshProposal`
			// always records a baseline, so this is only reachable for a row that
			// predates the guard or was written by hand. Fail closed and make the user
			// re-run: the cost is one refresh, versus silently reverting a human edit.
			//
			// The same holds for a proposal with no body hash, stored before the
			// body half was recorded, for every document type: the version
			// alone does not name a body. A generation run saves its new body
			// at the old version and moves the version at a later step, so in
			// between a version-only check passes and Accept would write the
			// proposal over the body the run just produced (Fizzy #2946).
			if (baselineVersion === null || !baselineContentHash) {
				await clearRefreshProposal(input.id);
				return { applied: false as const, reason: "stale" as const };
			}

			// A Proposal's body belongs to its generation run while the run is
			// queued or writing (Fizzy #2946). The baseline
			// version does not prove no run wrote: a Proposal run's final save
			// writes its body at the old version. So accepting under a run is
			// refused, here and again by the write itself, and the proposal is
			// kept so it can be accepted (or found stale) once the run is done.
			// The write's own refusal is the query's default for a Proposal's
			// content write. Decided by type, not by the rollout gate: a run
			// keeps writing when the gate is turned off mid-run.
			const generationInProgress = () =>
				new ORPCError("CONFLICT", {
					message:
						"A generation run is writing this document; try again when it finishes.",
					data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
				});
			if (
				isRunGuardedDocumentType(current.type) &&
				(current.status === "QUEUED" || current.status === "GENERATING")
			) {
				throw generationInProgress();
			}

			let document: Awaited<ReturnType<typeof updateDocument>>;
			try {
				// Visual slots (KTD17) come from the CURRENT stored body, not from the
				// proposal: the draft can sit for days, so a slot a person deleted in
				// the meantime must not come back with it. With no slot on either side
				// the proposal is written unchanged.
				document = await updateDocument(input.id, {
					content: normalizeQuoteArtifacts(
						preserveVisualMarkers(
							current.content,
							preserveVisualSlots(
								current.content,
								pendingContent,
							),
						),
					),
					changeDescription: settings.pendingSummary ?? undefined,
					// The accepting human, NOT the agent that drafted this.
					lastEditedBy: user.id,
					userId: user.id,
					organizationId,
					expectedVersion: baselineVersion,
					expectedContentHash: baselineContentHash,
				});
			} catch (error) {
				// A run queued between the read above and this write. Nothing
				// was written, and the proposal stays.
				if (error instanceof DocumentGenerationInProgressError) {
					throw generationInProgress();
				}
				if (error instanceof DocumentVersionConflictError) {
					// The document moved under the proposal — its version, or its
					// body at the same version. Nothing was written.
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
