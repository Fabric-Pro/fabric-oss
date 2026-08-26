/**
 * Preview what enriching one existing ticket with a proposed action item would
 * change.
 *
 * Powers the Create-vs-Enrich review row: when a reviewer re-targets an
 * enrichment at a different ticket, the diff must show what would change on
 * THAT ticket, not the one the routing pass originally matched. The merge is
 * `reanalyzeBodyByKind` — the same structure-preserving merge the apply path
 * runs — so the preview and the eventual write cannot disagree about shape.
 *
 * Stateless: nothing is created or persisted. It returns the target's current
 * body beside the merged result, plus whether the target is closed or archived
 * so the reviewer is warned before approving.
 */

import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess, TERMINAL_DRAFTING_STAGES } from "@repo/database";
import { reanalyzeBodyByKind } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const previewEnrichmentProcedure = tenantProtectedProcedure
	// Verifies membership of the organization the CALLER supplied. This endpoint
	// returns a ticket's body, so trusting the input org unchecked would be a
	// cross-tenant read.
	.use(requireInputOrgPermission(Permissions.STORY_READ))
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/preview-enrichment",
		tags: ["Projects", "Stories"],
		summary: "Preview enriching an existing ticket with proposed content",
		description:
			"Runs the structure-preserving merge over a target ticket's current body and the proposed new detail, returning both sides so the review UI can diff them. Persists nothing.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			targetStoryId: z.string(),
			/** The proposed new detail, as captured from the meeting or chat. */
			proposedDescription: z.string().optional(),
			proposedAcceptanceCriteria: z.string().optional(),
			/** The analyzer's reasoning, folded in as context for the merge. */
			reasoning: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const access = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!access) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project",
			});
		}

		// Scoped by projectId, so a forged story id cannot preview — or leak the
		// body of — a ticket in another project.
		const target = await db.userStory.findFirst({
			where: { id: input.targetStoryId, projectId: input.projectId },
			select: {
				id: true,
				identifier: true,
				title: true,
				kind: true,
				description: true,
				acceptanceCriteria: true,
				draftingStage: true,
			},
		});
		if (!target) {
			throw new ORPCError("NOT_FOUND", {
				message: "Target ticket not found in this project",
			});
		}

		const newInfo = [
			input.proposedDescription ?? "",
			input.proposedAcceptanceCriteria
				? `Acceptance criteria update:\n${input.proposedAcceptanceCriteria}`
				: "",
			input.reasoning ? `Why this update: ${input.reasoning}` : "",
		]
			.filter(Boolean)
			.join("\n\n");

		const merged = await reanalyzeBodyByKind({
			kind: target.kind,
			title: target.title,
			identifier: target.identifier,
			existingDescription: target.description ?? "",
			existingAcceptanceCriteria: target.acceptanceCriteria,
			newInfo,
			userId: user.id,
			organizationId: organizationId ?? undefined,
			projectId: input.projectId,
		});

		return {
			targetId: target.id,
			targetIdentifier: target.identifier,
			targetTitle: target.title,
			// The reviewer must be warned before approving an enrichment of work
			// the team has already closed out.
			targetClosed: TERMINAL_DRAFTING_STAGES.includes(
				target.draftingStage,
			),
			currentDescription: target.description ?? "",
			currentAcceptanceCriteria: target.acceptanceCriteria ?? "",
			mergedDescription: merged.description,
			// `undefined` from the merge means "leave acceptance criteria alone";
			// echoing the current value keeps the diff a no-op rather than
			// rendering as a deletion.
			mergedAcceptanceCriteria:
				merged.acceptanceCriteria ?? target.acceptanceCriteria ?? "",
			// True when no safe targeted edit could be produced. The UI says the
			// body would be kept as-is instead of showing an empty diff that
			// reads like "nothing will change".
			fallbackUsed: merged.fallbackUsed,
		};
	});
