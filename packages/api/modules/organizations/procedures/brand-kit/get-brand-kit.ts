import { ORPCError } from "@orpc/server";
import {
	type BrandKitView,
	getBrandKit,
	getBrandSiteFetch,
} from "@repo/database";
import {
	BRAND_FETCH_FAILURE_CODES,
	BRAND_FETCH_STATUSES,
	effectiveBrandFetchAttempt,
	isOrganizationFontKey,
} from "@repo/utils/proposal-artifact/brand-sources";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertGlossyOrProposalArtifactEnabledForOrganization } from "../../../projects/lib/proposal-artifact-feature";
import { signBrandKitHeroRead } from "../../lib/brand-kit-assets";
import { verifyOrganizationMembership } from "../../lib/membership";

const siteFetchOutputSchema = z.object({
	/** The website the latest attempt fetched. */
	website: z.string(),
	status: z.enum(BRAND_FETCH_STATUSES),
	failureCode: z.enum(BRAND_FETCH_FAILURE_CODES).nullable(),
	requestedAt: z.date(),
	/** When the colours below were found; null until a fetch succeeds. */
	fetchedAt: z.date().nullable(),
	/** The website the colours below came from, which may be an older one. */
	resultWebsite: z.string().nullable(),
	primaryColor: z.string().nullable(),
	accentColors: z.array(z.string()),
});

export const brandKitOutputSchema = z.object({
	accentColors: z.array(z.string()),
	guidance: z.string().nullable(),
	/** Null until the kit is first saved. */
	updatedAt: z.date().nullable(),
	primaryColor: z.string().nullable(),
	displayFontFamily: z.string().nullable(),
	bodyFontFamily: z.string().nullable(),
	hasDisplayFontFile: z.boolean(),
	hasBodyFontFile: z.boolean(),
	/** A short-lived inline read of the hero, or null when there is none. */
	heroUrl: z.string().nullable(),
	website: z.string().nullable(),
	/** The version a save names as `expectedVersion`; 0 before the first. */
	version: z.number().int(),
	/** The organization's latest website fetch, or null when none ran. */
	siteFetch: siteFetchOutputSchema.nullable(),
});

type BrandKitOutput = z.infer<typeof brandKitOutputSchema>;

/**
 * Shape the organization's Brand kit for the client. Storage keys never
 * leave: a font file is reported as present, and the hero as a short-lived
 * read, best-effort, so a storage failure shows the kit without its preview
 * rather than failing the read. The site fetch never names who asked for it.
 */
export async function presentBrandKit(
	organizationId: string,
	kit: BrandKitView | null,
): Promise<BrandKitOutput> {
	const [siteFetch, heroUrl] = await Promise.all([
		getBrandSiteFetch(organizationId),
		// Null for a key that is not this organization's hero.
		kit?.heroKey
			? signBrandKitHeroRead(organizationId, kit.heroKey).catch(
					() => null,
				)
			: Promise.resolve(null),
	]);
	const attempt = siteFetch
		? effectiveBrandFetchAttempt(siteFetch, new Date())
		: null;
	return {
		accentColors: kit?.accentColors ?? [],
		guidance: kit?.guidance ?? null,
		updatedAt: kit?.updatedAt ?? null,
		primaryColor: kit?.primaryColor ?? null,
		displayFontFamily: kit?.displayFontFamily ?? null,
		bodyFontFamily: kit?.bodyFontFamily ?? null,
		hasDisplayFontFile: isOrganizationFontKey(
			organizationId,
			kit?.displayFontKey,
		),
		hasBodyFontFile: isOrganizationFontKey(
			organizationId,
			kit?.bodyFontKey,
		),
		heroUrl,
		website: kit?.website ?? null,
		version: kit?.version ?? 0,
		siteFetch:
			siteFetch && attempt
				? {
						website: siteFetch.website,
						status: attempt.status,
						failureCode: attempt.failureCode,
						requestedAt: siteFetch.requestedAt,
						fetchedAt: siteFetch.fetchedAt,
						resultWebsite: siteFetch.resultWebsite,
						primaryColor: siteFetch.primaryColor,
						accentColors: siteFetch.accentColors,
					}
				: null,
	};
}

/**
 * Get the organization's Brand kit (Fizzy #2589, extended in Fizzy #2946):
 * the accent and primary colours, fonts, hero, website and brand guidance
 * its Glossy editions and client-document Proposals use, with the latest
 * website fetch's status. The logo and the named brand color are read where
 * they already live; this returns only what the kit adds, and never fills
 * the primary from the named brand color.
 *
 * Project guests never read it here — they are not members of the
 * organization; the build reads it through `getBrandKitForProject`.
 *
 * AUTHORIZATION: `ORG_READ` against the requested organization, then
 * membership of it, then the Brand kit gate (GLOSSY_EDITION or
 * PROPOSAL_ARTIFACT for that organization). Every member reads it.
 */
export const getBrandKitProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/brand-kit",
		tags: ["Organizations", "Glossy"],
		summary: "Get the organization Brand kit",
		description:
			"The colors, fonts, hero image, website and brand guidance used to style the organization's Glossy editions and Proposals.",
	})
	.input(z.object({ organizationId: z.string() }))
	.output(z.object({ brandKit: brandKitOutputSchema }))
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		const membership = await verifyOrganizationMembership(
			organizationId,
			user.id,
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}
		await assertGlossyOrProposalArtifactEnabledForOrganization(
			organizationId,
		);

		const brandKit = await getBrandKit(organizationId);
		return { brandKit: await presentBrandKit(organizationId, brandKit) };
	});
