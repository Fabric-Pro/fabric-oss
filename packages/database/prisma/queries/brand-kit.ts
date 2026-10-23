/**
 * The organization Brand kit (Fizzy #2589, extended in Fizzy #2946): the
 * preparer's accent and primary colours, fonts, hero image, website and
 * brand guidance, used to style Glossy editions and client-document Proposals.
 *
 * It lives in `OrganizationBrandKit`, never in organization metadata: the auth
 * library writes metadata wholesale, so a key kept there can be lost to a
 * concurrent update no compare-and-set of ours could prevent. The existing
 * named brand color stays in metadata (see `brand-color.ts`) and is neither
 * read nor written here.
 *
 * Every value here is an admin's choice. A colour fetched from the
 * organization's website is kept in its own row (`brand-site-fetch.ts`), so no
 * automated write ever reaches this table.
 */

import { HEX_COLOR_PATTERN } from "@repo/utils/brand-colors";
import {
	isBrandWebsite,
	isOrganizationFontKey,
	isOrganizationHeroKey,
} from "@repo/utils/proposal-artifact/brand-sources";
import { safeFontFamily } from "@repo/utils/proposal-artifact/theme-tokens";
import { db } from "../client";

export const BRAND_KIT_MAX_ACCENTS = 3;
export const BRAND_KIT_MAX_GUIDANCE_LENGTH = 2000;

export type BrandKitValidationCode =
	| "tooManyAccents"
	| "invalidAccent"
	| "guidanceTooLong"
	| "invalidPrimary"
	| "invalidFontFamily"
	| "fontWithoutFamily"
	| "invalidWebsite"
	| "invalidAssetKey";

export class BrandKitValidationError extends Error {
	constructor(readonly code: BrandKitValidationCode) {
		super(`Invalid Brand kit: ${code}`);
		this.name = "BrandKitValidationError";
	}
}

/**
 * The fields a save names. `undefined` keeps what is stored, so a caller that
 * knows only the accents and guidance (the Glossy-era form, an API client)
 * changes nothing else.
 */
export interface BrandKitFields {
	accentColors: string[];
	/** Replaced on every save; absent clears it, as before the kit grew. */
	guidance?: string | null;
	primaryColor?: string | null;
	displayFontFamily?: string | null;
	bodyFontFamily?: string | null;
	website?: string | null;
}

/** Promoted object keys; `undefined` keeps the stored key. */
export interface BrandKitAssetKeys {
	displayFontKey?: string | null;
	bodyFontKey?: string | null;
	heroKey?: string | null;
}

/**
 * The website as stored: `https://host`, nothing else. The caller has already
 * normalized what a person typed; this refuses anything that is not already
 * in that one shape (an IP literal included), because fetch rows are matched
 * to it by equality.
 */
function storedWebsite(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) {
		return null;
	}
	if (!isBrandWebsite(trimmed)) {
		throw new BrandKitValidationError("invalidWebsite");
	}
	return trimmed;
}

function familyOrNull(value: string | null | undefined): string | null {
	if (!value?.trim()) {
		return null;
	}
	const family = safeFontFamily(value);
	if (!family) {
		throw new BrandKitValidationError("invalidFontFamily");
	}
	return family;
}

/**
 * Validate and normalize Brand kit fields: up to three `#rrggbb` accents and
 * a `#rrggbb` primary (lowercased), guidance of at most 2,000 characters
 * (trimmed; empty becomes null), family names the theme may write, and a
 * website as `https://host`. Fields left `undefined` stay `undefined`.
 */
