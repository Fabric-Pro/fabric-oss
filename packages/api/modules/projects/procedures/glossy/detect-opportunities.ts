import {
	GLOSSY_DETECTABLE_KINDS,
	GLOSSY_MAX_OPPORTUNITIES,
	GLOSSY_REASON_MAX_CHARS,
	type GlossyDetectableKind,
} from "@repo/agent-prompts/glossy";
import {
	computeDocumentContentHash,
	db,
	getCacheEntries,
	getRecipientBrand,
	putCacheEntry,
} from "@repo/database";
import { normalizeWebsiteUrl } from "@repo/integrations/website-brand";
import {
	detectGlossyOpportunities,
	type GlossyDetectableSection,
	type GlossyDetectionCacheOutput,
	parseDetectionOutput,
	planGlossyKeys,
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
import {
	GLOSSY_INELIGIBLE_REASONS,
	glossyIneligibility,
	loadGlossyDocument,
} from "../../lib/glossy-access";
import { requireGlossyEnabled } from "../../lib/glossy-feature";

/** At most this many recipient websites are proposed from link sources. */
const MAX_WEBSITE_SUGGESTIONS = 3;

/** Link sources scanned for a recipient website. */
const LINK_SOURCES_SCANNED = 50;

const opportunityOutputSchema = z.object({
	sectionKey: z.string(),
	/** The section's cleaned heading, for the form's list. */
	heading: z.string().nullable(),
	kind: z.enum(GLOSSY_DETECTABLE_KINDS),
	/** Plain text, at most 160 characters; never render it as HTML (KTD13). */
	reason: z.string(),
});

type DetectedOpportunity = z.infer<typeof opportunityOutputSchema>;

const outputSchema = z.discriminatedUnion("outcome", [
	z.object({
		outcome: z.literal("detected"),
		/** Send back with the confirmed opportunities; a later edit makes the build `draftStale`. */
		contentHash: z.string(),
		/** In document order, one per section, at most eight (R17, R24). */
		opportunities: z.array(opportunityOutputSchema),
		/** Read from an earlier detection of this same body. */
		fromCache: z.boolean(),
		/** The model call failed in a way a retry would not fix; nothing was cached. */
		degraded: z.boolean(),
		/**
		 * `https://host` websites from the project's link sources, proposed
		 * only while the project has no recipient brand (R33).
		 */
		recipientWebsiteSuggestions: z.array(z.string()),
	}),
	z.object({
		outcome: z.literal("aiProviderNotConfigured"),
		message: z.string(),
	}),
	z.object({
		outcome: z.literal("notEligible"),
		reason: z.enum(GLOSSY_INELIGIBLE_REASONS),
	}),
]);

type DetectOutput = z.infer<typeof outputSchema>;

/**
 * Align first's detection (Fizzy #2589, R24, R33, KTD8, KTD10, KTD21; F2).
 *
 * One model call in the request, over the live document, keyed exactly as
 * the build keys its snapshot: `planGlossyKeys` — the helper the build's own
 * activities use — gives the section keys, the sections to propose for, and
 * the whole-document detection key. The result is cached under that key
 * without an attempt guard; an Align-first build of the same body then finds
 * the reasons there at finalize, and runs no detection of its own. A second
 * detection of an unchanged body is answered from that row.
 *
 * Returns the opportunities with their headings and reasons, the content
 * hash to confirm with, and — while the project has no recipient brand —
 * websites from its link sources to fetch one from. Nothing else is written:
 * the recipient brand is saved through `projects.recipientBrand.*`, the build
 * through `projects.glossy.build`.
 *
 * Detection spends the editor's AI budget, so it is an editor action under
 * the AI rate limit, resolved as this editor in the project's organization
 * (a personal key counts).
 *
 * AUTHORIZATION: `requireGlossyEnabled` first (gate off → NOT_FOUND for every
 * caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then the shared
 * Glossy gate including `canEditProject`.
 */
export const detectGlossyOpportunitiesProcedure = tenantProtectedProcedure
	.use(requireGlossyEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{documentId}/glossy/detect",
		tags: ["Projects", "Glossy"],
		summary: "Detect Glossy visual opportunities",
		description:
			"Detect where visuals would help the document, for the Align-first form. Nothing is built.",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
		}),
	)
	.output(outputSchema)
	.handler(
		async ({ input, context, path, signal }): Promise<DetectOutput> => {
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

			const plan = planGlossyKeys({
				content: document.content,
				projectId: input.projectId,
				documentType,
			});
			if (plan.cleanup.nothingToPresent) {
				return { outcome: "notEligible", reason: "nothingToPresent" };
			}
			const contentHash = computeDocumentContentHash(document.content);
			const recipientWebsiteSuggestions = await suggestRecipientWebsites(
				input.projectId,
			);

			const cachedRow = (
				await getCacheEntries({
					documentId: input.documentId,
					kind: "DETECTION",
					cacheKeys: [plan.detectionKey],
				})
			).get(plan.detectionKey);
			// The build's own reader: a row in a shape it does not read is a miss.
			const cached =
				cachedRow === undefined
					? null
					: parseDetectionOutput(cachedRow);
			if (cached) {
				// Re-store the row so its `lastUsedAt` moves: a build that claimed
				// before this read would otherwise prune the row at finalize, and
				// the Align-first build confirming it would lose its reasons.
				await putCacheEntry({
					documentId: input.documentId,
					projectId: input.projectId,
					kind: "DETECTION",
					cacheKey: plan.detectionKey,
					sectionKey: null,
					output: {
						opportunities: cached,
					} satisfies GlossyDetectionCacheOutput,
				});
				const opportunities = withinPlan(cached, plan.detectable);
				audit(context, input, organizationId, {
					count: opportunities.length,
					fromCache: true,
					degraded: false,
				});
				return {
					outcome: "detected",
					contentHash,
					opportunities,
					fromCache: true,
					degraded: false,
					recipientWebsiteSuggestions,
				};
			}

			await enforceAiRateLimit(userId, path);

			const result = await detectGlossyOpportunities({
				userId,
				organizationId,
				projectId: input.projectId,
				abortSignal: signal,
				documentType,
				sections: plan.detectable,
				limit: GLOSSY_MAX_OPPORTUNITIES,
			});
			if (result.status === "aiProviderNotConfigured") {
				return {
					outcome: "aiProviderNotConfigured",
					message: result.message,
				};
			}
			if (result.status === "degraded") {
				// Not cached, so the next detection tries again (as the build does).
				audit(context, input, organizationId, {
					count: 0,
					fromCache: false,
					degraded: true,
				});
				return {
					outcome: "detected",
					contentHash,
					opportunities: [],
					fromCache: false,
					degraded: true,
					recipientWebsiteSuggestions,
				};
			}

			const found = result.opportunities.map((opportunity) => ({
				sectionKey: opportunity.sectionKey,
				kind: opportunity.kind,
				reason: opportunity.reason,
			}));
			await putCacheEntry({
				documentId: input.documentId,
				projectId: input.projectId,
				kind: "DETECTION",
				cacheKey: plan.detectionKey,
				sectionKey: null,
				output: {
					opportunities: found,
				} satisfies GlossyDetectionCacheOutput,
			});
			const opportunities = withinPlan(found, plan.detectable);
			audit(context, input, organizationId, {
				count: opportunities.length,
				fromCache: false,
				degraded: false,
			});
			return {
				outcome: "detected",
				contentHash,
				opportunities,
				fromCache: false,
				degraded: false,
				recipientWebsiteSuggestions,
			};
		},
	);

