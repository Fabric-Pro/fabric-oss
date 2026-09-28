import { randomUUID } from "node:crypto";
import { GLOSSY_PIPELINE_VERSION } from "@repo/agent-prompts/glossy";
import {
	applyVisualRegeneration,
	type GlossyEditionView,
	getGlossyBuildSnapshot,
	getGlossyEdition,
	type Prisma,
} from "@repo/database";
import {
	extractGlossyVisual,
	type GlossyVisualDropReason,
	glossyVisualDropReason,
	planGlossyKeys,
	planGlossyRegeneration,
} from "@repo/temporal";
import {
	type EditionContent,
	type EditionVisual,
	editionContentSchema,
} from "@repo/utils/glossy/edition-content";
import { isGlossyEligible } from "@repo/utils/glossy/eligibility";
import { specHash, type VisualSpec } from "@repo/utils/glossy/visual-spec";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	enforceAiRateLimit,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { isGlossyHolderGone } from "../../lib/dispatch-glossy-build";
import {
	glossyHolderSchema,
	locateGlossyVisual,
	loadGlossyDocument,
	presentGlossyHolder,
	readGlossyEditionContent,
} from "../../lib/glossy-access";
import { requireGlossyEnabled } from "../../lib/glossy-feature";

/**
 * How many times a regenerate re-applies its splice to fresh content after
 * another regenerate of the same edition wrote first. Each round costs one
 * read and one guarded write, never a model call.
 */
const MAX_WRITE_ATTEMPTS = 3;

const outputSchema = z.discriminatedUnion("outcome", [
	z.object({
		outcome: z.literal("regenerated"),
		visualKey: z.string(),
		kind: z.string(),
		/** The new spec's hash: what an Accept of this visual now approves. */
		specHash: z.string(),
		contentRevision: z.number().int(),
	}),
	/**
	 * The replacement failed its checks (R18); the previous visual is kept,
	 * unchanged, and so is its review.
	 */
	z.object({
		outcome: z.literal("noValidReplacement"),
		/** A `GlossyVisualDropReason`, as the build report uses. */
		reason: z.string(),
	}),
	/**
	 * A build holds the edition; try again once it finishes. `stuck` is the
	 * `get` procedure's verdict on the holder (stale heartbeat, run gone):
	 * only a new build reclaims it, so the page offers that instead of a wait.
	 */
	z.object({
		outcome: z.literal("building"),
		holder: glossyHolderSchema,
		stuck: z.boolean(),
	}),
	z.object({
		outcome: z.literal("aiProviderNotConfigured"),
		message: z.string(),
	}),
	/** The edition holds no such visual. */
	z.object({ outcome: z.literal("visualNotFound") }),
	/** An existing diagram is restyled, not extracted: there is nothing to regenerate. */
	z.object({ outcome: z.literal("notRegenerable") }),
	/**
	 * The edition was built under rules this code no longer keys the same
	 * way (a pipeline change); only a rebuild can refresh it.
	 */
	z.object({ outcome: z.literal("rebuildRequired") }),
	/** A rebuild published a new edition meanwhile; nothing was written. */
	z.object({ outcome: z.literal("superseded") }),
]);

type RegenerateOutput = z.infer<typeof outputSchema>;

