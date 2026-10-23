import {
	getRecipientBrand,
	isRecipientLogoKeyForProject,
	type RecipientBrandSuggestionView,
	type RecipientBrandView,
	resolveProposalBrandSources,
} from "@repo/database";
import {
	normalizeHexColorList,
	strictHexColor,
} from "@repo/utils/glossy/visual-colors";
import {
	BRAND_FETCH_FAILURE_CODES,
	BRAND_FETCH_STATUSES,
	type BrandCandidate,
	brandAlternatives,
	effectiveBrandFetchAttempt,
	isRecipientSuggestedLogoKey,
	neutralizeBrandName,
} from "@repo/utils/proposal-artifact/brand-sources";
import {
	type SourcedValue,
	THEME_TOKEN_SOURCES,
	type ThemeTokenSource,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalArtifactDocument } from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";
import {
	RECIPIENT_SUGGESTION_FIELDS,
	signRecipientLogoRead,
} from "../../lib/recipient-brand";

const sourceSchema = z.enum(THEME_TOKEN_SOURCES);

/** The proposer's primary colour as each source holds it, `#rrggbb` or null. */
const primarySourcesSchema = z.object({
	resolved: z.object({ value: z.string(), source: sourceSchema }),
	/**
	 * What the document wears when its Style sets no primary: the value a
	 * reset to the inherited colour applies, by the tokens' own precedence.
	 */
	inherited: z.object({ value: z.string(), source: sourceSchema }),
	style: z.string().nullable(),
	brandKit: z.string().nullable(),
	vendorSite: z.string().nullable(),
	/** Each source holding another value, once per value, in precedence order. */
	alternatives: z.array(
		z.object({ source: sourceSchema, value: z.string() }),
	),
});

/** The proposer's accents as each source holds them, at most three each. */
const accentSourcesSchema = z.object({
	resolved: z.object({ value: z.array(z.string()), source: sourceSchema }),
	/** What the document wears when its Style sets no accents. */
	inherited: z.object({ value: z.array(z.string()), source: sourceSchema }),
	style: z.array(z.string()),
	brandKit: z.array(z.string()),
	vendorSite: z.array(z.string()),
	alternatives: z.array(
		z.object({ source: sourceSchema, value: z.array(z.string()) }),
	),
});

/** An asset shown read-only with its source: whether there is one, never where. */
const assetSourceSchema = z.object({
	source: sourceSchema,
	present: z.boolean(),
});

const fontSourceSchema = z.object({
	family: z.string(),
	source: sourceSchema,
	/** Whether the Brand kit uploaded a file for this family. */
	hasFile: z.boolean(),
});

const fetchStatusSchema = z.enum(BRAND_FETCH_STATUSES);
const fetchFailureCodeSchema = z.enum(BRAND_FETCH_FAILURE_CODES).nullable();

/**
 * Everything the Style tab shows, field by field. An object schema drops any
 * key it does not name, so a column added to a source later (the attempt's
 * `requestedById`, a storage key) reaches the wire only when it is added
 * here too.
 */
const brandSourcesSchema = z.object({
	proposer: z.object({
		primary: primarySourcesSchema,
		accents: accentSourcesSchema,
		logo: assetSourceSchema,
		hero: assetSourceSchema,
		fonts: z.object({
			display: fontSourceSchema,
			body: fontSourceSchema,
		}),
	}),
	/** The Brand kit's website, the one the vendor-site fetch reads. */
	brandKitWebsite: z.string().nullable(),
	/** The organization's latest website fetch, as a reader sees its attempt. */
	siteFetch: z
		.object({
			website: z.string(),
			status: fetchStatusSchema,
			failureCode: fetchFailureCodeSchema,
			requestedAt: z.date(),
			resultWebsite: z.string().nullable(),
			fetchedAt: z.date().nullable(),
		})
		.nullable(),
	/** The project's recipient brand; null until someone sets one. */
	recipient: z
		.object({
			website: z.string().nullable(),
			name: z.string().nullable(),
			colors: z.array(z.string()),
			hasLogo: z.boolean(),
			/** What a confirmation sends back as `expectedVersion`. */
			version: z.number().int(),
			/**
			 * The recipient website fetch for the website above; null when
			 * none ran for it.
			 */
			suggestion: z
				.object({
					requestId: z.string(),
					website: z.string(),
					status: fetchStatusSchema,
					failureCode: fetchFailureCodeSchema,
					requestedAt: z.date(),
					fetchedAt: z.date().nullable(),
					/**
					 * What the fetch found, while a field of it can still be
					 * confirmed; null otherwise.
					 */
					result: z
						.object({
							name: z.string().nullable(),
							colors: z.array(z.string()),
							/** A short-lived signed read; null without a logo. */
							logoUrl: z.string().nullable(),
							/**
							 * The fields whose value differs from the
							 * recipient brand's: the ones to offer a Confirm.
							 */
							alternatives: z.array(
								z.enum(RECIPIENT_SUGGESTION_FIELDS),
							),
						})
						.nullable(),
				})
				.nullable(),
		})
		.nullable(),
});

