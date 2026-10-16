import { ORPCError } from "@orpc/client";
import { clearFindingResponse } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalArtifactDocument } from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";
import { presentSavedAnswer, savedAnswerSchema } from "./get-analysis";

/**
 * A finding's stable key as the analysis workflow forms it: a key version
 * (`k1` today), a colon and the first 32 hex digits of a SHA-256 digest. Any
 * key version is accepted, so an answer stored under an older one — listed
 * under "No longer raised" once the key version moves on — can still be
 * cleared.
 */
const STABLE_KEY_PATTERN = /^k[1-9][0-9]{0,2}:[0-9a-f]{32}$/;

const clearFindingResponseInputSchema = z.object({
	projectId: z.string(),
	documentId: z.string(),
	/** The answered finding's stable key, as the analysis read returned it. */
	stableKey: z.string().regex(STABLE_KEY_PATTERN),
	/**
	 * The id and version of the answer the member saw. Together they name
	 * that exact answer, so one cleared and given again meanwhile — a new row,
	 * back at version 1 — is never removed in its place.
	 */
	responseId: z.string().min(1),
	version: z.number().int().positive(),
});

const clearFindingResponseOutputSchema = z.discriminatedUnion("outcome", [
	z.object({ outcome: z.literal("cleared"), stableKey: z.string() }),
	z.object({
		outcome: z.literal("stale"),
		/** Someone changed the answer since the member last saw it. */
		reason: z.literal("VERSION_CHANGED"),
		/** The answer as it is saved now; nothing was cleared. */
		current: savedAnswerSchema,
	}),
]);

/**
 * Clear a member's answer to a finding of a Proposal's Internal Analysis
 * (Fizzy #2946), returning the finding to Unaddressed and taking the answer
 * out of later generations' settled decisions. Keyed by document and stable
 * key, so an answer under "No longer raised" — one whose key no shown run
 * raises — can be cleared too.
 *
 * Only the answer the member saw, by id and version, is cleared: when it
 * changed meanwhile, or was cleared and given again, the call answers
 * `stale` with the answer as saved now, and nothing is removed. No answer for
 * the key answers NOT_FOUND. A key not in the stable-key format is refused
 * as BAD_REQUEST by the input check, before the document or the answer is
 * read.
 *
 * The audit row carries the key, kind and version, never the answer's text.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then
 * `loadProposalArtifactDocument` (document in project, project access, edit
 * access, membership of the owning organization, a Proposal).
 */
export const clearFindingResponseProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/analysis/responses/clear",
		tags: ["Projects", "Proposal artifact"],
		summary: "Clear an answer to an analysis finding",
		description:
			"Removes the answer to a finding of a Proposal's Internal Analysis, including one to a finding no longer raised, when it is still the answer and version given. Organization members with edit access only.",
	})
	.input(clearFindingResponseInputSchema)
	.output(clearFindingResponseOutputSchema)
	.handler(async ({ input, context }) => {
		const { document, organizationId } = await loadProposalArtifactDocument(
			{
				projectId: input.projectId,
				documentId: input.documentId,
				userId: context.user.id,
				write: true,
			},
		);

		const result = await clearFindingResponse({
			organizationId,
			documentId: document.id,
			stableKey: input.stableKey,
			responseId: input.responseId,
			version: input.version,
		});

		if (result.outcome === "not_found") {
			throw new ORPCError("NOT_FOUND", { message: "Answer not found" });
		}
		if (result.outcome === "stale") {
			return {
				outcome: "stale" as const,
				reason: "VERSION_CHANGED" as const,
				current: await presentSavedAnswer(result.current),
			};
		}

		recordAuditFromRequest(context, {
			action: "project.document_analysis.cleared",
			category: "project",
			outcome: "success",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_document",
				id: document.id,
				name: null,
			},
			metadata: {
				stableKey: input.stableKey,
				kind: result.kind,
				version: input.version,
			},
		});

		return { outcome: "cleared" as const, stableKey: input.stableKey };
	});
