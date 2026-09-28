import {
	clearVisualDecision,
	getGlossyEdition,
	upsertVisualDecision,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	GLOSSY_APPENDIX_SECTION_KEY,
	locateGlossyVisual,
	loadGlossyDocument,
	readGlossyEditionContent,
} from "../../lib/glossy-access";
import { requireGlossyEnabled } from "../../lib/glossy-feature";

const inputSchema = z
	.object({
		projectId: z.string(),
		documentId: z.string(),
		visualKey: z.string().min(1).max(128),
		/** Accept approves the visual; Discard leaves it out of downloads; Restore undoes either. */
		decision: z.enum(["accept", "discard", "restore"]),
		/**
		 * Accept only, and required there: the `specHash` of the visual the
		 * editor approved, as `projects.glossy.get` returned it.
		 */
		specHash: z.string().min(1).max(128).optional(),
	})
	.refine((input) => input.decision !== "accept" || Boolean(input.specHash), {
		message: "An acceptance names the spec hash it approves",
		path: ["specHash"],
	});

const outputSchema = z.discriminatedUnion("outcome", [
	z.object({
		outcome: z.literal("reviewed"),
		visualKey: z.string(),
		/** The visual's decision now; null is pending, and included (R28). */
		decision: z.enum(["ACCEPTED", "DISCARDED"]).nullable(),
	}),
	/** The published edition holds no such visual. */
	z.object({ outcome: z.literal("visualNotFound") }),
	/**
	 * Accept named a spec the visual no longer shows — it was regenerated
	 * since the page loaded. Nothing was recorded; `specHash` is the current
	 * one, to show before approving.
	 */
	z.object({ outcome: z.literal("visualChanged"), specHash: z.string() }),
]);

type ReviewOutput = z.infer<typeof outputSchema>;

/**
 * Review one visual of the published Glossy edition: Accept, Discard, or
 * Restore (Fizzy #2589, R26, R28, R29, R30, KTD10, KTD19).
 *
 * - The visual key must be one the published content shows; otherwise
 *   `visualNotFound`, with nothing written.
 * - Accept stores the spec hash the editor approved, and must name the
 *   visual's current one. An acceptance applies only while that hash is the
 *   visual's, so a later regenerate turns it back to pending.
 * - Discard applies by visual key alone: it survives a regenerate of the
 *   visual and a rebuild of its unchanged section, and it excludes the
 *   visual from downloads with the surrounding text unchanged (R29).
 * - Restore removes the decision, so the visual is pending and included
 *   again (R28).
 *
 * The decision hangs off the section that shows the visual, so a rebuild
 * keeps it while that section's text is unchanged and prunes it when the
 * section is gone (KTD8). Review is not refused while a build runs: it
 * writes no content, and the next build keeps the decision by that rule.
 * Concurrent reviews of one visual are last-write-wins.
 *
 * `visual_reviewed` records the decision and the visual key, nothing else.
 *
 * AUTHORIZATION: `requireGlossyEnabled` first (gate off → NOT_FOUND for every
 * caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then the shared
 * Glossy gate including `canEditProject`. The Glossy tables' RLS admits
 * every project member, viewers included, so this is where a viewer stops.
 */
export const reviewGlossyVisualProcedure = tenantProtectedProcedure
	.use(requireGlossyEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{documentId}/glossy/visuals/{visualKey}/review",
		tags: ["Projects", "Glossy"],
		summary: "Review a Glossy visual",
		description:
			"Accept, discard, or restore one visual of the Glossy edition. A discarded visual is left out of downloads.",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }): Promise<ReviewOutput> => {
		const userId = context.user.id;
		const { organizationId } = await loadGlossyDocument({
			projectId: input.projectId,
			documentId: input.documentId,
			userId,
			write: true,
		});

		const edition = await getGlossyEdition({
			documentId: input.documentId,
			projectId: input.projectId,
		});
		const content = readGlossyEditionContent(edition?.content);
		const located = content
			? locateGlossyVisual(content, input.visualKey)
			: null;
		if (!located) {
			return { outcome: "visualNotFound" };
		}

		let decision: "ACCEPTED" | "DISCARDED" | null;
		if (input.decision === "restore") {
			await clearVisualDecision({
				documentId: input.documentId,
				projectId: input.projectId,
				visualKey: input.visualKey,
			});
			decision = null;
		} else {
			if (
				input.decision === "accept" &&
				input.specHash !== located.visual.specHash
			) {
				return {
					outcome: "visualChanged",
					specHash: located.visual.specHash,
				};
			}
			decision = input.decision === "accept" ? "ACCEPTED" : "DISCARDED";
			const row = await upsertVisualDecision({
				documentId: input.documentId,
				projectId: input.projectId,
				visualKey: input.visualKey,
				sectionKey: located.sectionKey ?? GLOSSY_APPENDIX_SECTION_KEY,
				decision,
				// A discard applies by visual key alone (KTD10).
				specHash:
					decision === "ACCEPTED" ? located.visual.specHash : null,
				decidedById: userId,
			});
			if (!row) {
				return { outcome: "visualNotFound" };
			}
		}

		recordAuditFromRequest(context, {
			action: "project.glossy_edition.visual_reviewed",
			category: "project",
			outcome: "success",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_document",
				id: input.documentId,
				name: null,
			},
			metadata: { decision: input.decision, visualKey: input.visualKey },
		});
		return { outcome: "reviewed", visualKey: input.visualKey, decision };
	});
