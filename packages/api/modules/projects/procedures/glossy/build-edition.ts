import { ORPCError } from "@orpc/server";
import {
	GLOSSY_DETECTABLE_KINDS,
	GLOSSY_MAX_OPPORTUNITIES,
	GLOSSY_STYLE_DIRECTION_MAX_CHARS,
} from "@repo/agent-prompts/glossy";
import { computeDocumentContentHash, type Prisma } from "@repo/database";
import {
	type GlossyBuildOptions,
	type GlossyOpportunityRef,
	planGlossyKeys,
	resolveGlossyModel,
} from "@repo/temporal";
import { isGlossyEligible } from "@repo/utils/glossy/eligibility";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	enforceAiRateLimit,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { dispatchGlossyBuild } from "../../lib/dispatch-glossy-build";
import {
	GLOSSY_INELIGIBLE_REASONS,
	glossyHolderSchema,
	glossyIneligibility,
	glossyPreparerOverridesSchema,
	loadGlossyDocument,
	presentGlossyHolder,
} from "../../lib/glossy-access";
import { requireGlossyEnabled } from "../../lib/glossy-feature";

const lengthModeSchema = z.enum(["brief", "standard"]).default("brief");

const opportunitySchema = z.object({
	sectionKey: z.string().min(1).max(128),
	kind: z.enum(GLOSSY_DETECTABLE_KINDS),
});

/**
 * Build options (R14, R23, R24). Roll the dice takes nothing but the length
 * mode. Align first carries what the editor confirmed on the form: the
 * opportunities they kept, as `{ sectionKey, kind }` pairs, and the content
 * hash detection ran against, so a body edited since is refused as
 * `draftStale` instead of built from a plan that no longer fits it (KTD10).
 */
const optionsSchema = z.discriminatedUnion("mode", [
	z.object({
		mode: z.literal("roll_the_dice"),
		lengthMode: lengthModeSchema,
	}),
	z.object({
		mode: z.literal("align_first"),
		lengthMode: lengthModeSchema,
		styleDirection: z
			.string()
			.trim()
			.max(GLOSSY_STYLE_DIRECTION_MAX_CHARS)
			.nullable()
			.optional(),
		preparerOverrides: glossyPreparerOverridesSchema.nullable().optional(),
		detection: z.object({
			/** `contentHash` from `projects.glossy.detect`. */
			contentHash: z.string().regex(/^[0-9a-f]{16}$/),
			opportunities: z
				.array(opportunitySchema)
				.max(GLOSSY_MAX_OPPORTUNITIES),
		}),
	}),
]);

const outputSchema = z.discriminatedUnion("outcome", [
	z.object({
		outcome: z.literal("started"),
		startedAt: z.date(),
	}),
	z.object({
		outcome: z.literal("alreadyBuilding"),
		/** Who holds the build, and since when; null when it finished meanwhile. */
		holder: glossyHolderSchema,
	}),
	z.object({
		outcome: z.literal("aiProviderNotConfigured"),
		message: z.string(),
	}),
	/** The document changed since Align first's detection: detect again. */
	z.object({ outcome: z.literal("draftStale") }),
	z.object({
		outcome: z.literal("notEligible"),
		reason: z.enum(GLOSSY_INELIGIBLE_REASONS),
	}),
]);

type BuildOutput = z.infer<typeof outputSchema>;

/**
 * Start a Glossy edition build (Fizzy #2589, R3, R5, R9, R10, R23, R24,
 * KTD4, KTD10, KTD19, KTD21, AE6).
 *
 * In order:
 *  1. the shared Glossy gate for a write — rollout flag and trashed project
 *     (NOT_FOUND), document in project (NOT_FOUND), project access and
 *     `canEditProject` (FORBIDDEN) — which is also the procedure's single read
 *     of the document: eligibility, the Align-first check, and the snapshot
 *     all come from it;
 *  2. eligibility: a Proposal or Business Case with content, not mid-generation;
 *  3. Align first: the confirmed detection must have run against this very
 *     body — the content hash matches and every confirmed opportunity is one
 *     detection could propose for it (a `planGlossyKeys` detectable section,
 *     a kind that section does not already show) — or the answer is
 *     `draftStale`;
 *  4. the AI rate limit, shared with detect and regenerate;
 *  5. BYOK through the same resolver the build uses, as this editor in the
 *     project's organization, so a personal key counts. No provider → a typed
 *     `aiProviderNotConfigured`, before anything is claimed or started;
 *  6. the claim, a stuck holder's reclaim, and the workflow start, with the
 *     claim released when the start fails (`dispatchGlossyBuild`);
 *  7. `build_started`, recorded only for a started build.
 *
 * Inputs name the document only; no edition, build, or cache id is accepted.
 *
 * AUTHORIZATION: `requireGlossyEnabled` first (gate off → NOT_FOUND for every
 * caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then the shared
 * Glossy gate including `canEditProject`. The database's RLS admits every
 * project member to the Glossy rows, so this is where a viewer is stopped.
 */