/**
 * Regenerate one visual of the published Glossy edition (Fizzy #2589, R27,
 * R30, KTD6, KTD8, KTD10, KTD19, KTD21).
 *
 * In order:
 *  1. the shared Glossy gate for a write (rollout flag and trashed project
 *     NOT_FOUND, document in project NOT_FOUND, project access and
 *     `canEditProject` FORBIDDEN);
 *  2. refused while a build holds the edition (`building`): a build replaces
 *     the whole content, and the write below is guarded on no build anyway;
 *  3. the visual must be one the published content shows (`visualNotFound`),
 *     and one the build extracted — an existing diagram is `notRegenerable`;
 *  4. the visual is re-planned from the published attempt's own snapshot
 *     and options (KTD6), keyed exactly as the build keyed it
 *     (`planGlossyRegeneration`), so the replacement is written to the
 *     cache row a later rebuild of the unchanged section reads — it sticks;
 *  5. one extraction in the request, as this editor in the project's
 *     organization (a personal key counts; none → `aiProviderNotConfigured`,
 *     nothing written), under the AI rate limit, with a fresh variant nonce
 *     so the model offers a different visual of the same kind (R27);
 *  6. the label guard runs inside the extraction; a replacement that fails
 *     it is not used: the old visual stays and the answer is
 *     `noValidReplacement` with the build's reason code;
 *  7. the guarded write (`applyVisualRegeneration`): content, cache row, and
 *     the cleared acceptance commit together, only while the published
 *     attempt and the content revision are the ones read and no build
 *     holds the edition. When another regenerate wrote first, the one-visual
 *     splice is re-applied to the fresh content — no second model call.
 *     When a build claimed meanwhile the answer is `building`, and when a
 *     rebuild published, `superseded`; either way nothing was written, no
 *     cache row either.
 *
 * `visual_regenerated` is recorded for a written replacement and, as a
 * failure, for one the guard refused (R30); spec text never enters the audit
 * row. Inputs name the document and the visual only; no edition, build, or
 * cache id is accepted.
 *
 * AUTHORIZATION: `requireGlossyEnabled` first (gate off → NOT_FOUND for every
 * caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then the shared
 * Glossy gate including `canEditProject`.
 */