export function normalizeBrandKitFields(input: BrandKitFields): BrandKitFields {
	if (input.accentColors.length > BRAND_KIT_MAX_ACCENTS) {
		throw new BrandKitValidationError("tooManyAccents");
	}
	if (!input.accentColors.every((color) => HEX_COLOR_PATTERN.test(color))) {
		throw new BrandKitValidationError("invalidAccent");
	}
	const guidance = input.guidance?.trim() || null;
	if (guidance && guidance.length > BRAND_KIT_MAX_GUIDANCE_LENGTH) {
		throw new BrandKitValidationError("guidanceTooLong");
	}
	let primaryColor: string | null | undefined;
	if (input.primaryColor !== undefined) {
		const primary = input.primaryColor?.trim() || null;
		if (primary && !HEX_COLOR_PATTERN.test(primary)) {
			throw new BrandKitValidationError("invalidPrimary");
		}
		primaryColor = primary?.toLowerCase() ?? null;
	}
	return {
		accentColors: input.accentColors.map((color) => color.toLowerCase()),
		guidance,
		primaryColor,
		displayFontFamily:
			input.displayFontFamily === undefined
				? undefined
				: familyOrNull(input.displayFontFamily),
		bodyFontFamily:
			input.bodyFontFamily === undefined
				? undefined
				: familyOrNull(input.bodyFontFamily),
		website:
			input.website === undefined
				? undefined
				: storedWebsite(input.website),
	};
}

export interface BrandKitView {
	organizationId: string;
	accentColors: string[];
	guidance: string | null;
	primaryColor: string | null;
	displayFontFamily: string | null;
	bodyFontFamily: string | null;
	displayFontKey: string | null;
	bodyFontKey: string | null;
	heroKey: string | null;
	website: string | null;
	version: number;
	updatedById: string | null;
	updatedAt: Date;
}

const BRAND_KIT_SELECT = {
	organizationId: true,
	accentColors: true,
	guidance: true,
	primaryColor: true,
	displayFontFamily: true,
	bodyFontFamily: true,
	displayFontKey: true,
	bodyFontKey: true,
	heroKey: true,
	website: true,
	version: true,
	updatedById: true,
	updatedAt: true,
} as const;

/** The organization's Brand kit, or null when it has never been saved. */
export async function getBrandKit(
	organizationId: string,
): Promise<BrandKitView | null> {
	return db.organizationBrandKit.findUnique({
		where: { organizationId },
		select: BRAND_KIT_SELECT,
	});
}

/**
 * The Brand kit of the organization that owns `projectId` — the only read path
 * for project guests, who are not members of that organization. The caller
 * has already passed the project gate; the organization comes from the
 * project row and never from the caller. Null for an unknown project, a
 * project outside any organization, or an organization with no kit.
 */
export async function getBrandKitForProject(
	projectId: string,
): Promise<BrandKitView | null> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	if (!project?.organizationId) {
		return null;
	}
	return getBrandKit(project.organizationId);
}

export type BrandKitField =
	| "accentColors"
	| "guidance"
	| "primaryColor"
	| "displayFontFamily"
	| "bodyFontFamily"
	| "website"
	| "displayFontKey"
	| "bodyFontKey"
	| "heroKey";

const COMPARED_FIELDS: readonly BrandKitField[] = [
	"accentColors",
	"guidance",
	"primaryColor",
	"displayFontFamily",
	"bodyFontFamily",
	"website",
	"displayFontKey",
	"bodyFontKey",
	"heroKey",
];

const ASSET_FIELDS = ["displayFontKey", "bodyFontKey", "heroKey"] as const;

const FONT_SLOTS = [
	["displayFontFamily", "displayFontKey"],
	["bodyFontFamily", "bodyFontKey"],
] as const;

function assertAssetKeys(organizationId: string, keys: BrandKitAssetKeys) {
	const fontKeysValid = [keys.displayFontKey, keys.bodyFontKey].every(
		(key) => key == null || isOrganizationFontKey(organizationId, key),
	);
	const heroValid =
		keys.heroKey == null ||
		isOrganizationHeroKey(organizationId, keys.heroKey);
	if (!fontKeysValid || !heroValid) {
		throw new BrandKitValidationError("invalidAssetKey");
	}
}

export type UpsertBrandKitResult =
	| {
			outcome: "applied";
			brandKit: BrandKitView;
			/** Names only, for an audit entry. */
			changedFields: BrandKitField[];
			/** Promoted keys this save replaced or removed, for cleanup. */
			supersededKeys: string[];
	  }
	| { outcome: "conflict" };