type BrandSourcesOutput = z.infer<typeof brandSourcesSchema>;
type RecipientOutput = NonNullable<BrandSourcesOutput["recipient"]>;
type SuggestionOutput = NonNullable<RecipientOutput["suggestion"]>;

/**
 * The values a person may pick instead of the resolved one. Never the
 * neutral default: only the Style, the Brand kit and the website fetch are
 * offered, each as the tokens would read it.
 */
function alternativesOf<T>(
	resolved: SourcedValue<T>,
	candidates: Array<BrandCandidate<T | null>>,
): Array<{ source: ThemeTokenSource; value: T }> {
	return brandAlternatives<T | null>(resolved, candidates).flatMap(
		(candidate) =>
			candidate.value === null
				? []
				: [{ source: candidate.source, value: candidate.value }],
	);
}

/** Whether the suggestion's field would change the recipient brand. */
function differs<T>(current: T, suggested: T): boolean {
	return (
		brandAlternatives({ source: "MANUAL", value: current }, [
			{ source: "FETCHED_UNCONFIRMED", value: suggested },
		]).length > 0
	);
}

/**
 * The suggestion for the recipient's current website, or null. Its result is
 * shown only while confirm would accept it: the attempt SUCCEEDED as a reader
 * sees it and found that same website. A running, failed or cut-off re-fetch
 * shows its state without the earlier result, since a click on it could only
 * come back stale.
 *
 * The suggested logo is signed only after its key is checked to be one of
 * this project's suggested logos, best-effort like the recipient brand's own
 * read; one that cannot be signed is not offered. A logo counts as the
 * recipient's own only when both hashes are known and equal; a row logo
 * without a hash differs.
 */
async function presentSuggestion(
	projectId: string,
	brand: RecipientBrandView,
	suggestion: RecipientBrandSuggestionView | null,
	now: Date,
): Promise<SuggestionOutput | null> {
	if (!suggestion || !brand.website || suggestion.website !== brand.website) {
		return null;
	}
	const attempt = effectiveBrandFetchAttempt(suggestion, now);
	const view: SuggestionOutput = {
		requestId: suggestion.requestId,
		website: suggestion.website,
		status: attempt.status,
		failureCode: attempt.failureCode,
		requestedAt: suggestion.requestedAt,
		fetchedAt: suggestion.fetchedAt,
		result: null,
	};
	if (
		attempt.status !== "SUCCEEDED" ||
		suggestion.resultWebsite !== brand.website
	) {
		return view;
	}

	const name = neutralizeBrandName(suggestion.name);
	const logoKey = isRecipientSuggestedLogoKey(projectId, suggestion.logoKey)
		? suggestion.logoKey
		: null;
	let logoUrl: string | null = null;
	if (logoKey) {
		try {
			logoUrl = await signRecipientLogoRead(logoKey);
		} catch {
			logoUrl = null;
		}
	}
	const sameLogo =
		brand.logoKey !== null &&
		brand.logoHash !== null &&
		suggestion.logoHash !== null &&
		brand.logoHash === suggestion.logoHash;

	const alternatives: Array<(typeof RECIPIENT_SUGGESTION_FIELDS)[number]> =
		[];
	if (differs(brand.name, name)) {
		alternatives.push("name");
	}
	if (differs(brand.colors, suggestion.colors)) {
		alternatives.push("colors");
	}
	// A logo the member cannot see is not offered: they confirm what they saw.
	if (logoUrl && !sameLogo) {
		alternatives.push("logo");
	}
	return {
		...view,
		result: { name, colors: suggestion.colors, logoUrl, alternatives },
	};
}

/**
 * Where each brand value of a Proposal comes from, for its Style tab (Fizzy
 * #2946): the value each source holds for the proposer's colours, the one
 * that resolved and the alternatives a person may pick instead; the source
 * of the logo, hero and fonts; the Brand kit's website with its latest fetch;
 * and the recipient brand with the fetch of its website, "found, not
 * applied" until a member confirms a field of it.
 *
 * Every value is read in the project's owning organization: the sources
 * through `resolveProposalBrandSources`, and the recipient brand only when
 * its row is in that same organization. Nothing here carries a storage key
 * or who asked for a fetch, and the only signed read is the suggested logo,
 * after its key is checked. A read, so no audit row.
 *
 * Organization members only: the website fetches and the suggestion are the
 * organization's working material, never a project guest's.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_READ)`, then
 * `loadProposalArtifactDocument` (document in project, project access,
 * membership of the owning organization, a Proposal).
 */
