/**
 * The brand assets a Proposal export prints (Fizzy #2946): each logo and the
 * hero the guest-safe tokens point at, read from storage and re-encoded, so
 * the print page and the Word file carry bytes, never a key or a URL.
 *
 * Each key is checked again here, against the one place its upload writes,
 * before a byte is read: the organization logo is `{organizationId}.png` in
 * the avatars bucket, the hero a promoted Brand kit hero of the export's own
 * organization, a recipient logo sits under this project's promoted
 * recipient-brand prefix. An asset that fails a check, cannot be read, would
 * overrun the export's image budget, does not decode or stays over the
 * encoded cap at its smallest edge is left off the cover, and the export
 * says so with one warning.
 *
 * Each logo is also measured, so the dark cover can tell a logo drawn for a
 * light background (set on a light plate) from one drawn for a dark one, and
 * so is the hero, so the ink laid over it is only as dense as it needs. Each
 * asset is kept small enough to print, the hero with a small copy for the
 * openers.
 */

import { config } from "@repo/config";
import {
	isRecipientLogoKeyForProject,
	trustedOrganizationLogoKey,
} from "@repo/database";
import { srgbChannelToLinear } from "@repo/utils/brand-colors";
import { isOrganizationHeroKey } from "@repo/utils/proposal-artifact/brand-sources";
import {
	mapThemeAssets,
	type ProposalThemeTokens,
	type ThemeAssetRef,
} from "@repo/utils/proposal-artifact/theme-tokens";
import sharp, { type Sharp } from "sharp";
import type { ExportImageBudget } from "../../lib/proposal-export/extract-document-images";
import { fitExportImage } from "../../lib/proposal-export/fit-export-image";
import {
	type NormalizeExportImageResult,
	normalizeExportImage,
} from "../../lib/proposal-export/normalize-image";
import { readStoredObjectWithin } from "../../lib/proposal-export/read-stored-object";
import {
	type ExportRaster,
	type ExportThemeTokens,
	PROPOSAL_EXPORT_LIMITS,
	type ProposalExportWarning,
} from "../../lib/proposal-export/types";
import { activityLogger } from "../lib/activity-logger";

/**
 * The longest edge a logo is kept at: the cover draws one at most 2.75 inches
 * wide, which this covers at print resolution.
 */
const LOGO_MAX_EDGE = 1200;

/**
 * The longest edge of the hero's copy for the section openers, whose
 * graphic is at most about four inches wide.
 */
const HERO_OPENER_EDGE = 900;

/**
 * The hero, re-encoded at the largest edge that keeps it printable (it
 * fills the cover's width, and steps down only to fit the encoded cap),
 * with its small copy for the openers.
 */
async function normalizeHero(
	bytes: Buffer,
): Promise<NormalizeExportImageResult> {
	const result = await fitExportImage(bytes, {
		maxEdge: PROPOSAL_EXPORT_LIMITS.maxImageEdge,
	});
	if (!result.ok) {
		return result;
	}
	const opener = await normalizeExportImage(bytes, {
		maxEdge: HERO_OPENER_EDGE,
	});
	return opener.ok
		? { ok: true, image: { ...result.image, openerCopy: opener.image } }
		: result;
}

/** One sRGB channel byte as linear light, as WCAG's luminance reads it. */
const LINEAR = Array.from({ length: 256 }, (_, value) =>
	srgbChannelToLinear(value),
);

/** One pixel's relative luminance from its sRGB channel bytes. */
function pixelLuminance(data: Buffer, offset: number): number {
	return (
		0.2126 * (LINEAR[data[offset] as number] as number) +
		0.7152 * (LINEAR[data[offset + 1] as number] as number) +
		0.0722 * (LINEAR[data[offset + 2] as number] as number)
	);
}

/** Calls `visit` with each pixel's luminance and alpha (0 to 1). */
async function eachPixel(
	image: Sharp,
	visit: (luminance: number, alpha: number) => void,
): Promise<void> {
	const { data, info } = await image
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const channels = info.channels;
	for (let offset = 0; offset + channels <= data.length; offset += channels) {
		visit(pixelLuminance(data, offset), (data[offset + 3] as number) / 255);
	}
}

/**
 * A logo's mean relative luminance over its opaque pixels, each weighted by
 * its alpha, and whether it has no transparent pixel at all. A logo with no
 * opaque pixel has no luminance.
 */
export async function measureLogo(
	raster: ExportRaster,
): Promise<{ luminance?: number; opaque: boolean }> {
	let weight = 0;
	let sum = 0;
	let opaque = true;
	await eachPixel(sharp(raster.bytes), (luminance, alpha) => {
		if (alpha < 1) {
			opaque = false;
		}
		if (alpha > 0) {
			weight += alpha;
			sum += luminance * alpha;
		}
	});
	return weight > 0 ? { luminance: sum / weight, opaque } : { opaque };
}

/** The hero is measured at this longest edge: its tones, not its detail. */
const HERO_MEASURE_EDGE = 400;

/** The share of the hero's pixels the veil's bright end is darker than. */
const HERO_BRIGHT_PERCENTILE = 0.9;

/** Luminance buckets of the hero's histogram. */
const HERO_BUCKETS = 1024;

