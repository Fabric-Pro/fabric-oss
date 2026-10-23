/**
 * Proposal artifact mode (Fizzy #2946): when a Proposal is a client document,
 * who reads it as an insider, and the brand tokens its page and exports wear.
 *
 * A Proposal in artifact mode is written for the client, so its live page and
 * its exports wear one shared theme for organization members and project
 * guests alike. Two predicates decide everything, and every reader (the
 * page's API, the procedures, the Temporal worker) calls these instead of
 * spelling the rule again:
 *
 * - the client-document predicate: the PROPOSAL_ARTIFACT rollout gate is on
 *   for the project's OWNING organization and the document is a Proposal. It
 *   governs the theme, the exports and chat prompt resolution, for members
 *   and guests alike. The gate half is its own organization-level predicate,
 *   which also decides where a new default at a superseded prompt action is
 *   refused;
 * - the internal predicate: the client-document predicate, and the reader
 *   holds a `member` row in that owning organization. It governs what stays
 *   inside the organization: the tabs, the Internal Analysis, the Style.
 *
 * Neither predicate decides whether outside writers refuse under a live
 * generation run: that is `isRunGuardedDocumentType` in
 * `@repo/utils/generation-run-guard`, decided by type alone, because a
 * Proposal's run keeps going when the gate is turned off mid-run and a gate
 * rollback must never reopen those writes.
 *
 * Every function here takes the owning organization, resolved by the caller
 * from the Project row. Never pass the session's organization or one from the
 * input: a guest working from their own organization would otherwise be
 * judged by the wrong gate and read the wrong organization's brand.
 */