/**
 * Create or update the organization's Brand kit if nobody saved it since
 * `expectedVersion` was read (0: no kit yet). Without `expectedVersion` the
 * save applies over whatever is stored, as the kit did before it had a
 * version; only a write racing this one between its read and its update
 * conflicts. `conflict` writes nothing.
 */
export async function upsertBrandKit(
	input: BrandKitFields & {
		organizationId: string;
		assets?: BrandKitAssetKeys;
		expectedVersion?: number;
		updatedById: string;
	},
): Promise<UpsertBrandKitResult> {
	const fields = normalizeBrandKitFields(input);
	const assets = input.assets ?? {};
	assertAssetKeys(input.organizationId, assets);

	return db.$transaction(async (tx) => {
		const current = await tx.organizationBrandKit.findUnique({
			where: { organizationId: input.organizationId },
			select: BRAND_KIT_SELECT,
		});
		const readVersion = current?.version ?? 0;
		if (
			input.expectedVersion !== undefined &&
			input.expectedVersion !== readVersion
		) {
			return { outcome: "conflict" as const };
		}

		const keep = <K extends BrandKitField>(
			name: K,
			value: BrandKitView[K] | undefined,
		): BrandKitView[K] | null =>
			value !== undefined ? value : (current?.[name] ?? null);
		const next = {
			accentColors: fields.accentColors,
			guidance: fields.guidance,
			primaryColor: keep("primaryColor", fields.primaryColor),
			displayFontFamily: keep(
				"displayFontFamily",
				fields.displayFontFamily,
			),
			bodyFontFamily: keep("bodyFontFamily", fields.bodyFontFamily),
			website: keep("website", fields.website),
			displayFontKey: keep("displayFontKey", assets.displayFontKey),
			bodyFontKey: keep("bodyFontKey", assets.bodyFontKey),
			heroKey: keep("heroKey", assets.heroKey),
		};
		// A file is uploaded for one family. Renaming the family without a
		// new file drops the kept one, which would otherwise print under a
		// name it was never uploaded for.
		for (const [family, key] of FONT_SLOTS) {
			if (
				assets[key] === undefined &&
				fields[family] !== undefined &&
				fields[family] !== (current?.[family] ?? null)
			) {
				next[key] = null;
			}
		}
		// A file is uploaded for a family; one without its name could never
		// be applied, so it is refused rather than stored.
		if (
			(next.displayFontKey && !next.displayFontFamily) ||
			(next.bodyFontKey && !next.bodyFontFamily)
		) {
			throw new BrandKitValidationError("fontWithoutFamily");
		}

		if (!current) {
			// ON CONFLICT DO NOTHING: of two first saves, one inserts and the
			// other sees a row it did not read, which is a conflict.
			const { count } = await tx.organizationBrandKit.createMany({
				data: [
					{
						organizationId: input.organizationId,
						...next,
						version: 1,
						updatedById: input.updatedById,
					},
				],
				skipDuplicates: true,
			});
			if (count === 0) {
				return { outcome: "conflict" as const };
			}
		} else {
			const { count } = await tx.organizationBrandKit.updateMany({
				where: {
					organizationId: input.organizationId,
					version: current.version,
				},
				data: {
					...next,
					version: { increment: 1 },
					updatedById: input.updatedById,
				},
			});
			if (count === 0) {
				return { outcome: "conflict" as const };
			}
		}

		const brandKit = await tx.organizationBrandKit.findUniqueOrThrow({
			where: { organizationId: input.organizationId },
			select: BRAND_KIT_SELECT,
		});
		const changedFields = COMPARED_FIELDS.filter(
			(name) =>
				JSON.stringify(
					current?.[name] ?? (name === "accentColors" ? [] : null),
				) !== JSON.stringify(brandKit[name]),
		);
		// The version did not move between the read and the write, so the
		// keys read above are exactly the ones this write replaced.
		const supersededKeys = ASSET_FIELDS.flatMap((name) => {
			const previous = current?.[name] ?? null;
			return previous && previous !== brandKit[name] ? [previous] : [];
		});
		return {
			outcome: "applied" as const,
			brandKit,
			changedFields,
			supersededKeys,
		};
	});
}