/**
 * The hero's bright end: the relative luminance its brightest tenth of
 * visible pixels starts at, counting a pixel by its alpha, rounded up to its
 * bucket's top. A hero with no visible pixel has none. The cover's text sits
 * over the whole picture, so its bright end, not its mean, sets the veil.
 */
export async function measureHero(
	raster: ExportRaster,
): Promise<{ luminance?: number }> {
	const buckets = new Float64Array(HERO_BUCKETS);
	let total = 0;
	await eachPixel(
		sharp(raster.bytes).resize(HERO_MEASURE_EDGE, HERO_MEASURE_EDGE, {
			fit: "inside",
			withoutEnlargement: true,
		}),
		(luminance, alpha) => {
			if (alpha > 0) {
				const bucket = Math.min(
					Math.floor(luminance * HERO_BUCKETS),
					HERO_BUCKETS - 1,
				);
				buckets[bucket] = (buckets[bucket] as number) + alpha;
				total += alpha;
			}
		},
	);
	if (total === 0) {
		return {};
	}
	let seen = 0;
	for (let bucket = 0; bucket < HERO_BUCKETS; bucket++) {
		seen += buckets[bucket] as number;
		if (seen >= total * HERO_BRIGHT_PERCENTILE) {
			return { luminance: (bucket + 1) / HERO_BUCKETS };
		}
	}
	return { luminance: 1 };
}

/** Where a stored asset lives. */
export interface ThemeAssetLocation {
	bucket: string;
	key: string;
}

/** Reads one stored asset's bytes; throws when it cannot. */
export type ThemeAssetReader = (
	location: ThemeAssetLocation,
) => Promise<Buffer>;

/** Abandons the read as soon as the object passes the per-image cap. */
const readStoredAsset: ThemeAssetReader = (location) =>
	readStoredObjectWithin(location, PROPOSAL_EXPORT_LIMITS.maxImageBytes);

/** The asset's storage location, or null when its key fails its check. */
export function themeAssetLocation(
	ref: ThemeAssetRef,
	scope: { organizationId: string; projectId: string },
): ThemeAssetLocation | null {
	switch (ref.kind) {
		case "organization-logo":
			return trustedOrganizationLogoKey(ref.key, scope.organizationId) ===
				ref.key
				? { bucket: config.storage.bucketNames.avatars, key: ref.key }
				: null;
		case "organization-hero":
			return isOrganizationHeroKey(scope.organizationId, ref.key)
				? {
						bucket: config.storage.bucketNames.projectContexts,
						key: ref.key,
					}
				: null;
		case "recipient-logo":
			return isRecipientLogoKeyForProject(scope.projectId, ref.key)
				? {
						bucket: config.storage.bucketNames.projectContexts,
						key: ref.key,
					}
				: null;
		default:
			return null;
	}
}

export interface LoadedThemeAssets {
	tokens: ExportThemeTokens;
	/**
	 * The stored tokens as they printed: every asset left out is null, the
	 * others keep their reference. The export's brand record hashes these,
	 * so an asset that could not be read does not count as printed.
	 */
	printed: ProposalThemeTokens;
	warnings: ProposalExportWarning[];
}

/** Every asset of the tokens as print-ready bytes, or left out. */
export async function loadThemeAssets(input: {
	tokens: ProposalThemeTokens;
	organizationId: string;
	projectId: string;
	budget: ExportImageBudget;
	read?: ThemeAssetReader;
}): Promise<LoadedThemeAssets> {
	const read = input.read ?? readStoredAsset;
	let unavailable = 0;
	const loaded = new Set<ThemeAssetRef>();
	const tokens = await mapThemeAssets(input.tokens, async (ref) => {
		const location = themeAssetLocation(ref, input);
		if (!location) {
			unavailable++;
			return null;
		}
		try {
			const bytes = await read(location);
			// As for the document's images: an object over the per-image cap
			// is dropped without spending the shared budget on it.
			if (
				bytes.byteLength > PROPOSAL_EXPORT_LIMITS.maxImageBytes ||
				!input.budget.charge(bytes.byteLength)
			) {
				unavailable++;
				return null;
			}
			const result =
				ref.kind === "organization-hero"
					? await normalizeHero(bytes)
					: await fitExportImage(bytes, { maxEdge: LOGO_MAX_EDGE });
			if (!result.ok) {
				unavailable++;
				return null;
			}
			loaded.add(ref);
			// An unmeasured hero prints under the veil a white one needs, an
			// unmeasured logo straight on the ink.
			const measured = await (ref.kind === "organization-hero"
				? measureHero(result.image)
				: measureLogo(result.image)
			).catch((error: unknown) => {
				activityLogger.warn("Proposal export asset measure failed", {
					kind: ref.kind,
					error: error instanceof Error ? error.name : "unknown",
				});
				return {};
			});
			return { ...result.image, ...measured };
		} catch {
			unavailable++;
			return null;
		}
	});
	const printed = await mapThemeAssets(input.tokens, async (ref) =>
		loaded.has(ref) ? ref : null,
	);
	return {
		tokens,
		printed,
		warnings:
			unavailable > 0
				? [{ code: "LOGO_UNAVAILABLE", count: unavailable }]
				: [],
	};
}