export const buildGlossyEditionProcedure = tenantProtectedProcedure
	.use(requireGlossyEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{documentId}/glossy/build",
		tags: ["Projects", "Glossy"],
		summary: "Build the Glossy edition",
		description:
			"Start a background build of the document's Glossy edition with Roll the dice or the Align-first choices.",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			options: optionsSchema,
		}),
	)
	.output(outputSchema)
	.handler(async ({ input, context, path }): Promise<BuildOutput> => {
		const userId = context.user.id;
		const { document, organizationId } = await loadGlossyDocument({
			projectId: input.projectId,
			documentId: input.documentId,
			userId,
			write: true,
		});

		const documentType = document.type;
		const ineligible = glossyIneligibility(document);
		if (ineligible || !isGlossyEligible(documentType)) {
			return {
				outcome: "notEligible",
				reason: ineligible ?? "documentType",
			};
		}

		const contentHash = computeDocumentContentHash(document.content);
		const { options } = input;
		let buildOptions: GlossyBuildOptions;
		let recordedOptions: Prisma.InputJsonValue;
		if (options.mode === "align_first") {
			if (options.detection.contentHash !== contentHash) {
				return { outcome: "draftStale" };
			}
			const plan = planGlossyKeys({
				content: document.content,
				projectId: input.projectId,
				documentType,
			});
			if (plan.cleanup.nothingToPresent) {
				return { outcome: "notEligible", reason: "nothingToPresent" };
			}
			// Every confirmed opportunity must be one detection could have
			// proposed for this body: a detectable section (not one holding a
			// best-fit slot) and a kind the section does not already show.
			// Otherwise the key rules changed since detection (a deploy) or the
			// list was not detection's — detecting again is the fix either way.
			const detectable = new Map(
				plan.detectable.map((section) => [
					section.sectionKey,
					new Set<string>(section.reservedKinds),
				]),
			);
			if (
				options.detection.opportunities.some((opportunity) => {
					const reserved = detectable.get(opportunity.sectionKey);
					return !reserved || reserved.has(opportunity.kind);
				})
			) {
				return { outcome: "draftStale" };
			}
			const confirmed = uniqueOpportunities(
				options.detection.opportunities,
			);
			buildOptions = {
				mode: "align_first",
				lengthMode: options.lengthMode,
				styleDirection: options.styleDirection || null,
				confirmedOpportunities: confirmed,
			};
			recordedOptions = {
				mode: buildOptions.mode,
				lengthMode: buildOptions.lengthMode,
				styleDirection: buildOptions.styleDirection ?? null,
				confirmedOpportunities: confirmed.map((opportunity) => ({
					sectionKey: opportunity.sectionKey,
					kind: opportunity.kind,
				})),
				preparerOverrides: options.preparerOverrides
					? {
							primary: options.preparerOverrides.primary ?? null,
							accents: options.preparerOverrides.accents ?? [],
						}
					: null,
			};
		} else {
			buildOptions = {
				mode: "roll_the_dice",
				lengthMode: options.lengthMode,
			};
			recordedOptions = {
				mode: buildOptions.mode,
				lengthMode: buildOptions.lengthMode,
			};
		}

		// A build is the most expensive AI call a user can start, and the
		// per-document claim admits one per document, not per user: the same
		// budget as detect and regenerate, after every cheap refusal.
		await enforceAiRateLimit(userId, path);

		const model = await resolveGlossyModel({
			userId,
			organizationId,
			projectId: input.projectId,
		});
		if (model.status !== "resolved") {
			return {
				outcome: "aiProviderNotConfigured",
				message: model.message,
			};
		}

		const result = await dispatchGlossyBuild({
			documentId: input.documentId,
			projectId: input.projectId,
			organizationId,
			userId,
			options: buildOptions,
			recordedOptions,
			snapshot: {
				title: document.title,
				content: document.content,
				version: document.version,
				contentHash,
			},
		});

		if (result.outcome === "startFailed") {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "The build could not be started. Try again.",
			});
		}
		if (result.outcome === "alreadyBuilding") {
			return {
				outcome: "alreadyBuilding",
				holder: await presentGlossyHolder(result.holder),
			};
		}

		recordAuditFromRequest(context, {
			action: "project.glossy_edition.build_started",
			category: "project",
			outcome: "success",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_document",
				id: input.documentId,
				name: null,
			},
			metadata: {
				buildId: result.buildId,
				mode: buildOptions.mode,
				lengthMode: buildOptions.lengthMode,
				confirmedOpportunities:
					buildOptions.confirmedOpportunities?.length ?? 0,
				reclaimed: result.reclaimed,
			},
		});

		return { outcome: "started", startedAt: result.startedAt };
	});

/** One entry per section and kind, in the order the editor confirmed them. */
function uniqueOpportunities(
	opportunities: ReadonlyArray<GlossyOpportunityRef>,
): GlossyOpportunityRef[] {
	const seen = new Set<string>();
	const unique: GlossyOpportunityRef[] = [];
	for (const opportunity of opportunities) {
		const id = `${opportunity.sectionKey}\u0000${opportunity.kind}`;
		if (!seen.has(id)) {
			seen.add(id);
			unique.push({
				sectionKey: opportunity.sectionKey,
				kind: opportunity.kind,
			});
		}
	}
	return unique;
}
