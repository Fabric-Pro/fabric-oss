/**
 * Reformat a PROPOSED work-item body for a target kind.
 *
 * Powers the proposal-review type-switch: when a reviewer flips an AI proposal
 * between Bug and Feature, the proposed body is re-run through the matching
 * structure prompt (`bug_creation` / feature stage prompt via `draftBodyByKind`)
 * so the preview — and, on apply, the saved body — is type-correct. The client
 * caches the result per kind so flipping back is instant (once per type).
 *
 * Stateless: this does NOT create or persist a story. It only formats text.
 */

import { draftBodyByKind } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const reformatProposalBodyProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/reformat-proposal-body",
		tags: ["Projects", "Stories"],
		summary: "Reformat a proposed work-item body for a target kind",
		description:
			"Runs the kind-appropriate drafting prompt over a proposed body so a reviewer switching a proposal between Bug and Feature sees the body in the matching structure. Does not persist anything.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			kind: z.enum(["BUG", "FEATURE"]),
			title: z.string(),
			description: z.string().optional(),
			acceptanceCriteria: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const result = await draftBodyByKind({
			projectId: input.projectId,
			organizationId,
			userId: user.id,
			kind: input.kind,
			title: input.title,
			description: input.description,
			acceptanceCriteria: input.acceptanceCriteria,
		});

		return {
			kind: input.kind,
			description: result.description,
			acceptanceCriteria: result.acceptanceCriteria ?? null,
			// Bug triage flag (F-171) so a pre-drafted bug keeps it when applied
			// without re-running the prompt. Meaningful for bugs; false for features.
			needsMoreInfo: result.needsMoreInfo,
			// False when no prompt was bound or the AI call failed — the caller
			// keeps the original body in that case rather than showing nothing.
			aiDrafted: result.aiDrafted,
		};
	});