export const regenerateGlossyVisualProcedure = tenantProtectedProcedure
	.use(requireGlossyEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{documentId}/glossy/visuals/{visualKey}/regenerate",
		tags: ["Projects", "Glossy"],
		summary: "Regenerate a Glossy visual",
		description:
			"Replace one visual of the Glossy edition with a fresh one of the same kind, from the same source section.",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			visualKey: z.string().min(1).max(128),
		}),
	)
	.output(outputSchema)
	.handler(
		async ({ input, context, path, signal }): Promise<RegenerateOutput> => {
			const userId = context.user.id;
			const { document, organizationId } = await loadGlossyDocument({
				projectId: input.projectId,
				documentId: input.documentId,
				userId,
				write: true,
			});
			const documentType = document.type;
			if (!isGlossyEligible(documentType)) {
				return { outcome: "visualNotFound" };
			}

			const edition = await getGlossyEdition({
				documentId: input.documentId,
				projectId: input.projectId,
			});
			if (!edition) {
				return { outcome: "visualNotFound" };
			}
			if (edition.currentBuildId) {
				return building(edition);
			}
			const content = readGlossyEditionContent(edition.content);
			const publishedBuildId = edition.publishedBuildId;
			const located = content
				? locateGlossyVisual(content, input.visualKey)
				: null;
			if (!content || !publishedBuildId || !located) {
				return { outcome: "visualNotFound" };
			}
			if (
				located.visual.source === "existing_mermaid" ||
				located.sectionKey === null
			) {
				return { outcome: "notRegenerable" };
			}
			if (String(content.pipelineVersion) !== GLOSSY_PIPELINE_VERSION) {
				return { outcome: "rebuildRequired" };
			}

			// The source the displayed visuals came from, never the live
			// document (KTD6). Its tenant columns are checked against the
			// gate's answer before anything of it reaches a model.
			const snapshot = await getGlossyBuildSnapshot(publishedBuildId);
			if (
				!snapshot ||
				snapshot.documentId !== input.documentId ||
				snapshot.projectId !== input.projectId ||
				snapshot.organizationId !== organizationId
			) {
				return { outcome: "rebuildRequired" };
			}
			const sectionKey = located.sectionKey;
			const section = planGlossyKeys({
				content: snapshot.content,
				projectId: snapshot.projectId,
				documentType,
			}).sections.find((entry) => entry.key === sectionKey);
			const plan = section
				? planGlossyRegeneration({
						sectionKey,
						section: section.section,
						visualKey: input.visualKey,
						visual: located.visual,
						buildOptions: snapshot.options,
					})
				: null;
			if (!section || !plan) {
				return { outcome: "rebuildRequired" };
			}

			await enforceAiRateLimit(userId, path);

			const result = await extractGlossyVisual({
				userId,
				organizationId,
				projectId: input.projectId,
				abortSignal: signal,
				documentType,
				section: section.section,
				kind: plan.requestKind,
				slotHint: plan.slotHint,
				styleDirection: plan.styleDirection,
				variantNonce: randomUUID(),
			});
			if (result.status === "aiProviderNotConfigured") {
				return {
					outcome: "aiProviderNotConfigured",
					message: result.message,
				};
			}

			const auditBase = {
				action: "project.glossy_edition.visual_regenerated",
				category: "project",
				organizationId,
				projectId: input.projectId,
				resource: {
					type: "project_document",
					id: input.documentId,
					name: null,
				},
			} as const;

			const replacement =
				result.status === "extracted"
					? replaceVisual(content, input.visualKey, result.spec)
					: null;
			if (result.status === "dropped" || !replacement) {
				const reason: GlossyVisualDropReason =
					result.status === "dropped"
						? glossyVisualDropReason(result.reason)
						: "invalid_spec";
				recordAuditFromRequest(context, {
					...auditBase,
					outcome: "failure",
					metadata: {
						visualKey: input.visualKey,
						kind: located.visual.kind,
						reason,
					},
				});
				return { outcome: "noValidReplacement", reason };
			}

			let current = { edition, content: replacement.content };
			for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
				const written = await applyVisualRegeneration({
					documentId: input.documentId,
					projectId: input.projectId,
					expectedPublishedBuildId: publishedBuildId,
					expectedContentRevision: current.edition.contentRevision,
					content:
						current.content as unknown as Prisma.InputJsonValue,
					visualKey: input.visualKey,
					cacheEntry: {
						cacheKey: plan.cacheKey,
						sectionKey: plan.sectionKey,
						output: {
							spec: replacement.visual.spec,
						} as Prisma.InputJsonValue,
					},
				});
				if (written.outcome === "applied") {
					recordAuditFromRequest(context, {
						...auditBase,
						outcome: "success",
						metadata: {
							visualKey: input.visualKey,
							kind: replacement.visual.kind,
							contentRevision: written.contentRevision,
						},
					});
					return {
						outcome: "regenerated",
						visualKey: input.visualKey,
						kind: replacement.visual.kind,
						specHash: replacement.visual.specHash,
						contentRevision: written.contentRevision,
					};
				}

				// Nothing was written. Find out who got there first.
				const fresh = await getGlossyEdition({
					documentId: input.documentId,
					projectId: input.projectId,
				});
				if (fresh?.currentBuildId) {
					return building(fresh);
				}
				const freshContent = readGlossyEditionContent(fresh?.content);
				const stillThere = freshContent
					? locateGlossyVisual(freshContent, input.visualKey)
					: null;
				if (
					!fresh ||
					!freshContent ||
					fresh.publishedBuildId !== publishedBuildId ||
					stillThere?.sectionKey !== sectionKey
				) {
					return { outcome: "superseded" };
				}
				// Another regenerate of this edition wrote first: splice this
				// visual into its content and try again.
				const respliced = replaceVisual(
					freshContent,
					input.visualKey,
					replacement.visual.spec,
				);
				if (!respliced) {
					return { outcome: "superseded" };
				}
				current = { edition: fresh, content: respliced.content };
			}
			return { outcome: "superseded" };
		},
	);

/** The edition with one visual's spec replaced; null if the result would not be valid content. */
function replaceVisual(
	content: EditionContent,
	visualKey: string,
	spec: VisualSpec,
): { content: EditionContent; visual: EditionVisual } | null {
	const previous = Object.hasOwn(content.visuals, visualKey)
		? content.visuals[visualKey]
		: undefined;
	if (!previous) {
		return null;
	}
	const visual: EditionVisual = {
		...previous,
		kind: spec.kind,
		spec,
		specHash: specHash(spec),
	};
	const parsed = editionContentSchema.safeParse({
		...content,
		visuals: { ...content.visuals, [visualKey]: visual },
	});
	return parsed.success ? { content: parsed.data, visual } : null;
}

async function building(edition: GlossyEditionView): Promise<RegenerateOutput> {
	const holder = edition.currentBuild;
	return {
		outcome: "building",
		holder: await presentGlossyHolder(holder),
		stuck: holder ? await isGlossyHolderGone(holder, new Date()) : false,
	};
}