function audit(
	context: Parameters<typeof recordAuditFromRequest>[0],
	input: { projectId: string; documentId: string },
	organizationId: string,
	metadata: { count: number; fromCache: boolean; degraded: boolean },
): void {
	recordAuditFromRequest(context, {
		action: "project.glossy_edition.opportunities_detected",
		category: "project",
		outcome: "success",
		organizationId,
		projectId: input.projectId,
		resource: {
			type: "project_document",
			id: input.documentId,
			name: null,
		},
		metadata,
	});
}

/**
 * The form's list: only sections detection may propose for, none of a kind
 * the section already shows, one per section, at most eight, in document
 * order, each with its heading. The model's answer passed the same filters;
 * a cached row is filtered again because another writer may have made it.
 */
function withinPlan(
	opportunities: ReadonlyArray<{
		sectionKey: string;
		kind: GlossyDetectableKind;
		reason: string;
	}>,
	detectable: readonly GlossyDetectableSection[],
): DetectedOpportunity[] {
	const byKey = new Map(
		detectable.map((section, index) => [
			section.sectionKey,
			{ section, index },
		]),
	);
	const taken = new Set<string>();
	return opportunities
		.filter((opportunity) => {
			const entry = byKey.get(opportunity.sectionKey);
			if (
				!entry ||
				taken.has(opportunity.sectionKey) ||
				entry.section.reservedKinds.includes(opportunity.kind)
			) {
				return false;
			}
			taken.add(opportunity.sectionKey);
			return true;
		})
		.sort(
			(a, b) =>
				(byKey.get(a.sectionKey)?.index ?? 0) -
				(byKey.get(b.sectionKey)?.index ?? 0),
		)
		.slice(0, GLOSSY_MAX_OPPORTUNITIES)
		.map((opportunity) => ({
			sectionKey: opportunity.sectionKey,
			heading: byKey.get(opportunity.sectionKey)?.section.heading ?? null,
			kind: opportunity.kind,
			reason: opportunity.reason.slice(0, GLOSSY_REASON_MAX_CHARS),
		}));
}

/**
 * Recipient websites from the project's link sources (R33), as the fetch
 * will store them (`https://host`). Marketing websites come first. None while
 * the project already has a recipient brand: the form then shows that one.
 */
async function suggestRecipientWebsites(projectId: string): Promise<string[]> {
	const existing = await getRecipientBrand(projectId);
	if (existing) {
		return [];
	}
	const sources = await db.projectContext.findMany({
		where: { projectId, type: "LINK", sourceUrl: { not: null } },
		select: { sourceUrl: true, knowledgeBaseSourceCategory: true },
		orderBy: { createdAt: "asc" },
		take: LINK_SOURCES_SCANNED,
	});
	const ordered = [
		...sources.filter(
			(source) =>
				source.knowledgeBaseSourceCategory === "MARKETING_WEBSITE",
		),
		...sources.filter(
			(source) =>
				source.knowledgeBaseSourceCategory !== "MARKETING_WEBSITE",
		),
	];
	const websites: string[] = [];
	for (const source of ordered) {
		const website = source.sourceUrl
			? normalizeWebsiteUrl(source.sourceUrl)
			: null;
		if (website && !websites.includes(website)) {
			websites.push(website);
		}
		if (websites.length >= MAX_WEBSITE_SUGGESTIONS) {
			break;
		}
	}
	return websites;
}