import {
	isOrganizationHeroKey,
	organizationBrandAssetId,
} from "@repo/utils/proposal-artifact/brand-sources";
import {
	buildProposalThemeTokens,
	type ProposalThemeSources,
	type ProposalThemeTokens,
	type SourcedValue,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { db } from "../../client";
import {
	type BrandSiteFetchView,
	getBrandSiteFetch,
} from "../brand-site-fetch";
import { isFeatureEnabled } from "../feature-flags";
import { isOrganizationMember } from "../verify-organization-membership";
import { isRecipientLogoKeyForProject } from "./recipient-brand";
import {
	getRecipientBrandSuggestion,
	type RecipientBrandSuggestionView,
} from "./recipient-brand-suggestion";

/** The one document type that becomes a client document. */
export const PROPOSAL_DOCUMENT_TYPE = "PROPOSAL";

/**
 * Whether the organization's PROPOSAL_ARTIFACT gate is on. False without an
 * organization, decided before the flag is read: nothing outside an
 * organization ever reaches the flag store (ADR-018).
 *
 * The one place the gate is read for an organization, so the client-document
 * predicate and the prompt bindings it supersedes can never disagree about it.
 *
 * `organizationId` must be the OWNING organization: the project's, for
 * anything about a project or its documents; for an organization or project
 * default, the organization the binding is written in.
 */
export async function isProposalArtifactEnabledForOrganization(
	organizationId: string | null | undefined,
): Promise<boolean> {
	if (!organizationId) {
		return false;
	}
	return await isFeatureEnabled("PROPOSAL_ARTIFACT", organizationId);
}

/**
 * Whether the document is a client document: a Proposal in an organization
 * whose PROPOSAL_ARTIFACT gate is on. False without an organization and for
 * any other type, both decided before the flag is read: a project outside
 * any organization never reaches the flag store (ADR-018), and a Business
 * Case costs no lookup.
 *
 * `organizationId` must be the project's OWNING organization.
 */
export async function isProposalClientDocument(args: {
	organizationId: string | null | undefined;
	documentType: string;
}): Promise<boolean> {
	if (args.documentType !== PROPOSAL_DOCUMENT_TYPE) {
		return false;
	}
	return await isProposalArtifactEnabledForOrganization(args.organizationId);
}

/**
 * Whether `userId` reads the client document as an insider: it is a client
 * document, and they are a member of the owning organization. A project guest
 * holds a project role, EDITOR included, but no `member` row there, so they
 * read the client document and never what the organization keeps to itself
 * (see "Project guest" in CONCEPTS.md).
 *
 * `organizationId` must be the project's OWNING organization.
 */
export async function isProposalInternalReader(args: {
	organizationId: string | null | undefined;
	documentType: string;
	userId: string;
}): Promise<boolean> {
	const { organizationId, documentType } = args;
	if (
		!organizationId ||
		!(await isProposalClientDocument({ organizationId, documentType }))
	) {
		return false;
	}
	return await isOrganizationMember(args.userId, organizationId);
}

/**
 * The organization's logo key, when it is the one key the organization logo
 * upload writes: exactly `{organizationId}.png` in the avatars bucket. The
 * organization row's `logo` can hold any string, and that bucket also holds
 * user avatars and every other organization's logo, so anything else (a URL
 * of its own, a nested or leading-slash path, another organization's key) is
 * null before storage is touched.
 */
export function trustedOrganizationLogoKey(
	logo: string | null | undefined,
	organizationId: string,
): string | null {
	if (!organizationId) {
		return null;
	}
	return logo === `${organizationId}.png` ? logo : null;
}

/**
 * What a guest may see of each source. The style direction and the Brand kit
 * guidance are the organization's own instructions to its generator, so they
 * are not even selected here; the member variant reads them separately.
 */
const GUEST_SAFE_STYLE_SELECT = {
	primaryColor: true,
	accentColors: true,
} as const;

const GUEST_SAFE_BRAND_KIT_SELECT = {
	accentColors: true,
	primaryColor: true,
	displayFontFamily: true,
	bodyFontFamily: true,
	displayFontKey: true,
	bodyFontKey: true,
	heroKey: true,
	website: true,
} as const;

/** Only the result of the organization's website fetch, never the attempt. */
const GUEST_SAFE_SITE_FETCH_SELECT = {
	resultWebsite: true,
	primaryColor: true,
	accentColors: true,
} as const;

const GUEST_SAFE_RECIPIENT_SELECT = {
	organizationId: true,
	name: true,
	logoKey: true,
	colors: true,
} as const;

const GUEST_SAFE_ORGANIZATION_SELECT = { name: true, logo: true } as const;

interface ProposalThemeScope {
	/** The project's OWNING organization, resolved from the Project row. */
	organizationId: string;
	projectId: string;
	documentId: string;
}

/**
 * Every brand row a guest may see the effect of, read in the owning
 * organization, and the sources the resolver builds the tokens from:
 *
 * - the Style is read by document AND organization, so a row left behind in
 *   another organization reads as no Style;
 * - the Brand kit's keys count only in the one shape their upload writes for
 *   this organization; a font file only as the id inside its key;
 * - the website fetch counts only with its last result, and only while that
 *   result is for the Brand kit's current website;
 * - the recipient brand is keyed on the project alone, so its row counts only
 *   when it is in the same organization, and its logo only when the key is a
 *   promoted logo of this very project;
 * - the organization logo counts only as {@link trustedOrganizationLogoKey}.
 */
async function readGuestSafeBrandRows(args: ProposalThemeScope) {
	const [style, brandKit, siteFetch, recipient, organization] =
		await Promise.all([
			db.projectDocumentStyle.findFirst({
				where: {
					documentId: args.documentId,
					organizationId: args.organizationId,
				},
				select: GUEST_SAFE_STYLE_SELECT,
			}),
			db.organizationBrandKit.findUnique({
				where: { organizationId: args.organizationId },
				select: GUEST_SAFE_BRAND_KIT_SELECT,
			}),
			db.organizationBrandSiteFetch.findUnique({
				where: { organizationId: args.organizationId },
				select: GUEST_SAFE_SITE_FETCH_SELECT,
			}),
			db.projectRecipientBrand.findUnique({
				where: { projectId: args.projectId },
				select: GUEST_SAFE_RECIPIENT_SELECT,
			}),
			db.organization.findUnique({
				where: { id: args.organizationId },
				select: GUEST_SAFE_ORGANIZATION_SELECT,
			}),
		]);

	const sameOrganizationRecipient =
		recipient && recipient.organizationId === args.organizationId
			? recipient
			: null;
	const recipientLogoKey =
		sameOrganizationRecipient?.logoKey &&
		isRecipientLogoKeyForProject(
			args.projectId,
			sameOrganizationRecipient.logoKey,
		)
			? sameOrganizationRecipient.logoKey
			: null;
	const vendorSite =
		brandKit?.website && siteFetch?.resultWebsite === brandKit.website
			? {
					primaryColor: siteFetch.primaryColor,
					accentColors: siteFetch.accentColors,
				}
			: null;

	const sources: ProposalThemeSources = {
		organization: organization
			? {
					name: organization.name,
					logoKey: trustedOrganizationLogoKey(
						organization.logo,
						args.organizationId,
					),
				}
			: null,
		style: style
			? {
					primaryColor: style.primaryColor,
					accentColors: style.accentColors,
				}
			: null,
		brandKit: brandKit
			? {
					accentColors: brandKit.accentColors,
					primaryColor: brandKit.primaryColor,
					displayFontFamily: brandKit.displayFontFamily,
					bodyFontFamily: brandKit.bodyFontFamily,
					displayFontFileId: organizationBrandAssetId(
						args.organizationId,
						"fonts",
						brandKit.displayFontKey,
					),
					bodyFontFileId: organizationBrandAssetId(
						args.organizationId,
						"fonts",
						brandKit.bodyFontKey,
					),
					heroKey: isOrganizationHeroKey(
						args.organizationId,
						brandKit.heroKey,
					)
						? brandKit.heroKey
						: null,
				}
			: null,
		vendorSite,
		recipient: sameOrganizationRecipient
			? {
					name: sameOrganizationRecipient.name,
					logoKey: recipientLogoKey,
					colors: sameOrganizationRecipient.colors,
				}
			: null,
	};
	return { sources, brandKitWebsite: brandKit?.website ?? null };
}

/**
 * The document's brand tokens as any reader of the client document may see
 * them, guests included: the Style's colours, the Brand kit's colours, fonts
 * and hero, the colours the organization's website declared, the recipient
 * brand and the organization's name and logo, every one read in the owning
 * organization (see {@link readGuestSafeBrandRows}).
 *
 * Assets come back as storage references; the caller signs or inlines them
 * and checks each key again.
 */
export async function resolveGuestSafeProposalThemeTokens(
	args: ProposalThemeScope,
): Promise<ProposalThemeTokens> {
	const { sources } = await readGuestSafeBrandRows(args);
	return buildProposalThemeTokens(sources);
}

/**
 * Every source's value for the Style tab (Fizzy #2946): the resolved tokens,
 * what the Style, the Brand kit and the website fetch each hold for the
 * proposer's colours, what the document would wear without its Style, the
 * Brand kit's website with its latest fetch attempt, and the recipient's
 * latest website fetch as a suggestion. Organization members only: call it
 * after the internal predicate passed for the reader.
 */
export interface ProposalBrandSources {
	tokens: ProposalThemeTokens;
	proposer: {
		primary: {
			style: string | null;
			brandKit: string | null;
			vendorSite: string | null;
		};
		accents: {
			style: string[];
			brandKit: string[];
			vendorSite: string[];
		};
		/**
		 * The colours the document inherits when its Style sets none, by the
		 * same precedence the tokens use, so a "reset to inherited" shows
		 * exactly what the reset would apply.
		 */
		inherited: {
			primary: SourcedValue<string>;
			accents: SourcedValue<string[]>;
		};
	};
	brandKitWebsite: string | null;
	siteFetch: BrandSiteFetchView | null;
	suggestion: RecipientBrandSuggestionView | null;
}

export async function resolveProposalBrandSources(
	args: ProposalThemeScope,
): Promise<ProposalBrandSources> {
	const [{ sources, brandKitWebsite }, siteFetch, suggestion] =
		await Promise.all([
			readGuestSafeBrandRows(args),
			getBrandSiteFetch(args.organizationId),
			getRecipientBrandSuggestion({
				projectId: args.projectId,
				organizationId: args.organizationId,
			}),
		]);
	const inherited = buildProposalThemeTokens({ ...sources, style: null });
	return {
		tokens: buildProposalThemeTokens(sources),
		proposer: {
			primary: {
				style: sources.style?.primaryColor ?? null,
				brandKit: sources.brandKit?.primaryColor ?? null,
				vendorSite: sources.vendorSite?.primaryColor ?? null,
			},
			accents: {
				style: sources.style?.accentColors ?? [],
				brandKit: sources.brandKit?.accentColors ?? [],
				vendorSite: sources.vendorSite?.accentColors ?? [],
			},
			inherited: {
				primary: inherited.proposer.primary,
				accents: inherited.proposer.accents,
			},
		},
		brandKitWebsite,
		siteFetch,
		suggestion,
	};
}

export interface MemberProposalTheme {
	tokens: ProposalThemeTokens;
	/** The Style's free-text direction for the visuals; null when none. */
	styleDirection: string | null;
	/** The Brand kit's guidance text; null when none. */
	brandGuidance: string | null;
	/**
	 * Whether Fabric adds diagrams after each generation; true when the
	 * document has no saved Style.
	 */
	autoVisuals: boolean;
}

/**
 * The tokens plus what only the organization's members may read: the style
 * direction, the automatic-diagrams switch and the Brand kit guidance. Call it only after the internal
 * predicate passed for the reader ({@link isProposalInternalReader}).
 *
 * The tokens come from {@link resolveGuestSafeProposalThemeTokens} itself and
 * the internal fields from their own narrow reads, so the two variants can
 * never disagree about the tokens, and the guest-safe reads never select an
 * internal field.
 */
export async function resolveProposalThemeTokens(
	args: ProposalThemeScope,
): Promise<MemberProposalTheme> {
	const [tokens, style, brandKit] = await Promise.all([
		resolveGuestSafeProposalThemeTokens(args),
		db.projectDocumentStyle.findFirst({
			where: {
				documentId: args.documentId,
				organizationId: args.organizationId,
			},
			select: { styleDirection: true, autoVisuals: true },
		}),
		db.organizationBrandKit.findUnique({
			where: { organizationId: args.organizationId },
			select: { guidance: true },
		}),
	]);
	return {
		tokens,
		styleDirection: style?.styleDirection ?? null,
		brandGuidance: brandKit?.guidance ?? null,
		autoVisuals: style?.autoVisuals ?? true,
	};
}
