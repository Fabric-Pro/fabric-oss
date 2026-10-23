import { ORPCError } from "@orpc/client";
import {
	BRAND_ASSET_REJECTION_CODES,
	type BrandAssetRejectionCode,
} from "@repo/utils/brand-assets";
import { safeFontFamily } from "@repo/utils/proposal-artifact/theme-tokens";
import { parseBrandColorList } from "@saas/shared/components/BrandColorListField";
import type { orpcClient } from "@shared/lib/orpc-client";

export type BrandKit = Awaited<
	ReturnType<typeof orpcClient.organizations.brandKit.get>
>["brandKit"];
export type BrandKitUpdateInput = Parameters<
	typeof orpcClient.organizations.brandKit.update
>[0];

/** The three stored files, named as `brandKit.update` names them. */
export type AssetKind = "hero" | "displayFont" | "bodyFont";
export const ASSET_KINDS: readonly AssetKind[] = [
	"hero",
	"displayFont",
	"bodyFont",
];

/**
 * What the save does with one stored file. `replace` names the pending upload
 * by its token; the preview of a new hero is a local object URL, because a
 * pending upload is never signed for reading.
 */
export type AssetDraft =
	| { action: "keep" }
	| { action: "remove" }
	| {
			action: "replace";
			token: string;
			fileName: string;
			previewUrl: string | null;
	  };

/** A file refused by the browser, the upload or the save. */
export type AssetErrorCode = BrandAssetRejectionCode | "uploadFailed";

export type Draft = {
	/** As typed in a one-entry `BrandColorListField`. */
	primaryColor: string[];
	accentColors: string[];
	displayFontFamily: string;
	bodyFontFamily: string;
	website: string;
	guidance: string;
	assets: Record<AssetKind, AssetDraft>;
};

export function draftFrom(kit: BrandKit): Draft {
	return {
		// The kit's own primary only: the organization's named theme color is
		// Glossy's and never pre-fills it.
		primaryColor: kit.primaryColor ? [kit.primaryColor] : [],
		accentColors: kit.accentColors,
		displayFontFamily: kit.displayFontFamily ?? "",
		bodyFontFamily: kit.bodyFontFamily ?? "",
		website: kit.website ?? "",
		guidance: kit.guidance ?? "",
		assets: {
			hero: { action: "keep" },
			displayFont: { action: "keep" },
			bodyFont: { action: "keep" },
		},
	};
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether the draft holds anything the kit it was read from does not. */
export function draftDiffers(draft: Draft, base: BrandKit): boolean {
	const primary = parseBrandColorList(draft.primaryColor);
	const accents = parseBrandColorList(draft.accentColors);
	return (
		!sameJson(
			primary ?? draft.primaryColor,
			base.primaryColor ? [base.primaryColor] : [],
		) ||
		!sameJson(accents ?? draft.accentColors, base.accentColors) ||
		draft.displayFontFamily.trim() !== (base.displayFontFamily ?? "") ||
		draft.bodyFontFamily.trim() !== (base.bodyFontFamily ?? "") ||
		draft.website.trim() !== (base.website ?? "") ||
		draft.guidance.trim() !== (base.guidance ?? "") ||
		ASSET_KINDS.some((kind) => draft.assets[kind].action !== "keep")
	);
}

export type FamilyErrorCode = "fontFamilyRequired" | "fontFamilyInvalid";

/**
 * A family name as the theme accepts it (letters, digits, spaces, hyphens,
 * 2–64 characters), or why it cannot be saved. A font file needs a family to
 * be loaded under, which the server refuses as `fontWithoutFamily`.
 */
export function checkFamily(
	value: string,
	hasFile: boolean,
): { family: string | null; error: FamilyErrorCode | null } {
	if (!value.trim()) {
		return { family: null, error: hasFile ? "fontFamilyRequired" : null };
	}
	const family = safeFontFamily(value);
	return family
		? { family, error: null }
		: { family: null, error: "fontFamilyInvalid" };
}

export function hasFontFile(draft: AssetDraft, stored: boolean): boolean {
	return draft.action === "replace" || (draft.action === "keep" && stored);
}

/** The `data.code` a BAD_REQUEST from `brandKit.update` carries. */
const SAVE_ERROR_CODES = [
	"tooManyAccents",
	"invalidAccent",
	"guidanceTooLong",
	"invalidPrimary",
	"invalidFontFamily",
	"fontWithoutFamily",
	"invalidWebsite",
	"invalidAssetKey",
] as const;
export type SaveErrorCode = (typeof SAVE_ERROR_CODES)[number];

export function errorDataCode(error: unknown): unknown {
	return error instanceof ORPCError
		? (error.data as { code?: unknown } | undefined)?.code
		: undefined;
}

export function isSaveErrorCode(code: unknown): code is SaveErrorCode {
	return (SAVE_ERROR_CODES as readonly unknown[]).includes(code);
}

export function isRejectionCode(
	code: unknown,
): code is BrandAssetRejectionCode {
	return (BRAND_ASSET_REJECTION_CODES as readonly unknown[]).includes(code);
}