export const getProposalBrandSourcesProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/brand-sources",
		tags: ["Projects", "Proposal artifact"],
		summary: "Get the Proposal brand sources",
		description:
			"Where each of a Proposal's brand values comes from, the alternatives each source offers, and the recipient website suggestion. Organization members only.",
	})
	.input(z.object({ projectId: z.string(), documentId: z.string() }))
	.output(brandSourcesSchema)
	.handler(async ({ input, context }) => {
		const { document, organizationId } = await loadProposalArtifactDocument(
			{
				projectId: input.projectId,
				documentId: input.documentId,
				userId: context.user.id,
				write: false,
			},
		);

		const [sources, row] = await Promise.all([
			resolveProposalBrandSources({
				organizationId,
				projectId: input.projectId,
				documentId: document.id,
			}),
			getRecipientBrand(input.projectId),
		]);
		const now = new Date();
		const { tokens, proposer } = sources;

		const stylePrimary = strictHexColor(proposer.primary.style);
		const kitPrimary = strictHexColor(proposer.primary.brandKit);
		const sitePrimary = strictHexColor(proposer.primary.vendorSite);
		// Each list as the tokens read it: strict, each colour once, three at most.
		const styleAccents = normalizeHexColorList(proposer.accents.style);
		const kitAccents = normalizeHexColorList(proposer.accents.brandKit);
		const siteAccents = normalizeHexColorList(proposer.accents.vendorSite);

		const siteFetch = sources.siteFetch
			? {
					website: sources.siteFetch.website,
					...effectiveBrandFetchAttempt(sources.siteFetch, now),
					requestedAt: sources.siteFetch.requestedAt,
					resultWebsite: sources.siteFetch.resultWebsite,
					fetchedAt: sources.siteFetch.fetchedAt,
				}
			: null;

		// A row left behind in another organization is no recipient brand.
		const brand = row?.organizationId === organizationId ? row : null;
		const recipient: RecipientOutput | null = brand
			? {
					website: brand.website,
					name: brand.name,
					colors: brand.colors,
					hasLogo:
						brand.logoKey !== null &&
						isRecipientLogoKeyForProject(
							input.projectId,
							brand.logoKey,
						),
					version: brand.version,
					suggestion: await presentSuggestion(
						input.projectId,
						brand,
						sources.suggestion,
						now,
					),
				}
			: null;

		return {
			proposer: {
				primary: {
					resolved: tokens.proposer.primary,
					inherited: {
						value: proposer.inherited.primary.value,
						source: proposer.inherited.primary.source,
					},
					style: stylePrimary,
					brandKit: kitPrimary,
					vendorSite: sitePrimary,
					alternatives: alternativesOf(tokens.proposer.primary, [
						{ source: "MANUAL", value: stylePrimary },
						{ source: "BRAND_KIT", value: kitPrimary },
						{ source: "VENDOR_SITE", value: sitePrimary },
					]),
				},
				accents: {
					resolved: tokens.proposer.accents,
					inherited: {
						value: proposer.inherited.accents.value,
						source: proposer.inherited.accents.source,
					},
					style: styleAccents,
					brandKit: kitAccents,
					vendorSite: siteAccents,
					alternatives: alternativesOf(tokens.proposer.accents, [
						{ source: "MANUAL", value: styleAccents },
						{ source: "BRAND_KIT", value: kitAccents },
						{ source: "VENDOR_SITE", value: siteAccents },
					]),
				},
				logo: {
					source: tokens.proposer.logo.source,
					present: tokens.proposer.logo.value !== null,
				},
				hero: {
					source: tokens.proposer.hero.source,
					present: tokens.proposer.hero.value !== null,
				},
				fonts: {
					display: {
						family: tokens.proposer.fonts.display.value,
						source: tokens.proposer.fonts.display.source,
						hasFile:
							(tokens.proposer.fontFiles?.display.value ??
								null) !== null,
					},
					body: {
						family: tokens.proposer.fonts.body.value,
						source: tokens.proposer.fonts.body.source,
						hasFile:
							(tokens.proposer.fontFiles?.body.value ?? null) !==
							null,
					},
				},
			},
			brandKitWebsite: sources.brandKitWebsite,
			siteFetch,
			recipient,
		};
	});
